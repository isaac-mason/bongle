import { Object3D, type PerspectiveCamera, unproject } from 'gpucat';
import type { EulerOrder, Quat, Spherical, Vec3 } from 'math';
import { euler, spherical, vec3 } from 'math';
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
import type { EngineClient } from '../client/client';
import {
    getCursor,
    isKeyDown,
    isKeyJustDown,
    isModDown,
    isPointerCapturedByUi,
    isShiftDown,
    type MouseKeyboardInput,
} from '../client/input';
import { type ClientRoom, resolveRoomCamera } from '../client/rooms';
import { useClient } from '../client/ui/stores/client-store';
import { script } from '../core/registry';
import type { Node } from '../core/scene/scene-tree';
import { addTrait, getNodeById, getTrait, hasTrait, removeTrait } from '../core/scene/scene-tree';
import {
    type ClientContext,
    isOwner,
    onDispose,
    onFrame,
    onInput,
    onPostPhysicsStep,
    onPrePhysicsStep,
    onPreRender,
    onTick,
    type ScriptContext,
} from '../core/scene/scripts';
import * as Selection from '../core/scene/selection';
import { blockStateAabb } from '../core/voxels/block-registry';
import { createVoxelRaycastResult, raycastVoxels } from '../core/voxels/voxel-raycast';
import { chunkKey, toChunkCoord } from '../core/voxels/voxels';
import { env } from '../env';
import * as MarkerVisuals from '../render/markers/marker-visuals';
import * as Lines from '../render/overlay/lines';
import * as Quads from '../render/overlay/quads';
import * as Text from '../render/overlay/text';
import type { SpriteResources } from '../render/sprites/sprite-resources';
import * as Actions from './actions';
import { initBlueprints } from './blueprints';
import { readNudgeDelta } from './camera';
import { installEditorChatCommands } from './chat-commands';
import { installSelectionChatCommands } from './chat-selection';
import { createClipboardHandlers } from './clipboard';
import { type ControlMode, createEditRoomStore, type EditRoomStoreApi } from './edit-room-store';
import { CONTROL_MODE_KEYS, HOTBAR_NUMBER_KEYS, LIBRARY_KEYS, SELECTION_KEYS, type ToolCategoryId } from './editor-controls';
import { useEditor } from './editor-store';
import { EditorTrait } from './editor-trait';
import { isInputFocused } from './input';
import { activeBlockKeyOf } from './inventory';
import { lensOf } from './lens';
import * as NodeBodies from './node-bodies';
import { parsePattern } from './scene/pattern';
import * as Selector from './selector';
import { playDeselected } from './sounds';
import { findCategoryByTool, TOOL_CATEGORIES } from './tool-categories';
import { clearBoxSelect, updateBoxSelect } from './tools/box-select';
import { createBrushState, updateBrush } from './tools/brush-build';
import { createBrushSelectState, updateBrushSelect } from './tools/brush-select';
import { updateBuild } from './tools/build';
import { createElevationState, updateElevation } from './tools/elevation';
import * as Grab from './tools/grab';
import * as Handles from './tools/handles';
import {
    createRadialMenuState,
    openViewportContextMenu,
    type RadialMenuState,
    resolveSelectionTarget,
    updateInspect,
    updateRadialMenu,
} from './tools/inspect';
import { clearLassoStroke, lassoStrokeToWorldPoints, updateLassoSelect } from './tools/lasso-select';
import { updateMagicSelect } from './tools/magic-select';
import { createPainterState, updatePainter } from './tools/painter';
import * as Placement from './tools/placement';
import { createSmoothState, updateSmooth } from './tools/smooth';
import * as TransformTool from './tools/transform';
import * as ChunkBoundsVisuals from './visuals/chunk-bounds-visuals';
import * as DebugVisuals from './visuals/debug-visuals';
import * as GridVisuals from './visuals/grid-visuals';
import * as LassoVisuals from './visuals/lasso-visuals';
import * as NodeCard from './visuals/node-card';
import { LABEL_LIFT_PX, LABEL_SCALE } from './visuals/node-card';
import * as PivotPoint from './visuals/pivot-point';
import * as PrefabVisuals from './visuals/prefab-visuals';
import * as SelectionBox from './visuals/selection-box';
import {
    createSelectionMeshState,
    disposeSelectionMeshState,
    type SelectionMeshState,
    updateSelectionMeshes,
} from './visuals/selection-mesh';

type TimeResources = EngineClient['renderer']['time'];

const MAX_RAY_DIST = 1024;
const _hoverRayResult = createVoxelRaycastResult();
const _nearWorld: Vec3 = [0, 0, 0];
const _farWorld: Vec3 = [0, 0, 0];
const _rayDir: Vec3 = [0, 0, 0];
const _hoverNodeHits: Selector.NodeHit[] = [];
const _noEye: Vec3 = [0, 0, 0];
const _pinnedOwners = new Set<number>();

const _snapPos: Vec3 = [0, 0, 0];
const _snapQuat: Quat = [0, 0, 0, 1];
const _seedBodyPos: Vec3 = [0, 0, 0];
const _seedBackward: Vec3 = [0, 0, 0];
const _seedSph: Spherical = [0, 0, 0];

