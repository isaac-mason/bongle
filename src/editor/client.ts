// editor/client.ts, the client half of the editor module: the per-player editor
// script (EditorTrait). The script orchestrates; each concern below owns its state
// with an init / update / dispose triple, composed into one `Session`. Icons live
// in icons.ts, the room-session verbs in session.ts, the lens in lens.ts, the UI
// mount in ui/edit-ui.tsx. The server half is editor/server.ts; nothing here
// reaches server modules.

import { type PerspectiveCamera, type Scene, unproject } from 'gpucat';
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
import { script } from '../core/registry';
import { addTrait, getNodeById, getTrait, hasTrait, removeTrait } from '../core/scene/scene-tree';
import {
    type ClientContext,
    isOwner,
    onDispose,
    onFrame,
    onInput,
    onPostPhysicsStep,
    onPrePhysicsStep,
    onTick,
    type ScriptContext,
} from '../core/scene/scripts';
import * as Selection from '../core/scene/selection';
import { createVoxelRaycastResult, raycastVoxels } from '../core/voxels/voxel-raycast';
import { env } from '../env';
import { initBlueprints } from './blueprints';
import { readNudgeDelta } from './camera';
import { installEditorChatCommands } from './chat-commands';
import { installSelectionChatCommands } from './chat-selection';
import { createClipboardHandlers } from './clipboard';
import { type ControlMode, createEditRoomStore, type EditRoomStoreApi } from './edit-room-store';
import { HOTBAR_NUMBER_KEYS, LIBRARY_KEYS, type ToolCategoryId } from './editor-controls';
import { useEditor } from './editor-store';
import { EditorTrait } from './editor-trait';
import { isInputFocused } from './input';
import { activeBlockKeyOf } from './inventory';
import { lensOf } from './lens';
import * as NodeBodies from './node-bodies';
import { parsePattern } from './scene/pattern';
import { playDeselected } from './sounds';
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
    type SelectionMeshState,
    setSelectionMeshesVisible,
    updateSelectionMeshes,
} from './visuals/selection-mesh';

type TimeResources = EngineClient['renderer']['time'];

/* ── scratch ── */

const MAX_RAY_DIST = 1024;
const _hoverRayResult = createVoxelRaycastResult();
const _nearWorld: Vec3 = [0, 0, 0];
const _farWorld: Vec3 = [0, 0, 0];
const _rayDir: Vec3 = [0, 0, 0];

const _snapPos: Vec3 = [0, 0, 0];
const _snapQuat: Quat = [0, 0, 0, 1];
const _seedBodyPos: Vec3 = [0, 0, 0];
const _seedBackward: Vec3 = [0, 0, 0];
const _seedSph: Spherical = [0, 0, 0];

/* ── the script ── */

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

        const s = openSession(ctx);
        const { client, room, store, transform } = s;

        // grab body PD + transform writeback. PD runs before physics integrates;
        // writeback runs after physics so Interpolation.snapshot+interpolate
        // smooths the body's pose between fixed-step ticks for render-rate
        // motion. no-op when grab isn't active.
        onPrePhysicsStep(ctx, () => {
            if (!TransformTool.isInGrab(transform)) return;
            const camera = povCamera(s);
            if (camera) TransformTool.prePhysicsGrab(transform, room.physics, camera);
        });
        onPostPhysicsStep(ctx, () => TransformTool.postPhysicsGrab(transform, room.scene, room.physics));

        // input pre-passes run before the fly/orbit/character controllers consume
        // the same mouse delta or wheel.
        onInput(ctx, () => updateGrabRotate(s));
        onInput(ctx, () => updateShortcuts(s.shortcuts, client.input.mouseKeyboard, store, transform));

        onFrame(ctx, () => {
            mirrorRuntimeState(s);

            const active = editorViewActive(room);
            // tear down any armed placement the moment we're not actively placing
            // in the transform tool with the editor view focused, so a play/POV swap
            // mid placement can't leave the preview ghosts armed.
            if (transform.placement && (!active || store.getState().activeTool !== 'transform')) {
                TransformTool.cancelPlacement(transform, ctx);
            }
            // backstop: reap orphaned ghost nodes if any path dropped the
            // placement without a clean teardown. no-op in the common case.
            TransformTool.reconcilePlacementGhosts(transform);
            if (!active) {
                hideVisuals(s.visuals, transform);
                return;
            }
            showVisuals(s.visuals, transform);

            // the active POV camera, resolved once per frame: tools read it for
            // raycasts, nudge basis and projection, and the gizmo is patched with it
            // (TransformControls holds its own camera ref) so a POV swap shows
            // without a rebuild.
            const camera = povCamera(s);
            if (!camera) return;
            transform.gizmo.camera = camera;
            const time = client.state!.renderer.time;

            NodeBodies.update(s.nodeBodies, room.physics, room.scene, store, client.state!.resources);
            updateWorldVisuals(s.visuals, s);
            updateHover(client.input.mouseKeyboard, camera, ctx, store);

            // force-release any active grab when we leave transform/grab. covers
            // tool switches and transformMode flips between frames, when
            // updateInspect won't fire to clean up.
            const { activeTool } = store.getState();
            if (TransformTool.isInGrab(transform) && (activeTool !== 'transform' || store.getState().transformMode !== 'grab')) {
                TransformTool.exitGrab(transform, room.scene, room.physics, ctx);
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
                    s.visuals.pivot,
                    s.visuals.selection,
                    camera,
                );
                redrawInspectMesh(s.visuals, s, time);
                return;
            }

            updateVoxelTools(s, camera);
            updateSelectionKeys(s, camera);
            updateBrushPreview(s.brushPreview, store, activeTool);
            updateSelectionMeshes(s.visuals.selection, store.getState(), time);
            redrawInspectMesh(s.visuals, s, time);
        });

        onTick(ctx, () => reconcileController(room, store));

        onDispose(ctx, () => {
            closeSession(s);
            // a lens whose node died under a scene rebuild (a resync) is gone with
            // it; exitLocalEditorView already dropped it on the explicit path.
            if (lensActivation) useEditor.getState().setLens(room.playerId, null);
        });
    },
    { editor: true },
);

