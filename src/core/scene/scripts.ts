import type { Client, JsonValue, User } from 'bongle/interface';
import type { ContactManifold, ContactSettings, RigidBody } from 'crashcat';
import type { Scene } from 'gpucat';
import type * as Scripts from 'packcat';
import { env } from '../../api/env';
import type { EngineClient } from '../../client/engine-client';
import type { Input } from '../../client/input';
import type { ClientRoom } from '../../client/rooms';
import type { EngineServer } from '../../server/engine-server';
import type { Room } from '../../server/rooms';
import type { Avatar } from '../avatar/avatar';
import type { DepHandle } from '../capture/dep-graph';
import { setDeps } from '../capture/dep-graph';
import { recordScript } from '../capture/module-scope';
import type { ClientId } from '../client';
import type { Clock } from '../clock';
import type { Physics } from '../physics/physics';
import type { PlayerMode, RoomMode } from '../protocol';
import { registry, upsert } from '../registry';
import type { Resources } from '../resources';
import type { CommandHandle } from '../rpc';
import * as Rpc from '../rpc';
import * as blockHooks from '../voxels/block-hooks';
import type { BlockRegistry } from '../voxels/block-registry';
import type { Voxels } from '../voxels/voxels';
import * as SceneTree from './scene-tree';
import { logScriptError } from './script-errors';
import type { TraitBase, TraitHandle } from './traits';

export type Unsubscribe = () => void;

/**
 * client-side editor lens. when present, this client is in some flavor of
 * edit mode, either a real edit room (server-authoritative, `subject` ===
 * playerNode) or a local-only peek into a play room (`subject` is a
 * `realm: 'client'` node carrying EditorTrait + CameraTrait).
 *
 * the existence of `room.editor` is the on/off switch for the editor lens.
 * scripts declared with `{ editor: true }` also run in edit mode and read
 * the lens via `ctx.client.room?.editor`.
 *
 * grows over time with selection / hover / gizmo state. today: the lens's
 * subject + camera nodes. while the lens is active `client.subject` /
 * `client.camera` point at these.
 */
export type EditRoomState = {
    /** stable opaque id for this editor view; surfaces as RoomViewId so the
     *  UI can address the editor POV separately from the player POV
     *  even though both belong to the same ClientRoom. */
    id: string;

    /**
     * the node representing the editor actor. becomes `client.subject` while
     * the lens is active.
     */
    subject: SceneTree.Node;

    /**
     * lens-private camera node, `realm: 'client'` with TransformTrait +
     * CameraTrait. becomes `client.camera` while the lens is active, so the
     * lens's pose is preserved across play/edit tab toggles, independently of
     * `room.cameraNode` (which the player controller drives while in play
     * view). torn down with the lens.
     */
    camera: SceneTree.Node;
};

export type ClientContext = {
    /** the scene this client is in */
    scene: Scene;

    /**
     * the subject: the node local input drives and what the renderer + audio
     * treat as this client's point of view. a plain field on the single client
     * state (no box), so a write is observed everywhere that holds this
     * ClientContext (scripts via `ctx.client`, room-layer via `room.client`).
     * read it with `getSubject(ctx)`, swap with `setSubject(ctx, node)`.
     * defaults to `defaultSubject` (the player node).
     */
    subject: SceneTree.Node | null;

    /** local player body node, alias for `room.playerNode`. the server-side
     *  streaming anchor; keep it where interest should be. */
    player: SceneTree.Node;

    /**
     * active render camera node: what the renderer composes the render camera
     * from each frame (TransformTrait pose + CameraTrait projection). defaults
     * to `defaultCamera` (`room.cameraNode`) and is repointed by whichever
     * controller / lens is driving the view. read it with `getCamera(ctx)`
     * (or `ctx.client.camera`), swap it with `setCamera(ctx, node)`. single
     * source of truth; room-layer reaches it via `room.client`.
     */
    camera: SceneTree.Node;

    /**
     * the subject to return to when a temporary override (editor lens,
     * spectator, cinematic) ends. plain config field, seeded to the player
     * node at room setup; games may repoint it to control something other
     * than the player by default. no set/reset helpers, editor and games read
     * it and restore `subject` themselves.
     */
    defaultSubject: SceneTree.Node | null;

    /**
     * the camera to return to alongside `defaultSubject`. plain config field,
     * seeded to `room.cameraNode` at room setup. mostly a follower of the
     * default subject's controller camera; stands alone for controller-less
     * default views (a fixed / scripted camera).
     */
    defaultCamera: SceneTree.Node;

    /** the canvas element the renderer draws into */
    domElement: HTMLCanvasElement;

    /**
     * per-room viewport div that wraps the canvas. scripts can append HTML
     * overlays here (debug HUDs, custom UI). the viewport hides/shows with
     * the active room and is removed when the room is disposed, so script
     * overlays automatically follow room lifecycle.
     *
     * has `pointer-events: none` so the canvas under it still receives mouse
     * events. overlays that need interactivity must set `pointer-events: auto`
     * on themselves.
     */
    viewport: HTMLDivElement;

    /**
     * per-room touch overlay div, sibling of canvas under `viewport` and
     * appended AFTER the html UI overlay so it stacks visually above
     * everything by DOM order alone. touch controls helpers (joystick /
     * button) mount their roots here; pointer events live on the
     * helper roots, not on this container (which stays
     * `pointer-events: none`).
     */
    touchOverlay: HTMLDivElement;

    /** our own client id */
    clientId: ClientId | undefined;

    /** client input state, read keyboard/mouse here in onFrame hooks */
    input: Input;

    /** top-level client engine state, populated by engine-client on room creation */
    state?: EngineClient;

    /** the client room this script is running in */
    room?: ClientRoom;
};

