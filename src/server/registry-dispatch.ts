/**
 * registry-dispatch.ts — drains pending changes from the unified `registry`
 * singleton and applies them to the server-side engine state. invoked by
 * the bongle() vite plugin's hmr-end hook after a hot reload settles.
 *
 * dispatch order is encoded as call order here, not as a numeric priority
 * on each kind. ordering rule: producers before consumers — block textures
 * must rebuild atlas before blocks rewire voxels, models before model
 * handles, traits late so script swap sees settled state. each branch
 * gates on its kind store's pendingChanges length to keep no-op flushes
 * cheap; branches clear their own queues; one final `bumpVersion` marks
 * the flush boundary.
 *
 * blockTextures + blocks drain together via one wholesale BlockRegistry
 * rebuild + per-room rewire. server has no atlas / GPU work; chunks just
 * remesh on next tick. the freshly-derived BlockRegistry is read via
 * `registry.blockRegistry` (lazy, keyed on the source kinds' revisions).
 *
 * model resources are per-id: `registry.models.pendingChanges` drive
 * `Resources.setModel` (added/changed, with server-side bin url) and
 * `Resources.deleteModel` + `releaseModel` (removed).
 *
 * Server-side matchmaking config (maxPlayers, room caps) is read fresh on
 * each allocation via `registry.matchmakingConfig`, so a config edit
 * takes effect on the next allocation without explicit rewiring.
 *
 * scenes: when a `scene()` declaration is added or changed, read the
 * authored payload off `handle._payload` (stamped at module-eval by the
 * codegen barrel's `_registerScenePayload` calls) and feed it through
 * `Content.populateScene` so the declared `SceneHandle` reflects the
 * authored state. Live disk-edit updates flow separately through the kit's
 * `bongle:scenes` Vite plugin → HMR event → `applyScenePayload` in the
 * server boot template. Removed declarations clear the handle.
 *
 * trait changes drive a per-room script-instance swap via `applyTraitSwap`.
 * factory closures re-run against the current `registry.traits`; `onSwap`
 * preserves opt-in state across the swap.
 */

import { collectDirtyByRegistry } from '../core/capture/dep-graph';
import * as Content from '../core/content';
import { bumpVersion, logPendingChanges, registry } from '../core/registry';
import * as Resources from '../core/resources';
import { markPrefabAnchorsDirty } from '../core/scene/nodes';
import { applyTraitSwap, pruneRemovedScript } from '../core/scene/scripts';
import { resolveAllChunks } from '../core/voxels/voxels';
import * as ContentManager from './content-manager';
import type { EngineServer } from './engine-server';
import * as Net from './net';

export function applyRegistryChanges(state: EngineServer): void {
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
    logPendingChanges('server', allStores);

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

    // capture the OLD wire-index id lists before any branch drains. lazy
    // getters return cached arrays keyed on `revision`; once draining bumps
    // revision the next read rebuilds a fresh array, so these references
    // freeze the pre-flush state.
    const prevTraitIds = registry.traitWireIndex.indexToId;
    const prevCommandIds = registry.commandWireIndex.indexToId;

    // block textures feed into BlockRegistry (textures map + texAnimData), so
    // either queue draining requires a wholesale rebuild + per-room rewire.
    // server has no atlas / GPU work — chunks just remesh on next tick. read
    // the rebuilt registry once via the lazy `blockRegistry` getter so every
    // room points at the same instance.
    if (
        registry.blocks.pendingChanges.length > 0 ||
        registry.blockTextures.pendingChanges.length > 0
    ) {
        const blockRegistry = registry.blockRegistry;
        for (const room of state.rooms.rooms.values()) {
            room.voxels.registry = blockRegistry;
            resolveAllChunks(room.voxels);
        }
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
    // current `registry.traits`. factory closures re-run; onSwap preserves
    // opt-in state. removed traits/scripts get disposed inside applyTraitSwap.
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
    // clears the handle. live disk-edit updates are out-of-band: the kit's
    // `bongle:scenes` plugin fires HMR events that the boot template
    // routes through `applyScenePayload` directly.
    if (registry.scenes.pendingChanges.length > 0) {
        for (const change of registry.scenes.pendingChanges) {
            const sceneId = change.handle.id;
            if (change.kind === 'removed') {
                Content.clearScene(state.content, sceneId, 'server');
                continue;
            }
            const handle = change.handle.payload;
            const payload = handle._payload;
            if (!payload) {
                console.warn(
                    `[bongle] declared scene "${sceneId}" has no authored payload — handle stays empty, prefabs depending on it won't instantiate`,
                );
                continue;
            }
            ContentManager.seedLastWrittenRaw(
                state.contentManager,
                sceneId,
                ContentManager.serializeScenePayload(payload),
            );
            Content.populateScene(
                state.content,
                registry.blockRegistry,
                sceneId,
                payload,
                'server',
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
    // effect is consumed via the trait def. drain so the queue doesn't
    // grow unbounded — script swap was already handled above through the
    // merged `dirtyScriptIds`.
    registry.controls.pendingChanges.length = 0;
    registry.sync.pendingChanges.length = 0;
    registry.scripts.pendingChanges.length = 0;

    registry.prefabs.pendingChanges.length = 0;
    registry.matchmaking.pendingChanges.length = 0;

    // sounds: server has no playback runtime — drain so the queue doesn't
    // grow unbounded across HMR flushes.
    registry.sounds.pendingChanges.length = 0;

    // sprites: client-only (atlas + rendering). drain so the queue doesn't
    // grow unbounded across HMR flushes on the server side.
    registry.sprites.pendingChanges.length = 0;

    // particles: client-only (spawn pool + sprite atlas). drain so the
    // queue doesn't grow unbounded across HMR flushes on the server side.
    registry.particles.pendingChanges.length = 0;

    // emit `wire_table` to every connected client if our outbound id sets
    // shifted. messages enqueued AFTER this call (e.g. scene_syncs from
    // the next tick's `Discovery.flush`) will encode against the new
    // tables; WS ordering means the client adopts the new inbound mapping
    // before decoding those follow-ups. messages already in the per-client
    // outbox were encoded under the OLD tables and decode correctly on
    // arrival (client's inbound hasn't been updated yet).
    const nextTraitIds = registry.traitWireIndex.indexToId;
    const nextCommandIds = registry.commandWireIndex.indexToId;
    if (!idListsEqual(prevTraitIds, nextTraitIds) || !idListsEqual(prevCommandIds, nextCommandIds)) {
        Net.broadcast(state.net, state.clients, {
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