/* ── session: everything the editor holds for one player's room ── */

type Session = {
    ctx: ScriptContext;
    client: ClientContext;
    room: ClientRoom;
    store: EditRoomStoreApi;
    transform: TransformTool.TransformToolState;
    nodeBodies: NodeBodies.NodeBodies;
    visuals: Visuals;
    strokes: Strokes;
    shortcuts: Shortcuts;
    brushPreview: BrushPreview;
    /** teardowns for resources that don't live in the script (chat command
     *  registry, room-scoped state); on* hooks auto-clean with the script. */
    unsubs: Array<() => void>;
};

function openSession(ctx: ScriptContext): Session {
    const client = ctx.client!;
    const room = client.room!;
    const canvas = client.state!.renderer.canvas;

    // forward-ref: the store references the transform tool in its closures
    // (paste/cut, placement pivot, ...), and the gizmo closures inside the tool
    // read store on user interaction. Create the tool first with a placeholder
    // store, then the store, then patch transform.store. the initial POV camera
    // seeds the gizmo; the per-frame sync keeps it on the active POV.
    const initialCamera = resolveRoomCamera(client.state!.renderer.camera, room) as PerspectiveCamera;
    const transform = TransformTool.createTransformTool(initialCamera, canvas, client.render.scene, room.scene, ctx);
    const store = createEditRoomStore({ ctx, room, transformToolState: transform });
    transform.store = store;
    const nodeBodies = NodeBodies.init(store);
    useEditor.getState().registerEditRoomStore(room, store);

    // clipboard: page-level listeners (installed by mountEditUI) dispatch to the
    // active room's handlers through its edit store.
    store.setState({ clipboard: createClipboardHandlers(store, ctx, room, transform) });

    const unsubs: Array<() => void> = [];
    // builtin slash commands (/set, undo, redo, help, selection ops).
    installEditorChatCommands(room.chat, store, ctx, unsubs);
    installSelectionChatCommands(room.chat, store, ctx, room.physics, nodeBodies, unsubs);
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
        nodeBodies,
        visuals: initVisuals(client.render.scene),
        strokes: initStrokes(),
        shortcuts: initShortcuts(),
        brushPreview: initBrushPreview(),
        unsubs,
    };
}

function closeSession(s: Session): void {
    for (const u of s.unsubs) u();
    useEditor.getState().registerEditRoomStore(s.room, null);
    NodeBodies.dispose(s.nodeBodies, s.room.physics);
    TransformTool.disposeTransformTool(s.transform);
    disposeVisuals(s.visuals, s.client.render.scene);
}

