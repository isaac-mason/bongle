// box select tool update function.
//
// called each frame from EditorScript onFrame (client only).
// reads & writes the per-room store (selection + transient boxSelect + cursor).
//
// mouse flow:
//   click 1: hovered voxel → sets store.boxSelect = { cornerA, previewB: null }
//   each subsequent frame: update previewB to current hover
//   click 2: compute AABB between cornerA and previewB, write to store.selection,
//            clear store.boxSelect so UI rerenders.
//
// keyboard flow:
//   arrow keys move a keyboard cursor (store.cursor).
//   enter places corner A at the cursor, then enter again commits corner B.
//   keyboard-driven box-select sets `locked: true` so cursor raycast is ignored.
//
// in 'replace' mode the new AABB replaces the current selection.
// in 'add' mode the new AABB is merged into the current selection.
//
// when selectTarget is 'nodes' or 'all', the committed AABB is used to query the
// crashcat broadphase for editor node bodies.

import { isKeyDown } from '../../client/input';
import type { Input } from '../../client/input';
import type { EditRoomStoreApi, SelectionBehavior, SelectTarget } from '../edit-room-store';
import type { NodeBodies } from '../node-bodies';
import type { Physics } from '../../core/physics/physics';
import type { ScriptContext } from '../../core/scene/scripts';
import type { PointerState } from '../pointer-state';
import { pointerJustDown } from '../pointer-state';
import * as Selection from '../../core/scene/selection';
import { rebuildNodeSelection } from '../scene/node-selection';

// scratch region used to host the box's voxel rasterisation when querying
// nodes via origin-in-selection (kept across commits to skip the alloc).
const _queryRegion: Selection.Selection = Selection.create();

/** clear in-progress box-select state. */
export function clearBoxSelect(store: EditRoomStoreApi): void {
    store.setState({ boxSelect: undefined, cursor: null });
}

// ── per-frame update ───────────────────────────────────────────────

/**
 * per-frame box-select update. handles both mouse clicks and keyboard cursor.
 *
 * @param nudgeDelta - camera-relative nudge from arrow keys, or null if no nudge this frame
 * @param enterPressed - true if Enter was just pressed this frame
 */
