// editor/client.ts, the client half of the editor module: the per-player editor
// script (EditorTrait). Icons live in icons.ts, the room-session verbs in
// session.ts, the lens in lens.ts, the UI mount in ui/edit-ui.tsx. The server
// half is editor/server.ts; nothing here reaches server modules.

import { type PerspectiveCamera, unproject } from 'gpucat';
import type { Quat, Spherical, Vec3 } from 'math';
import { spherical, vec3 } from 'math';
import { CharacterControllerTrait } from '../builtins/character-controller';
import { FlyControllerTrait } from '../builtins/fly-controller';
import { OrbitControllerTrait } from '../builtins/orbit-controller';
import { PlayerControllerTrait } from '../builtins/player-controller';
import {
    getWorldPosition,
    getWorldQuaternion,
    resetInterpolation,
    setWorldPosition,
    setWorldQuaternion,
    TransformTrait,
} from '../builtins/transform';
import * as ClientChat from '../client/chat';
import { isKeyDown, isKeyJustDown, isModDown, isPointerCapturedByUi, isShiftDown } from '../client/input';
import { resolveRoomCamera } from '../client/rooms';
import { useClient } from '../client/ui/stores/client-store';
import { addTrait, getNodeById, getTrait, hasTrait, removeTrait } from '../core/scene/scene-tree';
import { isOwner, onDispose, onFrame, onInput, onPostPhysicsStep, onPrePhysicsStep, onTick, script } from '../core/scene/scripts';
import * as Selection from '../core/scene/selection';
import { createVoxelRaycastResult, raycastVoxels } from '../core/voxels/voxel-raycast';
import { env } from '../env';
import { initBlueprints } from './blueprints';
import { readNudgeDelta } from './camera';
import { installEditorChatCommands } from './chat-commands';
import { installSelectionChatCommands } from './chat-selection';
import { createClipboardHandlers } from './clipboard';
import type { ControlMode } from './edit-room-store';
import { createEditRoomStore } from './edit-room-store';
import { HOTBAR_NUMBER_KEYS, LIBRARY_KEYS, type ToolCategoryId } from './editor-controls';
import { useEditor } from './editor-store';
import { EditorTrait } from './editor-trait';
import { isInputFocused } from './input';
import { activeBlockKeyOf } from './inventory';
import { lensOf } from './lens';
import * as NodeBodies from './node-bodies';
import { createPointerState, disposePointerState, pointerFlush } from './pointer-state';
import { parsePattern } from './scene/pattern';
import { findCategoryByTool, TOOL_CATEGORIES } from './tool-categories';
import { clearBoxSelect, updateBoxSelect } from './tools/box-select';
import { createBrushState, updateBrush } from './tools/brush-build';
import { createBrushSelectState, updateBrushSelect } from './tools/brush-select';
import { updateBuild } from './tools/build';
import { createElevationState, updateElevation } from './tools/elevation';
import { openViewportContextMenu, updateInspect } from './tools/inspect';
import { clearLassoStroke, updateLassoSelect } from './tools/lasso-select';
import { updateMagicSelect } from './tools/magic-select';
import { createPainterState, updatePainter } from './tools/painter';
import { createSmoothState, updateSmooth } from './tools/smooth';
import * as TransformTool from './tools/transform';
import * as ChunkBoundsVisuals from './visuals/chunk-bounds-visuals';
import * as DebugVisuals from './visuals/debug-visuals';
import * as GridVisuals from './visuals/grid-visuals';
import * as InspectMesh from './visuals/inspect-mesh';
import * as PivotPoint from './visuals/pivot-point';
import * as PrefabVisuals from './visuals/prefab-visuals';
import {
    createSelectionMeshState,
    disposeSelectionMeshState,
    setSelectionMeshesVisible,
    updateSelectionMeshes,
} from './visuals/selection-mesh';

/* ── voxel raycast scratch state ── */

const MAX_RAY_DIST = 1024;
const _hoverRayResult = createVoxelRaycastResult();
const _nearWorld: Vec3 = [0, 0, 0];
const _farWorld: Vec3 = [0, 0, 0];
const _rayDir: Vec3 = [0, 0, 0];

// brush hover key cache, avoids allocating a new Selection.T every frame
let _brushHoverKey = '';
let _brushCornerA: [number, number, number] | null = null;
let _brushCornerB: [number, number, number] | null = null;