export type ServerContext = {
    /** top-level server engine state */
    state: EngineServer;

    /** the server room this script is running in */
    room: Room;

    /**
     * Matchmaking opts on this room's namespace. Stamped at namespace-creation
     * time, by the `play` handler for `client.matchmake`-allocated rooms, by
     * the runtime at boot for the deployed 'main' namespace. Empty for the
     * editor namespace and for dev runs that never received gameOptions.
     */
    readonly gameOptions: Readonly<Record<string, string | number | boolean>>;
};

export type SceneTreeContext = {
    /** room id for rpc send/broadcast */
    roomId: string;

    /**
     * the viewer's mode for this room (the PlayerMode of the Player it
     * represents). surfaced to scripts as `ctx.mode`; drives script-side
     * filtering of editor vs play behavior. on the server this equals
     * `roomMode` (no distinct viewer); the edit-viewer-of-a-play-room split
     * is a client concern.
     */
    playerMode: PlayerMode;

    /**
     * the room's authoritative mode (independent of the viewer). drives
     * room-level decisions like prefab previews vs voxel baking: an edit
     * Player attached to a play room still bakes voxels (no preview ghosts),
     * because the room is play.
     */
    roomMode: RoomMode;

    /** shared resources (scenes cache, per-scene versions) */
    resources: Resources;

    /** shared per-side rpc (driver + listener registry). one instance is
     *  shared across every room on this side; `listen()` scopes
     *  registrations by roomId so per-room handlers don't cross rooms. */
    rpc: Rpc.Rpc;

    /** client-specific context, undefined on server */
    client: ClientContext | undefined;

    /** server-specific context, undefined on client */
    server: ServerContext | undefined;

    /** per-room voxel data */
    voxels: Voxels;

    /** per-room physics world */
    physics: Physics;

    /** per-room game clock (monotonic seconds, advances at tick cadence) */
    clock: Clock;

    /** block registry, flat lookup tables for block type/state info */
    blocks: BlockRegistry;

    /** live script instances, keyed by node id → script id → instance.
     *  script id is `${trait._id}#${scriptIndex}` where scriptIndex is the
     *  script's position in its trait def's `scripts` array. */
    instances: Map<number, Map<string, ScriptInstance>>;
};

export type ScriptOptions = {
    /**
     * whether the script should run in edit mode.
     * @default false
     */
    editor?: boolean;

    /**
     * producer handles whose changes trigger this script to be re-built
     * on its attached trait instances. accepts anything with a DepGraph
     * `dependency` stamp, scene, model, block, trait, command, prefab
     * handles, etc. usually injected by the AST rewriter from identifiers
     * the factory body closes over; list manually for procedural cases
     * the rewriter can't see.
     */
    deps?: ReadonlyArray<DepHandle>;
};

export type ScriptContext<T extends TraitBase = TraitBase> = {
    /** the mode of the room this script is running in */
    mode: 'edit' | 'play';

    /** the trait instance this script is bound to. fully typed for the
     *  TraitHandle passed to `script()`. */
    trait: T;

    /** the node the bound trait is attached to (shortcut for `ctx.trait._node`) */
    node: SceneTree.Node;

    /** the scene tree this script is running in */
    nodes: SceneTree.SceneTree;

    /** per-room voxel data */
    voxels: Voxels;

    /** per-room physics world */
    physics: Physics;

    /** per-room game clock (monotonic seconds, advances at tick cadence) */
    clock: Clock;

    /** block registry, flat lookup tables for block type/state info */
    blocks: BlockRegistry;

    /** client information, safe to ! bang if env.client is true */
    client?: ClientContext;

    /** server information, safe to ! bang if env.server is true */
    server?: ServerContext;

    /** @internal reference to script instance for hook/RPC functions */
    _instance?: ScriptInstance;

    /** @internal reference to scene tree runtime for hook/RPC functions */
    _runtime?: SceneTreeContext;
};