// EditorTrait attaches to a player's server-owned room.playerNode in an edit room, or the
// client-local lens node (lens.ts, Shift+`) in a play room. presence is the on/off switch:
// attach runs the script body, detach (RemoveTraitCommand or lens node destruction) tears it
// down via onDispose. env.client gates server-side replicas to no-op.
script(
    EditorTrait,
    'editor',
    (ctx) => {
        if (!env.client) return;
        // an edit-room EditorTrait replicates to every client in the room, so gate on
        // ownership; a lens-spawned EditorTrait is client-local with no owner, allow that path.
        const lensRoom = ctx.client?.room;
        const lensActivation = lensRoom !== undefined && lensOf(lensRoom)?.subject === ctx.node;
        if (!lensActivation && !isOwner(ctx, ctx.node)) return;

        // idempotent: first room to reach here arms the scene-list subscriptions for the whole process.
        initBlueprints();

        const s = openSession(ctx);
        const { client, room, store, transform } = s;

        // PD runs before physics integrates; writeback runs after so interpolation smooths
        // the body's pose between fixed-step ticks. no-op when grab isn't active.
        onPrePhysicsStep(ctx, () => {
            if (!Grab.isInGrab(s.grab)) return;
            const camera = povCamera(s);
            if (camera) Grab.prePhysicsGrab(s.grab, room.physics, camera);
        });
        onPostPhysicsStep(ctx, () => Grab.postPhysicsGrab(s.grab, room.scene, room.physics));

        // input pre-passes run before the fly/orbit/character controllers consume
        // the same mouse delta or wheel.
        onInput(ctx, () => updateGrabRotate(s));
        onInput(ctx, () => updateShortcuts(s.shortcuts, client.input.mouseKeyboard, store, s.grab));
        onInput(ctx, () => updateDeselectKey(s));
        onInput(ctx, () => updateRadialMenuForActiveTool(s));

        onFrame(ctx, () => {
            mirrorRuntimeState(s);

            const active = editorViewActive(room);
            // avoids leaving preview ghosts armed after a play/POV swap mid placement.
            if (s.placement.current && (!active || store.getState().activeTool !== 'transform')) {
                Placement.cancelPlacement(s.placement, ctx);
            }
            // backstop for any path that dropped the placement without a clean teardown.
            Placement.reconcilePlacementGhosts(s.placement);
            setEditorViewActive(s, active);
            if (!active) return;

            // gizmo is patched with the resolved camera each frame so a POV swap shows without a rebuild.
            const camera = povCamera(s);
            if (!camera) return;
            transform.gizmo.camera = camera;
            transform.gizmo.pickerScale = client.state!.inputManager.inputMode === 'touch' ? TOUCH_PICKER_SCALE : 1;
            const time = client.state!.renderer.time;

            NodeBodies.update(s.nodeBodies, room.visibility, room.scene, store);
            Actions.drainPendingShapeFits(store.getState(), ctx);
            // shape handles take the pointer first, then the gizmo: a press either claims sets
            // its drag state before the tools below read it, so neither click also selects.
            const canvas = client.state!.renderer.canvas;
            Handles.update(
                s.handles,
                handlesEnabled(store),
                client.input.mouseKeyboard,
                camera,
                canvas.clientWidth,
                canvas.clientHeight,
                room.scene,
                ctx,
                store,
            );
            if (!Handles.isEngaged(s.handles)) TransformTool.feedPointer(transform, client.input.mouseKeyboard);
            updateHover(client.input.mouseKeyboard, camera, ctx, store, s.nodeBodies, room);
            if (useEditor.getState().showMarkers) MarkerVisuals.update(s.markers, room.visibility);
            else MarkerVisuals.clear(s.markers, room.visibility);

            // covers tool switches and transformMode flips between frames, when updateInspect won't fire to clean up.
            const { activeTool } = store.getState();
            if (Grab.isInGrab(s.grab) && (activeTool !== 'transform' || store.getState().transformMode !== 'grab')) {
                Grab.exitGrab(s.grab, room.scene, room.physics, ctx);
            }

            if (activeTool === 'inspect' || activeTool === 'transform') {
                resetBrushPreview(s.brushPreview);
                updateInspect(
                    store,
                    activeTool,
                    client,
                    room,
                    ctx,
                    s.nodeBodies,
                    transform,
                    s.placement,
                    s.grab,
                    s.handles,
                    s.visuals.pivot,
                    s.visuals.selection,
                    camera,
                );
                return;
            }

            updateVoxelTools(s, camera);
            updateSelectionKeys(s, camera);
            updateBrushPreview(s.brushPreview, store, activeTool);
            updateSelectionMeshes(s.visuals.selection, store.getState(), time);
            const lassoState = store.getState().lasso;
            LassoVisuals.update(
                s.visuals.lasso,
                lassoState
                    ? lassoStrokeToWorldPoints(lassoState.points, camera.position, store.getState().lassoOptions.maxDistance)
                    : null,
            );
        });

        // everything drawn from node poses waits for the last writer of the frame: a script posing a
        // character in its own onFrame or onPostAnimate runs before this, so the overlays never trail it.
        onPreRender(ctx, () => {
            if (!s.viewActive) return;
            const camera = povCamera(s);
            if (!camera) return;
            const time = client.state!.renderer.time;
            const canvas = client.state!.renderer.canvas;
            updateWorldVisuals(s.visuals, s);
            Handles.draw(
                s.handles,
                handlesEnabled(store),
                camera,
                canvas.clientWidth,
                canvas.clientHeight,
                room.scene,
                store,
                s.visuals.quads,
                s.visuals.text,
            );
            TransformTool.layoutGizmo(transform);
            redrawInspectMesh(s.visuals, s, time);
            drawBrushBounds(s.visuals, s);
            endOverlays(s.visuals);
        });

        onTick(ctx, () => reconcileController(room, store));

        onDispose(ctx, () => {
            closeSession(s);
            // exitLocalEditorView drops the lens on the explicit path; this covers a lens node
            // that died under a scene rebuild (a resync).
            if (lensActivation) useEditor.getState().setLens(room.playerId, null);
        });
    },
    { editor: true },
);

type Session = {
    ctx: ScriptContext;
    client: ClientContext;
    room: ClientRoom;
    store: EditRoomStoreApi;
    transform: TransformTool.TransformToolState;
    placement: Placement.PlacementTool;
    grab: Grab.GrabTool;
    handles: Handles.HandlesState;
    nodeBodies: NodeBodies.NodeBodies;
    visuals: Visuals;
    markers: MarkerVisuals.MarkerVisuals;
    strokes: Strokes;
    shortcuts: Shortcuts;
    radialMenu: RadialMenuState;
    brushPreview: BrushPreview;
    /** `editorViewActive` for this frame, computed once in onFrame and read again in onPreRender. */
    viewActive: boolean;
    /** the brush `brushBounds` was measured from; the store hands out a fresh ref on every mutation. */
    brushBoundsOf: Selection.Selection | null;
    brushBounds: Selection.Bounds | null;
    /** teardowns for resources that don't live in the script (chat command
     *  registry, room-scoped state); on* hooks auto-clean with the script. */
    unsubs: Array<() => void>;
};