/** the active POV camera, or null when the room has no active POV. */
function povCamera(s: Session): PerspectiveCamera | null {
    return resolveRoomCamera(s.client.state!.renderer.camera, s.room) as PerspectiveCamera | null;
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

    const fly = getTrait(lensOf(room)?.subject ?? room.playerNode, FlyControllerTrait);
    if (fly && fly.speed !== store.getState().flySpeed) {
        const seeded = store.getState().flySpeed !== null;
        store.setState({ flySpeed: fly.speed, flySpeedShownAt: seeded ? performance.now() : 0 });
    }
}

/* ── visuals: the editor's overlays in the room's render scene ── */

type Visuals = {
    selection: SelectionMeshState;
    inspect: InspectMesh.InspectMeshState;
    pivot: PivotPoint.State;
    debug: DebugVisuals.DebugVisualsState;
    grid: GridVisuals.GridVisualsState;
    chunkBounds: ChunkBoundsVisuals.ChunkBoundsVisualsState;
    prefabs: PrefabVisuals.PrefabVisuals;
};

function initVisuals(scene: Scene): Visuals {
    return {
        selection: createSelectionMeshState(scene),
        inspect: InspectMesh.init(scene),
        pivot: PivotPoint.create(scene),
        debug: DebugVisuals.init(scene),
        grid: GridVisuals.init(scene),
        chunkBounds: ChunkBoundsVisuals.init(scene),
        prefabs: PrefabVisuals.init(),
    };
}

/** the editor view is not the POV: force-hide every overlay so none leaks into
 *  the player view. through each visual's own visibility, not by writing
 *  `mesh.visible` behind its back, or the two go out of sync and the overlay
 *  stays hidden once the view comes back. */
function hideVisuals(v: Visuals, transform: TransformTool.TransformToolState): void {
    v.grid.minorLines.visible = false;
    v.grid.majorLines.visible = false;
    v.grid.xAxisLines.visible = false;
    v.grid.zAxisLines.visible = false;
    v.debug.mesh.visible = false;
    v.chunkBounds.lines.visible = false;
    PivotPoint.setVisible(v.pivot, false);
    if (v.inspect.mesh) v.inspect.mesh.visible = false;
    setSelectionMeshesVisible(v.selection, false);
    const helper = transform.gizmo.getHelper?.();
    if (helper) (helper as { visible: boolean }).visible = false;
    // the gizmo owns its own canvas pointer listeners (gpucat TransformControls),
    // outside the engine's per-room input routing. a hidden helper still hit-tests,
    // so disable it too or a play-room drag across a handle moves an edit-room node.
    transform.gizmo.enabled = false;
}

function showVisuals(v: Visuals, transform: TransformTool.TransformToolState): void {
    setSelectionMeshesVisible(v.selection, true);
    transform.gizmo.enabled = true;
}

/** the world-space overlays that follow the scene rather than the tool: prefab
 *  ghost voxels, and the debug / grid / chunk-boundary toggles (global, shared
 *  across rooms via useEditor). */
function updateWorldVisuals(v: Visuals, s: Session): void {
    const { room, ctx } = s;
    PrefabVisuals.update(v.prefabs, room.scene, room.context, ctx.voxels.registry);
    const toggles = useEditor.getState();
    DebugVisuals.update(v.debug, room.physics.rigid.world, toggles.showPhysicsColliders);
    GridVisuals.update(v.grid, toggles.showGrid);
    ChunkBoundsVisuals.update(v.chunkBounds, ctx.voxels, toggles.showChunkBoundaries);
}

/** redraw the per-node selection AABB outlines. called from every tool's exit
 *  path so node selection is visible whether the user is in inspect, transform,
 *  or any voxel tool. during voxel placement the placement root has no
 *  geometry, so the ghost's voxel node stands in so the box reflects content. */
function redrawInspectMesh(v: Visuals, s: Session, time: TimeResources): void {
    const placement = s.transform.placement;
    const selectedNodes = [];
    for (const nid of s.store.getState().selection.nodes) {
        if (placement && nid === placement.rootNode.id && placement.voxelNode) {
            selectedNodes.push(placement.voxelNode);
            continue;
        }
        const n = getNodeById(s.room.scene, nid);
        if (n) selectedNodes.push(n);
    }
    InspectMesh.update(v.inspect, selectedNodes, s.client.state!.resources, time);
}

function disposeVisuals(v: Visuals, scene: Scene): void {
    PivotPoint.dispose(v.pivot);
    disposeSelectionMeshState(v.selection);
    InspectMesh.dispose(v.inspect);
    DebugVisuals.dispose(v.debug, scene);
    GridVisuals.dispose(v.grid, scene);
    ChunkBoundsVisuals.dispose(v.chunkBounds, scene);
    PrefabVisuals.dispose(v.prefabs);
}

