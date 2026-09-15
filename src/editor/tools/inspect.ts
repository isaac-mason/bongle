import { type PerspectiveCamera, unproject } from 'gpucat';
import { type Vec3, vec3 } from 'math';
import { TransformTrait } from '../../builtins/transform';
import {
    getCanvasTouches,
    getCursor,
    isKeyDown,
    isKeyJustDown,
    isModDown,
    isMouseDown,
    isMouseJustDown,
    isMouseJustUp,
    isMouseTap,
} from '../../client/input';
import type { ClientRoom } from '../../client/rooms';
import type { Node } from '../../core/scene/scene-tree';
import { getTrait } from '../../core/scene/scene-tree';
import type { ClientContext, ScriptContext } from '../../core/scene/scripts';
import * as Selection from '../../core/scene/selection';
import { getBlock } from '../../core/voxels/voxels';
import type { EditRoomStoreApi } from '../edit-room-store';
import { INSPECT_KEYS } from '../editor-controls';
import { useEditor } from '../editor-store';
import { isInputFocused } from '../input';
import { lensOf } from '../lens';
import { isOwnershipBoundary, type NodeBodies } from '../node-bodies';
import * as Selector from '../selector';
import { playDeselected, playSelected } from '../sounds';
import type { NodeMenuItem } from '../ui/node-menu';
import { buildViewportMenuEntries } from '../ui/viewport-menu-entries';
import type { State as PivotPoint } from '../visuals/pivot-point';
import * as PivotPointMod from '../visuals/pivot-point';
import type { SelectionMeshState } from '../visuals/selection-mesh';
import { updateSelectionMeshes } from '../visuals/selection-mesh';
import type { GrabTool } from './grab';
import * as Grab from './grab';
import { type HandlesState, isEngaged } from './handles';
import type { PlacementTool } from './placement';
import * as Placement from './placement';
import type { TransformToolState } from './transform';
import * as TransformTool from './transform';

// Builds the chain of TransformTrait-bearing ancestors from topmost (under
// sceneRoot) to the hit node; first click selects the topmost, each subsequent
// click on an already-selected chain member drills one tier toward the leaf.
// An ownership boundary drops everything below it, so the drill stops there.
export function resolveSelectionTarget(hitNode: Node, selectedNodeIds: Set<number>, sceneRoot: Node): Node {
    let chain: Node[] = [];
    let cur: Node | null = hitNode;
    while (cur && cur !== sceneRoot) {
        if (isOwnershipBoundary(cur)) chain = [];
        if (getTrait(cur, TransformTrait)) chain.push(cur);
        cur = cur.parent;
    }
    if (chain.length === 0) return hitNode;
    chain.reverse(); // [topmost, ..., leaf]

    // drill from the deepest currently-selected member of the chain
    for (let i = chain.length - 1; i >= 0; i--) {
        if (selectedNodeIds.has(chain[i].id)) {
            return i + 1 < chain.length ? chain[i + 1] : chain[i];
        }
    }
    return chain[0];
}

// scratch vecs reused per call, not safe if called concurrently (it's not)
const _nearWorld: [number, number, number] = [0, 0, 0];
const _farWorld: [number, number, number] = [0, 0, 0];
const _rayDir: [number, number, number] = [0, 0, 0];
const MAX_RAY_DIST = 1024;

export type ContextMenuTarget = { world: Vec3 | null; block: { wx: number; wy: number; wz: number; key: string } | null };

/** raycasts along (ndcX, ndcY), refines the selection the same way a right-click always has
 *  (selects a not-yet-selected node hit, or the voxel under the cursor), and reports whether a
 *  menu should open there. shared by `openViewportContextMenu` (cursor visible, tap-triggered)
 *  and `updateRadialMenu` (pointer-locked, hold-triggered) so both open on identical criteria. */