function openSession(ctx: ScriptContext): Session {
    const client = ctx.client!;
    const room = client.room!;
    // forward-ref: the store references the transform tool in its closures
    // (paste/cut, placement pivot, ...), and the gizmo closures inside the tool
    // read store on user interaction. Create the tool first with a placeholder
    // store, then the store, then patch transform.store. the initial POV camera
    // seeds the gizmo; the per-frame sync keeps it on the active POV.
    const initialCamera = resolveRoomCamera(client.state!.renderer.camera, room) as PerspectiveCamera;
    // created detached, and every editor overlay hangs off it; `setEditorViewActive` is the only
    // thing that puts it in the scene or takes it out. the gizmo goes under it like the rest.
    const overlayRoot = new Object3D();
    overlayRoot.name = 'editor-overlays';
    const transform = TransformTool.createTransformTool(initialCamera, overlayRoot, room.scene, ctx);
    const placement = Placement.init(transform);
    const store = createEditRoomStore({ ctx, room, placement });
    transform.store = store;
    placement.store = store;
    const nodeBodies = NodeBodies.init(store, room.physics);
    useEditor.getState().registerEditRoomStore(room, store);

    // clipboard: page-level listeners (installed by mountEditUI) dispatch to the
    // active room's handlers through its edit store.
    store.setState({ clipboard: createClipboardHandlers(store, ctx, room, placement) });

    const unsubs: Array<() => void> = [];
    // builtin slash commands (/set, undo, redo, help, selection ops).
    installEditorChatCommands(room.chat, store, ctx, unsubs);
    installSelectionChatCommands(room.chat, store, ctx, nodeBodies, unsubs);
    // /relight, client-side spec only; the listener lives on the server.
    // registered here so it disappears in play mode.
    ClientChat.registerCommand(room.chat, {
        name: '/relight',
        description: 'recompute all light propagation in this room',
        args: [],
    });
    unsubs.push(() => ClientChat.unregisterCommand(room.chat, '/relight'));

    return {
        ctx,
        client,
        room,
        store,
        transform,
        placement,
        grab: Grab.init(store),
        handles: Handles.init(),
        nodeBodies,
        visuals: initVisuals(overlayRoot),
        markers: MarkerVisuals.init(room.scene),
        strokes: initStrokes(),
        shortcuts: initShortcuts(),
        radialMenu: createRadialMenuState(),
        brushPreview: initBrushPreview(),
        viewActive: false,
        brushBoundsOf: null,
        brushBounds: null,
        unsubs,
    };
}

function closeSession(s: Session): void {
    for (const u of s.unsubs) u();
    useEditor.getState().registerEditRoomStore(s.room, null);
    NodeBodies.dispose(s.nodeBodies);
    TransformTool.disposeTransformTool(s.transform);
    MarkerVisuals.dispose(s.markers, s.room.visibility);
    disposeVisuals(s.visuals);
}

/** the active POV camera, or null when the room has no active POV. */
function povCamera(s: Session): PerspectiveCamera | null {
    return resolveRoomCamera(s.client.state!.renderer.camera, s.room) as PerspectiveCamera | null;
}

/** the sprite atlas and batch, absent until the renderer has loaded resources. */
function withSpriteResources(s: Session, fn: (sprite: SpriteResources) => void): void {
    const sprite = s.client.state!.renderer.atlases().sprite;
    if (sprite) fn(sprite);
}

/** editor visuals + tools only run when this room is the active room AND the POV
 *  is the editor's camera. for a play room that means the lens is up AND the
 *  user is on the inspect-client sub-tab (client.subject is the lens); for an
 *  edit room the player node IS the editor camera.
 *
 *  an inactive room's Input reads zero structurally (the engine routes DOM
 *  events only into the active room), so the active-room check here is about
 *  visuals and the gizmo, not about clicks leaking across rooms. */
function editorViewActive(room: ClientRoom): boolean {
    if (room.client.state!.rooms.activePlayerId !== room.playerId) return false;
    const lens = lensOf(room);
    return room.playerMode === 'edit' || (lens !== null && room.client.subject === lens.subject);
}

/** mirror runtime facts into the store for the UI: the scene revision (the
 *  hierarchy and inspector re-derive off it; nothing announces a mutation by
 *  hand) and the fly controller's speed (the first read seeds silently, a later
 *  change re-arms the indicator's show timer). */
function mirrorRuntimeState(s: Session): void {
    const { room, store } = s;
    const sceneRevision = room.scene.replication.versionCounter;
    if (sceneRevision !== store.getState().sceneRevision) store.setState({ sceneRevision });
    const inspected = store.getState().inspectedVoxel;
    if (inspected) {
        const chunk = room.voxels.chunks.get(
            chunkKey(toChunkCoord(inspected.wx), toChunkCoord(inspected.wy), toChunkCoord(inspected.wz)),
        );
        const voxelRevision = chunk ? chunk.version : 0;
        if (voxelRevision !== store.getState().voxelRevision) store.setState({ voxelRevision });
    }

    const fly = getTrait(lensOf(room)?.subject ?? room.playerNode, FlyControllerTrait);
    if (fly && fly.speed !== store.getState().flySpeed) {
        const seeded = store.getState().flySpeed !== null;
        store.setState({ flySpeed: fly.speed, flySpeedShownAt: seeded ? performance.now() : 0 });
    }
}

type Visuals = {
    /** every editor overlay hangs off this; the view gate attaches and detaches it, nothing else. */
    root: Object3D;
    selection: SelectionMeshState;
    lasso: LassoVisuals.LassoVisualsState;
    pivot: PivotPoint.State;
    debug: DebugVisuals.DebugVisualsState;
    grid: GridVisuals.GridVisualsState;
    chunkBounds: ChunkBoundsVisuals.ChunkBoundsVisualsState;
    prefabs: PrefabVisuals.PrefabVisuals;
    /** frame batches: cleared in `updateWorldVisuals`, uploaded in `endOverlays`. */
    lines: Lines.LineBatch;
    quads: Quads.QuadBatch;
    text: Text.TextBatch;
};

