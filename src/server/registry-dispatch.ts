import { collectDirtyByRegistry } from '../core/capture/dep-graph';
import * as Content from '../core/content';
import { bumpVersion, logPendingChanges, protocolManifest, registry, reindexRegistry } from '../core/registry';
import * as Resources from '../core/resources';
import { markPrefabAnchorsDirty } from '../core/scene/scene-tree';
import { applyTraitSwap, pruneRemovedScript } from '../core/scene/scripts';
import { resolveAllChunks } from '../core/voxels/voxels';
import * as ContentManager from './content-manager';
import * as Net from './net';
import type { EngineServer } from './server';

/** (re)seed Resources.models from the registry's bundled models. drops old
 *  entries first so a hot-reload that renamed/removed/changed bins is covered;
 *  lazy systems ensureModel on first reference. */
export function seedModels(state: EngineServer): void {
    state.resources.modelPayloads.clear();
    state.resources.models.clear();
    for (const [id, handle] of registry.models.byId) {
        Resources.setModel(state.resources, id, {
            clientUrl: handle.bin.client,
            serverUrl: handle.bin.server,
            source: 'bundled',
            def: handle,
        });
    }
}

export function applyRegistryChanges(state: EngineServer): void {
    const allStores = [
        registry.tiles,
        registry.blocks,
        registry.models,
        registry.prefabs,
        registry.scenes,
        registry.traits,
        registry.controls,
        registry.sync,
        registry.scripts,
        registry.commands,
        registry.config,
        registry.sounds,
        registry.sprites,
        registry.particles,
    ];
    logPendingChanges('server', allStores);

    // resolve the DepGraph dirty consumer set before any branch drains its queue,
    // since `collectDirtyByRegistry` reads the `pendingChanges` arrays.
    const dirtyByRegistry = collectDirtyByRegistry(allStores);
    const dirtyPrefabIds = dirtyByRegistry.get('prefabs') ?? new Set<string>();
    const dirtyScriptIds = dirtyByRegistry.get('scripts') ?? new Set<string>();
    // a removed script is pruned from its owning trait def here so applyTraitSwap
    // disposes the live instance and instantiateTraitScripts can't resurrect it.
    for (const ch of registry.scripts.pendingChanges) {
        dirtyScriptIds.add(ch.id);
        if (ch.kind === 'removed') pruneRemovedScript(ch.payload);
    }

    // snapshot the old protocol id lists before reindexing, to compare against
    // afterward and decide whether to re-broadcast the manifest.
    const prevTraitIds = registry.protocol.traits.indexToId;
    const prevCommandIds = registry.protocol.commands.indexToId;
    reindexRegistry(registry);

    // block/tile changes need a wholesale BlockRegistry rebuild + per-room rewire;
    // chunks remesh on next tick.
    if (registry.blocks.pendingChanges.length > 0 || registry.tiles.pendingChanges.length > 0) {
        const blockRegistry = registry.blockRegistry;
        for (const room of state.rooms.rooms.values()) {
            room.voxels.registry = blockRegistry;
            resolveAllChunks(room.voxels);
        }
        registry.blocks.pendingChanges.length = 0;
        registry.tiles.pendingChanges.length = 0;
    }

    if (registry.models.pendingChanges.length > 0) {
        for (const change of registry.models.pendingChanges) {
            const id = change.id;
            if (change.kind === 'removed') {
                Resources.deleteModel(state.resources, id);
                Resources.releaseModel(state.resources, id);
            } else {
                // re-register with both per-side urls; drop any stale payload
                // so the next ensureModel() refetches.
                Resources.releaseModel(state.resources, id);
                Resources.setModel(state.resources, id, {
                    clientUrl: change.payload.bin.client,
                    serverUrl: change.payload.bin.server,
                    source: 'bundled',
                    def: change.payload,
                });
            }
        }
        registry.models.pendingChanges.length = 0;
    }

    // trait body change: wholesale swap (structure may have moved). producer-only
    // change reaching `scripts:<id>` via DepGraph: narrow swap of affected ids only.
    if (registry.traits.pendingChanges.length > 0) {
        for (const room of state.rooms.rooms.values()) {
            applyTraitSwap(room.context);
        }
        registry.traits.pendingChanges.length = 0;
    } else if (dirtyScriptIds.size > 0) {
        for (const room of state.rooms.rooms.values()) {
            applyTraitSwap(room.context, dirtyScriptIds);
        }
    }

    // declaration-side scene change; live disk-edit updates flow separately through
    // bongle's `bongle:scenes` plugin into `applyScenePayload`.
    if (registry.scenes.pendingChanges.length > 0) {
        for (const change of registry.scenes.pendingChanges) {
            const sceneId = change.id;
            if (change.kind === 'removed') {
                Content.clearScene(state.content, sceneId, 'server');
                continue;
            }
            const handle = change.payload;
            const payload = handle._payload;
            if (!payload) {
                console.warn(
                    `[bongle] declared scene "${sceneId}" has no authored payload — handle stays empty, prefabs depending on it won't instantiate`,
                );
                continue;
            }
            ContentManager.putScene(state.contentManager, sceneId, ContentManager.serializeScenePayload(payload));
            Content.populateScene(state.content, registry.blockRegistry, sceneId, payload, 'server');
        }
        registry.scenes.pendingChanges.length = 0;
    }

    // mark dirty anchors in edit rooms so the next prefab tick re-instantiates them.
    // play rooms stay stable across HMR to preserve gameplay state.
    if (dirtyPrefabIds.size > 0) {
        for (const room of state.rooms.rooms.values()) {
            if (room.mode !== 'edit') continue;
            markPrefabAnchorsDirty(room.scene, dirtyPrefabIds);
        }
    }
    // wire-index tables recompute lazily on next read; nothing to do beyond draining.
    registry.commands.pendingChanges.length = 0;
    // script swap already handled above via the merged `dirtyScriptIds`.
    registry.controls.pendingChanges.length = 0;
    registry.sync.pendingChanges.length = 0;
    registry.scripts.pendingChanges.length = 0;

    registry.prefabs.pendingChanges.length = 0;
    registry.config.pendingChanges.length = 0;

    // sounds/sprites/particles are client-only; drain so the queues don't grow
    // unbounded across HMR flushes.
    registry.sounds.pendingChanges.length = 0;
    registry.sprites.pendingChanges.length = 0;
    registry.particles.pendingChanges.length = 0;

    // messages enqueued after this point encode against the new tables; the client
    // adopts the new inbound mapping (via wire_table) before decoding them, while
    // anything already in the outbox was encoded under the old tables.
    const nextTraitIds = registry.protocol.traits.indexToId;
    const nextCommandIds = registry.protocol.commands.indexToId;
    if (!idListsEqual(prevTraitIds, nextTraitIds) || !idListsEqual(prevCommandIds, nextCommandIds)) {
        Net.broadcast(state.net, state.clients, { type: 'wire_table', ...protocolManifest(registry) });
    }

    bumpVersion(registry);
}

function idListsEqual(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
