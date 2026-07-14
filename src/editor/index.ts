import {
    CharacterControllerTrait,
    env,
    FlyControllerTrait,
    OrbitControllerTrait,
    PlayerControllerTrait,
    resetInterpolation,
    TransformTrait,
} from 'bongle';
import type { Client } from 'bongle/interface';
import { type PerspectiveCamera, unproject } from 'gpucat';
import type { Quat, Spherical, Vec3 } from 'mathcat';
import { quat, spherical, vec3 } from 'mathcat';
import * as chat from '../api/chat';
import { getWorldPosition, getWorldQuaternion, setWorldPosition, setWorldQuaternion } from '../builtins/transform';
import * as ClientChat from '../client/chat';
import { installEditorClientListeners } from '../client/editor';
import type { EngineClient } from '../client/engine-client';
import { isKeyDown, isKeyJustDown, isKeyJustUp, isModDown, isShiftDown } from '../client/input';
import * as Net from '../client/net';
import { getRenderCamera, setActivePlayer } from '../client/rooms';
import { availableDebugTabs, useClient } from '../client/ui/client-store';
import type { ScenePayload } from '../core/content/scene-store';
import { registry } from '../core/registry';
import {
    addChild,
    addTrait,
    addTraitBySlot,
    bumpNodeVersion,
    createNode,
    deserializeNode,
    destroyNode,
    getNodeById,
    getTrait,
    hasTrait,
    isAncestorOf,
    type Realm,
    removeTrait,
    removeTraitBySlot,
    reorderChild,
    reparent,
    type SerializedNode,
    setNodePersist,
    setPrefab,
    setRealm,
} from '../core/scene/scene-tree';
import {
    isOwner,
    listen,
    onDispose,
    onFrame,
    onInput,
    onPostPhysicsStep,
    onPrePhysicsStep,
    onTick,
    script,
} from '../core/scene/scripts';
import * as Selection from '../core/scene/selection';
import { SetBlockFlags } from '../core/voxels/block-flags';
import { propagateAllLight } from '../core/voxels/light';
import { createVoxelRaycastResult, raycastVoxels } from '../core/voxels/voxel-raycast';
import { setBlock } from '../core/voxels/voxels';
import * as BlockIcons from '../client/block-icons';
import * as PrefabIcons from '../client/prefab-icons';
import * as Blueprints from '../server/blueprints';
import type { EngineServer } from '../server/engine-server';
import { setTraitProps } from './actions';
import { initBlueprints } from './blueprints';
import { readNudgeDelta } from './camera';
import { installEditorChatCommands } from './chat-commands';
import { installSelectionChatCommands } from './chat-selection';
import { createClipboardHandlers } from './clipboard';
import {
    AddTraitCommand,
    CreateNodeCommand,
    DestroyNodeCommand,
    RemoveTraitCommand,
    ReorderCommand,
    ReparentCommand,
    SaveBlueprintCommand,
    SetNameCommand,
    SetNodePersistCommand,
    SetPrefabCommand,
    SetRealmCommand,
    SetTraitCommand,
    VoxelEditCommand,
} from './commands';
import type { ControlMode } from './edit-room-store';
import { createEditRoomStore } from './edit-room-store';
import { HOTBAR_NUMBER_KEYS, LIBRARY_KEYS, type ToolCategoryId } from './editor-controls';
import { useEditor } from './editor-store';
import { EditorServerTrait, EditorTrait } from './editor-trait';
import { isInputFocused } from './input';
import { activeBlockKeyOf } from './inventory';
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
import { createSelectionMeshState, disposeSelectionMeshState, updateSelectionMeshes } from './visuals/selection-mesh';

/* ── server-only module refs, populated by registerServer before any script inits ── */

type RoomsMod = typeof import('../server/rooms');
type DiscoveryMod = typeof import('../server/discovery');

let _Rooms: RoomsMod | undefined;
let _Discovery: DiscoveryMod | undefined;

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