/* ── strokes: per-room state of the brush-family tools ── */

// active flag, last centre, accumulating ops, preview keys. per room so two
// joined edit rooms keep independent strokes. each tool owns its own state;
// that brush / brush-select / smooth share a stroke harness is their detail.
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

/* ── hover: where the pointer's ray lands, published to the store each frame ── */

/** always active regardless of tool. the cursor's ndc is pinned to (0,0)
 *  under pointer lock, so this implicitly fires from the crosshair. the hover
 *  AABB hugs the block's collider shape (slabs, stairs, fences) rather than the
 *  full cell; cube colliders and the synthesized air-mode hover use the unit
 *  cube. */
function updateHover(mk: MouseKeyboardInput, camera: PerspectiveCamera, ctx: ScriptContext, store: EditRoomStoreApi): void {
    const cursor = getCursor(mk);
    unproject(_nearWorld, [cursor.ndcX, cursor.ndcY, 0], camera);
    unproject(_farWorld, [cursor.ndcX, cursor.ndcY, 1], camera);
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
        lastHoverVoxel: hoverVoxel ?? cur.lastHoverVoxel,
    }));
}

/* ── shortcuts: the editor-only key / wheel bindings ── */

// chord-prefix pattern (V/M/B categories): tap-alone commits on keyup; hold +
// digit jumps to a slot and suppresses the keyup commit via `consumed`.
type Shortcuts = {
    heldCategory: ToolCategoryId | null;
    consumed: boolean;
};

function initShortcuts(): Shortcuts {
    return { heldCategory: null, consumed: false };
}

function updateShortcuts(
    sc: Shortcuts,
    mk: MouseKeyboardInput,
    store: EditRoomStoreApi,
    transform: TransformTool.TransformToolState,
): void {
    // cmd/ctrl combos (undo/redo etc.) are handled at the DOM layer (edit-ui.tsx)
    // so they fire while a tool-option input holds focus. swallow them here so a
    // held modifier doesn't trigger letter-key tool shortcuts.
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

    // hotbar 1..9 (suppressed while a chord prefix is held). binding a hovered
    // library tile to a slot is the library's own DOM handler (ui/library.tsx);
    // it stops the event before it reaches the engine, so a digit read here is
    // always a plain slot select.
    if (sc.heldCategory === null) {
        for (let i = 0; i < HOTBAR_NUMBER_KEYS.length; i++) {
            if (isKeyJustDown(mk, HOTBAR_NUMBER_KEYS[i]!)) {
                store.getState().setActiveSlot(i);
                break;
            }
        }
    }

    // wheel cycles the hotbar slot in build/brush tools. grab handles its own
    // wheel inside transform; fly/orbit see only what we don't consume here.
    // brush is included because the active slot resolves $active in patterns.
    // skipped while a UI overlay (library, etc.) holds the pointer so a scroll
    // inside an open panel scrolls it instead of cycling slots.
    const wheelTool = store.getState().activeTool;
    if (
        (wheelTool === 'build' || wheelTool === 'brush') &&
        mk._wheelDeltaY !== 0 &&
        !isPointerCapturedByUi(mk) &&
        !TransformTool.isInGrab(transform)
    ) {
        store.getState().cycleActiveSlot(Math.sign(mk._wheelDeltaY));
        mk._wheelDeltaY = 0;
    }
}

/** grab free-rotate: when R is held during grab, mouse delta drives the held
 *  body's rotation and is consumed (zeroed) so neither the fly nor character
 *  controller swings the camera. */
function updateGrabRotate(s: Session): void {
    const { transform, room, client } = s;
    if (!TransformTool.isInGrab(transform)) return;
    const camera = povCamera(s);
    if (!camera) return;
    const mk = client.input.mouseKeyboard;
    const grab = transform.grab!;
    const isRot = isKeyDown(mk, 'KeyR');

    if (isRot && !grab.rotating) {
        TransformTool.beginRotate(transform, room.physics);
    } else if (!isRot && grab.rotating) {
        TransformTool.endRotate(transform, room.physics, camera);
    }

    if (grab.rotating) {
        TransformTool.applyRotateDelta(transform, mk._dx, mk._dy, camera);
        mk._dx = 0;
        mk._dy = 0;
    }
}

/* ── the voxel tools and the keys that act on a selection ── */