export type ScriptInstance = {
    /** the script definition */
    def: ScriptDef;

    /** whether the script has been initialized */
    initialized: boolean;

    /** the node this script instance is attached to */
    node: SceneTree.Node;

    /** the trait instance this script is bound to. used to filter live
     *  instances on removeTrait. */
    trait: TraitBase;

    /** fired once on initial script attach, before the script enters the scene tree */
    onInit: Set<() => void>;

    /** client-only: fires once per frame at the very start, before onUpdate.
     *  use to consume input (e.g. zero mk._dx/_dy) so later hooks see no input. */
    onInput: Set<(args: FrameArgs) => void>;

    /** fired once per frame, before the tick loop. use for input polling and camera updates. */
    onUpdate: Set<(args: UpdateArgs) => void>;

    /** fired once per fixed-timestep tick */
    onTick: Set<(args: TickArgs) => void>;

    /** client-only: fires once per frame, before the tick loop. use for input polling and camera updates. */
    onFrame: Set<(args: FrameArgs) => void>;

    /** fired when the script instance is disposed */
    onDispose: Set<() => void>;

    /** fired when the node enters the scene tree (initial attach or reparent attach) */
    onEnter: Set<(parent: SceneTree.Node) => void>;

    /** fired when the node exits the scene tree (detach or before reparent detach) */
    onExit: Set<(parent: SceneTree.Node) => void>;

    /** server-only: fired when a client joins the room */
    onJoin: Set<(args: JoinArgs) => void>;

    /** server-only: fired when a client leaves the room */
    onLeave: Set<(args: LeaveArgs) => void>;

    /** fired before the physics step */
    onPrePhysicsStep: Set<(args: TickArgs) => void>;

    /** fired after the physics step */
    onPostPhysicsStep: Set<(args: TickArgs) => void>;

    /** fired after animator sampling, before world-matrix recompute. use for
     *  procedural post-processing (head look-at, spring/damper, etc.). */
    onPostAnimate: Set<(args: TickArgs) => void>;

    /** fired during physics step when a contact is added or persisted */
    onPhysicsContactAdded: Set<(args: PhysicsContactArgs) => void>;

    /** fired during physics step when a contact persists from the previous step */
    onPhysicsContactPersisted: Set<(args: PhysicsContactArgs) => void>;

    /** fired during broadphase to validate body pairs, return false to reject collision */
    onPhysicsBodyPairValidate: Set<(bodyA: RigidBody, bodyB: RigidBody) => boolean>;

    /** swaps out state on module reload */
    onSwap: { ser: () => unknown; des: (data: unknown) => void } | null;

    /** queries acquired via `query(ctx, ...)`. released on dispose so unused
     *  queries are evicted from the scene tree's query map. */
    queries: Set<SceneTree.Query<any>>;

    /** rpc listener registrations owned by this instance, each record is
     *  the data needed to remove the entry from `runtime.rpc.listeners`:
     *  the commandId it's keyed under, and the ListenerEntry reference
     *  returned by `Rpc.listen`. disposeScriptInstance walks this array
     *  and calls `Rpc.unlisten` per record. data-driven cleanup, no
     *  closure-based unsubscribes stored anywhere. */
    netListeners: Array<{ commandId: string; entry: Rpc.ListenerEntry }>;

    /** runtime env for this instance */
    _runtime: SceneTreeContext;

    /** context passed to the factory, held until initScriptInstance runs the factory, then cleared */
    _ctx: ScriptContext;
};

export type ScriptFactory<T extends TraitBase = TraitBase> = (ctx: ScriptContext<T>) => void;

/** body passed by the user to `script()`. just the factory + opts. */
export type ScriptBody = {
    factory: ScriptFactory;
    /** if true, this script's hooks register in edit mode too. default false. */
    editor: boolean;
};

/**
 * stored ScriptDef. body + `{ traitId, scriptId, key, dependency }`.
 * `key` is the composed `${traitId}.${scriptId}`, used as the instance
 * Map key, DepGraph dependency id, and log label. don't parse it apart;
 * read `traitId` / `scriptId` directly.
 */
export type ScriptDef = ScriptBody & {
    traitId: string;
    scriptId: string;
    key: string;
    /** DepGraph dependency, see SceneHandle.dependency. lets the AST
     *  rewrite wrap `script(...)` calls with `__addDeps(h, [...])`. */
    dependency: { registry: 'scripts'; id: string };
};

/**
 * register a script (behavior) on a trait. callable multiple times per trait,
 * each call appends to the trait def's `scripts` array. attaching the trait to
 * a live node instantiates one ScriptInstance per registered script. the
 * factory runs at attach time with `ctx.trait` typed for the handle.
 *
 * `id` is a stable user-supplied string (without trait prefix). the runtime
 * identifier becomes `${trait._id}.${id}`, used as the instance map key,
 * DepGraph dependency key, and error message label.
 *
 * @example
 * ```ts
 * const Gamemode = trait('gamemode');
 * script(Gamemode, 'tick', (ctx) => {
 *     onTick(ctx, () => { /* ctx.trait is TraitInstance<typeof Gamemode> *\/ });
 * });
 * ```
 */
export function script<T extends TraitBase>(
    handle: TraitHandle<T>,
    scriptId: string,
    factory: ScriptFactory<T>,
    opts?: ScriptOptions,
): ScriptDef {
    const target = handle._def;
    const key = `${handle._id}.${scriptId}`;
    const def: ScriptDef = {
        traitId: handle._id,
        scriptId,
        key,
        dependency: { registry: 'scripts', id: key },
        factory: factory as unknown as ScriptFactory,
        editor: opts?.editor === true,
    };
    // upsert into the trait def's script list: reuse the slot if this id already
    // exists, else append (`scripts[length] = def` extends the array). re-
    // registration is normal under HMR, a built-in trait like WorldTrait keeps
    // its def (and `scriptsById`) across a user-file reload, so the same
    // `script()` call re-runs against a populated map; latest factory wins.
    const existing = target.scriptsById.get(scriptId);
    const index = existing ? existing.index : target.scripts.length;
    target.scripts[index] = def;
    target.scriptsById.set(scriptId, { reg: def, index });
    // upsert into the per-kind store so HMR detects individual script
    // factory edits without flipping the parent trait hash. dispatch
    // turns these pendingChanges into a targeted applyTraitSwap.
    upsert(registry.scripts, key, def);
    // record this script key into the owning module's snapshot so the
    // patch/invalidate diff sees which scripts the module declares this run.
    // the diff is set-based: an unchanged key set means only factory bodies
    // moved (swapped in place below), while an added/removed/renamed key is a
    // shape change that invalidates, which is what disposes a script the
    // user deleted or renamed, even on a persistent (built-in) trait def.
    recordScript(key);
    // wire dep edges so the dirty set covers scripts whose closed-over
    // producers changed even when the factory body itself is unchanged
    // (e.g. a referenced model handle reloaded). dispatch uses these to
    // target only the dirty scripts on applyTraitSwap.
    setDeps({ registry: 'scripts', id: key }, opts?.deps ? opts.deps.map((d) => d.dependency) : []);
    return def;
}

