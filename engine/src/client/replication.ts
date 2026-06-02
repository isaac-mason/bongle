/**
 * client-side replication.
 *
 * each tick, iterates owned nodes and packs owner-authority sync slices
 * individually. only sends a sync_update when at least one slice's packed
 * bytes differ from the previous tick (same per-slice byte-compare approach
 * the server's diff system uses).
 */

import { registry } from '../core/registry';
import type { PlayerId } from '../core/client';
import type { BinaryField } from '../core/protocol';
import type { Node, Nodes } from '../core/scene/nodes';
import { getSyncCodecs } from '../core/scene/packcat-bridge';
import { bytesEqual } from '../core/utils/bytes';
import type { ClientNet } from './net';
import { send } from './net';

/** per-node, per-sync last-sent bytes. keyed by node → "${traitSlot}:${syncIdx}" → bytes. */
type SyncSnapshots = Map<Node, Map<string, Uint8Array>>;

export function createSyncSnapshots(): SyncSnapshots {
    return new Map();
}

/**
 * send sync updates for owner-authority slices that changed since last tick.
 * call once per tick (not per frame) to match the server's tick rate.
 */
export function sendOwnerSyncUpdates(
    net: ClientNet,
    sg: Nodes,
    roomId: string,
    playerId: PlayerId,
    snapshots: SyncSnapshots,
): void {
    const owned = sg.playerIdToOwnedNodes.get(playerId);
    if (!owned || owned.size === 0) {
        // we own nothing this tick — drop any stale snapshots so they don't
        // leak forever after an owner handoff. cheap when already empty.
        if (snapshots.size > 0) snapshots.clear();
        return;
    }

    // drop snapshot entries for nodes we no longer own (destroyed, or owner
    // changed away). single pass covers both cases now that the index is the
    // ground truth — no `_idToNode.has` probe per snapshot.
    for (const node of snapshots.keys()) {
        if (!owned.has(node)) snapshots.delete(node);
    }

    const wireIndex = registry.traitWireIndex;
    for (const node of owned) {
        for (const [traitSlot, instance] of node._traits) {
            const def = registry.traitsBySlot.get(traitSlot);
            if (!def) continue;

            const codecs = getSyncCodecs(def);
            if (!codecs) continue;

            // skip traits with no owner-authority syncs
            let hasOwnerSync = false;
            for (const sd of def.sync) {
                if (sd.authority === 'owner') {
                    hasOwnerSync = true;
                    break;
                }
            }
            if (!hasOwnerSync) continue;

            let nodeSnapshots = snapshots.get(node);
            if (!nodeSnapshots) {
                nodeSnapshots = new Map();
                snapshots.set(node, nodeSnapshots);
            }

            const changedFields: BinaryField[] = [];

            for (let i = 0; i < codecs.length; i++) {
                if (def.sync[i].authority !== 'owner') continue;

                const current = codecs[i].pack(instance, node);
                if (current.length === 0) continue;

                const key = `${traitSlot}:${i}`;
                const previous = nodeSnapshots.get(key);

                if (previous && bytesEqual(current, previous)) continue;

                nodeSnapshots.set(key, current);
                changedFields.push({ index: i, data: current });
            }

            if (changedFields.length === 0) continue;

            send(net, {
                type: 'sync_update',
                roomId,
                nodeId: node.id,
                traitNetIndex: wireIndex.idToIndex.get(def.id)!,
                fields: changedFields,
            });
        }
    }
}