const LINE_CAPACITY = 100_000;
const LINE_WIDTH_PX = 5;
const QUAD_CAPACITY = 4096;
const TOUCH_PICKER_SCALE = 1.6;

/** `root` is the session's overlay root, already holding the transform gizmo. */
function initVisuals(root: Object3D): Visuals {
    const quads = Quads.init(root, QUAD_CAPACITY);
    return {
        root,
        selection: createSelectionMeshState(root),
        lasso: LassoVisuals.init(root),
        pivot: PivotPoint.create(root),
        debug: DebugVisuals.init(),
        grid: GridVisuals.init(root),
        chunkBounds: ChunkBoundsVisuals.init(root),
        prefabs: PrefabVisuals.init(),
        lines: Lines.init(root, LINE_CAPACITY, LINE_WIDTH_PX),
        quads,
        text: Text.init(quads),
    };
}

/** the single gate on the editor view. the overlay root carries every gpucat overlay, so
 *  detaching it hides all of them and drops the subtree out of the matrix walk too; the
 *  calls below it are the visuals that live in the node tree instead, which the root can't reach. */
function setEditorViewActive(s: Session, active: boolean): void {
    if (s.viewActive === active) return;
    s.viewActive = active;
    if (active) s.client.render.scene.add(s.visuals.root);
    else s.visuals.root.removeFromParent();
    // the gizmo only sees pointer input through `feedPointer`, which the inactive frame
    // never reaches; `enabled` is belt and braces for any path that still hit-tests.
    s.transform.gizmo.enabled = active;
    if (!active) MarkerVisuals.clear(s.markers, s.room.visibility);
}

/** the world-space overlays that follow the scene rather than the tool: prefab
 *  ghost voxels, and the debug / grid / chunk-boundary toggles (global, shared
 *  across rooms via useEditor). */
function handlesEnabled(store: EditRoomStoreApi): boolean {
    return useEditor.getState().showHandles && store.getState().activeTool === 'inspect';
}

function updateWorldVisuals(v: Visuals, s: Session): void {
    const { room, ctx } = s;
    // overlay sizes are authored in CSS pixels; taken from the canvas itself, so a backend that clamps the
    // device ratio is followed rather than second-guessed.
    const canvas = s.client.state!.renderer.canvas;
    const pixelRatio = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1;
    Lines.begin(v.lines, pixelRatio);
    Quads.begin(v.quads, pixelRatio);
    withSpriteResources(s, (sprite) => {
        Quads.bindAtlas(v.quads, sprite);
        Text.bind(v.text, sprite);
    });
    PrefabVisuals.update(v.prefabs, room.scene, room.context, ctx.voxels.registry);
    const toggles = useEditor.getState();
    const { showPhysicsColliders, showPhysicsContacts } = useClient.getState();
    DebugVisuals.update(v.debug, room.physics, showPhysicsColliders, showPhysicsContacts, v.lines, v.quads);
    GridVisuals.update(v.grid, toggles.showGrid);
    ChunkBoundsVisuals.update(v.chunkBounds, ctx.voxels, toggles.showChunkBoundaries);
}

/** redraw the per-node selection AABB outlines. called from every tool's exit
 *  path so node selection is visible whether the user is in inspect, transform,
 *  or any voxel tool. during voxel placement the placement root has no
 *  geometry, so the ghost's voxel node stands in so the box reflects content. */
function redrawInspectMesh(v: Visuals, s: Session, time: TimeResources): void {
    const selectedNodes = [];
    for (const nid of s.store.getState().selection.nodes) {
        const n = getNodeById(s.room.scene, nid);
        if (n) selectedNodes.push(n);
    }
    for (const node of selectedNodes) {
        if (node !== s.room.scene.root) SelectionBox.draw(v.lines, node, s.client.state!.resources, time.seconds);
    }
    // the placement ghost is a preview the transform tool owns, never selected: its box, no card.
    const placement = s.placement.current;
    if (placement) SelectionBox.draw(v.lines, placement.voxelNode ?? placement.rootNode, s.client.state!.resources, time.seconds);
    drawCards(v, s, selectedNodes);
    drawDragReadout(v, s);
}

// one pass over every node with a card: pinned markers, the selection, the hovered node.
function drawCards(v: Visuals, s: Session, selectedNodes: Node[]): void {
    const storeState = s.store.getState();
    const { showOutlines, showNames, showMarkers } = useEditor.getState();
    const toggles: NodeCard.CardToggles = { outlines: showOutlines, names: showNames };
    // the transform tool and a handle drag keep the shape outlines (the radius and box still read) and drop the text;
    // handles themselves are the inspect tool's.
    const transforming = storeState.activeTool === 'transform';
    const handling = s.handles.armed !== null;
    const selectedToggles: NodeCard.CardToggles = transforming || handling ? { ...toggles, names: false } : toggles;
    const batches: NodeCard.CardBatches = {
        lines: v.lines,
        quads: v.quads,
        text: v.text,
        sprite: s.client.state!.renderer.atlases().sprite,
    };
    const eye = povCamera(s)?.position ?? _noEye;
    const selectedIds = storeState.selection.nodes;
    const activeId = Selection.activeNode(storeState.selection);

    if (showMarkers) {
        _pinnedOwners.clear();
        for (const [marker] of MarkerVisuals.markers(s.markers)) {
            if (!marker.enabled) continue;
            const owner = NodeCard.ownerOf(marker._node);
            if (selectedIds.has(owner.id) || _pinnedOwners.has(owner.id)) continue;
            const transform = getTrait(owner, TransformTrait);
            if (!transform) continue;
            _pinnedOwners.add(owner.id);
            NodeCard.drawCard(batches, owner, transform, NodeCard.cardFor(owner), 'pinned', eye, toggles);
        }
    }
    for (const node of selectedNodes) {
        const transform = getTrait(node, TransformTrait);
        if (!transform) continue;
        NodeCard.drawCard(
            batches,
            node,
            transform,
            NodeCard.cardFor(node),
            node.id === activeId && !transforming && !handling ? 'active' : 'selected',
            eye,
            selectedToggles,
        );
    }
    const hoverNode = storeState.hoverNodeId !== null ? getNodeById(s.room.scene, storeState.hoverNodeId) : undefined;
    const hoverTransform = hoverNode ? getTrait(hoverNode, TransformTrait) : null;
    if (hoverNode && hoverTransform && !selectedIds.has(hoverNode.id)) {
        NodeCard.drawCard(batches, hoverNode, hoverTransform, NodeCard.cardFor(hoverNode), 'hover', eye, toggles);
    }
}