/* helpers */

const noop: Unsubscribe = () => {};

/* queries */

/**
 * register (or reuse) a live query tied to this script instance's lifetime.
 * the returned `Query` is the same handle for any caller with identical
 * conditions; calling twice on the same instance dedups to one refcount.
 * the query is released when the script instance disposes, do not hold
 * references across `onSwap` boundaries.
 */
export function query<const Args extends SceneTree.ConditionArgs[]>(
    ctx: ScriptContext,
    conditions: Args,
): SceneTree.Query<SceneTree.ConditionArgsToConditions<Args>> {
    const q = SceneTree.query(ctx.nodes, conditions);
    const instance = ctx._instance;
    if (instance && !instance.queries.has(q)) {
        instance.queries.add(q);
        SceneTree.acquireQuery(ctx.nodes, q);
    }
    return q;
}

export function filter<const Args extends SceneTree.ConditionArgs[]>(ctx: ScriptContext, conditions: Args): SceneTree.Node[] {
    return SceneTree.filter(ctx.nodes, conditions);
}

export function first<T extends TraitBase>(ctx: ScriptContext, trait: TraitHandle<T>): T | null {
    const node = SceneTree.findAncestor(ctx.node, [trait]);
    if (!node) return null;
    return node[0];
}

/* ── hook functions ────────────────────────────────────────────────── */

export function onInit(ctx: ScriptContext, fn: () => void): Unsubscribe {
    const instance = ctx._instance;
    if (!instance) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    instance.onInit.add(fn);
    return () => instance.onInit.delete(fn);
}

export type TickArgs = { delta: number };

export function onTick(ctx: ScriptContext, fn: (args: TickArgs) => void): Unsubscribe {
    const instance = ctx._instance;
    if (!instance) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    instance.onTick.add(fn);
    return () => instance.onTick.delete(fn);
}

export type UpdateArgs = { delta: number };

/**
 * register a callback that fires once per frame, before the fixed-timestep tick
 * loop. use this for input polling and camera updates, reads fresh input state
 * and drives the camera before any physics/kcc ticks run that frame.
 * client-only, no-op on the server.
 */
export function onUpdate(ctx: ScriptContext, fn: (args: UpdateArgs) => void): Unsubscribe {
    const instance = ctx._instance;
    if (!instance) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    // server has no client context, onUpdate is client-only
    if (!ctx.client) return noop;
    instance.onUpdate.add(fn);
    return () => instance.onUpdate.delete(fn);
}

export type FrameArgs = { delta: number };

export function onFrame(ctx: ScriptContext, fn: (args: FrameArgs) => void): Unsubscribe {
    const instance = ctx._instance;
    if (!instance) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    instance.onFrame.add(fn);
    return () => instance.onFrame.delete(fn);
}

/**
 * register a callback that fires at the very start of each frame, before
 * onUpdate / onTick / onFrame. intended for input pre-processing, e.g. an
 * editor consuming mouse deltas before player controllers read them.
 *
 * iteration order matches onFrame (flat over runtime.instances). consumers
 * relying on "X runs before Y" should rely on script registration order.
 * client-only, no-op on the server.
 */
export function onInput(ctx: ScriptContext, fn: (args: FrameArgs) => void): Unsubscribe {
    const instance = ctx._instance;
    if (!instance) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    // client-only, server has no local input
    if (!ctx.client) return noop;
    instance.onInput.add(fn);
    return () => instance.onInput.delete(fn);
}

export function onDispose(ctx: ScriptContext, fn: () => void): Unsubscribe {
    const instance = ctx._instance;
    if (!instance) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    instance.onDispose.add(fn);
    return () => instance.onDispose.delete(fn);
}

/**
 * register a callback that fires when this script's node enters the scene tree.
 * fires on initial attach and on every reparent (after the new parent is set).
 */
export function onEnter(ctx: ScriptContext, fn: (parent: SceneTree.Node) => void): Unsubscribe {
    const instance = ctx._instance;
    if (!instance) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    instance.onEnter.add(fn);
    return () => instance.onEnter.delete(fn);
}

/**
 * register a callback that fires when this script's node exits the scene tree.
 * fires on detach and before every reparent detach.
 */
export function onExit(ctx: ScriptContext, fn: (parent: SceneTree.Node) => void): Unsubscribe {
    const instance = ctx._instance;
    if (!instance) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    instance.onExit.add(fn);
    return () => instance.onExit.delete(fn);
}

/** join-data key carrying the editor's viewpoint when a session is launched
 *  via the editor "play" button. absent for normal (production) joins, so a
 *  game reading it degrades to its usual spawn. games opt in for "play from
 *  here" — read it with `editorPlayData()`. */
export const EDITOR_JOIN_KEY = '__editor';

/** editor viewpoint pose passed under `EDITOR_JOIN_KEY` in join data. */
export type EditorPlayData = {
    /** editor camera world position at play time. */
    position: [number, number, number];
    /** editor camera world orientation at play time. */
    quaternion: [number, number, number, number];
};