function updateVoxelTools(s: Session, camera: PerspectiveCamera): void {
    const { store, ctx, client, room, nodeBodies, transform, strokes } = s;
    const mk = client.input.mouseKeyboard;
    const { activeTool } = store.getState();

    if (activeTool === 'build') {
        updateBuild(store, ctx, client.input, ctx.voxels, transform, camera);
    }
    if (activeTool === 'box-select') {
        const boxNudge = !isInputFocused() ? readNudgeDelta(client.input, camera.quaternion) : null;
        const boxEnter = !isInputFocused() && isKeyJustDown(mk, 'Enter');
        updateBoxSelect(store, ctx, client.input, room.physics, nodeBodies, boxNudge, boxEnter);
    }
    if (activeTool === 'magic-select') {
        updateMagicSelect(store, ctx, client.input, ctx.voxels, ctx.blocks);
    }
    if (activeTool === 'lasso-select') {
        updateLassoSelect(store, ctx, client.input, camera, ctx.voxels, ctx.blocks, nodeBodies, room.scene);
    }
    // right-click context menu for dedicated selection tools. inspect handles its
    // own inside updateInspect; build / paint / brush / smooth / elevation +
    // transform use right-click for tool semantics (erase, place commit).
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
function updateSelectionKeys(s: Session, camera: PerspectiveCamera): void {
    const { store, client, transform } = s;
    const mk = client.input.mouseKeyboard;

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
        !TransformTool.isInGrab(transform)
    ) {
        clearBoxSelect(store);
        clearLassoStroke(store);
        if (hasSelection) {
            store.setState({ selection: Selection.create(), inspectedVoxel: null });
        } else if (hasInspectedVoxel) {
            store.setState({ inspectedVoxel: null });
        }
    }

    // Escape: cascading cancel for selection tools
    if (!isInputFocused() && isKeyJustDown(mk, 'Escape')) {
        const sNow = store.getState();
        if (sNow.cursor || hasInProgressTool) {
            // cancel keyboard cursor and/or any in-progress selection tool
            clearBoxSelect(store);
            clearLassoStroke(store);
        } else if (hasSelection) {
            store.setState({ selection: Selection.create(), inspectedVoxel: null });
            playDeselected(s.ctx);
        } else if (hasInspectedVoxel) {
            store.setState({ inspectedVoxel: null });
        } else {
            // nothing active: fall back to the inspect tool
            store.setState({ activeTool: 'inspect' });
        }
    }

    // action shortcuts
    if (!isInputFocused()) {
        const st = store.getState();
        const activeBlockKey = activeBlockKeyOf(useEditor.getState().hotbar, st.activeSlotIndex);
        if (isKeyJustDown(mk, 'KeyF') && !isShiftDown(mk) && activeBlockKey) st.fill(parsePattern(activeBlockKey));
        if (isKeyJustDown(mk, 'Backspace')) st.delete();
        if (isKeyJustDown(mk, 'KeyF') && isShiftDown(mk) && activeBlockKey) st.replace(parsePattern(activeBlockKey));
    }

    // p = pick
    if (!isInputFocused() && isKeyJustDown(mk, 'KeyP')) store.getState().pick();

    // nudge the committed selection (any selection tool, when no keyboard cursor is active)
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
}

/* ── brush preview: the hover / box-corner selection shown as the brush ── */

// a cache of what the preview was last built from, so a new Selection.T is only
// allocated when the hover or the box corners moved. per room: two joined edit
// rooms must not clobber each other's cache.
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
    // lasso has its own screen-space overlay; suppress the world-space hover
    // brush so it doesn't add visual noise.
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

/* ── controller: reconcile the attached controller trait with the chosen mode ── */

const ORBIT_TAKEOVER_DISTANCE = 5;

/** runs each tick. targets the lens node when a lens is up (Shift+` peek into a
 *  play room), else the player node (edit-mode flow).
 *
 *  controllers each own their own camera node (created in onInit, destroyed in
 *  onDispose). a naive swap snaps the pose back to whatever default the incoming
 *  controller seeds; we want the user's view preserved. snapshot the outgoing
 *  camera-node pose, swap, then:
 *    1. write the pose back onto the new camera node; fly's tick rebases off
 *       this, and player's edit-mode tick derives cc.look off it.
 *    2. seed any per-controller state that doesn't fall out of (1):
 *       - orbit: its focal point, `target = camPos + forward * 5`, so it orbits
 *         about a point in front of the camera instead of snapping to origin.
 *       - character: place the body at camera-pos - eyeHeight and snap interp
 *         so the body doesn't lerp from its prior location. */
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