// server-side editor concerns. attached to the room root by the server
// when an edit room is created (in dev / env.editor builds). holds the
// authoritative voxel/scene mutation listeners and the /relight command.
// no client side, replicated to clients only as a marker, the script
// body early-returns there.
script(
    EditorServerTrait,
    'editor-server',
    (ctx) => {
        if (!env.server) return;

        // //relight, full recompute of sky + rgb light for the room. only
        // the server has authoritative light state, so the listener lives
        // here. clients without the editor enabled never see the spec; play
        // clients with /relight typed fall through to plain-chat, which the
        // server ignores for slash inputs.
        const relightCmd = chat.command(ctx, {
            name: '/relight',
            description: 'recompute all light propagation in this room',
            args: [],
        });
        chat.listen(ctx, relightCmd, () => {
            if (!env.editor) return;
            const t0 = performance.now();
            propagateAllLight(ctx.voxels);
            const ms = (performance.now() - t0).toFixed(1);
            chat.message(ctx, `light repropagated in ${ms}ms`);
        });

        // capability gate, does this client have permission to mutate scene
        // state in this room? Today the only signal is `env.editor` (dev builds
        // grant edit to any connected client; prod builds grant to no one).
        // Future: real auth, project owner, role, etc. Decoupled from player
        // mode so a play-mode client with editor toggled on can still issue
        // edit RPCs.
        const canEdit = (_client: Client) => env.editor;
        const editGated =
            <T>(fn: (args: T, client: Client) => void) =>
            (args: T, client: Client) => {
                if (!canEdit(client)) return;
                fn(args, client);
            };

        // editGated; on a body that actually mutated (returns true, guard
        // early-returns don't), flag the room dirty (broadcast to clients via the
        // room list). wraps the mutating listeners below.
        const editMutate = <T>(fn: (args: T, client: Client) => boolean | undefined) =>
            editGated<T>((args, client) => {
                if (!fn(args, client)) return;
                const { room } = ctx.server!;
                _Rooms!.setRoomDirty(room, true);
            });

        // voxel edit ops from clients
        listen(
            ctx,
            VoxelEditCommand,
            editMutate(({ ops }) => {
                // BULK: authoring edits settle their block-def hooks inline (each
                // write drains only its own op + chained recomputes) but fire no
                // script observers. no explicit end-of-brush drain needed.
                for (const op of ops) {
                    setBlock(ctx.voxels, op.wx, op.wy, op.wz, op.key, SetBlockFlags.BULK);
                }
                return true;
            }),
        );

        // save-as-blueprint, client extracts the ScenePayload from its
        // local selection and ships it here as JSON; server validates the
        // name (or allocates one), then writes a scene file under
        // `content/scenes/blueprints/<name>.scene.json`.
        listen(
            ctx,
            SaveBlueprintCommand,
            editGated((args) => {
                const { state } = ctx.server!;
                let payload: ScenePayload;
                try {
                    payload = JSON.parse(args.payload) as ScenePayload;
                } catch {
                    chat.message(ctx, '[blueprint] invalid payload (json parse failed)');
                    return;
                }
                const name =
                    args.name && args.name.length > 0 ? args.name : Blueprints.allocateBlueprintName(state.contentManager);
                const result = Blueprints.saveBlueprint(state.contentManager, name, payload);
                if (!result.ok) {
                    chat.message(ctx, `[blueprint] ${result.error}`);
                    return;
                }
                // disk write → kit's `bongle:scenes` file watcher fires →
                // `bongle:scene-list` emission catches up the editor.
                chat.message(
                    ctx,
                    result.overwritten ? `[blueprint] overwrote ${result.sceneId}` : `[blueprint] saved ${result.sceneId}`,
                );
            }),
        );

        // scene mutation handlers
        listen(
            ctx,
            CreateNodeCommand,
            editMutate((args, _client) => {
                const { room } = ctx.server!;
                const sceneTree = room.nodes;
                const parent = getNodeById(sceneTree, args.parentId);
                if (!parent) return;
                const node = createNode({
                    id: args.id,
                    name: args.name,
                    persist: args.persist,
                });
                if (args.prefab) {
                    try {
                        node.prefab = JSON.parse(args.prefab);
                    } catch {
                        /* fall through with no prefab */
                    }
                }
                addChild(parent, node);
                const traits: Array<{ id: string; controls?: Record<string, unknown> }> = JSON.parse(args.traits);
                for (const st of traits) {
                    const def = registry.traits.byId.get(st.id)?.payload;
                    if (!def) {
                        node._unresolvedTraits.set(st.id, { json: st.controls });
                        continue;
                    }
                    addTraitBySlot(node, def.slot, st.controls);
                }
                if (args.children) {
                    const children: SerializedNode[] = JSON.parse(args.children);
                    for (const cdata of children) {
                        addChild(node, deserializeNode(cdata));
                    }
                }
                reorderChild(parent, node, args.index);
                return true;
            }),
        );
        listen(
            ctx,
            DestroyNodeCommand,
            editMutate((args, client) => {
                const { state, room } = ctx.server!;
                const node = getNodeById(room.nodes, args.id);
                if (!node) return;
                if (node === room.nodes.root) return;
                _Discovery!.forgetNode(state.discovery, state.rooms, client, room.id, args.id);
                destroyNode(room.nodes, node);
                return true;
            }),
        );
        listen(
            ctx,
            SetNameCommand,
            editMutate((args, client) => {
                const { state, room } = ctx.server!;
                const node = getNodeById(room.nodes, args.id);
                if (!node) return;
                node.name = args.name ?? undefined;
                bumpNodeVersion(room.nodes, node);
                _Discovery!.stampNodeKnowledge(state.discovery, state.rooms, client, room.id, room.nodes, args.id);
                return true;
            }),
        );
        listen(
            ctx,
            SetRealmCommand,
            editMutate((args, client) => {
                const { state, room } = ctx.server!;
                const node = getNodeById(room.nodes, args.id);
                if (!node) return;
                if (node === room.nodes.root) return;
                // setRealm marks the affected subtree dirty so discovery re-evaluates
                // descendants' visibility (matters for play viewers in mixed rooms).
                setRealm(node, args.realm as Realm);
                _Discovery!.stampNodeKnowledge(state.discovery, state.rooms, client, room.id, room.nodes, args.id);
                return true;
            }),
        );
        listen(
            ctx,
            ReparentCommand,
            editMutate((args, client) => {
                const { state, room } = ctx.server!;
                const sceneTree = room.nodes;
                const node = getNodeById(sceneTree, args.id);
                if (!node) return;
                if (node === sceneTree.root) return;
                const newParent = getNodeById(sceneTree, args.parentId);
                if (!newParent) return;
                if (node === newParent || isAncestorOf(node, newParent)) return;
                reparent(node, newParent);
                reorderChild(newParent, node, args.index);
                bumpNodeVersion(sceneTree, node);
                _Discovery!.stampNodeKnowledge(state.discovery, state.rooms, client, room.id, sceneTree, args.id);
                return true;
            }),
        );
        listen(
            ctx,
            ReorderCommand,
            editMutate((args, client) => {
                const { state, room } = ctx.server!;
                const sceneTree = room.nodes;
                const node = getNodeById(sceneTree, args.id);
                if (!node?.parent) return;
                reorderChild(node.parent, node, args.index);
                bumpNodeVersion(sceneTree, node);
                _Discovery!.stampNodeKnowledge(state.discovery, state.rooms, client, room.id, sceneTree, args.id);
                return true;
            }),
        );
        listen(
            ctx,
            SetTraitCommand,
            editMutate((args, client) => {
                const { state, room } = ctx.server!;
                const node = getNodeById(room.nodes, args.id);
                if (!node) return;
                setTraitProps(room.nodes, node, args.traitId, JSON.parse(args.props));
                _Discovery!.stampNodeKnowledge(state.discovery, state.rooms, client, room.id, room.nodes, args.id);
                return true;
            }),
        );
        listen(
            ctx,
            AddTraitCommand,
            editMutate((args, client) => {
                const { state, room } = ctx.server!;
                const sceneTree = room.nodes;
                const node = getNodeById(sceneTree, args.id);
                if (!node) return;
                const def = registry.traits.byId.get(args.traitId)?.payload;
                if (!def) {
                    node._unresolvedTraits.set(args.traitId, { json: args.props ? JSON.parse(args.props) : undefined });
                    bumpNodeVersion(sceneTree, node);
                } else {
                    addTraitBySlot(node, def.slot, args.props ? JSON.parse(args.props) : undefined);
                }
                _Discovery!.stampNodeKnowledge(state.discovery, state.rooms, client, room.id, sceneTree, args.id);
                return true;
            }),
        );
        listen(
            ctx,
            RemoveTraitCommand,
            editMutate((args, client) => {
                const { state, room } = ctx.server!;
                const sceneTree = room.nodes;
                const node = getNodeById(sceneTree, args.id);
                if (!node) return;
                const def = registry.traits.byId.get(args.traitId)?.payload;
                if (!def) {
                    node._unresolvedTraits.delete(args.traitId);
                    bumpNodeVersion(sceneTree, node);
                } else {
                    removeTraitBySlot(node, def.slot);
                }
                _Discovery!.stampNodeKnowledge(state.discovery, state.rooms, client, room.id, sceneTree, args.id);
                return true;
            }),
        );
        listen(
            ctx,
            SetPrefabCommand,
            editMutate((args, client) => {
                const { state, room } = ctx.server!;
                const sceneTree = room.nodes;
                const node = getNodeById(sceneTree, args.id);
                if (!node) return;
                if (args.prefab) {
                    try {
                        setPrefab(node, JSON.parse(args.prefab));
                    } catch {
                        return;
                    }
                } else {
                    setPrefab(node, null);
                }
                bumpNodeVersion(sceneTree, node);
                _Discovery!.stampNodeKnowledge(state.discovery, state.rooms, client, room.id, sceneTree, args.id);
                return true;
            }),
        );
        listen(
            ctx,
            SetNodePersistCommand,
            editMutate((args, client) => {
                const { state, room } = ctx.server!;
                const sceneTree = room.nodes;
                const node = getNodeById(sceneTree, args.id);
                if (!node) return;
                setNodePersist(node, args.persist);
                bumpNodeVersion(sceneTree, node);
                _Discovery!.stampNodeKnowledge(state.discovery, state.rooms, client, room.id, sceneTree, args.id);
                return true;
            }),
        );
    },
    { editor: true },
);