const READOUT_COLOR: [number, number, number, number] = [1, 0.85, 0.1, 1];
const RAD_TO_DEG = 180 / Math.PI;
const _readoutEuler: [number, number, number, EulerOrder] = [0, 0, 0, 'xyz'];

// the live value of whatever is being dragged, under the gizmo or handle.
function drawDragReadout(v: Visuals, s: Session): void {
    const handle = Handles.readout(s.handles, s.room.scene);
    if (handle) {
        Text.labelLeft(
            v.text,
            handle.at[0],
            handle.at[1],
            handle.at[2],
            handle.text,
            LABEL_SCALE,
            handle.dxPx,
            0,
            ...READOUT_COLOR,
        );
        return;
    }
    const transform = s.transform;
    if (!transform.dragging) return;
    const proxy = transform.proxy;
    let text: string;
    if (transform.gizmo.mode === 'rotate') {
        const steps = TransformTool.cardinalRotationSteps(transform);
        if (steps) {
            text = `${steps[0] * 90} ${steps[1] * 90} ${steps[2] * 90} deg`;
        } else {
            euler.fromQuat(_readoutEuler, proxy.quaternion, 'xyz');
            text = `${(_readoutEuler[0] * RAD_TO_DEG).toFixed(0)} ${(_readoutEuler[1] * RAD_TO_DEG).toFixed(0)} ${(_readoutEuler[2] * RAD_TO_DEG).toFixed(0)} deg`;
        }
    } else if (transform.gizmo.mode === 'scale') {
        text = `x${proxy.scale[0].toFixed(2)} x${proxy.scale[1].toFixed(2)} x${proxy.scale[2].toFixed(2)}`;
    } else {
        text = `${proxy.position[0].toFixed(2)} ${proxy.position[1].toFixed(2)} ${proxy.position[2].toFixed(2)}`;
    }
    Text.label(
        v.text,
        proxy.position[0],
        proxy.position[1],
        proxy.position[2],
        text,
        LABEL_SCALE,
        -LABEL_LIFT_PX,
        ...READOUT_COLOR,
    );
}

const BOUNDS_READOUT_COLOR: [number, number, number, number] = [0.4, 1, 1, 1];

/** the brush's extent, one number per axis, each centred on the box edge that runs along it.
 *  the three edges chosen are the ones meeting at the corner nearest the eye, so the numbers
 *  stay on the silhouette rather than behind the shape. skipped for a single cell, where the
 *  brush outline already says everything and every hovered block would carry a "1 x 1 x 1".
 *  `Selection.bounds` walks every set bit, so it is memoised on the brush ref the store hands out. */
function drawBrushBounds(v: Visuals, s: Session): void {
    const brush = s.store.getState().brush;
    if (!brush || Selection.count(brush) < 2) return;
    if (s.brushBoundsOf !== brush) {
        s.brushBoundsOf = brush;
        s.brushBounds = Selection.bounds(brush);
    }
    const bounds = s.brushBounds;
    if (!bounds) return;

    // bounds are inclusive voxel coords; the box they describe spans min .. max + 1.
    const minX = bounds.min[0];
    const minY = bounds.min[1];
    const minZ = bounds.min[2];
    const maxX = bounds.max[0] + 1;
    const maxY = bounds.max[1] + 1;
    const maxZ = bounds.max[2] + 1;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    const midZ = (minZ + maxZ) / 2;

    const eye = povCamera(s)?.position ?? _noEye;
    const nearX = eye[0] < midX ? minX : maxX;
    const nearY = eye[1] < midY ? minY : maxY;
    const nearZ = eye[2] < midZ ? minZ : maxZ;

    const [spanX, spanY, spanZ] = bounds.dimensions;
    NodeCard.drawBackedLabel(v, midX, nearY, nearZ, `${spanX}`, 0, ...BOUNDS_READOUT_COLOR);
    NodeCard.drawBackedLabel(v, nearX, midY, nearZ, `${spanY}`, 0, ...BOUNDS_READOUT_COLOR);
    NodeCard.drawBackedLabel(v, nearX, nearY, midZ, `${spanZ}`, 0, ...BOUNDS_READOUT_COLOR);
}

/** uploads what the frame batched; last call of the onPreRender pass. */
function endOverlays(v: Visuals): void {
    Lines.end(v.lines);
    Quads.end(v.quads);
}

function disposeVisuals(v: Visuals): void {
    PivotPoint.dispose(v.pivot);
    disposeSelectionMeshState(v.selection);
    LassoVisuals.dispose(v.lasso);
    Lines.dispose(v.lines);
    Quads.dispose(v.quads);
    GridVisuals.dispose(v.grid);
    ChunkBoundsVisuals.dispose(v.chunkBounds);
    PrefabVisuals.dispose(v.prefabs);
    v.root.removeFromParent();
}

// per room so two joined edit rooms keep independent strokes.
type Strokes = {
    brush: ReturnType<typeof createBrushState>;
    brushSelect: ReturnType<typeof createBrushSelectState>;
    paint: ReturnType<typeof createPainterState>;
    smooth: ReturnType<typeof createSmoothState>;
    elevation: ReturnType<typeof createElevationState>;
};

function initStrokes(): Strokes {
    return {
        brush: createBrushState(),
        brushSelect: createBrushSelectState(),
        paint: createPainterState(),
        smooth: createSmoothState(),
        elevation: createElevationState(),
    };
}

/** the hover AABB hugs the block's collider shape (slabs, stairs, fences) rather than the full
 *  cell; cube colliders and the synthesized air-mode hover use the unit cube. */