function resolveContextMenuTarget(
    store: EditRoomStoreApi,
    room: ClientRoom,
    ctx: ScriptContext,
    nodeBodies: NodeBodies,
    camera: PerspectiveCamera,
    ndcX: number,
    ndcY: number,
): ContextMenuTarget | null {
    unproject(_nearWorld, [ndcX, ndcY, 0], camera);
    unproject(_farWorld, [ndcX, ndcY, 1], camera);
    vec3.subtract(_rayDir, _farWorld, _nearWorld);
    vec3.normalize(_rayDir, _rayDir);

    const hits = Selector.castRay(
        nodeBodies,
        room.scene,
        ctx.voxels,
        _nearWorld[0],
        _nearWorld[1],
        _nearWorld[2],
        _rayDir[0],
        _rayDir[1],
        _rayDir[2],
        MAX_RAY_DIST,
    );

    const editorNode = lensOf(room)?.subject;
    const nodeHit = hits.find((h): h is Selector.NodeHit => h.kind === 'node' && h.node !== editorNode);
    const voxelHit = hits.find((h): h is Selector.VoxelHit => h.kind === 'voxel');
    const voxelWins = voxelHit !== undefined && (nodeHit === undefined || voxelHit.distance < nodeHit.distance);

    const s = store.getState();
    let shouldOpen = false;

    if (!voxelWins && nodeHit) {
        // Right-click on a node outside the selection makes it the selection
        // (topmost transform-bearing ancestor, no drill-down).
        let target: Node = nodeHit.node;
        let cur: Node | null = nodeHit.node.parent;
        while (cur && cur !== room.scene.root) {
            if (getTrait(cur, TransformTrait)) target = cur;
            cur = cur.parent;
        }
        if (!s.selection.nodes.has(target.id)) {
            s.selectNode(target.id);
        }
        shouldOpen = true;
    } else if (voxelWins && Selection.countVoxels(s.selection) > 0) {
        shouldOpen = true;
    } else if (voxelWins && voxelHit) {
        store.getState().replaceSelection(Selection.ofVoxel(voxelHit.voxelX, voxelHit.voxelY, voxelHit.voxelZ));
        shouldOpen = true;
    } else if (s.selection.nodes.size > 0 || Selection.countVoxels(s.selection) > 0) {
        shouldOpen = true;
    }

    if (!shouldOpen) return null;

    const world: Vec3 | null =
        voxelWins && voxelHit
            ? Placement.placePointOnFace(
                  [voxelHit.voxelX, voxelHit.voxelY, voxelHit.voxelZ],
                  [voxelHit.nx, voxelHit.ny, voxelHit.nz],
                  [voxelHit.px, voxelHit.py, voxelHit.pz],
                  s.snapTo,
              )
            : null;
    const block =
        voxelWins && voxelHit
            ? {
                  wx: voxelHit.voxelX,
                  wy: voxelHit.voxelY,
                  wz: voxelHit.voxelZ,
                  key: getBlock(ctx.voxels, voxelHit.voxelX, voxelHit.voxelY, voxelHit.voxelZ),
              }
            : null;
    return { world, block };
}

// Right-click tap: raycast, refine selection, open the viewport context menu at
// the cursor. Callers gate by activeTool. Drags are filtered out, only fires on
// release if the press never crossed the input layer's drag threshold.
export function openViewportContextMenu(
    store: EditRoomStoreApi,
    client: ClientContext,
    room: ClientRoom,
    ctx: ScriptContext,
    nodeBodies: NodeBodies,
    camera: PerspectiveCamera,
): void {
    // Touch has no second button, so a long-press stands in for a right-click tap;
    // the cursor already tracks the pressing finger.
    const cursor = getCursor(client.input.mouseKeyboard);
    let longPress = false;
    for (const finger of getCanvasTouches(client.input.touch).values()) {
        if (finger.longPressed) {
            longPress = true;
            break;
        }
    }
    if (!longPress && !isMouseTap(client.input.mouseKeyboard, 'right')) return;
    // pointer-locked has no OS cursor to anchor a dropdown at; see updateRadialMenu instead.
    if (document.pointerLockElement) return;

    const resolved = resolveContextMenuTarget(store, room, ctx, nodeBodies, camera, cursor.ndcX, cursor.ndcY);
    if (!resolved) return;
    store.getState().openViewportContextMenu(cursor.x, cursor.y, resolved.world, resolved.block, false);
}

