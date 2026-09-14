import type { Input } from '../../client/input';
import { isKeyDown, isMouseJustDown } from '../../client/input';
import type { ScriptContext } from '../../core/scene/scripts';
import * as Selection from '../../core/scene/selection';
import type { EditRoomStoreApi, SelectionBehavior, SelectTarget } from '../edit-room-store';
import type { NodeBodies } from '../node-bodies';
import { rebuildNodeSelection } from '../scene/node-selection';
import { playAnchored, playSelected } from '../sounds';

// scratch region hosting the box's voxel rasterisation for the origin-in-selection node query,
// kept across commits to skip the alloc
const _queryRegion: Selection.Selection = Selection.create();

/** clear in-progress box-select state. */
export function clearBoxSelect(store: EditRoomStoreApi): void {
    store.setState({ boxSelect: undefined, cursor: null });
}

/** Per-frame box-select update, handling both mouse clicks and keyboard cursor. */
export function updateBoxSelect(
    store: EditRoomStoreApi,
    ctx: ScriptContext,
    input: Input,
    nodeBodies: NodeBodies | null,
    /** camera-relative nudge from arrow keys, or null if no nudge this frame */
    nudgeDelta: [number, number, number] | null,
    /** true if Enter was just pressed this frame */
    enterPressed: boolean,
): void {
    const s = store.getState();
    const hv = s.hoverVoxel;
    const hasSelection = !Selection.isEmpty(s.selection);

    // only activates when there's no committed selection, or a cursor-driven box-select is in progress
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

    const after = store.getState();

    // enter places corner A, or commits corner B via keyboard cursor
    if (cursorAllowed && after.cursor && enterPressed) {
        if (!after.boxSelect) {
            store.setState({
                boxSelect: { cornerA: [...after.cursor!], previewB: [...after.cursor!], locked: true },
            });
            playAnchored(ctx);
        } else if (after.boxSelect.previewB) {
            const mk = input.mouseKeyboard;
            const shiftHeld = isKeyDown(mk, 'ShiftLeft') || isKeyDown(mk, 'ShiftRight');
            const effective = shiftHeld ? 'add' : after.selectionBehavior;
            commitBoxSelect(store, ctx, after.cursor, nodeBodies, effective, after.selectTarget);
            store.setState({ cursor: null });
        }
        return;
    }

    const justDown = isMouseJustDown(input.mouseKeyboard, 'left');

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
        playAnchored(ctx);
    } else {
        // second click commits; when locked (keyboard-driven), use the nudged previewB
        const cornerB = after.boxSelect.locked && after.boxSelect.previewB ? after.boxSelect.previewB : hv;
        if (!cornerB) return;
        const mk = input.mouseKeyboard;
        const shiftHeld = isKeyDown(mk, 'ShiftLeft') || isKeyDown(mk, 'ShiftRight');
        const effective = shiftHeld ? 'add' : after.selectionBehavior;
        commitBoxSelect(store, ctx, cornerB, nodeBodies, effective, after.selectTarget);
    }
}

/** Commits the in-progress box-select using the given corner B; no-op if none is in progress. */
export function commitBoxSelect(
    store: EditRoomStoreApi,
    ctx: ScriptContext,
    cornerB: [number, number, number],
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

    const next = selectionBehavior === 'add' ? Selection.clone(s.selection) : Selection.create();

    if (selectTarget !== 'nodes') {
        Selection.setAABB(next, minX, minY, minZ, maxX, maxY, maxZ);
    }

    // origin-in-box: rasterises the box into a scratch region and picks nodes whose origins fall inside
    if (selectTarget !== 'voxels') {
        _queryRegion.chunks.clear();
        _queryRegion.nodes.clear();
        Selection.setAABB(_queryRegion, minX, minY, minZ, maxX, maxY, maxZ);
        rebuildNodeSelection(_queryRegion, ctx, nodeBodies);
        for (const nid of _queryRegion.nodes) next.nodes.add(nid);
    }

    store.getState().replaceSelection(next);
    store.setState({ boxSelect: undefined });
    playSelected(ctx, selectionBehavior === 'add');
}