export type JoinArgs = {
    client: ClientId;
    playerNode: SceneTree.Node;
    user: User;
    joinData: Record<string, JsonValue>;
    /** Model id the player renders with, resolved upstream (matchmaker /
     *  builtin) and already stamped onto `playerNode`'s CharacterTrait
     *  before this fires. */
    characterModelId: string;
    /** Rig contract of that model, e.g. `RIG_TYPE_6BONE`, lets onJoin
     *  branch on rig family without reaching for the trait. */
    rigType: string;
};

/**
 * register a callback that fires when a client joins the room.
 * server-only, no-op on the client.
 */
export function onJoin(ctx: ScriptContext, fn: (args: JoinArgs) => void): Unsubscribe {
    const instance = ctx._instance;
    // only meaningful on the server (no client context)
    if (!instance || ctx.client !== undefined) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    instance.onJoin.add(fn);
    return () => instance.onJoin.delete(fn);
}

/** args passed to onLeave callbacks */
export type LeaveArgs = {
    client: ClientId;
    playerNode: SceneTree.Node;
};

/**
 * register a callback that fires when a client leaves the room.
 * server-only, no-op on the client.
 */
export function onLeave(ctx: ScriptContext, fn: (args: LeaveArgs) => void): Unsubscribe {
    const instance = ctx._instance;
    // only meaningful on the server (no client context)
    if (!instance || ctx.client !== undefined) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    instance.onLeave.add(fn);
    return () => instance.onLeave.delete(fn);
}

/* ── block event hooks ───────────────────────────────────────────── */

/**
 * register a callback that fires when a block of `block`'s type is built
 * (placed where air or a different block was). server-only, no-op on the
 * client. handler receives the world coords + new state id; close over
 * `ctx` for scene/room access (e.g. spawn an item, play a sound).
 */
export function onBlockBuild(
    ctx: ScriptContext,
    block: import('../voxels/blocks').BlockHandle,
    fn: (ev: import('../voxels/blocks').BlockChangeCtx) => void,
): Unsubscribe {
    const instance = ctx._instance;
    if (!instance || ctx.client !== undefined) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    const observers = blockHooks.ensureBlockObservers(ctx.voxels);
    const entry = observers.get(block._index) ?? {};
    if (!entry.onBlockBuild) entry.onBlockBuild = new Set();
    entry.onBlockBuild.add(fn);
    observers.set(block._index, entry);
    const cleanup = () => {
        entry.onBlockBuild?.delete(fn);
        if (entry.onBlockBuild && entry.onBlockBuild.size === 0) entry.onBlockBuild = undefined;
    };
    instance.onDispose.add(cleanup);
    return () => {
        cleanup();
        instance.onDispose.delete(cleanup);
    };
}

/**
 * register a callback that fires when a block of `block`'s type is broken
 * (replaced with air or a different block). server-only.
 */
export function onBlockBreak(
    ctx: ScriptContext,
    block: import('../voxels/blocks').BlockHandle,
    fn: (ev: import('../voxels/blocks').BlockChangeCtx) => void,
): Unsubscribe {
    const instance = ctx._instance;
    if (!instance || ctx.client !== undefined) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    const observers = blockHooks.ensureBlockObservers(ctx.voxels);
    const entry = observers.get(block._index) ?? {};
    if (!entry.onBlockBreak) entry.onBlockBreak = new Set();
    entry.onBlockBreak.add(fn);
    observers.set(block._index, entry);
    const cleanup = () => {
        entry.onBlockBreak?.delete(fn);
        if (entry.onBlockBreak && entry.onBlockBreak.size === 0) entry.onBlockBreak = undefined;
    };
    instance.onDispose.add(cleanup);
    return () => {
        cleanup();
        instance.onDispose.delete(cleanup);
    };
}

/**
 * register a callback that fires when a block of `block`'s type changes
 * state in place (same block-type, different stateId). server-only.
 * handler receives both old and new state ids on the event payload.
 */
export function onBlockStateChange(
    ctx: ScriptContext,
    block: import('../voxels/blocks').BlockHandle,
    fn: (ev: import('../voxels/blocks').BlockStateChangeCtx) => void,
): Unsubscribe {
    const instance = ctx._instance;
    if (!instance || ctx.client !== undefined) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    const observers = blockHooks.ensureBlockObservers(ctx.voxels);
    const entry = observers.get(block._index) ?? {};
    if (!entry.onBlockStateChange) entry.onBlockStateChange = new Set();
    entry.onBlockStateChange.add(fn);
    observers.set(block._index, entry);
    const cleanup = () => {
        entry.onBlockStateChange?.delete(fn);
        if (entry.onBlockStateChange && entry.onBlockStateChange.size === 0) entry.onBlockStateChange = undefined;
    };
    instance.onDispose.add(cleanup);
    return () => {
        cleanup();
        instance.onDispose.delete(cleanup);
    };
}

/**
 * register a callback that fires before each physics step.
 * use this to apply forces, set velocities, or prepare body state
 * before the physics world is stepped.
 */
export function onPrePhysicsStep(ctx: ScriptContext, fn: (args: TickArgs) => void): Unsubscribe {
    const instance = ctx._instance;
    if (!instance) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    instance.onPrePhysicsStep.add(fn);
    return () => instance.onPrePhysicsStep.delete(fn);
}

/**
 * register a callback that fires after each physics step.
 * use this to read collision results, updated positions/velocities,
 * or react to physics simulation output.
 */
