/**
 * registry-dispatch.ts — drains pending changes from the unified `registry`
 * singleton and applies them to the client-side engine state. invoked by
 * the bongle() vite plugin's hmr-end hook after a hot reload settles.
 *
 * mirror of `server/registry-dispatch.ts`. dispatch order is encoded as
 * call order here, not as a numeric priority on each kind. ordering rule:
 * producers before consumers — block textures rebuild atlas before blocks
 * rewire voxels, models before model handles, traits late. each branch
 * gates on its kind store's pendingChanges length to keep no-op flushes
 * cheap; branches clear their own queues; one final `bumpVersion` marks
 * the flush boundary.
 *
 * client-side `resolveAllChunks` marks every chunk dirty, which the mesher
 * picks up on the next frame — no explicit `remeshWorld` call needed.
 *
 * because blockTextures feed into BlockRegistry (textures + texAnimData)
 * and into VoxelResources (atlas + animation buffer), the two stores
 * drain together — a wholesale BlockRegistry rebuild covers both.
 * VoxelResources.refresh internally short-circuits when the atlas hash
 * and texAnimData are unchanged, so a blocks-only edit doesn't thrash
 * per-room visuals.
 *
 * model resources are per-id: `registry.models.pendingChanges` drive
 * `Resources.setModel` (added/changed) and `Resources.deleteModel` +
 * `releaseModel` (removed).
 *
 * scenes: when a new `scene()` declaration appears mid-session (or its
 * authored payload changes), the codegen barrel's `_registerScenePayload`
 * write lands on the handle's `_payload` field. This branch reads
 * `_payload` and re-populates scene state on the client side. Live
 * disk-edit updates flow separately through the kit's `bongle:scenes`
 * Vite plugin → HMR event → `applyScenePayload` in the client boot
 * template.
 *
 * trait changes drive a per-room script-instance swap via `applyTraitSwap`.
 * factory closures re-run against the current `registry.traits`; `onSwap`
 * preserves opt-in state across the swap.
 */

import { env } from 'bongle';
import { collectDirtyByRegistry } from '../core/capture/dep-graph';
import * as Content from '../core/content';
import { useEditor } from '../editor/editor-store';
import { bumpVersion, logPendingChanges, registry, type KindStore } from '../core/registry';
import * as Resources from '../core/resources';
import { markPrefabAnchorsDirty } from '../core/scene/nodes';
import { applyTraitSwap, pruneRemovedScript } from '../core/scene/scripts';
import { resolveAllChunks } from '../core/voxels/voxels';
import type { EngineClient } from './engine-client';
import * as Net from './net';
import * as ParticleResources from './particles/particle-resources';
import * as ExtrudedSpriteResources from './sprites/extruded-sprite-resources';
import * as ExtrudedSpriteVisuals from './sprites/extruded-sprite-visuals';
import * as SpriteResources from './sprites/sprite-resources';
import * as VoxelMeshResources from './voxels/voxel-mesh-resources';
import * as VoxelMeshVisuals from './voxels/voxel-mesh-visuals';
import * as Performance from './performance';
import * as VoxelResources from './voxels/voxel-resources';
import * as VoxelVisuals from './voxels/voxel-visuals';