function updateHover(
    mk: MouseKeyboardInput,
    camera: PerspectiveCamera,
    ctx: ScriptContext,
    store: EditRoomStoreApi,
    nodeBodies: NodeBodies.NodeBodies,
    room: ClientRoom,
): void {
    const cursor = getCursor(mk);
    unproject(_nearWorld, [cursor.ndcX, cursor.ndcY, 0], camera);
    unproject(_farWorld, [cursor.ndcX, cursor.ndcY, 1], camera);
    vec3.subtract(_rayDir, _farWorld, _nearWorld);
    vec3.normalize(_rayDir, _rayDir);

    _hoverNodeHits.length = 0;
    Selector.castNodeRay(
        nodeBodies,
        room.scene,
        _nearWorld[0],
        _nearWorld[1],
        _nearWorld[2],
        _rayDir[0],
        _rayDir[1],
        _rayDir[2],
        MAX_RAY_DIST,
        _hoverNodeHits,
    );
    let hoverNodeId: number | null = null;
    let nearest = Infinity;
    for (const hit of _hoverNodeHits) {
        if (hit.distance >= nearest) continue;
        nearest = hit.distance;
        hoverNodeId = resolveSelectionTarget(hit.node, store.getState().selection.nodes, room.scene.root).id;
    }
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

    let hoverAabb: [number, number, number, number, number, number] | null = null;
    if (_hoverRayResult.hit) {
        const [vx, vy, vz] = hoverVoxel!;
        hoverAabb = blockStateAabb(ctx.blocks, _hoverRayResult.stateId, vx, vy, vz);
    }

    // air mode: synthesize a hover position in empty space
    if (!hoverVoxel && store.getState().selectorMode === 'air') {
        const d = store.getState().airDistance;
        hoverVoxel = [
            Math.floor(_nearWorld[0] + _rayDir[0] * d),
            Math.floor(_nearWorld[1] + _rayDir[1] * d),
            Math.floor(_nearWorld[2] + _rayDir[2] * d),
        ];
        hoverAabb = [hoverVoxel[0], hoverVoxel[1], hoverVoxel[2], hoverVoxel[0] + 1, hoverVoxel[1] + 1, hoverVoxel[2] + 1];
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
        hoverNodeId,
        lastHoverVoxel: hoverVoxel ?? cur.lastHoverVoxel,
    }));
}

const CONTROL_MODE_CYCLE: readonly ControlMode[] = ['fly', 'orbit', 'character'];

// chord-prefix pattern (V/M/B categories): tap-alone commits on keyup; hold + digit jumps to a
// slot and suppresses the keyup commit via `consumed`.
type Shortcuts = {
    heldCategory: ToolCategoryId | null;
    consumed: boolean;
};

function initShortcuts(): Shortcuts {
    return { heldCategory: null, consumed: false };
}