export function onPostPhysicsStep(ctx: ScriptContext, fn: (args: TickArgs) => void): Unsubscribe {
    const instance = ctx._instance;
    if (!instance) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    instance.onPostPhysicsStep.add(fn);
    return () => instance.onPostPhysicsStep.delete(fn);
}

/**
 * register a callback that fires after animator sampling, before world-matrix
 * recompute. ideal for procedural post-processing, head-look at the camera,
 * springs/dampers driven by parent motion, simple constraint clamps. local
 * TRS values are set; world matrices for this tick haven't been recomputed yet.
 */
export function onPostAnimate(ctx: ScriptContext, fn: (args: TickArgs) => void): Unsubscribe {
    const instance = ctx._instance;
    if (!instance) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    instance.onPostAnimate.add(fn);
    return () => instance.onPostAnimate.delete(fn);
}

/** args passed to onPhysicsContact callbacks, raw crashcat types */
export type PhysicsContactArgs = {
    bodyA: RigidBody;
    bodyB: RigidBody;
    manifold: ContactManifold;
    settings: ContactSettings;
};

/**
 * register a callback that fires during the physics step when a contact is detected.
 * receives raw crashcat body/manifold/settings, you can modify settings to customize
 * contact behavior (e.g. zero friction for ice surfaces, set isSensor).
 */
export function onPhysicsContact(
    ctx: ScriptContext,
    event: 'added' | 'persisted',
    fn: (args: PhysicsContactArgs) => void,
): Unsubscribe {
    const instance = ctx._instance;
    if (!instance) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    const set = event === 'added' ? instance.onPhysicsContactAdded : instance.onPhysicsContactPersisted;
    set.add(fn);
    return () => set.delete(fn);
}

/**
 * register a callback that fires during broadphase to validate body pairs.
 * return false to reject collision detection for this pair.
 * if any registered callback returns false, the pair is rejected.
 */
export function onPhysicsBodyPairValidate(ctx: ScriptContext, fn: (bodyA: RigidBody, bodyB: RigidBody) => boolean): Unsubscribe {
    const instance = ctx._instance;
    if (!instance) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    instance.onPhysicsBodyPairValidate.add(fn);
    return () => instance.onPhysicsBodyPairValidate.delete(fn);
}

export function onSwap(ctx: ScriptContext, ser: () => unknown, des: (data: unknown) => void): void {
    const instance = ctx._instance;
    if (!instance) return;
    instance.onSwap = { ser, des };
}

/* ── ownership query ─────────────────────────────────────────────── */

/** returns true if the caller has write authority over `node`:
 *  - on a client, true iff the active Player in this script's room is the node's owner.
 *  - on the server, true iff the node has no client owner (server is the implicit
 *    owner of unowned nodes, so server-driven NPCs / props tick from the server side). */
export function isOwner(ctx: ScriptContext, node: SceneTree.Node): boolean {
    if (env.server) return node.owner == null;
    const playerId = ctx.client?.room?.playerId;
    return playerId != null && node.owner === playerId;
}

/* ── rpc functions ────────────────────────────────────────────────── */

export function send<S extends Scripts.Schema, Direction extends Rpc.RpcDirection>(
    ctx: ScriptContext,
    handle: CommandHandle<S, Direction>,
    data: Scripts.SchemaType<S>,
    client?: Direction extends typeof Rpc.SERVER_TO_CLIENT ? Client : never,
): void {
    const runtime = ctx._runtime;
    if (!runtime) return;
    Rpc.send(runtime.rpc, registry.commandWireIndex, handle, data as never, runtime.roomId, client);
}

export function broadcast(
    ctx: ScriptContext,
    handle: CommandHandle<Scripts.Schema, 'server_to_client'>,
    data: Scripts.SchemaType<Scripts.Schema>,
): void {
    const runtime = ctx._runtime;
    if (!runtime) return;
    Rpc.send(runtime.rpc, registry.commandWireIndex, handle, data, runtime.roomId);
}

export function listen(
    ctx: ScriptContext,
    handle: CommandHandle<Scripts.Schema, 'client_to_server'>,
    fn: (data: Scripts.SchemaType<Scripts.Schema>, from: Client) => void,
): Unsubscribe;
export function listen(
    ctx: ScriptContext,
    handle: CommandHandle<Scripts.Schema, 'server_to_client'>,
    fn: (data: Scripts.SchemaType<Scripts.Schema>) => void,
): Unsubscribe;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function listen(
    ctx: ScriptContext,
    handle: CommandHandle<Scripts.Schema, any>,
    fn: (...args: any[]) => void,
): Unsubscribe {
    const runtime = ctx._runtime;
    const instance = ctx._instance;
    if (!runtime || !instance) return noop;

    const entry = Rpc.listen(runtime.rpc, handle.id, fn, runtime.roomId);
    const record = { commandId: handle.id, entry };
    instance.netListeners.push(record);
    return () => {
        const i = instance.netListeners.indexOf(record);
        if (i !== -1) instance.netListeners.splice(i, 1);
        Rpc.unlisten(runtime.rpc, handle.id, entry);
    };
}

/* ── script instance creation ───────────────────────────────────── */