// TEMP diagnostic: count HMR dispatches to detect runaway re-fire loops.
// Logs every call with elapsed-ms-since-last and a 30-call rolling rate.
// Remove once the HMR perf regression is found.
let _hmrCallCount = 0;
let _hmrLastT = 0;
let _hmrFirstT = 0;
export async function applyRegistryChanges(state: EngineClient): Promise<void> {
    const _now = (typeof performance !== 'undefined' ? performance : Date).now();
    _hmrCallCount++;
    if (_hmrCallCount === 1) _hmrFirstT = _now;
    const sinceLast = _hmrLastT > 0 ? (_now - _hmrLastT).toFixed(0) : 'first';
    const ratePerSec = _hmrCallCount > 1
        ? (_hmrCallCount / ((_now - _hmrFirstT) / 1000)).toFixed(2)
        : '—';
    console.log(`[registry-dispatch][hmr] call#${_hmrCallCount} sinceLast=${sinceLast}ms rate=${ratePerSec}/s`);
    _hmrLastT = _now;

    const allStores = [
        registry.blockTextures,
        registry.blocks,
        registry.models,
        registry.prefabs,
        registry.scenes,
        registry.traits,
        registry.controls,
        registry.sync,
        registry.scripts,
        registry.commands,
        registry.matchmaking,
        registry.sounds,
        registry.sprites,
        registry.particles,
    ];
    logPendingChanges('client', allStores);

    // resolve the DepGraph dirty consumer set BEFORE any branch drains its
    // queue — `collectDirtyByRegistry` reads `pendingChanges` arrays. each
    // dispatch branch below clears its own queue once it acts, so the
    // dirty map captures the full flush before we lose it.
    const dirtyByRegistry = collectDirtyByRegistry(allStores);
    const dirtyPrefabIds = dirtyByRegistry.get('prefabs') ?? new Set<string>();
    const dirtyScriptIds = dirtyByRegistry.get('scripts') ?? new Set<string>();
    // direct script-store changes feed the same applyTraitSwap path — keys
    // already match `ScriptDef.key` (`${traitId}.${scriptId}`). a removed
    // script (its `script()` call deleted from source) is pruned from the
    // owning trait def here so applyTraitSwap disposes the live instance and
    // instantiateTraitScripts can't resurrect it — see pruneRemovedScript.
    for (const ch of registry.scripts.pendingChanges) {
        dirtyScriptIds.add(ch.handle.id);
        if (ch.kind === 'removed') pruneRemovedScript(ch.handle.payload);
    }

    // editor HMR toasts — one per kind with pending changes, plus one
    // for script-instance swaps reaching via DepGraph (when trait body
    // didn't change but a producer did). gated on env.editor so shipped
    // builds skip the store churn.
    if (env.editor) pushHmrToasts(allStores, dirtyScriptIds);

    // capture the OLD wire-index id lists before any branch drains. lazy
    // getters return cached arrays keyed on `revision`; once draining bumps
    // revision the next read rebuilds a fresh array, so these references
    // freeze the pre-flush state.
    const prevTraitIds = registry.traitWireIndex.indexToId;
    const prevCommandIds = registry.commandWireIndex.indexToId;

    // block textures feed BlockRegistry (textures + texAnimData) AND drive the
    // GPU atlas — refresh() short-circuits on hash + texAnimData equality, so
    // a blocks-only edit (no texture change) keeps the same VoxelResources.
    // when the atlas does change, per-room visuals (which hold material refs)
    // must be disposed + re-init'd; mesh visuals also bind the atlas + anim
    // buffer directly.
    if (
        registry.blocks.pendingChanges.length > 0 ||
        registry.blockTextures.pendingChanges.length > 0
    ) {
        await refreshBlockResources(state);
        registry.blocks.pendingChanges.length = 0;
        registry.blockTextures.pendingChanges.length = 0;
    }

    if (registry.models.pendingChanges.length > 0) {
        for (const change of registry.models.pendingChanges) {
            const id = change.handle.id;
            if (change.kind === 'removed') {
                Resources.deleteModel(state.resources, id);
                Resources.releaseModel(state.resources, id);
            } else {
                // added or changed — re-register with both per-side urls and
                // drop any stale payload so the next ensureModel() refetches.
                Resources.releaseModel(state.resources, id);
                Resources.setModel(state.resources, id, {
                    clientUrl: change.handle.payload.bin.client,
                    serverUrl: change.handle.payload.bin.server,
                    source: 'bundled',
                    handle: change.handle.payload,
                });
            }
        }
        registry.models.pendingChanges.length = 0;
    }

    // trait def changes — swap every live script instance against the
    // current `registry.traits`. client and server envs HMR independently;
    // each side owns its own script swap. there is no server→client rejoin
    // signal on trait edits, so the client must swap server-backed rooms
    // too — gating on `room.local` would leave them stuck on old defs.
    //
    // dual path:
    //   - trait body change → wholesale swap (every instance), since trait
    //     structure (script index, field layout) may have moved.
    //   - producer-only change reaching `scripts:<id>` via DepGraph → narrow
    //     swap targeting only the affected script ids.
    if (registry.traits.pendingChanges.length > 0) {
        for (const room of state.rooms.rooms.values()) {
            applyTraitSwap(room.scriptRuntime);
        }
        registry.traits.pendingChanges.length = 0;
    } else if (dirtyScriptIds.size > 0) {
        for (const room of state.rooms.rooms.values()) {
            applyTraitSwap(room.scriptRuntime, dirtyScriptIds);
        }
    }

    // scenes: declaration-side change. read each declared handle's
    // `_payload` (stamped by the codegen barrel) and apply it. `removed`
    // clears the handle. live disk-edit updates are out-of-band: the
    // bongle:scenes plugin fires HMR events the boot template routes
    // through applyScenePayload directly.
    if (registry.scenes.pendingChanges.length > 0) {
        for (const change of registry.scenes.pendingChanges) {
            const sceneId = change.handle.id;
            if (change.kind === 'removed') {
                Content.clearScene(state.content, sceneId, 'client');
                continue;
            }
            const handle = change.handle.payload;
            const payload = handle._payload;
            if (!payload) continue;
            Content.populateScene(
                state.content,
                registry.blockRegistry,
                sceneId,
                payload,
                'client',
            );
        }
        registry.scenes.pendingChanges.length = 0;
    }

    // prefabs: mark dirty anchors in edit rooms so the next prefab tick
    // re-instantiates them with the fresh def + dep content. play rooms
    // stay stable across HMR (preserves gameplay state) — only setPrefab /
    // registerSubtree dirty anchors there. dirtyPrefabIds folds both
    // directly-changed prefabs and transitive dep-change consumers.
    if (dirtyPrefabIds.size > 0) {
        for (const room of state.rooms.rooms.values()) {
            if (room.nodes.roomMode !== 'edit') continue;
            markPrefabAnchorsDirty(room.nodes, dirtyPrefabIds);
        }
    }
    // commands + traits: wire-index tables for both are lazy-derived on
    // `registry.commandWireIndex` / `.traitWireIndex` and recompute on next
    // read after the revision bumps from the draining above. nothing to do
    // here beyond draining the queue.
    registry.commands.pendingChanges.length = 0;

    // controls / sync / scripts: per-trait registrations whose runtime
    // effect is consumed via the trait def (controlsById, syncById,
    // scriptsById). codec WeakMaps keyed on TraitDef are dropped when
    // the parent trait swaps identity (replaceIdentity on the traits
    // store) — drain so the queue doesn't grow unbounded.
    registry.controls.pendingChanges.length = 0;
    registry.sync.pendingChanges.length = 0;
    registry.scripts.pendingChanges.length = 0;

    registry.prefabs.pendingChanges.length = 0;
    registry.matchmaking.pendingChanges.length = 0;

    // sounds: runtime reaction wired in `client/audio/audio.ts`. drain here
    // so the queue doesn't grow unbounded; downstream readers consume via
    // `registry.sounds.byId` lazily.
    registry.sounds.pendingChanges.length = 0;

    // particles: per-id resolution at spawn time via `registry.particles`.
    // drain so the queue doesn't grow unbounded.
    registry.particles.pendingChanges.length = 0;

    // sprites: a registry change means the kit asset-pipeline pass will
    // (re)emit `sprites-atlas.{png,json}`. refresh here re-fetches both
    // and short-circuits on hash equality. image-file edits without a
    // registry change ride the `bongle:sprite-atlas-updated` HMR path
    // into `refreshSpriteResources` directly (parallel to the voxel
    // atlas's `bongle:block-texture-atlas-updated` flow).
    if (registry.sprites.pendingChanges.length > 0) {
        await refreshSpriteResources(state);
        registry.sprites.pendingChanges.length = 0;
    }

    // emit `wire_table` to the server if our outbound id sets shifted.
    // messages enqueued AFTER this call (e.g. sync_update / net_message
    // from the next tick) encode against the new tables; WS ordering means
    // the server adopts the new inbound mapping for this client before
    // decoding those follow-ups.
    const nextTraitIds = registry.traitWireIndex.indexToId;
    const nextCommandIds = registry.commandWireIndex.indexToId;
    if (!idListsEqual(prevTraitIds, nextTraitIds) || !idListsEqual(prevCommandIds, nextCommandIds)) {
        Net.send(state.net, {
            type: 'wire_table',
            traits: nextTraitIds,
            commands: nextCommandIds,
        });
    }

    bumpVersion(registry);
}

