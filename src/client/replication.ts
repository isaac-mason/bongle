import type { PlayerId } from '../core/client';
import type { BinaryField } from '../core/protocol';
import { registry } from '../core/registry';
import { getSyncCodecs } from '../core/scene/packcat-bridge';
import type { Node, SceneTree } from '../core/scene/scene-tree';
import { diffSync } from '../core/scene/sync/sync-diff';
import type { ClientNet } from './net';
import { send } from './net';

/** nodes we currently hold an owner-upload snapshot for (snapshot lives on each
 *  trait instance's `_sync.bytes/values`); reset when ownership is lost so a
 *  future re-own re-uploads from scratch. */
export function createSyncSnapshots(): Set<Node> {
    return new Set();
}

/** send sync updates for owner-authority slices that changed since last tick.
 *  call once per tick, not per frame, to match the server's tick rate. */
export function sendOwnerSyncUpdates(
    net: ClientNet,
    sg: SceneTree,
    roomId: string,
    playerId: PlayerId,
    tracked: Set<Node>,
): void {
    const owned = sg.replication.owners.get(playerId);

    // untrack nodes no longer owned (destroyed, or handed off) so a future re-own
    // re-uploads from scratch rather than diffing against a stale snapshot
    if (tracked.size > 0) {
        for (const node of tracked) {
            if (!owned?.has(node)) {
                resetOwnerSnapshot(node);
                tracked.delete(node);
            }
        }
    }

    if (!owned || owned.size === 0) return;

    const wireIndex = registry.protocol.traits;
    for (const node of owned) {
        let ownsAnySync = false;

        const nodeTraits = node.traits;
        for (let traitSlot = 0; traitSlot < nodeTraits.length; traitSlot++) {
            const instance = nodeTraits[traitSlot];
            if (instance === undefined) continue;
            const handle = registry.slotToTrait[traitSlot];
            if (!handle) continue;

            const codecs = getSyncCodecs(handle);
            if (!codecs) continue;

            const sync = instance._sync;
            if (!sync) continue;

            let hasOwnerSync = false;
            for (const sd of handle.def.sync) {
                if (sd.authority === 'owner') {
                    hasOwnerSync = true;
                    break;
                }
            }
            if (!hasOwnerSync) continue;
            ownsAnySync = true;

            const changedFields: BinaryField[] = [];

            for (let i = 0; i < codecs.length; i++) {
                if (handle.def.sync[i].authority !== 'owner') continue;

                // emitOnFirstSeen: the server needs the initial value of a newly owned slice
                if (diffSync(codecs[i], instance, node, i, sync, true)) {
                    changedFields.push({ index: i, data: sync.bytes[i]! });
                }
            }

            if (changedFields.length === 0) continue;

            send(net, {
                type: 'sync_update',
                roomId,
                nodeId: node.id,
                traitNetIndex: wireIndex.idToIndex.get(handle.id)!,
                fields: changedFields,
            });
        }

        if (ownsAnySync) tracked.add(node);
    }
}

/** clear the per-instance owner-upload snapshots for every trait on a node, so a
 *  future re-own re-uploads from first-seen. */
function resetOwnerSnapshot(node: Node): void {
    const nodeTraits = node.traits;
    for (let slot = 0; slot < nodeTraits.length; slot++) {
        const instance = nodeTraits[slot];
        if (instance === undefined) continue;
        const sync = instance._sync;
        if (!sync) continue;
        sync.bytes.fill(undefined);
    }
}