function updateShortcuts(sc: Shortcuts, mk: MouseKeyboardInput, store: EditRoomStoreApi, grab: Grab.GrabTool): void {
    // cmd/ctrl combos are handled at the DOM layer (edit-ui.tsx) so they fire while a tool-option
    // input holds focus; swallow here so a held modifier doesn't trigger letter-key shortcuts.
    if (isModDown(mk)) return;

    // tool category chord (V/M/B + digit jump, tap to cycle)
    if (sc.heldCategory === null) {
        for (const cat of TOOL_CATEGORIES) {
            if (isKeyJustDown(mk, cat.key)) {
                sc.heldCategory = cat.id;
                sc.consumed = false;
                break;
            }
        }
    }
    if (sc.heldCategory !== null) {
        const cat = TOOL_CATEGORIES.find((c) => c.id === sc.heldCategory)!;
        if (isKeyDown(mk, cat.key)) {
            for (let i = 0; i < HOTBAR_NUMBER_KEYS.length; i++) {
                if (isKeyJustDown(mk, HOTBAR_NUMBER_KEYS[i]!)) {
                    if (i < cat.tools.length) {
                        store.getState().setActiveTool(cat.tools[i]!.id);
                        sc.consumed = true;
                    }
                    break;
                }
            }
        } else {
            // category key released, commit cycle if not consumed
            if (!sc.consumed) {
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
            sc.heldCategory = null;
            sc.consumed = false;
        }
    }

    // library toggle (E)
    if (isKeyJustDown(mk, LIBRARY_KEYS.toggleLibrary)) store.getState().toggleLibrary();

    // camera control mode cycle (M): fly -> orbit -> character -> fly
    if (isKeyJustDown(mk, CONTROL_MODE_KEYS.cycle)) {
        const s = store.getState();
        const idx = CONTROL_MODE_CYCLE.indexOf(s.controlMode);
        s.setControlMode(CONTROL_MODE_CYCLE[(idx + 1) % CONTROL_MODE_CYCLE.length]!);
    }

    // suppressed while a chord prefix is held; library.tsx stops the event before it reaches
    // here when binding a hovered tile to a slot, so a digit read here is always a plain select.
    if (sc.heldCategory === null) {
        for (let i = 0; i < HOTBAR_NUMBER_KEYS.length; i++) {
            if (isKeyJustDown(mk, HOTBAR_NUMBER_KEYS[i]!)) {
                store.getState().setActiveSlot(i);
                break;
            }
        }
    }

    // brush is included because the active slot resolves $active in patterns; skipped while a
    // UI overlay holds the pointer so a scroll inside an open panel scrolls it instead.
    const wheelTool = store.getState().activeTool;
    if (
        (wheelTool === 'build' || wheelTool === 'brush') &&
        mk._wheelDeltaY !== 0 &&
        !isPointerCapturedByUi(mk) &&
        !Grab.isInGrab(grab)
    ) {
        store.getState().cycleActiveSlot(Math.sign(mk._wheelDeltaY));
        mk._wheelDeltaY = 0;
    }
}

/** grab free-rotate: when R is held during grab, mouse delta drives the held
 *  body's rotation and is consumed (zeroed) so neither the fly nor character
 *  controller swings the camera. */
function updateGrabRotate(s: Session): void {
    const { room, client } = s;
    if (!Grab.isInGrab(s.grab)) return;
    const camera = povCamera(s);
    if (!camera) return;
    const mk = client.input.mouseKeyboard;
    const grab = s.grab.current!;
    const isRot = isKeyDown(mk, 'KeyR');

    if (isRot && !grab.rotating) {
        Grab.beginRotate(s.grab, room.physics);
    } else if (!isRot && grab.rotating) {
        Grab.endRotate(s.grab, room.physics, camera);
    }

    if (grab.rotating) {
        Grab.applyRotateDelta(s.grab, mk._dx, mk._dy, camera);
        mk._dx = 0;
        mk._dy = 0;
    }
}

/** same tool gating as the tap-triggered `openViewportContextMenu` (see updateVoxelTools /
 *  updateInspect below), but run as an input pre-pass — see updateRadialMenu's docs for why it
 *  can't just live alongside those onFrame-time calls. */
function updateRadialMenuForActiveTool(s: Session): void {
    const { activeTool } = s.store.getState();
    const gated =
        activeTool === 'inspect' || activeTool === 'box-select' || activeTool === 'magic-select' || activeTool === 'lasso-select';
    if (!gated) {
        // a tool switch mid-hold (a keyboard tool-category shortcut, say) shouldn't leave the
        // menu stuck open with nothing left driving its release. `viewportContextMenu.radial` is
        // the one place "is the radial menu open" lives — see updateRadialMenu's doc comment.
        if (s.store.getState().viewportContextMenu?.radial) s.store.getState().closeViewportContextMenu();
        return;
    }
    const camera = povCamera(s);
    if (!camera) return;
    updateRadialMenu(s.radialMenu, s.store, s.client, s.room, s.ctx, s.nodeBodies, camera);
}

function updateVoxelTools(s: Session, camera: PerspectiveCamera): void {
    const { store, ctx, client, room, nodeBodies, strokes } = s;
    const mk = client.input.mouseKeyboard;
    const { activeTool } = store.getState();

    if (activeTool === 'build') {
        updateBuild(store, ctx, client.input, ctx.voxels, s.placement, camera);
    }
    if (activeTool === 'box-select') {
        const boxNudge = !isInputFocused() ? readNudgeDelta(client.input, camera.quaternion) : null;
        const boxEnter = !isInputFocused() && isKeyJustDown(mk, 'Enter');
        updateBoxSelect(store, ctx, client.input, nodeBodies, boxNudge, boxEnter);
    }
    if (activeTool === 'magic-select') {
        updateMagicSelect(store, ctx, client.input, ctx.voxels, ctx.blocks);
    }
    if (activeTool === 'lasso-select') {
        updateLassoSelect(store, ctx, client.input, camera, ctx.voxels, ctx.blocks, nodeBodies, room.scene);
    }
    // other tools use right-click for their own semantics (erase, place commit); inspect handles its own.
    if (activeTool === 'box-select' || activeTool === 'magic-select' || activeTool === 'lasso-select') {
        openViewportContextMenu(store, client, room, ctx, nodeBodies, camera);
    }
    if (activeTool === 'brush-select') {
        updateBrushSelect(strokes.brushSelect, store, ctx, client.input, ctx.voxels);
    }
    if (activeTool === 'paint') {
        updatePainter(strokes.paint, store, ctx, client.input, ctx.voxels);
    }
    if (activeTool === 'brush') {
        updateBrush(strokes.brush, store, ctx, client.input, ctx.voxels);
    }
    if (activeTool === 'smooth') {
        updateSmooth(strokes.smooth, store, ctx, client.input, ctx.voxels);
    }
    if (activeTool === 'elevation') {
        updateElevation(strokes.elevation, store, ctx, client.input, ctx.voxels);
    }
}

/** R resets / cancels, Escape cascades, F / Shift+F fill / replace with the
 *  active block, Backspace deletes, P picks, arrows + [ ] nudge the committed
 *  selection. all skipped while an input field holds focus. */
/** the one deselect that works in every tool and under pointer lock, where the browser takes Escape for itself. */
function updateDeselectKey(s: Session): void {
    const mk = s.client.input.mouseKeyboard;
    if (isInputFocused() || isModDown(mk)) return;
    if (!isKeyJustDown(mk, SELECTION_KEYS.deselect)) return;
    clearSelectionEverywhere(s);
}

/** drops an in-progress box or lasso stroke first, then the selection itself; silent when there was nothing. */
function clearSelectionEverywhere(s: Session): void {
    const { store } = s;
    const hadSelection = !Selection.isEmpty(store.getState().selection);
    clearBoxSelect(store);
    clearLassoStroke(store);
    if (!hadSelection) return;
    store.getState().clearSelection();
    playDeselected(s.ctx);
}

function updateSelectionKeys(s: Session, camera: PerspectiveCamera): void {
    const { store, client } = s;
    const mk = client.input.mouseKeyboard;

    // skipped while grab is active, R drives free-rotate there
    const sBefore = store.getState();
    const hasSelection = !Selection.isEmpty(sBefore.selection);
    const hasInProgressTool = !!sBefore.boxSelect || !!sBefore.lasso;
    if (
        (hasSelection || hasInProgressTool) &&
        !isInputFocused() &&
        isKeyJustDown(mk, SELECTION_KEYS.clearAll) &&
        !Grab.isInGrab(s.grab)
    ) {
        clearBoxSelect(store);
        clearLassoStroke(store);
        // same rule as deselect and Escape: the sound marks a committed selection going away,
        // not an in-progress stroke being dropped.
        if (hasSelection) {
            store.getState().clearSelection();
            playDeselected(s.ctx);
        }
    }

    if (!isInputFocused() && isKeyJustDown(mk, 'Escape')) {
        const sNow = store.getState();
        if (sNow.cursor || hasInProgressTool) {
            clearBoxSelect(store);
            clearLassoStroke(store);
        } else if (hasSelection) {
            store.getState().clearSelection();
            playDeselected(s.ctx);
        } else {
            store.setState({ activeTool: 'inspect' });
        }
    }

    if (!isInputFocused()) {
        const st = store.getState();
        const activeBlockKey = activeBlockKeyOf(useEditor.getState().hotbar, st.activeSlotIndex);
        if (isKeyJustDown(mk, 'KeyF') && !isShiftDown(mk) && activeBlockKey) st.fill(parsePattern(activeBlockKey));
        if (isKeyJustDown(mk, 'Backspace')) st.delete();
        if (isKeyJustDown(mk, 'KeyF') && isShiftDown(mk) && activeBlockKey) st.replace(parsePattern(activeBlockKey));
    }

    if (!isInputFocused() && isKeyJustDown(mk, 'KeyP')) store.getState().pick();

    const sNudge = store.getState();
    if (!sNudge.cursor && !sNudge.boxSelect && !Selection.isEmpty(sNudge.selection) && !isInputFocused()) {
        const nudge = readNudgeDelta(client.input, camera.quaternion);
        if (nudge) {
            const [dx, dy, dz] = nudge;
            const next = Selection.create();
            Selection.nudge(next, sNudge.selection, dx, dy, dz);
            store.getState().replaceSelection(next);
        }
    }
}

// cache of what the preview was last built from, so a new Selection.T is only allocated when
// the hover or box corners moved.
type BrushPreview = {
    hoverKey: string;
    cornerA: [number, number, number] | null;
    cornerB: [number, number, number] | null;
};

function initBrushPreview(): BrushPreview {
    return { hoverKey: '', cornerA: null, cornerB: null };
}

function resetBrushPreview(p: BrushPreview): void {
    p.hoverKey = '';
    p.cornerA = null;
    p.cornerB = null;
}

function updateBrushPreview(p: BrushPreview, store: EditRoomStoreApi, activeTool: string): void {
    // lasso draws its own stroke overlay (LassoVisuals); suppress the hover-voxel
    // brush box so it doesn't add visual noise next to it.
    if (activeTool === 'lasso-select') {
        if (store.getState().brush !== null) {
            store.setState({ brush: null });
            resetBrushPreview(p);
        }
        return;
    }
    // brush + paint + smooth + elevation drive state.brush themselves (shape-at-
    // hover preview when idle, accumulated stroke during drag).
    if (
        activeTool === 'brush' ||
        activeTool === 'brush-select' ||
        activeTool === 'paint' ||
        activeTool === 'smooth' ||
        activeTool === 'elevation'
    ) {
        resetBrushPreview(p);
        return;
    }

    const st = store.getState();
    const boxSelect = st.boxSelect;
    if (boxSelect?.previewB) {
        const [ax, ay, az] = boxSelect.cornerA;
        const [bx, by, bz] = boxSelect.previewB;
        const sameAsLast =
            st.brush !== null &&
            p.cornerA !== null &&
            p.cornerB !== null &&
            p.cornerA[0] === ax &&
            p.cornerA[1] === ay &&
            p.cornerA[2] === az &&
            p.cornerB[0] === bx &&
            p.cornerB[1] === by &&
            p.cornerB[2] === bz;
        if (!sameAsLast) {
            p.cornerA = [ax, ay, az];
            p.cornerB = [bx, by, bz];
            p.hoverKey = '';
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
        return;
    }

    // single-voxel brush at the keyboard cursor (if active) or the mouse hover
    const brushVoxel = st.cursor ?? st.hoverVoxel;
    const hoverKey = brushVoxel ? `${brushVoxel[0]},${brushVoxel[1]},${brushVoxel[2]}` : '';
    if (hoverKey !== p.hoverKey) {
        p.hoverKey = hoverKey;
        p.cornerA = null;
        p.cornerB = null;
        if (brushVoxel) {
            const sel = Selection.create();
            Selection.set(sel, brushVoxel[0], brushVoxel[1], brushVoxel[2]);
            store.setState({ brush: sel });
        } else {
            store.setState({ brush: null });
        }
    }
}

const ORBIT_TAKEOVER_DISTANCE = 5;

/** each controller owns its own camera node and would otherwise snap the pose to its default
 *  on swap; this snapshots the outgoing pose and writes it onto the new controller's node, then
 *  seeds any per-controller state that doesn't fall out of the pose alone (orbit's focal point,
 *  character's body position under the eye height). */
function reconcileController(room: ClientRoom, store: EditRoomStoreApi): void {
    const node = lensOf(room)?.subject ?? room.playerNode;
    const desiredMode = store.getState().controlMode;

    let activeMode: ControlMode | null = null;
    if (hasTrait(node, FlyControllerTrait)) activeMode = 'fly';
    else if (hasTrait(node, OrbitControllerTrait)) activeMode = 'orbit';
    else if (hasTrait(node, CharacterControllerTrait)) activeMode = 'character';
    if (activeMode === desiredMode) return;

    const hadPose = snapshotCameraPose(room);

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
    writeCameraPose(room);

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
            // seed the body under the snapshot eye, so the player camera
            // (head = body + eyeHeight) lands on the prior pose.
            _seedBodyPos[0] = _snapPos[0];
            _seedBodyPos[1] = _snapPos[1] - cc.config.eyeHeight;
            _seedBodyPos[2] = _snapPos[2];
            setWorldPosition(transform, _seedBodyPos);
            resetInterpolation(node);
            transform.teleport++;

            // seed look from the snapshot orientation so the player camera
            // reproduces it. fwd(look) = -toVec3(look), and the camera's backward
            // axis (+Z) fed through setFromVec3 yields look with fwd(look) =
            // camera-forward.
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

            // editor character mode starts in free-fly with the double-tap-Space
            // toggle armed (desktop) and the on-screen fly/walk toggle button
            // shown (touch).
            cc.input.noclip = true;
            pc.controls.desktop.doubleTapNoclip = true;
            pc.controls.touch.flyToggleButton = true;
        }
    }
}

function snapshotCameraPose(room: ClientRoom): boolean {
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
}

function writeCameraPose(room: ClientRoom): void {
    const t = getTrait(room.client.camera, TransformTrait);
    if (!t) return;
    setWorldPosition(t, _snapPos);
    setWorldQuaternion(t, _snapQuat);
}

/** forward = quat * [0,0,-1]; shared by the character + orbit seeds. */
function writeForwardFromSnapQuat(out: Vec3): void {
    const qx = _snapQuat[0],
        qy = _snapQuat[1],
        qz = _snapQuat[2],
        qw = _snapQuat[3];
    out[0] = -2 * (qx * qz + qw * qy);
    out[1] = -2 * (qy * qz - qw * qx);
    out[2] = -(1 - 2 * (qx * qx + qy * qy));
}