function idListsEqual(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/**
 * Rebuild the BlockRegistry from current registry contents, refresh
 * VoxelResources (atlas + animation buffer) — short-circuits when the atlas
 * manifest hash and texAnimData are byte-identical to the previous build —
 * then repoint every room's `voxels.registry` and remesh all chunks. If
 * `VoxelResources.refresh` reports an atlas swap, rebuild each room's
 * per-room voxel materials (they bind the GPU TextureArray + per-room
 * env buffers) and re-init the room's voxel + voxel-mesh visuals.
 *
 * Called from the registry dispatch when blocks/blockTextures pendingChanges
 * fire, AND directly from the `bongle:block-texture-atlas-updated` HMR listener when the
 * asset pipeline regenerates the atlas because of an image-file edit. The
 * pipeline-driven case has no registry change to ride on; this entrypoint
 * is the only way the image edit propagates to the live client.
 */
export async function refreshBlockResources(state: EngineClient): Promise<void> {
    const blockRegistry = registry.blockRegistry;

    const { resources: nextRes, changed: voxelResourcesChanged } = await VoxelResources.refresh(
        state.voxelResources,
        blockRegistry,
        state.renderer.environmentResources,
        state.voxelBudget,
        Performance.settingsForTier(state.performance).voxelWorkerCount,
        Performance.settingsForTier(state.performance).voxelWorkerQueueDepth,
        state.renderer.renderer,
    );
    state.voxelResources = nextRes;

    // voxelMeshResources binds the engine-global atlas + texAnim, so it
    // must rebuild alongside voxelResources whenever those swap.
    if (voxelResourcesChanged) {
        VoxelMeshResources.dispose(state.voxelMeshResources);
        state.voxelMeshResources = VoxelMeshResources.init(
            state.voxelResources.atlas,
            state.voxelResources.texAnimBuffer,
        );
    }

    const activeRoom = state.rooms.activePlayerId !== null
        ? state.rooms.rooms.get(state.rooms.activePlayerId) ?? null
        : null;

    for (const room of state.rooms.rooms.values()) {
        room.voxels.registry = blockRegistry;
        resolveAllChunks(room.voxels);

        if (voxelResourcesChanged) {
            // engine-global voxel arenas + geometries + materials all live
            // on the rebuilt `state.voxelResources`. per-room visuals just
            // hold three `Mesh` wrappers pointing at those — re-init drops
            // the stale meshes (which still reference the disposed
            // geometries) and adds fresh ones bound to the new resources.
            VoxelVisuals.dispose(room.voxelVisuals, room.scene);
            VoxelMeshVisuals.dispose(room.voxelMeshVisuals, room.scene, room.visibility);
            room.voxelVisuals = VoxelVisuals.initRoomMeshes(room.scene, state.voxelResources);
            room.voxelMeshVisuals = VoxelMeshVisuals.init(
                room.scene,
                room.nodes,
                state.voxelMeshResources,
                state.renderer.environmentResources,
            );
        }
    }

    // re-seat the active room into the freshly-built engine-global arena
    // (refresh blew away the previous arena contents; the new packer is
    // empty). marks every chunk dirty so the prioritised remesh path
    // refills the arena over the next few frames.
    if (voxelResourcesChanged && activeRoom) {
        VoxelVisuals.activateRoom(state.voxelResources, activeRoom.voxelVisuals, activeRoom.voxels);
    }
}

/**
 * Re-fetch `sprites-atlas.{png,json}` into the engine-global
 * `SpriteResources`. Called from the sprites dispatch branch above AND
 * from the `bongle:sprite-atlas-updated` HMR listener in the boot
 * template (the image-file-edit path has no registry change to ride).
 * `SpriteResources.refresh` rebinds the sprite material's atlas
 * TextureNode in place; the extruded + particle materials hold their own
 * TextureNodes against the same atlas and need an explicit rebind. The
 * extruded-sprite per-room geometry pool is baked from atlas pixels and
 * is invalidated wholesale — dispose + re-init so it re-bakes lazily.
 */
export async function refreshSpriteResources(state: EngineClient): Promise<void> {
    const changed = await SpriteResources.refresh(state.spriteResources);
    if (!changed) return;
    ExtrudedSpriteResources.rebindAtlas(state.extrudedSpriteResources, state.spriteResources.atlas);
    ParticleResources.rebindAtlas(state.particleResources, state.spriteResources.atlas);
    // wipe the engine-global silhouette pool — every bake is stale against
    // the new atlas pixels. per-room visuals dispose+re-init so their alive
    // states (holding now-dangling GeometrySlot refs) drop, and next frame's
    // update lazily re-acquires into the freshly-cleared pool.
    ExtrudedSpriteResources.clearGeometryPool(state.extrudedSpriteResources);
    for (const room of state.rooms.rooms.values()) {
        ExtrudedSpriteVisuals.dispose(room.extrudedSpriteVisuals, state.extrudedSpriteResources, room.visibility);
        room.extrudedSpriteVisuals = ExtrudedSpriteVisuals.init(
            room.scene,
            room.nodes,
            state.extrudedSpriteResources,
            state.renderer.environmentResources,
        );
    }
}

// per-kind toast labels. singular when one id changed, plural for many.
// missing entries fall back to the raw store name.
const TOAST_LABELS: Record<string, [singular: string, plural: string]> = {
    blocks: ['block', 'blocks'],
    blockTextures: ['block texture', 'block textures'],
    models: ['model', 'models'],
    prefabs: ['prefab', 'prefabs'],
    scenes: ['scene', 'scenes'],
    traits: ['trait', 'traits'],
    controls: ['control', 'controls'],
    sync: ['sync', 'syncs'],
    scripts: ['script', 'scripts'],
    commands: ['command', 'commands'],
    matchmaking: ['matchmaking', 'matchmaking'],
    sounds: ['sound', 'sounds'],
    sprites: ['sprite', 'sprites'],
    particles: ['particle emitter', 'particle emitters'],
};

function pushHmrToasts(
    stores: ReadonlyArray<KindStore<unknown>>,
    dirtyScriptIds: ReadonlySet<string>,
): void {
    const ed = useEditor.getState();
    for (const store of stores) {
        if (store.pendingChanges.length === 0) continue;
        const ids = store.pendingChanges.map((ch) => ch.handle.id);
        const allSame = store.pendingChanges.every((ch) => ch.kind === store.pendingChanges[0]!.kind);
        const verb = !allSame ? 'updated'
            : store.pendingChanges[0]!.kind === 'added' ? 'added'
            : store.pendingChanges[0]!.kind === 'removed' ? 'removed'
            : 'updated';
        const [singular, plural] = TOAST_LABELS[store.name] ?? [store.name, store.name];
        const message = ids.length === 1
            ? `${singular} '${ids[0]}' ${verb}`
            : `${ids.length} ${plural} ${verb}`;
        ed.pushToast({ kind: store.name, message });
    }
    // script-instance swaps via DepGraph (producer-only change reaching
    // `scripts:<id>` whose body itself didn't move). suppressed when the
    // trait body OR the script body itself changed — those already
    // toasted under `traits` / `scripts` above.
    const directScriptIds = new Set(registry.scripts.pendingChanges.map((ch) => ch.handle.id));
    const propagatedScriptIds = [...dirtyScriptIds].filter((id) => !directScriptIds.has(id));
    if (propagatedScriptIds.length > 0 && registry.traits.pendingChanges.length === 0) {
        const n = propagatedScriptIds.length;
        ed.pushToast({
            kind: 'scripts',
            message: `${n} script instance${n === 1 ? '' : 's'} updated via deps`,
        });
    }
}