// per-player editor activation. EditorTrait attaches to:
//   - a player's server-owned `room.playerNode` in an edit room (server-
//     seeded on join, replicated to the owning client)
//   - the client-local `room.editor.subject` lens spawned by Shift+`
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
        // owner, so isOwner returns false; allow that path via the local
        // ClientRoom's lens pointer.
        const lensActivation = ctx.client?.room?.editor?.subject === ctx.node;
        if (!lensActivation && !isOwner(ctx, ctx.node)) return;

        // wire up scene-list cold-fetch + HMR. idempotent, first room
        // to reach here arms the subscriptions for the whole process.
        initBlueprints();

        const client = ctx.client!;
        const room = client.room!;

        // ── voxel editor setup ──

        const canvas = client.domElement;
        const pointer = createPointerState(canvas);
        const meshState = createSelectionMeshState(client.scene);
        const inspectMeshState = InspectMesh.init(client.scene);
        // forward-ref: the store references transformToolState in its
        // closures (paste/cut, placement pivot, …), and the gizmo
        // closures inside transformToolState read state.store on user
        // interaction. Create the tool first with a placeholder store,
        // then create the store, then patch transformToolState.store.
        // resolve the initial POV camera for the gizmo. TransformControls
        // holds its own camera ref internally; the per-frame sync below
        // (`transformToolState.gizmo.camera = camera`) keeps it pointing
        // at the active POV so swaps don't strand the gizmo on a stale ref.
        const initialCamera = getRenderCamera(room) as PerspectiveCamera;
        const transformToolState = TransformTool.createTransformTool(
            initialCamera,
            client.domElement,
            client.scene,
            room.nodes,
            ctx,
        );
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

        const pivotPoint = PivotPoint.create(client.scene);
        const debugVisualsState = DebugVisuals.init(client.scene);
        const gridVisualsState = GridVisuals.init(client.scene);
        const chunkBoundsState = ChunkBoundsVisuals.init(client.scene);
        const prefabVisuals = PrefabVisuals.init();

        // ── clipboard: copy / paste via system clipboard ──
        // page-level listeners (installed in registerClient) dispatch to
        // useEditor's active room via room.editorClipboard.
        room.editorClipboard = createClipboardHandlers(store, ctx, room, transformToolState);

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
            const camera = getRenderCamera(room) as PerspectiveCamera | null;
            if (!camera) return;
            TransformTool.prePhysicsGrab(transformToolState, room.physics, camera);
        });
        onPostPhysicsStep(ctx, () => {
            TransformTool.postPhysicsGrab(transformToolState, room.nodes, room.physics);
        });

        // ── grab free-rotate input pre-pass ──
        // runs before player controllers' look-input on every frame.
        // when R is held during grab, mouse delta drives the held
        // body's rotation and is consumed (zeroed) so neither the
        // fly nor character controller swings the camera.
        onInput(ctx, () => {
            if (!TransformTool.isInGrab(transformToolState)) return;
            const camera = getRenderCamera(room) as PerspectiveCamera | null;
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
        // chord-prefix patterns (` debug, V/M/B categories): tap-alone
        // commits on keyup; hold + digit jumps to a slot and suppresses
        // the keyup commit via a "consumed" flag. mirrors the convention
        // that was previously DOM-listener-based in client/ui/ui.tsx.
        let backtickConsumed = false;
        let heldCategory: ToolCategoryId | null = null;
        let categoryConsumed = false;
        onInput(ctx, () => {
            const mk = client.input.mouseKeyboard;

            // cmd/ctrl combos (undo/redo etc.) are handled at the DOM layer
            // (edit-ui.tsx) so they fire while a tool-option input holds
            // focus. swallow them here so a held modifier doesn't trigger
            // letter-key tool shortcuts.
            if (isModDown(mk)) return;

            // ── backtick: debug panel chord prefix ──
            if (isKeyJustDown(mk, 'Backquote')) backtickConsumed = false;
            if (isKeyDown(mk, 'Backquote')) {
                for (let i = 0; i < HOTBAR_NUMBER_KEYS.length; i++) {
                    if (isKeyJustDown(mk, HOTBAR_NUMBER_KEYS[i]!)) {
                        const tabs = availableDebugTabs();
                        if (i < tabs.length) {
                            useClient.getState().setDebugTab(tabs[i]!);
                            useClient.getState().setDebugOpen(true);
                            backtickConsumed = true;
                        }
                        break;
                    }
                }
            }
            if (isKeyJustUp(mk, 'Backquote') && !backtickConsumed) {
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
            if (!isKeyDown(mk, 'Backquote') && heldCategory === null) {
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
            const wheelTool = store.getState().activeTool;
            if (
                (wheelTool === 'build' || wheelTool === 'brush') &&
                mk._wheelDeltaY !== 0 &&
                !TransformTool.isInGrab(transformToolState)
            ) {
                store.getState().cycleActiveSlot(Math.sign(mk._wheelDeltaY));
                mk._wheelDeltaY = 0;
            }
        });

        // ── per-frame voxel tool update ──
        onFrame(ctx, () => {
            // editor visuals + tool dispatch only run when POV is the
            // editor's camera. for play rooms, that means the lens is up
            // AND the user is on the inspect-client sub-tab (client.subject
            // is the lens). for edit rooms, the player node IS the editor
            // camera. when not active, force-hide every editor visual so
            // they don't leak into the player view, and short-circuit.
            const editorViewActive = room.playerMode === 'edit' || (!!room.editor && room.client.subject === room.editor.subject);
            if (!editorViewActive) {
                gridVisualsState.minorLines.visible = false;
                gridVisualsState.majorLines.visible = false;
                gridVisualsState.xAxisLines.visible = false;
                gridVisualsState.zAxisLines.visible = false;
                debugVisualsState.mesh.visible = false;
                chunkBoundsState.lines.visible = false;
                if (pivotPoint.mesh) pivotPoint.mesh.visible = false;
                if (inspectMeshState.mesh) inspectMeshState.mesh.visible = false;
                const sm = meshState;
                if (sm.selectionMesh) sm.selectionMesh.visible = false;
                if (sm.selectionOutline) sm.selectionOutline.visible = false;
                if (sm.selectionEdges) sm.selectionEdges.visible = false;
                if (sm.brushMesh) sm.brushMesh.visible = false;
                if (sm.brushEdges) sm.brushEdges.visible = false;
                if (sm.hoverOutline) sm.hoverOutline.visible = false;
                const helper = transformToolState.gizmo.getHelper?.();
                if (helper) (helper as { visible: boolean }).visible = false;
                return;
            }

            // resolve the active POV camera once; tools read this for
            // raycasts, nudge basis, build/inspect projection. also patch
            // it into the gizmo so a POV swap (player ↔ editor freecam)
            // is reflected in the gizmo's projection without rebuilding.
            // TransformControls is third-party and holds its own camera
            // ref, there's no way to avoid this sync.
            const camera = getRenderCamera(room) as PerspectiveCamera | null;
            if (!camera) return;
            transformToolState.gizmo.camera = camera;

            // sync editor node bodies with the scene tree for broadphase queries
            NodeBodies.update(nodeBodies, room.physics, room.nodes, store, client.state!.resources);

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
                    if (placement && nid === placement.rootId && placement.voxelNodeId !== null) {
                        const vn = getNodeById(room.nodes, placement.voxelNodeId);
                        if (vn) selectedNodes.push(vn);
                        continue;
                    }
                    const n = getNodeById(room.nodes, nid);
                    if (n) selectedNodes.push(n);
                }
                InspectMesh.update(inspectMeshState, selectedNodes, client.state!.resources);
            }

            // update prefab ghost voxels for nodes whose def produces voxels
            PrefabVisuals.update(prefabVisuals, room.nodes, room.scriptRuntime, ctx.voxels.registry);

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

            // debug collider visualization, runs every frame regardless of active tool
            DebugVisuals.update(debugVisualsState, room.physics.rigid.world, store.getState().showPhysicsColliders);

            // grid visualization
            GridVisuals.update(gridVisualsState, store.getState().showGrid);

            // chunk-boundary wireframe overlay
            ChunkBoundsVisuals.update(chunkBoundsState, ctx.voxels, store.getState().showChunkBoundaries);

            // force-release any active grab when we leave transform/grab.
            // covers tool switches and transformMode flips that happen
            // between frames, updateInspect won't fire to clean up
            // when the new tool isn't inspect/transform.
            if (TransformTool.isInGrab(transformToolState)) {
                const tm = store.getState().transformMode;
                if (activeTool !== 'transform' || tm !== 'grab') {
                    TransformTool.exitGrab(transformToolState, room.nodes, room.physics, ctx);
                }
            }

            // force-cancel any active placement when leaving transform.
            // symmetric with the grab guard above, otherwise the
            // __placement_root / __placement_voxels ghost nodes
            // linger because cancelPlacement is only reachable via
            // Escape/Enter while still in transform.
            if (transformToolState.placement && activeTool !== 'transform') {
                TransformTool.cancelPlacement(transformToolState, room.nodes, ctx);
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
                updateLassoSelect(store, pointer, client.input, camera, ctx.voxels, ctx.blocks, nodeBodies, room.nodes);
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
                updateSelectionMeshes(meshState, store.getState());
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
                updateSelectionMeshes(meshState, store.getState());
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

            updateSelectionMeshes(meshState, store.getState());
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
            const node = room.editor?.subject ?? room.playerNode;
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
                    vec3.copy(transform.interpolatedWorldPosition, transform.position);
                    quat.copy(transform.interpolatedWorldQuaternion, transform.quaternion);
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
                    // double-tap-Space toggle armed.
                    cc.input.noclip = true;
                    pc.controls.desktop.doubleTapNoclip = true;
                }
            }
        });

        onDispose(ctx, () => {
            for (const u of unsubs) u();
            useEditor.getState().registerEditRoomStore(room, null);
            room.editorClipboard = null;

            // clean up node bodies
            NodeBodies.dispose(nodeBodies, room.physics);
            // clean up transform tool
            TransformTool.disposeTransformTool(transformToolState);
            PivotPoint.dispose(pivotPoint);
            // clean up voxel editor resources
            disposePointerState(canvas, pointer);
            disposeSelectionMeshState(meshState);
            InspectMesh.dispose(inspectMeshState);
            DebugVisuals.dispose(debugVisualsState, client.scene);
            GridVisuals.dispose(gridVisualsState, client.scene);
            ChunkBoundsVisuals.dispose(chunkBoundsState, client.scene);
            PrefabVisuals.dispose(prefabVisuals);
        });
    },
    { editor: true },
);

