import { collectDirtyByRegistry } from '../core/capture/dep-graph';
import * as Content from '../core/content';
import { bumpVersion, logPendingChanges, registry, reindexRegistry } from '../core/registry';
import * as Resources from '../core/resources';
import { markPrefabAnchorsDirty } from '../core/scene/scene-tree';
import { applyTraitSwap, pruneRemovedScript } from '../core/scene/scripts';
import { loadAtlasMetadata } from '../core/sprites/atlas';
import { resolveAllChunks } from '../core/voxels/voxels';
import * as Audio from './audio/audio';
import type { EngineClient } from './client';

export async function applyRegistryChanges(state: EngineClient): Promise<void> {
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
    ];
    logPendingChanges('client', allStores);

    // resolve the DepGraph dirty consumer set before any branch drains its queue,
    // since collectDirtyByRegistry reads the pendingChanges arrays
    const dirtyByRegistry = collectDirtyByRegistry(allStores);
    const dirtyPrefabIds = dirtyByRegistry.get('prefabs') ?? new Set<string>();
    const dirtyScriptIds = dirtyByRegistry.get('scripts') ?? new Set<string>();
    // a removed script is pruned from its owning trait def here so applyTraitSwap
    // disposes the live instance and instantiateTraitScripts can't resurrect it
    for (const ch of registry.scripts.pendingChanges) {
        dirtyScriptIds.add(ch.id);
        if (ch.kind === 'removed') pruneRemovedScript(ch.payload);
    }

    reindexRegistry(registry);

    // refresh() short-circuits on hash + texAnimData equality, so a blocks-only edit
    // keeps the same VoxelResources; when the atlas does change, per-room visuals
    // (which hold material refs) must be disposed + re-init'd
    if (registry.blocks.pendingChanges.length > 0 || registry.tiles.pendingChanges.length > 0) {
        await refreshBlockResources(state);
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
                // drop the stale payload so the next ensureModel() refetches
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

    // there is no server->client rejoin signal on trait edits, so the client must swap
    // server-backed rooms too; gating on `room.local` would leave them stuck on old defs.
    // trait body change: wholesale swap, since trait structure may have moved.
    // producer-only change reaching `scripts:<id>` via DepGraph: narrow swap by id.
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

    // live disk-edit updates are out-of-band: the bongle:scenes plugin fires HMR
    // events the boot template routes through applyScenePayload directly
    if (registry.scenes.pendingChanges.length > 0) {
        for (const change of registry.scenes.pendingChanges) {
            const sceneId = change.id;
            if (change.kind === 'removed') {
                Content.clearScene(state.content, sceneId, 'client');
                continue;
            }
            const handle = change.payload;
            const payload = handle._payload;
            if (!payload) continue;
            Content.populateScene(state.content, registry.blockRegistry, sceneId, payload, 'client');
        }
        registry.scenes.pendingChanges.length = 0;
    }

    // play rooms stay stable across HMR (preserves gameplay state); only edit rooms
    // re-instantiate dirty prefab anchors on the next tick
    if (dirtyPrefabIds.size > 0) {
        for (const room of state.rooms.rooms.values()) {
            if (room.roomMode !== 'edit') continue;
            markPrefabAnchorsDirty(room.scene, dirtyPrefabIds);
        }
    }
    // wire-index tables for commands/traits are lazy-derived and recompute on next
    // read after the revision bumps below; nothing to do here beyond draining the queue
    registry.commands.pendingChanges.length = 0;

    registry.controls.pendingChanges.length = 0;
    registry.sync.pendingChanges.length = 0;
    registry.scripts.pendingChanges.length = 0;

    registry.prefabs.pendingChanges.length = 0;
    registry.config.pendingChanges.length = 0;
    registry.sounds.pendingChanges.length = 0;

    // image-file edits without a registry change ride the `bongle:sprite-atlas-updated`
    // HMR path into refreshSpriteResources directly
    if (registry.sprites.pendingChanges.length > 0) {
        await refreshSpriteResources(state);
        registry.sprites.pendingChanges.length = 0;
    }

    bumpVersion(registry);

    // broad "registry flush settled" signal for browser consumers, e.g. the editor
    // invalidating cached prefab icons; block icons ride the narrower `block-resources-changed`
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('bongle:registry-changed'));
    }
}

/** (re)seed Resources.models from the unified registry's bundled models. drops
 *  old entries first so vanished payloads release their pool slots on the next
 *  MeshResources.update. lazy systems ensureModel on first reference. */
export function seedModels(state: EngineClient): void {
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

/**
 * Rebuild the BlockRegistry from current registry contents and refresh VoxelResources
 * (atlas + animation buffer), short-circuiting when the atlas manifest hash and
 * texAnimData are byte-identical to the previous build. Called from the registry
 * dispatch when blocks/tiles pendingChanges fire, and directly from the
 * `bongle:tile-atlas-updated` HMR listener for an image-file edit with no registry change.
 */
export async function refreshBlockResources(state: EngineClient): Promise<void> {
    const blockRegistry = registry.blockRegistry;

    // independent of the GPU resource swap below, so it runs first
    for (const room of state.rooms.rooms.values()) {
        room.voxels.registry = blockRegistry;
        resolveAllChunks(room.voxels);
    }

    // owned by the backend since it spans client-global resources + the active room's visuals
    await state.renderer.refreshBlockResources({
        blockRegistry,
        voxelBudget: state.perf.voxelBudget,
        settings: state.perf.settings,
        resources: state.resources,
    });

    if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('bongle:block-resources-changed'));
    }
}

/** Re-fetch `sprites-atlas.{png,json}` into the backend's sprite resources. Called from
 *  the sprites dispatch branch above and from the `bongle:sprite-atlas-updated` HMR
 *  listener for an image-file edit with no registry change to ride. */
export async function refreshSpriteResources(state: EngineClient): Promise<void> {
    // reload CPU atlas metadata first (the render swap reads it for new frame UVs), then the GPU atlas
    state.resources.spriteAtlas = await loadAtlasMetadata(state.resources.loader);
    await state.renderer.refreshSpriteResources({ resources: state.resources });
}

/** Re-fetch `audio-manifest.json` + `audio-atlas.webm` into the engine-global
 *  `AudioResources`. Called from the `bongle:audio-atlas-updated` HMR listener, since a
 *  sound source-file edit has no registry change to ride. In-flight playbacks keep their
 *  started buffers and finish. */
export async function refreshAudioResources(state: EngineClient): Promise<void> {
    await Audio.refreshResources(state.audioResources, state.resources.loader);
}