// per-player editor activation. EditorTrait attaches to:
//   - a player's server-owned `room.playerNode` in an edit room (server-
//     seeded on join, replicated to the owning client)
//   - the client-local lens node (lens.ts) spawned by Shift+`
//     into a play room (enterLocalEditorView)
//
// the trait's *presence* is the on/off switch, no parallel reactive flag,
// no imperative reconcile. attach → script body runs → editor is alive.
// detach (via RemoveTraitCommand on the player node, or destruction of the
// lens node) → onDispose tears it down. env.client gates server-side
// replicas to no-op.
script(
    EditorTrait,
    'editor',
    (ctx) => {
        if (!env.client) return;
        // server-attached EditorTrait on a player node replicates to *every*
        // client in the room (not just the owner). Gate on ownership so the
        // script only activates on the client that actually owns this node,
        // otherwise inspect-server would spin up the editor on the play
        // client too, registering under the wrong playerId. For lens-spawned
        // EditorTrait (Shift+`), the lens node is client-local with no
        // owner, so isOwner returns false; allow that path via the editor's
        // lens for this player.
        const lensRoom = ctx.client?.room;
        const lensActivation = lensRoom !== undefined && lensOf(lensRoom)?.subject === ctx.node;
        if (!lensActivation && !isOwner(ctx, ctx.node)) return;

        // wire up scene-list cold-fetch + HMR. idempotent, first room
        // to reach here arms the subscriptions for the whole process.
        initBlueprints();

        const client = ctx.client!;
        const room = client.room!;

        // ── voxel editor setup ──

        const canvas = client.state!.renderer.canvas;
        const pointer = createPointerState(canvas);
        const meshState = createSelectionMeshState(client.render.scene);
        const inspectMeshState = InspectMesh.init(client.render.scene);
        // forward-ref: the store references transformToolState in its
        // closures (paste/cut, placement pivot, …), and the gizmo
        // closures inside transformToolState read state.store on user
        // interaction. Create the tool first with a placeholder store,
        // then create the store, then patch transformToolState.store.
        // resolve the initial POV camera for the gizmo. TransformControls
        // holds its own camera ref internally; the per-frame sync below
        // (`transformToolState.gizmo.camera = camera`) keeps it pointing
        // at the active POV so swaps don't strand the gizmo on a stale ref.
        const initialCamera = resolveRoomCamera(client.state!.renderer.camera, room) as PerspectiveCamera;
        const transformToolState = TransformTool.createTransformTool(initialCamera, canvas, client.render.scene, room.scene, ctx);
        const store = createEditRoomStore({ ctx, room, transformToolState });
        transformToolState.store = store;
        const nodeBodies = NodeBodies.init(store);
        useEditor.getState().registerEditRoomStore(room, store);

        // per-room stroke state for the brush-family tools (active flag,
        // last centre, accumulating ops, preview keys). lives here rather
        // than module scope so two joined edit rooms keep independent strokes.
        // each tool owns its own State/create; that brush / brush-select /
        // smooth happen to share a stroke harness underneath is their detail.
        const brushState = createBrushState();
        const brushSelectState = createBrushSelectState();
        const painterState = createPainterState();
        const smoothState = createSmoothState();
        const elevationState = createElevationState();

        const pivotPoint = PivotPoint.create(client.render.scene);
        const debugVisualsState = DebugVisuals.init(client.render.scene);
        const gridVisualsState = GridVisuals.init(client.render.scene);
        const chunkBoundsState = ChunkBoundsVisuals.init(client.render.scene);
        const prefabVisuals = PrefabVisuals.init();

        // ── clipboard: copy / paste via system clipboard ──
        // page-level listeners (installed by mountEditUI) dispatch to the active
        // room's handlers through its edit store.
        store.setState({ clipboard: createClipboardHandlers(store, ctx, room, transformToolState) });

        // ── external-resource teardowns ──
        // on* hooks auto-clean with the script; this array is only for
        // resources that *don't* live in the script (chat command registry,
        // room-scoped state).
        const unsubs: Array<() => void> = [];

        // ── builtin slash commands (/set, undo, redo, help) ──
        installEditorChatCommands(room.chat, store, ctx, unsubs);
        installSelectionChatCommands(room.chat, store, ctx, room.physics, nodeBodies, unsubs);

        // //relight, client-side spec only; the listener lives on the
        // server. registered here so it disappears in play mode.
        ClientChat.registerCommand(room.chat, {
            name: '/relight',
            description: 'recompute all light propagation in this room',
            args: [],
        });
        unsubs.push(() => ClientChat.unregisterCommand(room.chat, '/relight'));

        // ── grab body PD + transform writeback ──
        // PD runs before physics integrates; writeback runs after
        // physics so Interpolation.snapshot+interpolate smooths the
        // body's pose between fixed-step ticks for render-rate
        // motion. no-op when grab isn't active.
        onPrePhysicsStep(ctx, () => {
            if (!TransformTool.isInGrab(transformToolState)) return;
            const camera = resolveRoomCamera(client.state!.renderer.camera, room) as PerspectiveCamera | null;
            if (!camera) return;
            TransformTool.prePhysicsGrab(transformToolState, room.physics, camera);
        });
        onPostPhysicsStep(ctx, () => {
            TransformTool.postPhysicsGrab(transformToolState, room.scene, room.physics);
        });

        // ── grab free-rotate input pre-pass ──
        // runs before player controllers' look-input on every frame.
        // when R is held during grab, mouse delta drives the held
        // body's rotation and is consumed (zeroed) so neither the
        // fly nor character controller swings the camera.
        onInput(ctx, () => {
            if (!TransformTool.isInGrab(transformToolState)) return;
            const camera = resolveRoomCamera(client.state!.renderer.camera, room) as PerspectiveCamera | null;
            if (!camera) return;
            const mk = client.input.mouseKeyboard;
            const grab = transformToolState.grab!;
            const isRot = isKeyDown(mk, 'KeyR');

            if (isRot && !grab.rotating) {
                TransformTool.beginRotate(transformToolState, room.physics);
            } else if (!isRot && grab.rotating) {
                TransformTool.endRotate(transformToolState, room.physics, camera);
            }

            if (grab.rotating) {
                TransformTool.applyRotateDelta(transformToolState, mk._dx, mk._dy, camera);
                // consume mouse delta so look hooks see no input
                mk._dx = 0;
                mk._dy = 0;
            }
        });

        // ── editor keyboard shortcuts ──
        // single dispatcher for every editor-only key/wheel binding. runs
        // as onInput so we land before fly/orbit/character controllers
        // consume the same mouse delta or wheel.
        //
        // chord-prefix pattern (V/M/B categories): tap-alone commits on
        // keyup; hold + digit jumps to a slot and suppresses the keyup
        // commit via a "consumed" flag. mirrors the convention that was
        // previously DOM-listener-based in client/ui/ui.tsx.
        let heldCategory: ToolCategoryId | null = null;
        let categoryConsumed = false;
        onInput(ctx, () => {
            const mk = client.input.mouseKeyboard;

            // cmd/ctrl combos (undo/redo etc.) are handled at the DOM layer
            // (edit-ui.tsx) so they fire while a tool-option input holds
            // focus. swallow them here so a held modifier doesn't trigger
            // letter-key tool shortcuts.
            if (isModDown(mk)) return;

            // ── backtick: toggle the debug dashboard ──
            if (isKeyJustDown(mk, 'Backquote')) {
                useClient.getState().toggleDebugOpen();
            }

            // ── tool category chord (V/M/B + digit jump, tap to cycle) ──
            if (heldCategory === null) {
                for (const cat of TOOL_CATEGORIES) {
                    if (isKeyJustDown(mk, cat.key)) {
                        heldCategory = cat.id;
                        categoryConsumed = false;
                        break;
                    }
                }
            }
            if (heldCategory !== null) {
                const cat = TOOL_CATEGORIES.find((c) => c.id === heldCategory)!;
                if (isKeyDown(mk, cat.key)) {
                    for (let i = 0; i < HOTBAR_NUMBER_KEYS.length; i++) {
                        if (isKeyJustDown(mk, HOTBAR_NUMBER_KEYS[i]!)) {
                            if (i < cat.tools.length) {
                                store.getState().setActiveTool(cat.tools[i]!.id);
                                categoryConsumed = true;
                            }
                            break;
                        }
                    }
                } else {
                    // category key released, commit cycle if not consumed
                    if (!categoryConsumed) {
                        const s = store.getState();
                        const currentCat = findCategoryByTool(s.activeTool);
                        if (currentCat?.id === cat.id) {
                            const idx = cat.tools.findIndex((t) => t.id === s.activeTool);
                            const next = cat.tools[(idx + 1) % cat.tools.length]!;
                            s.setActiveTool(next.id);
                        } else {
                            s.setActiveTool(cat.tools[0]!.id);
                        }
                    }
                    heldCategory = null;
                    categoryConsumed = false;
                }
            }

            // ── library toggle (E) ──
            if (isKeyJustDown(mk, LIBRARY_KEYS.toggleLibrary)) {
                store.getState().toggleLibrary();
            }

            // ── hotbar 1..9 (suppressed while a chord prefix is held) ──
            if (heldCategory === null) {
                for (let i = 0; i < HOTBAR_NUMBER_KEYS.length; i++) {
                    if (isKeyJustDown(mk, HOTBAR_NUMBER_KEYS[i]!)) {
                        const s = store.getState();
                        if (s.libraryOpen && s.hoveredInventoryItem) {
                            useEditor.getState().setHotbarSlot(i, s.hoveredInventoryItem);
                        } else {
                            s.setActiveSlot(i);
                        }
                        break;
                    }
                }
            }

            // ── wheel cycles hotbar slot in build/brush tools ──
            // grab handles its own wheel inside transform; fly/orbit
            // see only what we don't consume here. brush is included
            // because the active slot resolves $active in patterns.
            // skip while a UI overlay (library, etc.) holds the pointer so a
            // scroll inside an open panel scrolls it instead of cycling slots.
            const wheelTool = store.getState().activeTool;
            if (
                (wheelTool === 'build' || wheelTool === 'brush') &&
                mk._wheelDeltaY !== 0 &&
                !isPointerCapturedByUi(mk) &&
                !TransformTool.isInGrab(transformToolState)
            ) {
                store.getState().cycleActiveSlot(Math.sign(mk._wheelDeltaY));
                mk._wheelDeltaY = 0;
            }
        });

        // ── per-frame voxel tool update ──
        onFrame(ctx, () => {
            // mirror the runtime's scene revision into the store. the hierarchy and
            // inspector re-derive off it; nothing announces a mutation by hand.
            const sceneRevision = room.scene.replication.versionCounter;
            if (sceneRevision !== store.getState().sceneRevision) store.setState({ sceneRevision });

            // mirror the fly controller's speed off its trait for the indicator. the
            // first read seeds silently; a later change (wheel, inspector) re-arms the
            // indicator's show timer.
            const fly = getTrait(lensOf(room)?.subject ?? room.playerNode, FlyControllerTrait);
            if (fly && fly.speed !== store.getState().flySpeed) {
                const seeded = store.getState().flySpeed !== null;
                store.setState({ flySpeed: fly.speed, flySpeedShownAt: seeded ? performance.now() : 0 });
            }

            // editor visuals + tool dispatch only run when POV is the
            // editor's camera. for play rooms, that means the lens is up
            // AND the user is on the inspect-client sub-tab (client.subject
            // is the lens). for edit rooms, the player node IS the editor
            // camera. when not active, force-hide every editor visual so
            // they don't leak into the player view, and short-circuit.
            const lens = lensOf(room);
            const editorViewActive = room.playerMode === 'edit' || (lens !== null && room.client.subject === lens.subject);

            // tear down any armed placement the moment we're not actively placing
            // in the transform tool with the editor view focused. this runs BEFORE
            // the editorViewActive short-circuit below so a play/POV swap mid
            // placement can't leave the preview ghosts armed (cancelPlacement was
            // otherwise only reachable while still in transform with the view up).
            if (transformToolState.placement && (!editorViewActive || store.getState().activeTool !== 'transform')) {
                TransformTool.cancelPlacement(transformToolState, ctx);
            }
            // backstop: reap orphaned ghost nodes if any path dropped the
            // placement without a clean teardown. no-op in the common case.
            TransformTool.reconcilePlacementGhosts(transformToolState);

            // hide through each visual's own visibility, not by writing
            // `mesh.visible` behind its back: the two go out of sync and the
            // overlay stays hidden once the view comes back.
            if (!editorViewActive) {
                gridVisualsState.minorLines.visible = false;
                gridVisualsState.majorLines.visible = false;
                gridVisualsState.xAxisLines.visible = false;
                gridVisualsState.zAxisLines.visible = false;
                debugVisualsState.mesh.visible = false;
                chunkBoundsState.lines.visible = false;
                PivotPoint.setVisible(pivotPoint, false);
                if (inspectMeshState.mesh) inspectMeshState.mesh.visible = false;
                setSelectionMeshesVisible(meshState, false);
                const helper = transformToolState.gizmo.getHelper?.();
                if (helper) (helper as { visible: boolean }).visible = false;
                return;
            }

            setSelectionMeshesVisible(meshState, true);

            // resolve the active POV camera once; tools read this for
            // raycasts, nudge basis, build/inspect projection. also patch
            // it into the gizmo so a POV swap (player ↔ editor freecam)
            // is reflected in the gizmo's projection without rebuilding.
            // TransformControls is third-party and holds its own camera
            // ref, there's no way to avoid this sync.
            const camera = resolveRoomCamera(client.state!.renderer.camera, room) as PerspectiveCamera | null;
            if (!camera) return;
            transformToolState.gizmo.camera = camera;

            // shared render clock, threaded into the rainbow selection/inspect
            // materials (by node identity at material-build time) so they flow
            // with the rest of the engine's time-driven animation.
            const timeResources = client.state!.renderer.time;

            // sync editor node bodies with the scene tree for broadphase queries
            NodeBodies.update(nodeBodies, room.physics, room.scene, store, client.state!.resources);

            // redraw the per-node selection AABB outlines. called from
            // every tool's exit path so node selection is visible whether
            // the user is in inspect, transform, or any voxel tool.
            // during voxel-placement, the placement root has no geometry,
            // swap in the ghost's voxel node so the box reflects content.
            function redrawInspectMesh() {
                const selectedNodeIds = store.getState().selection.nodes;
                const placement = transformToolState.placement;
                const selectedNodes = [];
                for (const nid of selectedNodeIds) {
                    if (placement && nid === placement.rootNode.id && placement.voxelNode) {
                        selectedNodes.push(placement.voxelNode);
                        continue;
                    }
                    const n = getNodeById(room.scene, nid);
                    if (n) selectedNodes.push(n);
                }
                InspectMesh.update(inspectMeshState, selectedNodes, client.state!.resources, timeResources);
            }

            // update prefab ghost voxels for nodes whose def produces voxels
            PrefabVisuals.update(prefabVisuals, room.scene, room.context, ctx.voxels.registry);

            const { activeTool } = store.getState();

            // hover raycast, always active regardless of tool.
            // pointer.ndcX/Y is auto-frozen to (0,0) under pointer
            // lock, so this implicitly fires from the crosshair.
            unproject(_nearWorld, [pointer.ndcX, pointer.ndcY, 0], camera);
            unproject(_farWorld, [pointer.ndcX, pointer.ndcY, 1], camera);
            vec3.subtract(_rayDir, _farWorld, _nearWorld);
            vec3.normalize(_rayDir, _rayDir);
            raycastVoxels(
                _hoverRayResult,
                ctx.voxels,
                ctx.blocks,
                _nearWorld[0],
                _nearWorld[1],
                _nearWorld[2],
                _rayDir[0],
                _rayDir[1],
                _rayDir[2],
                MAX_RAY_DIST,
                0,
            );
            let hoverVoxel: [number, number, number] | null = _hoverRayResult.hit
                ? [_hoverRayResult.voxelX, _hoverRayResult.voxelY, _hoverRayResult.voxelZ]
                : null;

            // tight collider-AABB for the hovered block, drives the hover
            // outline so it hugs the actual shape (slabs, stairs, fences)
            // instead of the full voxel cell. cube colliders (cid=0) and the
            // synthesized air-mode hover both fall back to the unit cube.
            let hoverAabb: [number, number, number, number, number, number] | null = null;
            if (_hoverRayResult.hit) {
                const sid = _hoverRayResult.stateId;
                const cid = ctx.blocks.colliderId[sid]!;
                const [vx, vy, vz] = hoverVoxel!;
                if (cid === 0) {
                    hoverAabb = [vx, vy, vz, vx + 1, vy + 1, vz + 1];
                } else {
                    const boxes = ctx.blocks.shapeAabbs[cid]!;
                    let nx = Infinity,
                        ny = Infinity,
                        nz = Infinity,
                        xx = -Infinity,
                        xy = -Infinity,
                        xz = -Infinity;
                    for (const b of boxes) {
                        if (b[0] < nx) nx = b[0];
                        if (b[1] < ny) ny = b[1];
                        if (b[2] < nz) nz = b[2];
                        if (b[3] > xx) xx = b[3];
                        if (b[4] > xy) xy = b[4];
                        if (b[5] > xz) xz = b[5];
                    }
                    hoverAabb = [vx + nx, vy + ny, vz + nz, vx + xx, vy + xy, vz + xz];
                }
            }

            // air mode: synthesize a hover position in empty space
            if (!hoverVoxel && store.getState().selectorMode === 'air') {
                const d = store.getState().airDistance;
                hoverVoxel = [
                    Math.floor(_nearWorld[0] + _rayDir[0] * d),
                    Math.floor(_nearWorld[1] + _rayDir[1] * d),
                    Math.floor(_nearWorld[2] + _rayDir[2] * d),
                ];
                hoverAabb = [
                    hoverVoxel[0],
                    hoverVoxel[1],
                    hoverVoxel[2],
                    hoverVoxel[0] + 1,
                    hoverVoxel[1] + 1,
                    hoverVoxel[2] + 1,
                ];
            }
            const hoverNormal: [number, number, number] | null = _hoverRayResult.hit
                ? [_hoverRayResult.nx, _hoverRayResult.ny, _hoverRayResult.nz]
                : hoverVoxel
                  ? [0, 1, 0]
                  : null;
            const hoverPoint: [number, number, number] | null = _hoverRayResult.hit
                ? [_hoverRayResult.px, _hoverRayResult.py, _hoverRayResult.pz]
                : null;
            store.setState((cur) => ({
                hoverVoxel,
                hoverNormal,
                hoverPoint,
                hoverAabb,
                lastHoverVoxel: hoverVoxel ?? cur.lastHoverVoxel,
            }));

            // debug collider visualization, runs every frame regardless of active tool.
            // the show* toggles are global (useEditor), shared across rooms.
            DebugVisuals.update(debugVisualsState, room.physics.rigid.world, useEditor.getState().showPhysicsColliders);

            // grid visualization
            GridVisuals.update(gridVisualsState, useEditor.getState().showGrid);

            // chunk-boundary wireframe overlay
            ChunkBoundsVisuals.update(chunkBoundsState, ctx.voxels, useEditor.getState().showChunkBoundaries);

            // force-release any active grab when we leave transform/grab.
            // covers tool switches and transformMode flips that happen
            // between frames, updateInspect won't fire to clean up
            // when the new tool isn't inspect/transform.
            if (TransformTool.isInGrab(transformToolState)) {
                const tm = store.getState().transformMode;
                if (activeTool !== 'transform' || tm !== 'grab') {
                    TransformTool.exitGrab(transformToolState, room.scene, room.physics, ctx);
                }
            }

            // inspect tool: cast ray on click to select nodes, clear voxel visuals
            if (activeTool === 'inspect' || activeTool === 'transform') {
                _brushHoverKey = '';
                _brushCornerA = null;
                _brushCornerB = null;
                updateInspect(
                    store,
                    activeTool,
                    client,
                    room,
                    ctx,
                    nodeBodies,
                    transformToolState,
                    pivotPoint,
                    meshState,
                    pointer,
                    camera,
                );
                redrawInspectMesh();
                return;
            }

            const mk = client.input.mouseKeyboard;

            // tool dispatch
            if (activeTool === 'build') {
                updateBuild(store, ctx, pointer, client.input, ctx.voxels, transformToolState, camera);
            }
            if (activeTool === 'box-select') {
                const boxNudge = !isInputFocused() ? readNudgeDelta(client.input, camera.quaternion) : null;
                const boxEnter = !isInputFocused() && isKeyJustDown(mk, 'Enter');
                updateBoxSelect(store, ctx, pointer, client.input, room.physics, nodeBodies, boxNudge, boxEnter);
            }
            if (activeTool === 'magic-select') {
                updateMagicSelect(store, pointer, client.input, ctx.voxels, ctx.blocks);
            }
            if (activeTool === 'lasso-select') {
                updateLassoSelect(store, pointer, client.input, camera, ctx.voxels, ctx.blocks, nodeBodies, room.scene);
            }
            // right-click context menu for dedicated selection tools.
            // inspect handles its own call inside updateInspect; build/
            // paint/brush/smooth/elevation + transform use right-click
            // for tool semantics (erase, place commit) so are skipped.
            if (activeTool === 'box-select' || activeTool === 'magic-select' || activeTool === 'lasso-select') {
                openViewportContextMenu(store, client, room, ctx, nodeBodies, pointer, camera);
            }
            if (activeTool === 'brush-select') {
                updateBrushSelect(brushSelectState, store, ctx, pointer, client.input, ctx.voxels);
            }
            if (activeTool === 'paint') {
                updatePainter(painterState, store, ctx, pointer, client.input, ctx.voxels);
            }
            if (activeTool === 'brush') {
                updateBrush(brushState, store, ctx, pointer, client.input, ctx.voxels);
            }
            if (activeTool === 'smooth') {
                updateSmooth(smoothState, store, ctx, pointer, client.input, ctx.voxels);
            }
            if (activeTool === 'elevation') {
                updateElevation(elevationState, store, ctx, pointer, client.input, ctx.voxels);
            }

            pointerFlush(pointer);

            // r = reset selection or cancel in-progress tool
            // (skipped while grab is active, R drives free-rotate there)
            const sBefore = store.getState();
            const hasSelection = !Selection.isEmpty(sBefore.selection);
            const hasInProgressTool = !!sBefore.boxSelect || !!sBefore.lasso;
            const hasInspectedVoxel = sBefore.inspectedVoxel !== null;
            if (
                (hasSelection || hasInProgressTool || hasInspectedVoxel) &&
                !isInputFocused() &&
                isKeyJustDown(mk, 'KeyR') &&
                !TransformTool.isInGrab(transformToolState)
            ) {
                clearBoxSelect(store);
                clearLassoStroke(store);
                if (hasSelection) {
                    store.setState({
                        selection: Selection.create(),
                        inspectedVoxel: null,
                    });
                } else if (hasInspectedVoxel) {
                    store.setState({ inspectedVoxel: null });
                }
            }

            // Escape → cascading cancel for selection tools
            if (!isInputFocused() && isKeyJustDown(mk, 'Escape')) {
                const sNow = store.getState();
                if (sNow.cursor || hasInProgressTool) {
                    // cancel keyboard cursor and/or any in-progress selection tool
                    clearBoxSelect(store);
                    clearLassoStroke(store);
                } else if (hasSelection) {
                    // clear voxel selection
                    store.setState({
                        selection: Selection.create(),
                        inspectedVoxel: null,
                    });
                } else if (hasInspectedVoxel) {
                    store.setState({ inspectedVoxel: null });
                } else {
                    // nothing active → fall back to inspect tool
                    store.setState({ activeTool: 'inspect' });
                }
            }

            // action shortcuts (only when a selection exists and no input is focused)
            if (!isInputFocused()) {
                const s = store.getState();
                const hotbar = useEditor.getState().hotbar;
                const activeBlockKey = activeBlockKeyOf(hotbar, s.activeSlotIndex);
                if (isKeyJustDown(mk, 'KeyF') && !isShiftDown(mk) && activeBlockKey) s.fill(parsePattern(activeBlockKey));
                if (isKeyJustDown(mk, 'Backspace')) s.delete();
                if (isKeyJustDown(mk, 'KeyF') && isShiftDown(mk) && activeBlockKey) s.replace(parsePattern(activeBlockKey));
            }

            // p = pick
            if (!isInputFocused() && isKeyJustDown(mk, 'KeyP')) {
                store.getState().pick();
            }

            // nudge committed selection with arrow keys + [ / ] (any selection tool, when no keyboard cursor active)
            const sNudge = store.getState();
            if (!sNudge.cursor && !sNudge.boxSelect && !Selection.isEmpty(sNudge.selection) && !isInputFocused()) {
                const nudge = readNudgeDelta(client.input, camera.quaternion);
                if (nudge) {
                    const [dx, dy, dz] = nudge;
                    const next = Selection.create();
                    Selection.nudge(next, sNudge.selection, dx, dy, dz);
                    store.setState({ selection: next });
                }
            }

            // build brush selection each frame.
            // lasso has its own screen-space overlay, suppress the
            // world-space hover brush so it doesn't add visual noise.
            if (activeTool === 'lasso-select') {
                if (store.getState().brush !== null) {
                    store.setState({ brush: null });
                    _brushHoverKey = '';
                    _brushCornerA = null;
                    _brushCornerB = null;
                }
                updateSelectionMeshes(meshState, store.getState(), timeResources);
                redrawInspectMesh();
                return;
            }
            // brush + paint + smooth + elevation drive state.brush
            // themselves (shape-at-hover preview when idle, accumulated
            // stroke during drag), skip the single-voxel / box logic below.
            if (
                activeTool === 'brush' ||
                activeTool === 'brush-select' ||
                activeTool === 'paint' ||
                activeTool === 'smooth' ||
                activeTool === 'elevation'
            ) {
                _brushHoverKey = '';
                _brushCornerA = null;
                _brushCornerB = null;
                updateSelectionMeshes(meshState, store.getState(), timeResources);
                redrawInspectMesh();
                return;
            }

            const sBrush = store.getState();
            const boxSelect = sBrush.boxSelect;
            if (boxSelect?.previewB) {
                const [ax, ay, az] = boxSelect.cornerA;
                const [bx, by, bz] = boxSelect.previewB;
                const prevBrush = sBrush.brush;
                const sameAsLast =
                    prevBrush !== null &&
                    _brushCornerA !== null &&
                    _brushCornerB !== null &&
                    _brushCornerA[0] === ax &&
                    _brushCornerA[1] === ay &&
                    _brushCornerA[2] === az &&
                    _brushCornerB[0] === bx &&
                    _brushCornerB[1] === by &&
                    _brushCornerB[2] === bz;
                if (!sameAsLast) {
                    _brushCornerA = [ax, ay, az];
                    _brushCornerB = [bx, by, bz];
                    _brushHoverKey = '';
                    const sel = Selection.create();
                    Selection.setAABB(
                        sel,
                        Math.min(ax, bx),
                        Math.min(ay, by),
                        Math.min(az, bz),
                        Math.max(ax, bx),
                        Math.max(ay, by),
                        Math.max(az, bz),
                    );
                    store.setState({ brush: sel });
                }
            } else {
                // show single-voxel brush at keyboard cursor (if active) or mouse hover
                const brushVoxel = sBrush.cursor ?? sBrush.hoverVoxel;
                const hoverKey = brushVoxel ? `${brushVoxel[0]},${brushVoxel[1]},${brushVoxel[2]}` : '';
                if (hoverKey !== _brushHoverKey) {
                    _brushHoverKey = hoverKey;
                    _brushCornerA = null;
                    _brushCornerB = null;
                    if (brushVoxel) {
                        const sel = Selection.create();
                        Selection.set(sel, brushVoxel[0], brushVoxel[1], brushVoxel[2]);
                        store.setState({ brush: sel });
                    } else {
                        store.setState({ brush: null });
                    }
                }
            }

            updateSelectionMeshes(meshState, store.getState(), timeResources);
            redrawInspectMesh();
        });

        // controller swap, reconcile attached trait vs desired control mode each tick.
        // targets the local editor node when a lens is up (Shift+` peek into a play room),
        // else the player node (edit-mode flow).
        //
        // controllers each own their own camera node (created in onInit, destroyed
        // in onDispose). naïve swap snaps pose back to whatever default the incoming
        // controller seeds; we want the user's view preserved. snapshot the outgoing
        // camera-node pose, swap, then:
        //   1. write pose back onto the new camera node, fly's tick rebases off this,
        //      and player's edit-mode tick derives cc.look off it.
        //   2. seed any per-controller closure state that doesn't fall out of (1):
        //      - orbit: its focal point. derive `target = camPos + forward * 5` so it
        //        orbits about a point in front of where the camera is looking instead
        //        of snapping back to origin.
        //      - character: in edit mode, place the body at camera-pos - eyeHeight and
        //        snap interp so the body doesn't lerp from its prior location.
        const _snapPos: Vec3 = [0, 0, 0];
        const _snapQuat: Quat = [0, 0, 0, 1];
        const _seedBodyPos: Vec3 = [0, 0, 0];
        const _seedBackward: Vec3 = [0, 0, 0];
        const _seedSph: Spherical = [0, 0, 0];
        const ORBIT_TAKEOVER_DISTANCE = 5;
        const snapshotCameraPose = (): boolean => {
            const t = getTrait(room.client.camera, TransformTrait);
            if (!t) return false;
            const p = getWorldPosition(t);
            const q = getWorldQuaternion(t);
            _snapPos[0] = p[0];
            _snapPos[1] = p[1];
            _snapPos[2] = p[2];
            _snapQuat[0] = q[0];
            _snapQuat[1] = q[1];
            _snapQuat[2] = q[2];
            _snapQuat[3] = q[3];
            return true;
        };
        const writeCameraPose = (): void => {
            const t = getTrait(room.client.camera, TransformTrait);
            if (!t) return;
            setWorldPosition(t, _snapPos);
            setWorldQuaternion(t, _snapQuat);
        };
        // forward = quat * [0,0,-1]; pulled out so character + orbit seeds share it.
        const writeForwardFromSnapQuat = (out: Vec3): void => {
            const qx = _snapQuat[0],
                qy = _snapQuat[1],
                qz = _snapQuat[2],
                qw = _snapQuat[3];
            out[0] = -2 * (qx * qz + qw * qy);
            out[1] = -2 * (qy * qz - qw * qx);
            out[2] = -(1 - 2 * (qx * qx + qy * qy));
        };
        onTick(ctx, () => {
            const node = lensOf(room)?.subject ?? room.playerNode;
            const desiredMode = store.getState().controlMode;

            let activeMode: ControlMode | null = null;
            if (hasTrait(node, FlyControllerTrait)) activeMode = 'fly';
            else if (hasTrait(node, OrbitControllerTrait)) activeMode = 'orbit';
            else if (hasTrait(node, CharacterControllerTrait)) activeMode = 'character';

            if (activeMode === desiredMode) return;

            const hadPose = snapshotCameraPose();

            if (desiredMode === 'fly') {
                if (hasTrait(node, OrbitControllerTrait)) removeTrait(node, OrbitControllerTrait);
                if (hasTrait(node, PlayerControllerTrait)) removeTrait(node, PlayerControllerTrait);
                if (hasTrait(node, CharacterControllerTrait)) removeTrait(node, CharacterControllerTrait);
                addTrait(node, FlyControllerTrait);
            } else if (desiredMode === 'orbit') {
                if (hasTrait(node, FlyControllerTrait)) removeTrait(node, FlyControllerTrait);
                if (hasTrait(node, PlayerControllerTrait)) removeTrait(node, PlayerControllerTrait);
                if (hasTrait(node, CharacterControllerTrait)) removeTrait(node, CharacterControllerTrait);
                addTrait(node, OrbitControllerTrait);
            } else {
                if (hasTrait(node, FlyControllerTrait)) removeTrait(node, FlyControllerTrait);
                if (hasTrait(node, OrbitControllerTrait)) removeTrait(node, OrbitControllerTrait);
                // CC first so PlayerController can find it in onInit
                if (!hasTrait(node, CharacterControllerTrait)) addTrait(node, CharacterControllerTrait);
                if (!hasTrait(node, PlayerControllerTrait)) addTrait(node, PlayerControllerTrait);
            }

            if (!hadPose) return;
            writeCameraPose();

            if (desiredMode === 'orbit') {
                const orbit = getTrait(node, OrbitControllerTrait);
                if (orbit) {
                    writeForwardFromSnapQuat(_seedBodyPos);
                    orbit.target[0] = _snapPos[0] + _seedBodyPos[0] * ORBIT_TAKEOVER_DISTANCE;
                    orbit.target[1] = _snapPos[1] + _seedBodyPos[1] * ORBIT_TAKEOVER_DISTANCE;
                    orbit.target[2] = _snapPos[2] + _seedBodyPos[2] * ORBIT_TAKEOVER_DISTANCE;
                }
            } else if (desiredMode === 'character') {
                const pc = getTrait(node, PlayerControllerTrait);
                const cc = getTrait(node, CharacterControllerTrait);
                const transform = getTrait(node, TransformTrait);
                if (pc && cc && transform) {
                    // seed the body under the snapshot eye, so the player
                    // camera (head = body + eyeHeight) lands on the prior pose.
                    _seedBodyPos[0] = _snapPos[0];
                    _seedBodyPos[1] = _snapPos[1] - cc.config.eyeHeight;
                    _seedBodyPos[2] = _snapPos[2];
                    setWorldPosition(transform, _seedBodyPos);
                    resetInterpolation(node);
                    transform.teleport++;

                    // seed look from the snapshot orientation so the player
                    // camera reproduces it. fwd(look) = -toVec3(look), and
                    // the camera's backward axis (+Z) fed through setFromVec3
                    // yields look with fwd(look) = camera-forward.
                    const qx = _snapQuat[0],
                        qy = _snapQuat[1],
                        qz = _snapQuat[2],
                        qw = _snapQuat[3];
                    _seedBackward[0] = 2 * (qx * qz + qw * qy);
                    _seedBackward[1] = 2 * (qy * qz - qw * qx);
                    _seedBackward[2] = 1 - 2 * (qx * qx + qy * qy);
                    spherical.setFromVec3(_seedSph, _seedBackward);
                    cc.input.look[1] = _seedSph[1];
                    cc.input.look[2] = _seedSph[2];

                    // editor character mode starts in free-fly with the
                    // double-tap-Space toggle armed (desktop) and the on-screen
                    // fly/walk toggle button shown (touch).
                    cc.input.noclip = true;
                    pc.controls.desktop.doubleTapNoclip = true;
                    pc.controls.touch.flyToggleButton = true;
                }
            }
        });

        onDispose(ctx, () => {
            for (const u of unsubs) u();
            useEditor.getState().registerEditRoomStore(room, null);
            // a lens whose node died under a scene rebuild (a resync) is gone with
            // it; exitLocalEditorView already dropped it on the explicit path.
            if (lensActivation) useEditor.getState().setLens(room.playerId, null);

            // clean up node bodies
            NodeBodies.dispose(nodeBodies, room.physics);
            // clean up transform tool
            TransformTool.disposeTransformTool(transformToolState);
            PivotPoint.dispose(pivotPoint);
            // clean up voxel editor resources
            disposePointerState(canvas, pointer);
            disposeSelectionMeshState(meshState);
            InspectMesh.dispose(inspectMeshState);
            DebugVisuals.dispose(debugVisualsState, client.render.scene);
            GridVisuals.dispose(gridVisualsState, client.render.scene);
            ChunkBoundsVisuals.dispose(chunkBoundsState, client.render.scene);
            PrefabVisuals.dispose(prefabVisuals);
        });
    },
    { editor: true },
);