/* ── registration ── */

export async function registerServer(_state: EngineServer): Promise<void> {
    [_Rooms, _Discovery] = await Promise.all([import('../server/rooms'), import('../server/discovery')]);
}

/**
 * fetch the pre-built block icon atlas (written by the offline renderer
 * during dev) into the global editor store. project-wide asset; loaded once
 * per page and shared across every editor activation. fire-and-forget, late
 * resolution onto a doomed store at page teardown is harmless.
 *
 * The block atlas is the only icon artifact fetched into the store: scene +
 * prefab icons are per-file PNGs the UI loads by direct URL, so they need no
 * store state and no refetch.
 */
let blockChangeWired = false;
let registryChangeWired = false;
let editorClient: EngineClient | null = null;
let currentBlockIconUrl: string | null = null;
let blockIconRenderInFlight = false;
const prefabIconInFlight = new Set<string>();

function loadEditorAssets(): void {
    // Render the block-icon atlas in-browser (no baked artifact) and re-render
    // whenever the block/texture registry changes, via the client's runtime
    // `bongle:block-resources-changed` event (fired from registry-dispatch after
    // a block/atlas rebuild). Coalesced by the in-flight guard.
    if (!blockChangeWired) {
        blockChangeWired = true;
        window.addEventListener('bongle:block-resources-changed', () => void renderBlockIconsInBrowser());
    }
    // prefab icons render lazily per-id (see ensurePrefabIcon); a registry flush
    // invalidates the cache so visible prefabs re-render on next display.
    if (!registryChangeWired) {
        registryChangeWired = true;
        window.addEventListener('bongle:registry-changed', () => invalidatePrefabIcons());
    }
    renderBlockIconsWhenReady();
}