/** just the raw stick accumulator — NOT "is the menu open"; that's `store.viewportContextMenu.radial`
 *  alone (see updateRadialMenu's doc comment). keeping only non-authoritative, purely-local state
 *  here is what makes the store the one thing to check when tying anything else to this menu's
 *  lifetime — a second `active` flag here would be a second thing that could disagree with it. */
export type RadialMenuState = {
    /** accumulated look-delta since the hold started, in the same pixel-ish units as `mk._dx/_dy`. */
    stickX: number;
    stickY: number;
};

export function createRadialMenuState(): RadialMenuState {
    return { stickX: 0, stickY: 0 };
}

/** below this accumulated distance, no wedge is picked — small movements (or none at all,
 *  right after opening) read as "still deciding", not "top wedge". */
const RADIAL_DEAD_ZONE_PX = 18;
/** stick deflection beyond this reads as fully pushed (`radialPointer.mag` maxes at 1); the
 *  cursor stops moving further out but the wedge keeps tracking angle alone. */
const RADIAL_MAX_DRAG_PX = 120;

/** hold-RMB counterpart to `openViewportContextMenu` for while the pointer is locked (fly-cam
 *  free-look, character mode): there's no OS cursor to place a dropdown at or move to pick an
 *  item, so this reuses the screen-centre aim ray (same convention the lasso tool uses while
 *  locked) to open, and accumulated mouse delta — which pointer lock keeps delivering via
 *  `movementX/Y` even though the cursor itself never moves — to pick a wedge. Release confirms
 *  whatever's highlighted; Escape or releasing outside every wedge (the dead zone) cancels.
 *
 *  Open/closed lives ONLY in `store.viewportContextMenu` (null = closed, `.radial` distinguishes
 *  this from the dropdown) — not in `state` here, and not duplicated anywhere else. Anything that
 *  needs to react to this menu's lifetime (the `RadialMenu` UI, `updateRadialMenuForActiveTool`'s
 *  tool-switch guard in client.ts) reads that same field, so input and rendering can be edited
 *  independently without a second "is it open" flag to keep in sync by hand.
 *
 *  Callers gate by activeTool exactly like `openViewportContextMenu` (this doesn't duplicate that
 *  guard, or the existing tap-triggered function's own pointer-lock early-return — the two are
 *  independent, both self-consistent to call unconditionally). MUST run from an `onInput` hook
 *  registered before the fly/character controller's own `onInput` look handler consumes the same
 *  frame's `mk._dx/_dy` (see EditorTrait's "input pre-passes" block in client.ts) — called from
 *  `onFrame` instead, the controller would already have spent the delta and every wedge pick
 *  would read as the dead zone. */
