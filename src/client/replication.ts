/**
 * client-side replication.
 *
 * each tick, iterates owned nodes and packs owner-authority sync slices
 * individually. only sends a sync_update when at least one slice's packed
 * bytes differ from the previous tick (same per-slice byte-compare approach
 * the server's diff system uses).
 */

import type { PlayerId } from '../core/client';
import type { BinaryField } from '../core/protocol';
import { registry } from '../core/registry';
import type { Node, Nodes } from '../core/scene/nodes';
import { getSyncCodecs } from '../core/scene/packcat-bridge';
import { diffSyncSlice } from '../core/scene/sync/sync-diff';
import type { ClientNet } from './net';
import { send } from './net';

/** the set of owned nodes we currently hold an owner-upload snapshot for. the
 *  snapshot itself lives on each trait instance's `_sync.bytes/values`; this set
 *  exists only so we can reset a node's snapshot when ownership is lost, so a
 *  future re-own re-uploads from scratch (first-seen) rather than diffing against
 *  stale bytes. (name kept for caller stability — it tracks nodes, not state.) */
export function createSyncSnapshots(): Set<Node> {
    return new Set();
}

/**
 * send sync updates for owner-authority slices that changed since last tick.
 * call once per tick (not per frame) to match the server's tick rate. the
 * per-slice byte snapshot lives on `instance._sync` — same store the server
 * diff uses.
 */
export function sendOwnerSyncUpdates(net: ClientNet, sg: Nodes, roomId: string, playerId: PlayerId, tracked: Set<Node>): void {
    const owned = sg.playerIdToOwnedNodes.get(playerId);

    // reset + untrack nodes we no longer own (destroyed, or owner handed off) so
    // a future re-own re-uploads from scratch rather than diffing against a stale
    // per-instance snapshot.
    if (tracked.size > 0) {
        for (const node of tracked) {
            if (!owned || !owned.has(node)) {
                resetOwnerSnapshot(node);
                tracked.delete(node);
            }
        }
    }

    if (!owned || owned.size === 0) return;

    const wireIndex = registry.traitWireIndex;
    for (const node of owned) {
        let ownsAnySync = false;

        for (const [traitSlot, instance] of node._traits) {
            const def = registry.traitsBySlot.get(traitSlot);
            if (!def) continue;

            const codecs = getSyncCodecs(def);
            if (!codecs) continue;

            const sync = instance._sync;
            if (!sync) continue;

            // skip traits with no owner-authority syncs
            let hasOwnerSync = false;
            for (const sd of def.sync) {
                if (sd.authority === 'owner') {
                    hasOwnerSync = true;
                    break;
                }
            }
            if (!hasOwnerSync) continue;
            ownsAnySync = true;

            const changedFields: BinaryField[] = [];

            for (let i = 0; i < codecs.length; i++) {
                if (def.sync[i].authority !== 'owner') continue;

                // shared cold path: byte-diff or ThresholdRate metric. the client
                // uploads a first-seen owned slice (the server needs the initial
                // value), so emitOnFirstSeen = true.
                if (diffSyncSlice(def.sync[i], codecs[i], instance, node, i, sync, true)) {
                    changedFields.push({ index: i, data: sync.bytes[i]! });
                }
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

        if (ownsAnySync) tracked.add(node);
    }
}

/** clear the per-instance owner-upload snapshots for every trait on a node, so a
 *  future re-own re-uploads from first-seen. */
function resetOwnerSnapshot(node: Node): void {
    for (const [, instance] of node._traits) {
        const sync = instance._sync;
        if (!sync) continue;
        sync.bytes.fill(undefined);
        sync.values.fill(undefined);
    }
}