/** `registerClient` runs before the async GPU device handshake sets
 *  `state.voxelResources`, and initial blocks are pre-registered (no
 *  `applyRegistryChanges` flush, so no `block-resources-changed` event). So the
 *  boot render would bail early forever. Poll a few frames until the engine is
 *  live, then render once; registry-change events drive later re-renders. */
function renderBlockIconsWhenReady(attempt = 0): void {
    const state = editorClient;
    if (!state) return;
    if (!state.voxelResources) {
        if (attempt === 0 || attempt % 60 === 0) {
            console.log('[icon-debug] waiting for voxelResources… frame=%d', attempt);
        }
        if (attempt < 600) {
            requestAnimationFrame(() => renderBlockIconsWhenReady(attempt + 1));
        } else {
            console.warn('[icon-debug] voxelResources never became ready — block icons not rendered');
        }
        return;
    }
    console.log('[icon-debug] voxelResources ready at frame=%d — rendering block icons', attempt);
    void renderBlockIconsInBrowser();
}

/**
 * Render every block icon into an atlas on the live device (transient icon room,
 * torn down after), convert it to an object URL, and publish it to the editor
 * store for the inventory + inspector. No-op until the engine + block registry
 * are ready; safe to call repeatedly (coalesced by an in-flight guard).
 */