export function createScriptInstance(def: ScriptDef, trait: TraitBase, node: SceneTree.Node, runtime: SceneTreeContext): ScriptInstance {
    const instance: ScriptInstance = {
        def,
        node,
        trait,
        onInit: new Set(),
        onInput: new Set(),
        onUpdate: new Set(),
        onTick: new Set(),
        onFrame: new Set(),
        onDispose: new Set(),
        onEnter: new Set(),
        onExit: new Set(),
        onJoin: new Set(),
        onLeave: new Set(),
        onPrePhysicsStep: new Set(),
        onPostPhysicsStep: new Set(),
        onPostAnimate: new Set(),
        onPhysicsContactAdded: new Set(),
        onPhysicsContactPersisted: new Set(),
        onPhysicsBodyPairValidate: new Set(),
        onSwap: null,
        queries: new Set(),
        netListeners: [],
        initialized: false,
        _runtime: runtime,
        _ctx: undefined as unknown as ScriptContext, // set below
    };

    // ctx.client is the live, shared per-room client context. The engine
    // wires `.room`/`.state`/`.camera` onto it shortly AFTER scripts
    // instantiate (the room object doesn't exist yet at this point), so hold
    // the reference directly, a copy here would freeze those fields as
    // `undefined` forever, breaking isOwner / playMono / getSubject for
    // editor:true world systems. The editor lens is reachable via
    // `ctx.client.room?.editor`.
    const client = runtime.client;

    instance._ctx = {
        trait,
        node,
        nodes: node.scene!,
        mode: runtime.playerMode,
        voxels: runtime.voxels,
        physics: runtime.physics,
        clock: runtime.clock,
        blocks: runtime.blocks,
        client,
        server: runtime.server,
        _instance: instance,
        _runtime: runtime,
    };

    return instance;
}

/* ── script instance lifecycle ───────────────────────────────────── */

/**
 * run the factory body, registers onInit/onSwap/onTick/listen handlers via
 * ctx hooks. split out from `initScriptInstance` so the swap path can run
 * the factory, restore snapshot via `onSwap.des`, then fire onInit (so
 * onInit hooks see rehydrated state, not factory defaults).
 */
function runFactory(instance: ScriptInstance): void {
    if (instance.initialized) return;
    instance.initialized = true;
    const id = instance.def.key;
    const nodeId = instance.node.id;
    try {
        instance.def.factory(instance._ctx);
    } catch (err) {
        logScriptError(`script '${id}' factory @${nodeId}`, err);
    }
}

/** fire the onInit handlers the factory registered. see `runFactory`. */
function fireOnInit(instance: ScriptInstance): void {
    const id = instance.def.key;
    const nodeId = instance.node.id;
    for (const fn of instance.onInit) {
        try {
            fn();
        } catch (err) {
            logScriptError(`script '${id}'.onInit @${nodeId}`, err);
        }
    }
}

export function initScriptInstance(instance: ScriptInstance): void {
    runFactory(instance);
    fireOnInit(instance);
}

export function disposeScriptInstance(instance: ScriptInstance): void {
    const id = instance.def.key;
    const nodeId = instance.node.id;

    // onDispose hook
    for (const fn of instance.onDispose) {
        try {
            fn();
        } catch (err) {
            logScriptError(`script '${id}'.onDispose @${nodeId}`, err);
        }
    }

    // release queries
    if (instance.node.scene) {
        for (const q of instance.queries) {
            SceneTree.releaseQuery(instance.node.scene, q);
        }
    }
    instance.queries.clear();

    // release net listeners by walking the registration data and
    // unlistening per record, no stored closures, just data.
    for (const { commandId, entry } of instance.netListeners) {
        Rpc.unlisten(instance._runtime.rpc, commandId, entry);
    }
    instance.netListeners.length = 0;
}

export function tickScriptInstance(instance: ScriptInstance, args: TickArgs): void {
    for (const fn of instance.onTick) {
        try {
            fn(args);
        } catch (err) {
            logScriptError(`script '${instance.def.key}'.onTick @${instance.node.id}`, err);
        }
    }
}

export function postAnimateScriptInstance(instance: ScriptInstance, args: TickArgs): void {
    for (const fn of instance.onPostAnimate) {
        try {
            fn(args);
        } catch (err) {
            logScriptError(`script '${instance.def.key}'.onPostAnimate @${instance.node.id}`, err);
        }
    }
}

export function frameScriptInstance(instance: ScriptInstance, args: FrameArgs): void {
    for (const fn of instance.onFrame) {
        try {
            fn(args);
        } catch (err) {
            logScriptError(`script '${instance.def.key}'.onFrame @${instance.node.id}`, err);
        }
    }
}

export function inputScriptInstance(instance: ScriptInstance, args: FrameArgs): void {
    for (const fn of instance.onInput) {
        try {
            fn(args);
        } catch (err) {
            logScriptError(`script '${instance.def.key}'.onInput @${instance.node.id}`, err);
        }
    }
}

/**
 * fire join hooks on all script instances in a scene graph.
 * called by the server after a client joins a room.
 */
export function fireJoinHooks(
    runtime: SceneTreeContext,
    client: ClientId,
    user: User,
    joinData: Record<string, JsonValue>,
    playerNode: SceneTree.Node,
    avatar: Avatar,
): void {
    const args: JoinArgs = {
        client,
        playerNode,
        user,
        joinData,
        characterModelId: avatar.modelId,
        rigType: avatar.rigType,
    };
    for (const nodeInstances of runtime.instances.values()) {
        for (const instance of nodeInstances.values()) {
            for (const fn of instance.onJoin) {
                try {
                    fn(args);
                } catch (err) {
                    logScriptError(`script '${instance.def.key}'.onJoin @${instance.node.id}`, err);
                }
            }
        }
    }
}

/**
 * fire leave hooks on all script instances in a scene graph.
 * called by the server before a client leaves a room.
 */