export function updateBoxSelect(
    store: EditRoomStoreApi,
    ctx: ScriptContext,
    pointer: PointerState,
    input: Input,
    physics: Physics | null,
    nodeBodies: NodeBodies | null,
    nudgeDelta: [number, number, number] | null,
    enterPressed: boolean,
): void {
    const s = store.getState();
    const hv = s.hoverVoxel;
    const hasSelection = !Selection.isEmpty(s.selection);

    // ── keyboard cursor ────────────────────────────────────────────
    // only activates when there's no committed selection (or a cursor-driven
    // box-select is already in progress).
    const cursorAllowed = !hasSelection || !!s.cursor;

    if (cursorAllowed && nudgeDelta) {
        let cursor = s.cursor;
        if (cursor) {
            cursor = [cursor[0] + nudgeDelta[0], cursor[1] + nudgeDelta[1], cursor[2] + nudgeDelta[2]];
        } else {
            const origin = hv ?? s.lastHoverVoxel;
            if (origin) cursor = [origin[0] + nudgeDelta[0], origin[1] + nudgeDelta[1], origin[2] + nudgeDelta[2]];
        }
        if (cursor) {
            const nextBox = s.boxSelect
                ? { cornerA: s.boxSelect.cornerA, previewB: [...cursor] as [number, number, number], locked: true }
                : s.boxSelect;
            store.setState({ cursor, boxSelect: nextBox });
        }
    }

    // re-read after possible nudge
    const after = store.getState();

    // enter → place corner A or commit corner B via keyboard cursor
    if (cursorAllowed && after.cursor && enterPressed) {
        if (!after.boxSelect) {
            store.setState({
                boxSelect: { cornerA: [...after.cursor!], previewB: [...after.cursor!], locked: true },
            });
        } else if (after.boxSelect.previewB) {
            const mk = input.mouseKeyboard;
            const shiftHeld = isKeyDown(mk, 'ShiftLeft') || isKeyDown(mk, 'ShiftRight');
            const effective = shiftHeld ? 'add' : after.selectionBehavior;
            commitBoxSelect(store, ctx, after.cursor, physics, nodeBodies, effective, after.selectTarget);
            store.setState({ cursor: null });
        }
        return;
    }

    // ── mouse-driven flow ──────────────────────────────────────────
    const justDown = pointerJustDown(pointer, input);

    if (!justDown) {
        // update preview each frame so the overlay tracks the cursor (unless keyboard-locked)
        if (after.boxSelect && !after.boxSelect.locked && hv) {
            const prev = after.boxSelect.previewB;
            if (!prev || prev[0] !== hv[0] || prev[1] !== hv[1] || prev[2] !== hv[2]) {
                store.setState((cur) => ({
                    boxSelect: cur.boxSelect
                        ? { cornerA: cur.boxSelect.cornerA, previewB: [hv[0], hv[1], hv[2]], locked: cur.boxSelect.locked }
                        : cur.boxSelect,
                }));
            }
        }
        return;
    }

    // left click event
    if (!after.boxSelect) {
        if (!hv) return;
        store.setState({
            boxSelect: { cornerA: [hv[0], hv[1], hv[2]], previewB: [hv[0], hv[1], hv[2]], locked: false },
        });
    } else {
        // second click — commit selection.
        // when locked (keyboard-driven), use the nudged previewB; otherwise use hover voxel.
        const cornerB = after.boxSelect.locked && after.boxSelect.previewB ? after.boxSelect.previewB : hv;
        if (!cornerB) return;
        const mk = input.mouseKeyboard;
        const shiftHeld = isKeyDown(mk, 'ShiftLeft') || isKeyDown(mk, 'ShiftRight');
        const effective = shiftHeld ? 'add' : after.selectionBehavior;
        commitBoxSelect(store, ctx, cornerB, physics, nodeBodies, effective, after.selectTarget);
    }
}

/**
 * commit the in-progress box-select using the given corner B.
 * clears store.boxSelect and updates store.selection.
 * no-op if no box-select is in progress.
 */
export function commitBoxSelect(
    store: EditRoomStoreApi,
    ctx: ScriptContext,
    cornerB: [number, number, number],
    physics: Physics | null,
    nodeBodies: NodeBodies | null,
    selectionBehavior: SelectionBehavior,
    selectTarget: SelectTarget,
): void {
    const s = store.getState();
    if (!s.boxSelect) return;

    const [ax, ay, az] = s.boxSelect.cornerA;
    const [bx, by, bz] = cornerB;
    const minX = Math.min(ax, bx),
        minY = Math.min(ay, by),
        minZ = Math.min(az, bz);
    const maxX = Math.max(ax, bx),
        maxY = Math.max(ay, by),
        maxZ = Math.max(az, bz);

    const next =
        selectionBehavior === 'add' ? Selection.clone(s.selection) : Selection.create();

    // voxels
    if (selectTarget !== 'nodes') {
        Selection.setAABB(next, minX, minY, minZ, maxX, maxY, maxZ);
    }

    // nodes — origin-in-box: rasterise the box into a scratch region and
    // let the helper pick nodes whose origins fall inside.
    if (selectTarget !== 'voxels') {
        _queryRegion.chunks.clear();
        _queryRegion.nodes.clear();
        Selection.setAABB(_queryRegion, minX, minY, minZ, maxX, maxY, maxZ);
        rebuildNodeSelection(_queryRegion, ctx, physics, nodeBodies);
        for (const nid of _queryRegion.nodes) next.nodes.add(nid);
    }

    store.setState({
        selection: next,
        boxSelect: undefined,
    });
}
