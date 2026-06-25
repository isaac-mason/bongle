// renders one scene's icon. the subject is a SceneHandle (voxels + node
// children); seed the room by deserializing its voxels + children, then tick
// any embedded prefabs before the shared subject-render path.
//
//   1. look up SceneHandle by id from registry.scenes
//   2. preload all models (embedded-prefab apply() dereferences model handles)
//   3. deserialize voxels + children into a fresh offline room
//   4. Prefab.tick → instantiate any embedded prefabs (matches the live render)
//   5. renderPopulatedRoom → wait for models, light, frame, render, capture
//
// Always-render now: hash-gating + iteration over the scene set lives in the
// orchestrator (one PNG per scene).

import type { State } from '../engine';
import { createRoom, disposeRoom } from '../rooms';
import { addChild, deserializeNode } from '../../core/scene/nodes';
import { loadVoxels } from '../../core/voxels/voxel-savefile';
import { registry as engineRegistry } from '../../core/registry';
import { beginSnapshotSession, endSnapshotSession } from '../snapshot';
import { preloadAllModels, renderPopulatedRoom, SUBJECT_ICON_PX, tickPrefabsToFixpoint, waitFor } from '../subject';

export type SceneIconResult = {
    /** tightly-packed RGBA8 bytes, length = SUBJECT_ICON_PX² × 4. empty when
     *  the scene isn't registered, has no payload, or nothing renderable. */
    pixels: Uint8Array;
    pxSize: number;
};

export async function runSceneIcon(state: State, id: string): Promise<SceneIconResult> {
    const handleEntry = engineRegistry.scenes.byId.get(id);
    if (!handleEntry) {
        return { pixels: new Uint8Array(0), pxSize: SUBJECT_ICON_PX };
    }
    // _payload holds the canonical serialized form — handle.node/voxels are
    // mutated in place by populateScene on every reload.
    const payload = handleEntry.payload._payload as
        | { nodes: { root: { children: unknown[] } }; voxels: import('../../core/voxels/voxel-savefile').SavedVoxels | null }
        | null;
    if (!payload) return { pixels: new Uint8Array(0), pxSize: SUBJECT_ICON_PX };

    const room = createRoom(state);
    await state.voxelResources.atlasReady;
    await preloadAllModels(state);

    const session = beginSnapshotSession(state.renderer.renderer, SUBJECT_ICON_PX);

    let pixels: Uint8Array | null = null;
    try {
        if (payload.voxels) {
            loadVoxels(room.voxels, payload.voxels, room.voxels.registry);
        }
        for (const childData of payload.nodes.root.children) {
            addChild(room.nodes.root, deserializeNode(childData as Parameters<typeof deserializeNode>[0]));
        }
        // instantiate any embedded prefabs the scene authored — matches the
        // live render (engine-client ticks prefabs each frame). drained to a
        // fixpoint so nested prefabs (a scene embedding a prefab that embeds a
        // prefab…) fully resolve; without this the icon omits that content.
        tickPrefabsToFixpoint(room, state);
        pixels = await renderPopulatedRoom(state, room, session, id);
    } catch (e) {
        console.warn(`[scene-icon] "${id}" render failed — skipping:`, e);
    } finally {
        endSnapshotSession(session);
        disposeRoom(room);
    }

    return { pixels: pixels ?? new Uint8Array(0), pxSize: SUBJECT_ICON_PX };
}