export function fireLeaveHooks(runtime: SceneTreeContext, client: ClientId, playerNode: SceneTree.Node): void {
    const args: LeaveArgs = { client, playerNode };
    for (const nodeInstances of runtime.instances.values()) {
        for (const instance of nodeInstances.values()) {
            for (const fn of instance.onLeave) {
                try {
                    fn(args);
                } catch (err) {
                    logScriptError(`script '${instance.def.key}'.onLeave @${instance.node.id}`, err);
                }
            }
        }
    }
}

/** fire onEnter hooks on all script instances of a node */
export function fireEnterHooks(runtime: SceneTreeContext, node: SceneTree.Node, parent: SceneTree.Node): void {
    const nodeInstances = runtime.instances.get(node.id);
    if (!nodeInstances) return;
    for (const instance of nodeInstances.values()) {
        for (const fn of instance.onEnter) {
            try {
                fn(parent);
            } catch (err) {
                logScriptError(`script '${instance.def.key}'.onEnter @${node.id}`, err);
            }
        }
    }
}

/** fire onExit hooks on all script instances of a node */
export function fireExitHooks(runtime: SceneTreeContext, node: SceneTree.Node, parent: SceneTree.Node): void {
    const nodeInstances = runtime.instances.get(node.id);
    if (!nodeInstances) return;
    for (const instance of nodeInstances.values()) {
        for (const fn of instance.onExit) {
            try {
                fn(parent);
            } catch (err) {
                logScriptError(`script '${instance.def.key}'.onExit @${node.id}`, err);
            }
        }
    }
}

export function swapScriptInstance(oldInstance: ScriptInstance, newDef: ScriptDef, runtime: SceneTreeContext): ScriptInstance {
    let snapshot: unknown;
    if (oldInstance.onSwap) {
        snapshot = oldInstance.onSwap.ser();
    }
    disposeScriptInstance(oldInstance);
    const newInstance = createScriptInstance(newDef, oldInstance.trait, oldInstance.node, runtime);
    // factory runs first so the new instance registers its onSwap + onInit
    // handlers. then des() rehydrates factory-scope state from the prior
    // instance. only THEN fire onInit, so init code sees restored state
    // rather than factory defaults, e.g. spawning UI per restored entry,
    // attaching listeners by restored id, etc.
    runFactory(newInstance);
    if (snapshot !== undefined && newInstance.onSwap) {
        newInstance.onSwap.des(snapshot);
    }
    fireOnInit(newInstance);
    return newInstance;
}

/**
 * re-run every live script factory against the current `traitsRegistry`
 * so edits to script bodies (handlers, init code, constants) take effect
 * on HMR. factory-closure locals are reset by design, `onSwap` is the
 * opt-in for preserving state across reloads.
 *
 * called from `applyRegistryChanges*` per-room. removed defs are disposed
 * here; newly-added defs get picked up by the subsequent `initSceneTree`
 * pass via `instantiateTraitScripts`.
 *
 * `dirtyScriptIds` narrows the swap to a known-affected subset (DepGraph
 * propagation from a producer change reaching `scripts:<id>` consumers via
 * the per-script `setDeps` wiring). pass `null` for the trait-body-edit
 * path that needs every instance re-run, even unchanged scripts can become
 * structurally invalid if a trait field they depend on moved indices.
 */
/**
 * Mirror a `registry.scripts` removal into the owning trait def. `script()`
 * only ever upserts into a trait's `scripts[]`/`scriptsById`, so a `script()`
 * call deleted from source has no effect on a trait def that outlives the
 * edit, a built-in trait (def in an engine module) or any trait defined in a
 * *different* file than the removed `script()`. The registry detects the
 * deletion (drops the key on the owning module's reload) and emits a
 * `{ kind: 'removed' }` change; dispatch drains that change and calls this so
 * the def stops listing the orphan. With the def corrected, the normal
 * `applyTraitSwap` lookup disposes the live instance and
 * `instantiateTraitScripts` won't re-create it. `scripts[]` slots are
 * positional, so rebuild + reindex from the surviving entries.
 */
export function pruneRemovedScript(def: ScriptDef): void {
    const traitDef = registry.traits.byId.get(def.traitId)?.payload;
    if (!traitDef?.scriptsById.delete(def.scriptId)) return;
    const remaining = [...traitDef.scriptsById.values()].sort((a, b) => a.index - b.index).map((entry) => entry.reg);
    traitDef.scripts = remaining;
    remaining.forEach((reg, index) => {
        traitDef.scriptsById.set(reg.scriptId, { reg, index });
    });
}

export function applyTraitSwap(runtime: SceneTreeContext, dirtyScriptIds: ReadonlySet<string> | null = null): void {
    for (const [nodeId, nodeInstances] of runtime.instances) {
        for (const [instanceKey, oldInstance] of nodeInstances) {
            if (dirtyScriptIds && !dirtyScriptIds.has(instanceKey)) continue;
            const { traitId, scriptId } = oldInstance.def;

            const newTraitDef = registry.traits.byId.get(traitId)?.payload;
            const newDef = newTraitDef?.scriptsById.get(scriptId)?.reg;

            if (!newDef) {
                disposeScriptInstance(oldInstance);
                nodeInstances.delete(instanceKey);
                continue;
            }

            const newInstance = swapScriptInstance(oldInstance, newDef, runtime);
            nodeInstances.set(instanceKey, newInstance);
        }
        if (nodeInstances.size === 0) runtime.instances.delete(nodeId);
    }
}
