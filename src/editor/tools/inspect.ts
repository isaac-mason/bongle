import { type PerspectiveCamera, unproject } from 'gpucat';
import { type Vec3, vec3 } from 'math';
import { TransformTrait } from '../../builtins/transform';
import {
    getCanvasTouches,
    getCursor,
    isKeyDown,
    isKeyJustDown,
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
import type { State as PivotPoint } from '../visuals/pivot-point';
import * as PivotPointMod from '../visuals/pivot-point';
import type { SelectionMeshState } from '../visuals/selection-mesh';
import { updateSelectionMeshes } from '../visuals/selection-mesh';
import { type HandlesState, isEngaged } from './handles';
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
    if (document.pointerLockElement) return;

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

    if (shouldOpen) {
        const world: Vec3 | null =
            voxelWins && voxelHit
                ? TransformTool.placePointOnFace(
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
        s.openViewportContextMenu(cursor.x, cursor.y, world, block);
    }
}

export function updateInspect(
    store: EditRoomStoreApi,
    activeTool: 'inspect' | 'transform',
    client: ClientContext,
    room: ClientRoom,
    ctx: ScriptContext,
    nodeBodies: NodeBodies,
    transformToolState: TransformToolState,
    handles: HandlesState,
    pivotPoint: PivotPoint,
    meshState: SelectionMeshState,
    camera: PerspectiveCamera,
): void {
    const cursor = getCursor(client.input.mouseKeyboard);
    // Place-mode cursor follow is a non-destructive preview: a click commits with
    // a history entry, any other exit reverts to the snapshot positions.
    if (transformToolState.placeSnapshots !== null) {
        const s0 = store.getState();
        const stillActive = activeTool === 'transform' && s0.transformMode === 'place' && s0.selection.nodes.size > 0;
        if (!stillActive) {
            TransformTool.revertPlaceSelection(transformToolState, room.scene);
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
        if (placementContinuous && transformToolState.placement) {
            const placementPrefabId = transformToolState.placement.sourcePrefabId;
            const placementSceneId = transformToolState.placement.sourceSceneId;
            const slot = useEditor.getState().hotbar[activeSlotIndex] ?? null;
            const slotPrefabId = slot && slot.kind === 'prefab' ? slot.prefabId : null;
            const slotSceneId = slot && slot.kind === 'blueprint' ? slot.sceneId : null;
            const prefabMismatch = placementPrefabId !== null && placementPrefabId !== slotPrefabId;
            const sceneMismatch = placementSceneId !== null && placementSceneId !== slotSceneId;
            if (prefabMismatch || sceneMismatch) {
                TransformTool.cancelPlacement(transformToolState, ctx);
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
            TransformTool.updatePlacementFromRaycast(
                transformToolState,
                room.scene,
                hoverVoxelAtFrame,
                hoverNormalAtFrame,
                hoverPointAtFrame,
            );
        }
        const pivotPos = TransformTool.updateTransformTool(transformToolState, room.scene, client.state!.resources);
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
        if (TransformTool.isInGrab(transformToolState)) {
            if (isMouseJustUp(client.input.mouseKeyboard, 'left') || !isMouseDown(client.input.mouseKeyboard, 'left')) {
                TransformTool.exitGrab(transformToolState, room.scene, room.physics, ctx);
            } else {
                TransformTool.updateGrab(transformToolState, client.input.mouseKeyboard);
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
                TransformTool.enterGrab(transformToolState, target.id, room.scene, room.physics, client.state!.resources, camera);
            }
        }
    }

    if (inPlaceMode && TransformTool.isInPlacement(transformToolState)) {
        if (rightClicked) {
            TransformTool.commitPlacement(transformToolState, room.scene, ctx.voxels, ctx);
        } else if (clicked) {
            // Left click pins the ghost here and switches to the translate gizmo for fine-tuning.
            if (transformToolState.placement) transformToolState.placement.placed = true;
            store.setState({ transformMode: 'translate' });
        }
    } else if (inPlaceMode && store.getState().selection.nodes.size > 0) {
        // Place mode driving a plain selection (no ghost): either click pins the
        // cursor-follow position as a history entry and exits back to translate.
        if (clicked || rightClicked) {
            TransformTool.commitPlaceSelection(transformToolState, room.scene, ctx);
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

        if (selectTarget !== 'voxels') {
            const rawHit = voxelWins ? null : (nodeHit ?? null);
            const selectedNode = rawHit
                ? resolveSelectionTarget(rawHit.node, store.getState().selection.nodes, room.scene.root)
                : null;
            const mk = client.input.mouseKeyboard;
            const shiftHeld = isKeyDown(mk, 'ShiftLeft') || isKeyDown(mk, 'ShiftRight');
            const s = store.getState();
            if (shiftHeld && selectedNode) {
                if (s.selection.nodes.has(selectedNode.id)) {
                    s.removeFromSelection(selectedNode.id);
                } else {
                    s.addToSelection(selectedNode.id);
                }
            } else {
                s.selectNode(selectedNode ? selectedNode.id : null);
            }
        }

        // a block click is a voxel selection: shift toggles the voxel, plain replaces; a miss clears.
        if (activeTool === 'inspect' && selectTarget !== 'nodes') {
            const mk = client.input.mouseKeyboard;
            const shiftHeld = isKeyDown(mk, 'ShiftLeft') || isKeyDown(mk, 'ShiftRight');
            const cur = store.getState().selection;
            if (voxelHit && (voxelWins || selectTarget === 'voxels')) {
                const { voxelX, voxelY, voxelZ } = voxelHit;
                store
                    .getState()
                    .replaceSelection(
                        shiftHeld
                            ? Selection.withVoxelToggled(cur, voxelX, voxelY, voxelZ)
                            : Selection.ofVoxel(voxelX, voxelY, voxelZ),
                    );
            } else if (!shiftHeld && cur.chunks.size > 0) {
                store.getState().replaceSelection(Selection.nodesOnly(cur));
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
                if (hasNodeSelection) store.getState().clearNodeSelection();
                else if (Selection.countVoxels(store.getState().selection) > 0) store.getState().clearSelection();
            }
        } else if (activeTool === 'transform') {
            TransformTool.handleTransformKeys(mk, client.input, camera.quaternion, transformToolState, room.scene, ctx);
        }
    }

    // Inspect mesh update is hoisted out to editor/client.ts, so the selection
    // outline is drawn for every tool, not just inspect/transform.
}
