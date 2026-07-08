// inspect.ts, per-frame update for the inspect and transform tools.
//
// handles:
//   - gizmo + pivot point sync (transform mode)
//   - click-to-select raycasting (node + voxel)
//   - keyboard shortcuts (inspect: Q/T/Y/Escape; transform: delegated to handleTransformKeys)
//   - inspect bounding box mesh update

import { type PerspectiveCamera, unproject } from 'gpucat';
import { vec3 } from 'mathcat';
import { TransformTrait } from '../../builtins/transform';
import { isKeyDown, isKeyJustDown, isMouseJustDown, isMouseTap } from '../../client/input';
import type { ClientRoom } from '../../client/rooms';
import type { Node } from '../../core/scene/scene-tree';
import { getTrait, isAncestorOf } from '../../core/scene/scene-tree';
import type { ClientContext, ScriptContext } from '../../core/scene/scripts';
import * as Selection from '../../core/scene/selection';
import { getBlock } from '../../core/voxels/voxels';
import type { EditRoomStoreApi } from '../edit-room-store';
import { INSPECT_KEYS } from '../editor-controls';
import { useEditor } from '../editor-store';
import { isInputFocused } from '../input';
import type { NodeBodies } from '../node-bodies';
import type { PointerState } from '../pointer-state';
import { pointerFlush, pointerHeld, pointerJustDown, pointerJustUp } from '../pointer-state';
import * as Selector from '../selector';
import type { State as PivotPoint } from '../visuals/pivot-point';
import * as PivotPointMod from '../visuals/pivot-point';
import type { SelectionMeshState } from '../visuals/selection-mesh';
import { updateSelectionMeshes } from '../visuals/selection-mesh';
import type { TransformToolState } from './transform';
import * as TransformTool from './transform';

/**
 * resolve which node to actually select when clicking a node.
 * builds the chain of TransformTrait-bearing ancestors from the topmost
 * (under sceneRoot) down to the hit node. first click selects the
 * topmost; each subsequent click on an already-selected member of the
 * chain drills down one tier toward the leaf.
 */