async function renderBlockIconsInBrowser(): Promise<void> {
    const state = editorClient;
    console.log(
        '[icon-debug] renderBlockIconsInBrowser trigger: client=%o voxelRes=%o inFlight=%o',
        !!state,
        !!state?.voxelResources,
        blockIconRenderInFlight,
    );
    if (!state || !state.voxelResources || blockIconRenderInFlight) return;
    blockIconRenderInFlight = true;
    try {
        const atlas = await BlockIcons.renderBlockIconAtlas(state);
        console.log('[icon-debug] atlas result: cols=%d rows=%d', atlas.cols, atlas.rows);
        if (atlas.cols === 0) return; // no renderable blocks yet
        const url = await pixelsToObjectUrl(atlas.pixels, atlas.atlasWidth, atlas.atlasHeight);
        if (currentBlockIconUrl) URL.revokeObjectURL(currentBlockIconUrl);
        currentBlockIconUrl = url;
        useEditor.setState({
            blockIconAtlasUrl: url,
            blockIconCoords: atlas.coords,
            blockIconPx: atlas.iconPx,
            blockIconCols: atlas.cols,
            blockIconRows: atlas.rows,
        });
        console.log('[icon-debug] block atlas URL published (%d coords)', Object.keys(atlas.coords).length);
    } catch (e) {
        console.warn('[bongle] in-browser block icon render failed:', e);
    } finally {
        blockIconRenderInFlight = false;
    }
}