export function updateRadialMenu(
    state: RadialMenuState,
    store: EditRoomStoreApi,
    client: ClientContext,
    room: ClientRoom,
    ctx: ScriptContext,
    nodeBodies: NodeBodies,
    camera: PerspectiveCamera,
): void {
    const mk = client.input.mouseKeyboard;
    const isOpen = store.getState().viewportContextMenu?.radial === true;

    if (!document.pointerLockElement) {
        if (isOpen) store.getState().closeViewportContextMenu();
        return;
    }

    if (!isOpen) {
        if (!isMouseJustDown(mk, 'right')) return;
        const resolved = resolveContextMenuTarget(store, room, ctx, nodeBodies, camera, 0, 0);
        if (!resolved) return;
        state.stickX = 0;
        state.stickY = 0;
        // x/y become the viewport centre: nothing to anchor a dropdown at, but a followup
        // picker (add-trait, promote) still wants somewhere on-screen to open near.
        store
            .getState()
            .openViewportContextMenu(window.innerWidth / 2, window.innerHeight / 2, resolved.world, resolved.block, true);
        return;
    }

    const released = !isMouseDown(mk, 'right');
    const cancelled = isKeyJustDown(mk, 'Escape');
    if (released || cancelled) {
        if (released && !cancelled) {
            const hover = store.getState().radialPointer?.hover ?? null;
            if (hover !== null) {
                const items = buildViewportMenuEntries(store).filter((e): e is NodeMenuItem => e.kind === 'item');
                items[hover]?.onSelect();
            }
        }
        store.getState().closeViewportContextMenu();
        return;
    }

    // claims the delta (zeroing it) so the fly/character controller's own look doesn't also spin
    // the camera while this reads it for wedge selection; mirrors updateGrabRotate's same trick.
    state.stickX += mk._dx;
    state.stickY += mk._dy;
    mk._dx = 0;
    mk._dy = 0;
    const mag = Math.hypot(state.stickX, state.stickY);
    if (mag < RADIAL_DEAD_ZONE_PX) {
        store.getState().setRadialPointer({ hover: null, dirX: 0, dirY: 0, mag: 0 });
        return;
    }

    // direction is plain screen-space (x right, y down) — the same convention the SVG cursor in
    // ui/radial-menu.tsx draws in, so it composes with no sign flips.
    const dirX = state.stickX / mag;
    const dirY = state.stickY / mag;
    const clampedMag = Math.min(1, mag / RADIAL_MAX_DRAG_PX);

    const items = buildViewportMenuEntries(store).filter((e) => e.kind === 'item');
    if (items.length === 0) {
        store.getState().setRadialPointer({ hover: null, dirX, dirY, mag: clampedMag });
        return;
    }
    // screen space is y-down; wedge 0 sits at the top (angle -90deg) and wedges go clockwise.
    const angle = Math.atan2(state.stickY, state.stickX) + Math.PI / 2;
    const wedge = (2 * Math.PI) / items.length;
    const normalized = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const hover = Math.floor(normalized / wedge) % items.length;
    store.getState().setRadialPointer({ hover, dirX, dirY, mag: clampedMag });
}

