// renders one prefab into a single 256² icon tile. the subject is a prefab
// anchor (Prefab.tick instantiates scene children, runs apply(), stamps
// voxels); everything after seeding is the shared subject-render path.
//
//   1. look up the prefab payload by id from registry.prefabs
//   2. preload all models (Prefab.tick dereferences model handles)
//   3. attach a node with prefab=createPrefabConfig(...) + Prefab.tick
//   4. renderPopulatedRoom → wait for models, light, frame, render, capture
//
// Always-render now: hash-gating + iteration over the prefab set lives in
// the orchestrator (one PNG per prefab, like scenes — no atlas).

import type { State } from '../engine';
import { createRoom, disposeRoom } from '../rooms';
import { addChild, createNode, createPrefabConfig } from '../../core/scene/nodes';
import { registry as engineRegistry } from '../../core/registry';
import { beginSnapshotSession, endSnapshotSession } from '../snapshot';
import { preloadAllModels, renderPopulatedRoom, SUBJECT_ICON_PX, tickPrefabsToFixpoint, waitFor } from '../subject';

export type PrefabIconResult = {
    /** tightly-packed RGBA8 bytes, length = SUBJECT_ICON_PX² × 4. empty when
     *  the prefab isn't registered or there's nothing renderable. */
    pixels: Uint8Array;
    pxSize: number;
};

/** Render a single prefab's icon. Returns empty pixels if the prefab isn't
 *  registered, Prefab.tick throws, or there's nothing to render. */
export async function runPrefabIcon(state: State, id: string): Promise<PrefabIconResult> {
    const entry = engineRegistry.prefabs.byId.get(id);
    if (!entry) {
        return { pixels: new Uint8Array(0), pxSize: SUBJECT_ICON_PX };
    }
    const def = entry.payload;

    const room = createRoom(state);
    await state.voxelResources.atlasReady;
    await waitFor(() => room.modelVisuals.cullCompute !== null, 'cull computes');
    await preloadAllModels(state);

    const session = beginSnapshotSession(state.renderer.renderer, SUBJECT_ICON_PX);

    let pixels: Uint8Array | null = null;
    try {
        // attach a prefab anchor under the room root. mode='play' on the room
        // means Prefab.tick stamps voxels into the world automatically.
        const anchor = createNode({ name: def.id });
        anchor.prefab = createPrefabConfig(def.id, {
            args: def.args ? structuredClone(def.args.default) : {},
        });
        addChild(room.nodes.root, anchor);
        try {
            tickPrefabsToFixpoint(room, state);
            pixels = await renderPopulatedRoom(state, room, session, def.id);
        } catch (e) {
            console.warn(`[prefab-icons] "${def.id}" render failed — skipping:`, e);
        }
    } finally {
        endSnapshotSession(session);
        disposeRoom(room);
    }

    return { pixels: pixels ?? new Uint8Array(0), pxSize: SUBJECT_ICON_PX };
}