/**
 * Lazily render one prefab's icon in-browser and publish its object URL to the
 * store. Called by the inventory icon on first display; cached until a registry
 * change invalidates it. No-op if already rendered, in flight, or engine not
 * ready. Deduped per id.
 */
export async function ensurePrefabIcon(prefabId: string): Promise<void> {
    const state = editorClient;
    if (!state || !state.voxelResources || !prefabId) return;
    if (useEditor.getState().prefabIconUrls[prefabId] || prefabIconInFlight.has(prefabId)) return;
    prefabIconInFlight.add(prefabId);
    try {
        const icon = await PrefabIcons.renderPrefabIcon(state, prefabId);
        if (!icon) return;
        const url = await pixelsToObjectUrl(icon.pixels, icon.pxSize, icon.pxSize);
        useEditor.setState((s) => ({ prefabIconUrls: { ...s.prefabIconUrls, [prefabId]: url } }));
    } catch (e) {
        console.warn(`[bongle] in-browser prefab icon render failed (${prefabId}):`, e);
    } finally {
        prefabIconInFlight.delete(prefabId);
    }
}

/** Drop + revoke all cached prefab icons so visible ones re-render on next
 *  display. Called on a registry flush (prefabs depend on blocks/models/defs). */
function invalidatePrefabIcons(): void {
    const urls = useEditor.getState().prefabIconUrls;
    for (const id in urls) URL.revokeObjectURL(urls[id]!);
    prefabIconInFlight.clear();
    useEditor.setState({ prefabIconUrls: {} });
}

/** RGBA8 pixels (width×height) → PNG object URL (used as a CSS background-image). */
async function pixelsToObjectUrl(pixels: Uint8Array, width: number, height: number): Promise<string> {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d canvas context');
    // copy into a fresh ArrayBuffer-backed clamped array (ImageData rejects a
    // view over a potentially-shared buffer).
    const clamped = new Uint8ClampedArray(pixels);
    ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('canvas.toBlob returned null');
    return URL.createObjectURL(blob);
}

export function registerClient(state: EngineClient): void {
    editorClient = state;
    loadEditorAssets();
    installEditorClientListeners();

    useEditor.setState({
        resources: state.resources,
        switchRoom: (roomId, mode) => {
            for (const room of state.rooms.rooms.values()) {
                if (room.roomId === roomId && room.playerMode === mode) {
                    setActivePlayer(state.rooms, state.net, state.voxelResources, room.playerId);
                    return;
                }
            }
        },
        joinRoom: (roomId, mode) => Net.send(state.net, { type: 'join_room_as', roomId, mode }),
        leaveRoom: (roomId, mode) => Net.send(state.net, { type: 'leave_room', roomId, mode }),
        stopRoom: (roomId) => Net.send(state.net, { type: 'stop_room', roomId }),
    });
}