export function updateInspect(
    store: EditRoomStoreApi,
    activeTool: 'inspect' | 'transform',
    client: ClientContext,
    room: ClientRoom,
    ctx: ScriptContext,
    nodeBodies: NodeBodies,
    transformToolState: TransformToolState,
    placement: PlacementTool,
    grab: GrabTool,
    handles: HandlesState,
    pivotPoint: PivotPoint,
    meshState: SelectionMeshState,
    camera: PerspectiveCamera,
): void {
    const cursor = getCursor(client.input.mouseKeyboard);
    // Place-mode cursor follow is a non-destructive preview: a click commits with
    // a history entry, any other exit reverts to the snapshot positions.
    if (placement.placeSnapshots !== null) {
        const s0 = store.getState();
        const stillActive = activeTool === 'transform' && s0.transformMode === 'place' && s0.selection.nodes.size > 0;
        if (!stillActive) {
            Placement.revertPlaceSelection(placement, room.scene);
        }
    }

    // Snapshotted before being cleared below; used by transform placement raycast.
    const s = store.getState();
    const hoverVoxelAtFrame = s.hoverVoxel;
    const hoverNormalAtFrame = s.hoverNormal;
    const hoverPointAtFrame = s.hoverPoint;

    // Inspect/transform suppress the voxel tools' transient state; the selection itself stays.
    const dirty = s.hoverVoxel !== null || s.boxSelect !== undefined || s.brush !== null;
    if (dirty) {
        store.setState((cur) => ({
            hoverVoxel: null,
            hoverNormal: null,
            hoverPoint: null,
            lastHoverVoxel: hoverVoxelAtFrame ?? cur.lastHoverVoxel,
            boxSelect: undefined,
            brush: null,
        }));
    }
    updateSelectionMeshes(meshState, store.getState(), client.state!.renderer.time);

    if (activeTool === 'transform') {
        // placementContinuous marks a placement started by the build tool (a plain
        // ctrl+v paste leaves it false). If the active hotbar slot no longer matches
        // the in-flight placement, drop the ghost and bounce back to the build tool.
        const { placementContinuous, activeSlotIndex } = store.getState();
        if (placementContinuous && placement.current) {
            const placementPrefabId = placement.current.sourcePrefabId;
            const placementSceneId = placement.current.sourceSceneId;
            const slot = useEditor.getState().hotbar[activeSlotIndex] ?? null;
            const slotPrefabId = slot && slot.kind === 'prefab' ? slot.prefabId : null;
            const slotSceneId = slot && slot.kind === 'blueprint' ? slot.sceneId : null;
            const prefabMismatch = placementPrefabId !== null && placementPrefabId !== slotPrefabId;
            const sceneMismatch = placementSceneId !== null && placementSceneId !== slotSceneId;
            if (prefabMismatch || sceneMismatch) {
                Placement.cancelPlacement(placement, ctx);
                store.setState({ activeTool: 'build' });
            }
        }

        // Refreshed each frame so snapTo can be force-clamped to 'corner' when voxel
        // content is present, and the UI can disable the toggle.
        const hasVoxels = TransformTool.computeTransformHasVoxels(transformToolState, room.scene);
        if (store.getState().transformHasVoxels !== hasVoxels) {
            store.setState({ transformHasVoxels: hasVoxels });
        }

        const { transformMode } = store.getState();
        if (transformMode === 'place' && hoverVoxelAtFrame && hoverNormalAtFrame) {
            Placement.updatePlacementFromRaycast(placement, room.scene, hoverVoxelAtFrame, hoverNormalAtFrame, hoverPointAtFrame);
        }
        const pivotPos =
            TransformTool.updateTransformTool(transformToolState, room.scene, client.state!.resources) ??
            Placement.pivotPosition(placement) ??
            Grab.pivotPosition(grab, room.scene);
        PivotPointMod.update(pivotPoint, pivotPos ?? [0, 0, 0], pivotPos !== null);
    } else {
        TransformTool.detachGizmo(transformToolState);
        PivotPointMod.update(pivotPoint, [0, 0, 0], false);
    }

    const gizmoDragging =
        (activeTool === 'transform' && (transformToolState.dragging || transformToolState.consumedClick)) || isEngaged(handles);
    const transformModeNow = store.getState().transformMode;
    const inPlaceMode = activeTool === 'transform' && transformModeNow === 'place';
    const inGrabMode = activeTool === 'transform' && transformModeNow === 'grab';
    const clicked = isMouseJustDown(client.input.mouseKeyboard, 'left');
    // Mirrors the build tool: when the pointer is locked (RMB unambiguous) fire on
    // down; when the cursor is visible (fly/orbit) fire only on a tap, so a
    // right-drag look doesn't also commit the placement.
    const pointerLocked = !!document.pointerLockElement;
    const rightClicked = pointerLocked
        ? isMouseJustDown(client.input.mouseKeyboard, 'right')
        : isMouseTap(client.input.mouseKeyboard, 'right');

    // Tool/mode switch force-release happens in editor/client.ts before this runs.
    if (inGrabMode) {
        if (Grab.isInGrab(grab)) {
            if (isMouseJustUp(client.input.mouseKeyboard, 'left') || !isMouseDown(client.input.mouseKeyboard, 'left')) {
                Grab.exitGrab(grab, room.scene, room.physics, ctx);
            } else {
                Grab.updateGrab(grab, client.input.mouseKeyboard);
            }
        } else if (clicked && !gizmoDragging) {
            unproject(_nearWorld, [cursor.ndcX, cursor.ndcY, 0], camera);
            unproject(_farWorld, [cursor.ndcX, cursor.ndcY, 1], camera);
            vec3.subtract(_rayDir, _farWorld, _nearWorld);
            vec3.normalize(_rayDir, _rayDir);
            const hits = Selector.castRay(
                nodeBodies,
                room.scene,
                ctx.voxels,
                _nearWorld[0],
                _nearWorld[1],
                _nearWorld[2],
                _rayDir[0],
                _rayDir[1],
                _rayDir[2],
                MAX_RAY_DIST,
            );
            const editorNode = lensOf(room)?.subject;
            const nodeHit = hits.find((h): h is Selector.NodeHit => h.kind === 'node' && h.node !== editorNode);
            if (nodeHit) {
                // Grab always targets the topmost transform-bearing ancestor; drilling
                // into subnodes mid-grab would grab the wrong child of a selected parent.
                let target: Node = nodeHit.node;
                let cur: Node | null = nodeHit.node.parent;
                while (cur && cur !== room.scene.root) {
                    if (getTrait(cur, TransformTrait)) target = cur;
                    cur = cur.parent;
                }
                store.getState().selectNode(target.id);
                Grab.enterGrab(grab, target.id, room.scene, room.physics, client.state!.resources, camera);
            }
        }
    }

    if (inPlaceMode && Placement.isInPlacement(placement)) {
        if (rightClicked) {
            Placement.commitPlacement(placement, room.scene, ctx.voxels, ctx);
        } else if (clicked) {
            // Left click pins the ghost here and switches to the translate gizmo for fine-tuning.
            if (placement.current) placement.current.placed = true;
            store.setState({ transformMode: 'translate' });
        }
    } else if (inPlaceMode && store.getState().selection.nodes.size > 0) {
        // Place mode driving a plain selection (no ghost): either click pins the
        // cursor-follow position as a history entry and exits back to translate.
        if (clicked || rightClicked) {
            Placement.commitPlaceSelection(placement, room.scene, ctx);
            store.setState({ transformMode: 'translate' });
        }
    } else if (clicked && !gizmoDragging && !inPlaceMode && !inGrabMode) {
        const { selectTarget } = store.getState();

        unproject(_nearWorld, [cursor.ndcX, cursor.ndcY, 0], camera);
        unproject(_farWorld, [cursor.ndcX, cursor.ndcY, 1], camera);
        vec3.subtract(_rayDir, _farWorld, _nearWorld);
        vec3.normalize(_rayDir, _rayDir);

        const hits = Selector.castRay(
            nodeBodies,
            room.scene,
            ctx.voxels,
            _nearWorld[0],
            _nearWorld[1],
            _nearWorld[2],
            _rayDir[0],
            _rayDir[1],
            _rayDir[2],
            MAX_RAY_DIST,
        );

        // Excludes the local player node + descendants, and the editor lens node.
        const editorNode = lensOf(room)?.subject;

        // Hits are distance-sorted; take the nearest of each type, then let
        // distance arbitrate which one wins when both are present.
        const nodeHit = hits.find((h): h is Selector.NodeHit => h.kind === 'node' && h.node !== editorNode);
        const voxelHit = hits.find((h): h is Selector.VoxelHit => h.kind === 'voxel');

        const voxelWins = voxelHit !== undefined && (nodeHit === undefined || voxelHit.distance < nodeHit.distance);
        // a plain (non-shift) click that lands on the other category picks that up instead of
        // clearing this one, so losing this category isn't its own event worth a deselect blip.
        const willSelectVoxel = selectTarget !== 'nodes' && voxelHit !== undefined && (voxelWins || selectTarget === 'voxels');
        let selectedNodeThisClick = false;

        if (selectTarget !== 'voxels') {
            const rawHit = voxelWins ? null : (nodeHit ?? null);
            const selectedNode = rawHit
                ? resolveSelectionTarget(rawHit.node, store.getState().selection.nodes, room.scene.root)
                : null;
            const mk = client.input.mouseKeyboard;
            // cmd/ctrl is an alternate add-to-selection modifier, same as shift.
            const addHeld = isKeyDown(mk, 'ShiftLeft') || isKeyDown(mk, 'ShiftRight') || isModDown(mk);
            const s = store.getState();
            if (addHeld && selectedNode) {
                if (s.selection.nodes.has(selectedNode.id)) {
                    s.removeFromSelection(selectedNode.id);
                    playDeselected(ctx);
                } else {
                    s.addToSelection(selectedNode.id);
                    playSelected(ctx, true);
                }
            } else {
                const hadNodeSelection = s.selection.nodes.size > 0;
                s.selectNode(selectedNode ? selectedNode.id : null);
                if (selectedNode) {
                    selectedNodeThisClick = true;
                    playSelected(ctx, false);
                } else if (hadNodeSelection && !willSelectVoxel) {
                    playDeselected(ctx);
                }
            }
        }

        // a block click inspects it — sets `inspectedVoxel` directly, deliberately NOT the shared
        // voxel `selection` (see that field's doc comment): looking at a block's properties
        // shouldn't disturb whatever a select tool actually has selected. no shift-toggle here;
        // there's only ever one inspected voxel at a time.
        if (activeTool === 'inspect' && selectTarget !== 'nodes') {
            const mk = client.input.mouseKeyboard;
            // cmd/ctrl is an alternate add-to-selection modifier, same as shift — kept in sync
            // here even though inspect no longer has anything to "add" a voxel to, since it still
            // gates whether a miss clears a stale voxel selection from another tool.
            const addHeld = isKeyDown(mk, 'ShiftLeft') || isKeyDown(mk, 'ShiftRight') || isModDown(mk);
            const cur = store.getState().selection;
            if (voxelHit && (voxelWins || selectTarget === 'voxels')) {
                const { voxelX, voxelY, voxelZ } = voxelHit;
                store.getState().setInspectedVoxel({ wx: voxelX, wy: voxelY, wz: voxelZ });
                playSelected(ctx, false);
            } else {
                if (store.getState().inspectedVoxel) {
                    store.getState().setInspectedVoxel(null);
                    playDeselected(ctx);
                }
                // a miss still clears a stale voxel SELECTION left over from box/brush/lasso/magic
                // select — a separate, deliberate "click away to deselect" gesture, not the thing
                // that got reverted here.
                if (!addHeld && cur.chunks.size > 0 && !selectedNodeThisClick) {
                    store.getState().replaceSelection(Selection.nodesOnly(cur));
                    playDeselected(ctx);
                }
            }
        }
    }

    // Context menu is an inspect-tool concept; transform owns right-click for its
    // own semantics (place commit, grab exit).
    if (activeTool === 'inspect') {
        openViewportContextMenu(store, client, room, ctx, nodeBodies, camera);
    }

    if (!isInputFocused()) {
        const mk = client.input.mouseKeyboard;
        const hasNodeSelection = store.getState().selection.nodes.size > 0;

        if (activeTool === 'inspect') {
            if (hasNodeSelection) {
                // Q/T/Y activate the transform tool with the matching mode.
                if (isKeyJustDown(mk, INSPECT_KEYS.toTranslate)) {
                    store.setState({ activeTool: 'transform', transformMode: 'translate' });
                } else if (isKeyJustDown(mk, INSPECT_KEYS.toRotate)) {
                    store.setState({ activeTool: 'transform', transformMode: 'rotate' });
                } else if (isKeyJustDown(mk, INSPECT_KEYS.toScale)) {
                    store.setState({ activeTool: 'transform', transformMode: 'scale' });
                }
            }

            // Escape clears the node selection first, then the voxel selection.
            if (isKeyJustDown(mk, 'Escape')) {
                if (hasNodeSelection) {
                    store.getState().clearNodeSelection();
                    playDeselected(ctx);
                } else if (Selection.countVoxels(store.getState().selection) > 0) {
                    store.getState().clearSelection();
                    playDeselected(ctx);
                }
            }
        } else if (activeTool === 'transform') {
            if (Placement.isInPlacement(placement)) {
                Placement.handleKeys(placement, mk, client.input, camera.quaternion, room.scene, ctx);
            } else {
                TransformTool.handleTransformKeys(
                    mk,
                    client.input,
                    camera.quaternion,
                    transformToolState,
                    room.scene,
                    ctx,
                    Grab.isInGrab(grab),
                );
            }
        }
    }

    // Inspect mesh update is hoisted out to editor/client.ts, so the selection
    // outline is drawn for every tool, not just inspect/transform.
}