function resolveSelectionTarget(hitNode: Node, selectedNodeIds: Set<number>, sceneRoot: Node): Node {
    const chain: Node[] = [];
    let cur: Node | null = hitNode;
    while (cur && cur !== sceneRoot) {
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

/**
 * right-click tap → raycast, refine selection, open viewport context menu at
 * the cursor. callers gate by activeTool, wired in inspect + the dedicated
 * selection tools (box/magic/lasso-select) where right-click is otherwise
 * unused. drags are filtered out: only fires on release if the press never
 * crossed the input layer's drag threshold.
 */
export function openViewportContextMenu(
    store: EditRoomStoreApi,
    client: ClientContext,
    room: ClientRoom,
    ctx: ScriptContext,
    nodeBodies: NodeBodies,
    pointer: PointerState,
    camera: PerspectiveCamera,
): void {
    if (!isMouseTap(client.input.mouseKeyboard, 'right')) return;
    if (document.pointerLockElement) return;

    unproject(_nearWorld, [pointer.ndcX, pointer.ndcY, 0], camera);
    unproject(_farWorld, [pointer.ndcX, pointer.ndcY, 1], camera);
    vec3.subtract(_rayDir, _farWorld, _nearWorld);
    vec3.normalize(_rayDir, _rayDir);

    const hits = Selector.castRay(
        room.physics,
        nodeBodies,
        room.nodes,
        ctx.voxels,
        _nearWorld[0],
        _nearWorld[1],
        _nearWorld[2],
        _rayDir[0],
        _rayDir[1],
        _rayDir[2],
        MAX_RAY_DIST,
    );

    const playerNode = room.playerNode;
    const editorNode = room.editor?.subject;
    const nodeHit = hits.find(
        (h): h is Selector.NodeHit =>
            h.kind === 'node' && h.node !== playerNode && !isAncestorOf(playerNode, h.node) && h.node !== editorNode,
    );
    const voxelHit = hits.find((h): h is Selector.VoxelHit => h.kind === 'voxel');
    const voxelWins = voxelHit !== undefined && (nodeHit === undefined || voxelHit.distance < nodeHit.distance);

    const s = store.getState();
    let shouldOpen = false;

    if (!voxelWins && nodeHit) {
        // right-click on a node: if it isn't part of the current selection,
        // make it the selection (topmost transform-bearing ancestor, no drill-down
        // on right-click; menu acts on whatever the user sees highlighted).
        let target: Node = nodeHit.node;
        let cur: Node | null = nodeHit.node.parent;
        while (cur && cur !== room.nodes.root) {
            if (getTrait(cur, TransformTrait)) target = cur;
            cur = cur.parent;
        }
        if (!s.selection.nodes.has(target.id)) {
            s.selectNode(target.id);
        }
        shouldOpen = true;
    } else if (voxelWins && Selection.countVoxels(s.selection) > 0) {
        shouldOpen = true;
    } else if (s.selection.nodes.size > 0 || Selection.countVoxels(s.selection) > 0) {
        shouldOpen = true;
    }

    if (shouldOpen) {
        s.openViewportContextMenu(pointer.screenX, pointer.screenY);
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
    pivotPoint: PivotPoint,
    meshState: SelectionMeshState,
    pointer: PointerState,
    camera: PerspectiveCamera,
): void {
    // place-mode-with-selection cursor follow is a non-destructive preview:
    // confirm (click) commits with a history entry; any other exit (mode-key,
    // escape, tool change, selection cleared) reverts to the snapshot positions.
    if (transformToolState.placeSnapshots !== null) {
        const s0 = store.getState();
        const stillActive = activeTool === 'transform' && s0.transformMode === 'place' && s0.selection.nodes.size > 0;
        if (!stillActive) {
            TransformTool.revertPlaceSelection(transformToolState, room.nodes);
        }
    }

    // snapshot hover state before we clear it, used by transform placement raycast
    const s = store.getState();
    const hoverVoxelAtFrame = s.hoverVoxel;
    const hoverNormalAtFrame = s.hoverNormal;
    const hoverPointAtFrame = s.hoverPoint;

    // inspect/transform suppress the voxel tool path entirely: clear hover,
    // brush, in-progress box-select, and drop any voxel chunks while keeping
    // the node selection intact.
    const dirty = s.hoverVoxel !== null || s.boxSelect !== undefined || s.brush !== null || s.selection.chunks.size > 0;
    if (dirty) {
        store.setState((cur) => ({
            hoverVoxel: null,
            hoverNormal: null,
            hoverPoint: null,
            lastHoverVoxel: hoverVoxelAtFrame ?? cur.lastHoverVoxel,
            boxSelect: undefined,
            brush: null,
            selection: cur.selection.chunks.size > 0 ? { chunks: new Map(), nodes: cur.selection.nodes } : cur.selection,
        }));
        updateSelectionMeshes(meshState, store.getState());
    }
    // clear inspected voxel when not in inspect tool
    if (activeTool !== 'inspect' && store.getState().inspectedVoxel !== null) {
        store.setState({ inspectedVoxel: null });
    }

    // update gizmo for transform tool + pivot point
    if (activeTool === 'transform') {
        // build-tool prefab placement loop: if the active hotbar slot no longer
        // matches the in-flight prefab placement, drop the lingering ghost and
        // bounce back to the build tool so its auto-enter can re-arm for the
        // new slot. placementContinuous is the marker that the placement was
        // started by the build tool (regular ctrl+v paste leaves it false).
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
                TransformTool.cancelPlacement(transformToolState, room.nodes, ctx);
                store.setState({ activeTool: 'build' });
            }
        }

        // refresh transformHasVoxels each frame so snapTo can be force-clamped
        // to 'corner' when voxel content is present (and the UI can disable the toggle).
        const hasVoxels = TransformTool.computeTransformHasVoxels(transformToolState, room.nodes);
        if (store.getState().transformHasVoxels !== hasVoxels) {
            store.setState({ transformHasVoxels: hasVoxels });
        }

        // in place mode, drive placement ghost from cursor raycast
        const { transformMode } = store.getState();
        if (transformMode === 'place' && hoverVoxelAtFrame && hoverNormalAtFrame) {
            TransformTool.updatePlacementFromRaycast(
                transformToolState,
                room.nodes,
                hoverVoxelAtFrame,
                hoverNormalAtFrame,
                hoverPointAtFrame,
            );
        }
        const pivotPos = TransformTool.updateTransformTool(transformToolState, room.nodes);
        PivotPointMod.update(pivotPoint, pivotPos ?? [0, 0, 0], pivotPos !== null);
    } else {
        TransformTool.detachGizmo(transformToolState);
        PivotPointMod.update(pivotPoint, [0, 0, 0], false);
    }

    // click-to-select: only when gizmo is not dragging
    const gizmoDragging = activeTool === 'transform' && transformToolState.dragging;
    const transformModeNow = store.getState().transformMode;
    const inPlaceMode = activeTool === 'transform' && transformModeNow === 'place';
    const inGrabMode = activeTool === 'transform' && transformModeNow === 'grab';
    const clicked = pointerJustDown(pointer, client.input);
    // right-click trigger is mode-aware, mirroring the build tool: when the
    // pointer is already locked (RMB unambiguous) fire on down for a snappy
    // commit; when the cursor is visible (fly / orbit) fire only on a tap,
    // a release that didn't cross the drag threshold, so a right-drag look
    // doesn't also commit the placement.
    const pointerLocked = !!document.pointerLockElement;
    const rightClicked = pointerLocked
        ? isMouseJustDown(client.input.mouseKeyboard, 'right')
        : isMouseTap(client.input.mouseKeyboard, 'right');

    // grab mode: hold LMB on a node to grab; release/blur to drop. clicks on
    // empty space are no-ops. tool/mode switch force-release happens in
    // editor/index.ts before this function runs.
    if (inGrabMode) {
        if (TransformTool.isInGrab(transformToolState)) {
            if (pointerJustUp(pointer, client.input) || !pointerHeld(pointer, client.input)) {
                TransformTool.exitGrab(transformToolState, room.nodes, room.physics, ctx);
            } else {
                TransformTool.updateGrab(transformToolState, client.input.mouseKeyboard);
            }
        } else if (clicked && !gizmoDragging) {
            unproject(_nearWorld, [pointer.ndcX, pointer.ndcY, 0], camera);
            unproject(_farWorld, [pointer.ndcX, pointer.ndcY, 1], camera);
            vec3.subtract(_rayDir, _farWorld, _nearWorld);
            vec3.normalize(_rayDir, _rayDir);
            const hits = Selector.castRay(
                room.physics,
                nodeBodies,
                room.nodes,
                ctx.voxels,
                _nearWorld[0],
                _nearWorld[1],
                _nearWorld[2],
                _rayDir[0],
                _rayDir[1],
                _rayDir[2],
                MAX_RAY_DIST,
            );
            const playerNode = room.playerNode;
            const editorNode = room.editor?.subject;
            const nodeHit = hits.find(
                (h): h is Selector.NodeHit =>
                    h.kind === 'node' && h.node !== playerNode && !isAncestorOf(playerNode, h.node) && h.node !== editorNode,
            );
            if (nodeHit) {
                // grab always targets the topmost transform-bearing ancestor,
                // no drill-down. drilling into subnodes mid-grab leads to
                // grabbing the wrong child of an already-selected parent.
                let target: Node = nodeHit.node;
                let cur: Node | null = nodeHit.node.parent;
                while (cur && cur !== room.nodes.root) {
                    if (getTrait(cur, TransformTrait)) target = cur;
                    cur = cur.parent;
                }
                store.getState().selectNode(target.id);
                TransformTool.enterGrab(transformToolState, target.id, room.nodes, room.physics, client.state!.resources, camera);
            }
        }
    }

    if (inPlaceMode && TransformTool.isInPlacement(transformToolState)) {
        if (rightClicked) {
            // right click → commit placement immediately
            TransformTool.commitPlacement(transformToolState, room.nodes, ctx.voxels, ctx);
        } else if (clicked) {
            // left click → pin ghost here, switch to translate gizmo for fine-tuning
            if (transformToolState.placement) transformToolState.placement.placed = true;
            store.setState({ transformMode: 'translate' });
        }
    } else if (inPlaceMode && store.getState().selection.nodes.size > 0) {
        // place mode driving plain selection (no placement ghost): clicks pin
        // the selection at its current cursor-driven position. left → switch to
        // translate for fine-tune; right → exit place mode (back to translate).
        if (clicked || rightClicked) {
            // explicit confirm, commit cursor-follow as a history entry
            TransformTool.commitPlaceSelection(transformToolState, room.nodes, ctx);
            store.setState({ transformMode: 'translate' });
        }
    } else if (clicked && !gizmoDragging && !inPlaceMode && !inGrabMode) {
        const { selectTarget } = store.getState();

        unproject(_nearWorld, [pointer.ndcX, pointer.ndcY, 0], camera);
        unproject(_farWorld, [pointer.ndcX, pointer.ndcY, 1], camera);
        vec3.subtract(_rayDir, _farWorld, _nearWorld);
        vec3.normalize(_rayDir, _rayDir);

        const hits = Selector.castRay(
            room.physics,
            nodeBodies,
            room.nodes,
            ctx.voxels,
            _nearWorld[0],
            _nearWorld[1],
            _nearWorld[2],
            _rayDir[0],
            _rayDir[1],
            _rayDir[2],
            MAX_RAY_DIST,
        );

        // exclude the local player node + descendants, and the editor lens node.
        const playerNode = room.playerNode;
        const editorNode = room.editor?.subject;

        // find the nearest node hit (excluding player) and nearest voxel hit.
        // hits are distance-sorted, use the nearest of each type, then let
        // distance arbitrate which one wins when both are present.
        const nodeHit = hits.find(
            (h): h is Selector.NodeHit =>
                h.kind === 'node' && h.node !== playerNode && !isAncestorOf(playerNode, h.node) && h.node !== editorNode,
        );
        const voxelHit = hits.find((h): h is Selector.VoxelHit => h.kind === 'voxel');

        // voxel wins if it's closer than the nearest node (or there's no node)
        const voxelWins = voxelHit !== undefined && (nodeHit === undefined || voxelHit.distance < nodeHit.distance);

        if (selectTarget !== 'voxels') {
            const rawHit = voxelWins ? null : (nodeHit ?? null);
            const selectedNode = rawHit
                ? resolveSelectionTarget(rawHit.node, store.getState().selection.nodes, room.nodes.root)
                : null;
            const mk = client.input.mouseKeyboard;
            const shiftHeld = isKeyDown(mk, 'ShiftLeft') || isKeyDown(mk, 'ShiftRight');
            const s = store.getState();
            if (shiftHeld && selectedNode) {
                // shift+click: toggle the clicked node in the selection
                if (s.selection.nodes.has(selectedNode.id)) {
                    s.removeFromSelection(selectedNode.id);
                } else {
                    s.addToSelection(selectedNode.id);
                }
            } else {
                s.selectNode(selectedNode ? selectedNode.id : null);
            }
        }

        // inspect tool: set inspected voxel on click
        if (activeTool === 'inspect' && selectTarget !== 'nodes') {
            if (voxelHit && (voxelWins || selectTarget === 'voxels')) {
                const key = getBlock(ctx.voxels, voxelHit.voxelX, voxelHit.voxelY, voxelHit.voxelZ);
                store.setState({
                    inspectedVoxel: {
                        wx: voxelHit.voxelX,
                        wy: voxelHit.voxelY,
                        wz: voxelHit.voxelZ,
                        key,
                    },
                });
            } else {
                store.setState({ inspectedVoxel: null });
            }
        }
    }

    // context menu is an inspect-tool concept; transform owns right-click
    // for its own semantics (place commit, grab exit).
    if (activeTool === 'inspect') {
        openViewportContextMenu(store, client, room, ctx, nodeBodies, pointer, camera);
    }

    pointerFlush(pointer);

    // keyboard shortcuts for tool switching (only when not typing in an input)
    if (!isInputFocused()) {
        const mk = client.input.mouseKeyboard;
        const hasNodeSelection = store.getState().selection.nodes.size > 0;

        if (activeTool === 'inspect') {
            if (hasNodeSelection) {
                // Q/T/Y from inspect → activate transform tool with that mode
                if (isKeyJustDown(mk, INSPECT_KEYS.toTranslate)) {
                    store.setState({ activeTool: 'transform', transformMode: 'translate' });
                } else if (isKeyJustDown(mk, INSPECT_KEYS.toRotate)) {
                    store.setState({ activeTool: 'transform', transformMode: 'rotate' });
                } else if (isKeyJustDown(mk, INSPECT_KEYS.toScale)) {
                    store.setState({ activeTool: 'transform', transformMode: 'scale' });
                }
            }

            // Escape → clear node selection, then inspected voxel
            if (isKeyJustDown(mk, 'Escape')) {
                if (hasNodeSelection) {
                    store.getState().clearSelection();
                } else if (store.getState().inspectedVoxel !== null) {
                    store.setState({ inspectedVoxel: null });
                }
            }
        } else if (activeTool === 'transform') {
            TransformTool.handleTransformKeys(mk, client.input, camera.quaternion, transformToolState, room.nodes, ctx);
        }
    }

    // (inspect mesh update is hoisted out, see editor/index.ts so the
    // selection outline is drawn for every tool, not just inspect/transform.)
}
