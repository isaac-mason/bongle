import type { Client, JsonValue, User } from 'bongle/interface';
import type { ContactManifold, ContactSettings, RigidBody } from 'crashcat';
import type { Dashboard } from '../../client/debug';
import type { Scene } from 'gpucat';
import type * as Scripts from 'packcat';
import type { EngineClient } from '../../client/client';
import type { Input } from '../../client/input';
import type { ClientRoom } from '../../client/rooms';
import { env } from '../../env';
import type { Room } from '../../server/rooms';
import type { EngineServer } from '../../server/server';
import type { Avatar } from '../avatar/avatar';
import type { DepHandle } from '../capture/dep-graph';
import type { ClientId } from '../client';
import type { Clock } from '../clock';
import type { Physics } from '../physics/physics';
import type { PlayerMode, RoomMode } from '../protocol';
import { registry, traitStore } from '../registry';
import type { Resources } from '../resources';
import type { CommandHandle } from '../rpc';
import * as Rpc from '../rpc';
import * as blockHooks from '../voxels/block-hooks';
import type { Blocks } from '../voxels/block-registry';
import type { Voxels } from '../voxels/voxels';
import type { Condition, ConditionArgs, ConditionArgsToConditions } from './conditions';
import * as SceneTree from './scene-tree';
import { logScriptError } from './script-errors';
import { scriptsById, type TraitBase, type TraitHandle } from './traits';

export type Unsubscribe = () => void;

/** client-side debug state, reachable from scripts as `ctx.client.debug`. */
export type ClientDebugState = {
    readonly dashboard: Dashboard;
};

/** the gpucat render scenes for a room; grouped so the logical scene tree can own the bare `scene` name. */
export type RenderScenes = {
    scene: Scene;

    /** crisp, post-fxaa overlay content; shares the main scene's depth read-only so `depthTest` meshes aren't blurred by the post-chain. */
    overlayScene: Scene;
};

export type ClientContext = {
    /** the gpucat render scenes this client renders into */
    render: RenderScenes;

    /** the node local input drives and what renderer + audio treat as this client's point of view; read/swap via getSubject/setSubject. */
    subject: SceneTree.Node | null;

    /** local player body node, alias for `room.playerNode`; the server-side streaming anchor. */
    player: SceneTree.Node;

    /** active render camera node; read/swap via getCamera/setCamera, defaults to `defaultCamera`. */
    camera: SceneTree.Node;

    /** the subject to return to when a temporary override (editor lens, spectator, cinematic) ends. */
    defaultSubject: SceneTree.Node | null;

    /** the camera to return to alongside `defaultSubject`. */
    defaultCamera: SceneTree.Node;

    /** per-room overlay viewport div for HTML overlays; `pointer-events: none` unless a child opts in. */
    viewport: HTMLDivElement;

    /** per-room touch overlay div under `viewport`; touch controls mount their roots here. */
    touchOverlay: HTMLDivElement;

    clientId: ClientId | undefined;

    /** client debug surface; `dashboard` is the shared `Dashboard` games dock panels on, built lazily on first access. */
    debug: ClientDebugState;

    input: Input;

    state?: EngineClient;

    room?: ClientRoom;
};

export type ServerContext = {
    state: EngineServer;

    room: Room;

    /** matchmaking opts stamped on this room's namespace at creation; empty for the editor namespace. */
    readonly options: Readonly<Record<string, string | number | boolean>>;
};

export type SceneTreeContext = {
    roomId: string;

    /** the viewer's mode for this room, surfaced to scripts as `ctx.mode`; equals `roomMode` on the server. */
    playerMode: PlayerMode;

    /** the room's authoritative mode, independent of the viewer; an edit Player attached to a play room still bakes voxels. */
    roomMode: RoomMode;

    resources: Resources;

    /** `listen()` scopes registrations by roomId so per-room handlers don't cross rooms. */
    rpc: Rpc.Rpc;

    /** client-specific context, undefined on server */
    client: ClientContext | undefined;

    /** server-specific context, undefined on client */
    server: ServerContext | undefined;

    /** true on a real server room and on a client-only local room; false on a client connected to a remote server. */
    authority: boolean;

    voxels: Voxels;

    physics: Physics;

    clock: Clock;

    blocks: Blocks;

    /** live script instances, keyed by node id, then script id (`${trait.id}#${scriptIndex}`). */
    instances: Map<number, Map<string, ScriptInstance>>;
};

export type ScriptOptions = {
    /** whether the script should run in edit mode, default false. */
    editor?: boolean;

    /** producer handles whose changes trigger a rebuild of this script; usually injected by the AST rewriter. */
    deps?: ReadonlyArray<DepHandle>;
};

export type ScriptContext<T extends TraitBase = TraitBase> = {
    mode: 'edit' | 'play';

    /** the trait instance this script is bound to, fully typed for the TraitHandle passed to `script()`. */
    trait: T;

    /** the node the bound trait is attached to */
    node: SceneTree.Node;

    scene: SceneTree.SceneTree;

    voxels: Voxels;

    physics: Physics;

    clock: Clock;

    /** derived from `voxels.registry` at construction, never cached: an HMR block change repoints `voxels.registry`. */
    blocks: Blocks;

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
    def: ScriptDef;

    initialized: boolean;

    node: SceneTree.Node;

    /** the trait instance this script is bound to; used to filter live instances on removeTrait. */
    trait: TraitBase;

    /** fired once on initial script attach, before the script enters the scene tree */
    onInit: Set<() => void>;

    /** client-only: fires once per frame at the very start, before onUpdate. */
    onInput: Set<(args: FrameArgs) => void>;

    /** fired once per frame, before the tick loop */
    onUpdate: Set<(args: UpdateArgs) => void>;

    onTick: Set<(args: TickArgs) => void>;

    /** client-only: fires once per frame, before the tick loop */
    onFrame: Set<(args: FrameArgs) => void>;

    onDispose: Set<() => void>;

    /** fired when the node enters the scene tree (initial attach or reparent attach) */
    onEnter: Set<(parent: SceneTree.Node) => void>;

    /** fired when the node exits the scene tree (detach or before reparent detach) */
    onExit: Set<(parent: SceneTree.Node) => void>;

    /** authority-only */
    onJoin: Set<(args: JoinArgs) => void>;

    /** authority-only */
    onLeave: Set<(args: LeaveArgs) => void>;

    onPrePhysicsStep: Set<(args: TickArgs) => void>;

    onPostPhysicsStep: Set<(args: TickArgs) => void>;

    /** fired after animator sampling, before world-matrix recompute. */
    onPostAnimate: Set<(args: TickArgs) => void>;

    onPhysicsContactAdded: Set<(args: PhysicsContactArgs) => void>;

    onPhysicsContactPersisted: Set<(args: PhysicsContactArgs) => void>;

    /** return false to reject the collision */
    onPhysicsBodyPairValidate: Set<(bodyA: RigidBody, bodyB: RigidBody) => boolean>;

    onSwap: { ser: () => unknown; des: (data: unknown) => void } | null;

    /** queries acquired via `query(ctx, ...)`; released on dispose so unused queries are evicted from the scene tree's query map. */
    queries: Set<SceneTree.Query<any>>;

    /** query membership handlers owned by this instance; disposeScriptInstance walks this to fire the closing exit for every matching node. */
    queryHooks: Array<{ q: SceneTree.Query<any>; kind: 'enter' | 'exit'; fn: (...args: any[]) => void }>;

    /** rpc listener registrations owned by this instance, walked by disposeScriptInstance to call `Rpc.unlisten`. */
    netListeners: Array<{ commandId: string; entry: Rpc.ListenerEntry }>;

    _runtime: SceneTreeContext;

    /** context passed to the factory, held until initScriptInstance runs the factory, then cleared */
    _ctx: ScriptContext;
};

export type ScriptFactory<T extends TraitBase = TraitBase> = (ctx: ScriptContext<T>) => void;

export type ScriptBody = {
    factory: ScriptFactory;
    /** if true, this script's hooks register in edit mode too, default false. */
    editor: boolean;
};

/** stored ScriptDef; `key` is the composed `${traitId}.${scriptId}`, don't parse it apart, read `traitId`/`scriptId` directly. */
export type ScriptDef = ScriptBody & {
    traitId: string;
    scriptId: string;
    key: string;
    /** lets the AST rewrite wrap `script(...)` calls with `__addDeps(h, [...])`. */
    dependency: { registry: 'scripts'; id: string };
};

const noop: Unsubscribe = () => {};

/** register (or reuse) a live query tied to this script instance's lifetime; released when the instance disposes. */
export function query<const Args extends ConditionArgs[]>(
    ctx: ScriptContext,
    conditions: Args,
): SceneTree.Query<ConditionArgsToConditions<Args>> {
    const q = SceneTree.query(ctx.scene, conditions);
    const instance = ctx._instance;
    if (instance && !instance.queries.has(q)) {
        instance.queries.add(q);
        SceneTree.acquireQuery(ctx.scene, q);
    }
    return q;
}

/** react to a node starting to match `q`; fires immediately for every node already matching. paired with `onQueryExit`. */
export function onQueryEnter<Conditions extends Condition[]>(
    ctx: ScriptContext,
    q: SceneTree.Query<Conditions>,
    fn: QueryListener<Conditions>,
): Unsubscribe {
    return addQueryHook(ctx, q, 'enter', fn);
}

/** react to a node stopping matching `q`; fires once more, for every still-matching node, when unsubscribed or disposed. */
export function onQueryExit<Conditions extends Condition[]>(
    ctx: ScriptContext,
    q: SceneTree.Query<Conditions>,
    fn: QueryListener<Conditions>,
): Unsubscribe {
    return addQueryHook(ctx, q, 'exit', fn);
}

type QueryListener<Conditions extends Condition[]> = Parameters<typeof SceneTree.onQueryEnter<Conditions>>[1];

function addQueryHook<Conditions extends Condition[]>(
    ctx: ScriptContext,
    q: SceneTree.Query<Conditions>,
    kind: 'enter' | 'exit',
    fn: QueryListener<Conditions>,
): Unsubscribe {
    const instance = ctx._instance;
    if (!instance) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;

    // wrapped so a throwing handler is reported with the script's own identity and never escapes into the scene-tree mutation.
    const wrapped = (...args: unknown[]): void => {
        try {
            (fn as (...a: unknown[]) => void)(...args);
        } catch (err) {
            logScriptError(`script '${instance.def.key}'.onQuery${kind === 'enter' ? 'Enter' : 'Exit'}`, err);
        }
    };

    const record = { q: q as SceneTree.Query<any>, kind, fn: wrapped };
    instance.queryHooks.push(record);

    if (kind === 'enter') SceneTree.onQueryEnter(q, wrapped as QueryListener<Conditions>);
    else SceneTree.onQueryExit(q, wrapped as QueryListener<Conditions>);

    return () => {
        const i = instance.queryHooks.indexOf(record);
        if (i === -1) return;
        instance.queryHooks.splice(i, 1);
        releaseQueryHook(record);
    };
}

/** take one hook back off its query; for an exit hook this drains the closing exits. */
function releaseQueryHook(record: ScriptInstance['queryHooks'][number]): void {
    if (record.kind === 'enter') SceneTree.offQueryEnter(record.q, record.fn);
    else SceneTree.offQueryExit(record.q, record.fn);
}

export function filter<const Args extends ConditionArgs[]>(ctx: ScriptContext, conditions: Args): SceneTree.Node[] {
    return SceneTree.filter(ctx.scene, conditions);
}

export function first<T extends TraitBase>(ctx: ScriptContext, trait: TraitHandle<T>): T | null {
    const node = SceneTree.findAncestor(ctx.node, [trait]);
    if (!node) return null;
    return node[0];
}

/** true when this runtime owns the room simulation: a real server room, or a
 *  client-only local/standalone room where the client IS the server. */
function isRoomAuthority(ctx: ScriptContext): boolean {
    return ctx._runtime?.authority ?? false;
}

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

/** fires once per frame, before the fixed-timestep tick loop; client-only, no-op on the server. */
export function onUpdate(ctx: ScriptContext, fn: (args: UpdateArgs) => void): Unsubscribe {
    const instance = ctx._instance;
    if (!instance) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
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

/** fires at the very start of each frame, before onUpdate/onTick/onFrame; iteration order matches onFrame. client-only. */
export function onInput(ctx: ScriptContext, fn: (args: FrameArgs) => void): Unsubscribe {
    const instance = ctx._instance;
    if (!instance) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
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

/** fires when this script's node enters the scene tree: initial attach and every reparent, after the new parent is set. */
export function onEnter(ctx: ScriptContext, fn: (parent: SceneTree.Node) => void): Unsubscribe {
    const instance = ctx._instance;
    if (!instance) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    instance.onEnter.add(fn);
    return () => instance.onEnter.delete(fn);
}

/** fires when this script's node exits the scene tree: detach and before every reparent detach. */
export function onExit(ctx: ScriptContext, fn: (parent: SceneTree.Node) => void): Unsubscribe {
    const instance = ctx._instance;
    if (!instance) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    instance.onExit.add(fn);
    return () => instance.onExit.delete(fn);
}

/** join-data key carrying the editor's viewpoint when a session is launched via the editor "play" button; absent for normal joins. */
export const EDITOR_JOIN_KEY = '__editor';

/** editor viewpoint pose passed under `EDITOR_JOIN_KEY` in join data. */
export type EditorPlayData = {
    position: [number, number, number];
    quaternion: [number, number, number, number];
};

export type JoinArgs = {
    client: ClientId;
    playerNode: SceneTree.Node;
    user: User;
    joinData: Record<string, JsonValue>;
    /** 'edit' for an editor (including one inspecting a play room), 'play' otherwise. */
    mode: PlayerMode;
    /** already stamped onto `playerNode`'s CharacterTrait before this fires. */
    characterModelId: string;
    /** e.g. `RIG_TYPE_6BONE`; lets onJoin branch on rig family without reaching for the trait. */
    rigType: string;
};

/** fires when a client joins the room; authority-only, no-op on a client connected to a remote server. */
export function onJoin(ctx: ScriptContext, fn: (args: JoinArgs) => void): Unsubscribe {
    const instance = ctx._instance;
    if (!instance || !isRoomAuthority(ctx)) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    instance.onJoin.add(fn);
    return () => instance.onJoin.delete(fn);
}

export type LeaveArgs = {
    client: ClientId;
    playerNode: SceneTree.Node;
};

/** fires when a client leaves the room; authority-only, no-op on a client connected to a remote server. */
export function onLeave(ctx: ScriptContext, fn: (args: LeaveArgs) => void): Unsubscribe {
    const instance = ctx._instance;
    if (!instance || !isRoomAuthority(ctx)) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    instance.onLeave.add(fn);
    return () => instance.onLeave.delete(fn);
}

/** fires when a block of `block`'s type is built (placed where air or a different block was); authority-only. */
export function onBlockBuild(
    ctx: ScriptContext,
    block: import('../voxels/blocks').BlockHandle,
    fn: (event: import('../voxels/blocks').BlockChangeCtx) => void,
): Unsubscribe {
    const instance = ctx._instance;
    if (!instance || !isRoomAuthority(ctx)) return noop;
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

/** fires when a block of `block`'s type is broken (replaced with air or a different block); authority-only. */
export function onBlockBreak(
    ctx: ScriptContext,
    block: import('../voxels/blocks').BlockHandle,
    fn: (event: import('../voxels/blocks').BlockChangeCtx) => void,
): Unsubscribe {
    const instance = ctx._instance;
    if (!instance || !isRoomAuthority(ctx)) return noop;
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

/** fires when a block of `block`'s type changes state in place (same block-type, different stateId); authority-only. */
export function onBlockStateChange(
    ctx: ScriptContext,
    block: import('../voxels/blocks').BlockHandle,
    fn: (event: import('../voxels/blocks').BlockStateChangeCtx) => void,
): Unsubscribe {
    const instance = ctx._instance;
    if (!instance || !isRoomAuthority(ctx)) return noop;
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

/** fires before each physics step; use to apply forces, set velocities, or prepare body state. */
export function onPrePhysicsStep(ctx: ScriptContext, fn: (args: TickArgs) => void): Unsubscribe {
    const instance = ctx._instance;
    if (!instance) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    instance.onPrePhysicsStep.add(fn);
    return () => instance.onPrePhysicsStep.delete(fn);
}

/** fires after each physics step; use to read collision results and updated positions/velocities. */
export function onPostPhysicsStep(ctx: ScriptContext, fn: (args: TickArgs) => void): Unsubscribe {
    const instance = ctx._instance;
    if (!instance) return noop;
    if (ctx.mode === 'edit' && !instance.def.editor) return noop;
    instance.onPostPhysicsStep.add(fn);
    return () => instance.onPostPhysicsStep.delete(fn);
}

/** fires after animator sampling, before world-matrix recompute; good for head-look, springs/dampers, and constraint clamps. */
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

/** fires during the physics step when a contact is added or persists; modify `settings` to customize contact behavior. */
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

/** fires during broadphase to validate body pairs; rejected if any registered callback returns false. */
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

/** true if the caller has write authority over `node`: on a client the active Player owns it, on the server it has no client owner. */
export function isOwner(ctx: ScriptContext, node: SceneTree.Node): boolean {
    if (env.server) return node.owner == null;
    const playerId = ctx.client?.room?.playerId;
    return playerId != null && node.owner === playerId;
}

export function send<S extends Scripts.Schema, Direction extends Rpc.RpcDirection>(
    ctx: ScriptContext,
    handle: CommandHandle<S, Direction>,
    data: Scripts.SchemaType<S>,
    client?: Direction extends typeof Rpc.SERVER_TO_CLIENT ? Client : never,
): void {
    const runtime = ctx._runtime;
    if (!runtime) return;
    Rpc.send(runtime.rpc, registry.protocol.commands, handle, data as never, runtime.roomId, client);
}

export function broadcast<S extends Scripts.Schema>(
    ctx: ScriptContext,
    handle: CommandHandle<S, 'server_to_client'>,
    data: Scripts.SchemaType<S>,
): void {
    const runtime = ctx._runtime;
    if (!runtime) return;
    Rpc.send(runtime.rpc, registry.protocol.commands, handle, data as never, runtime.roomId);
}

export function listen<S extends Scripts.Schema>(
    ctx: ScriptContext,
    handle: CommandHandle<S, 'client_to_server'>,
    fn: (data: Scripts.SchemaType<S>, from: Client) => void,
): Unsubscribe;
export function listen<S extends Scripts.Schema>(
    ctx: ScriptContext,
    handle: CommandHandle<S, 'server_to_client'>,
    fn: (data: Scripts.SchemaType<S>) => void,
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

export function createScriptInstance(
    def: ScriptDef,
    trait: TraitBase,
    node: SceneTree.Node,
    runtime: SceneTreeContext,
): ScriptInstance {
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
        queryHooks: [],
        netListeners: [],
        initialized: false,
        _runtime: runtime,
        _ctx: undefined as unknown as ScriptContext, // set below
    };

    // ctx.client is the live, shared per-room client context; the engine wires .room/.state/.camera onto it after scripts instantiate.
    const client = runtime.client;

    instance._ctx = {
        trait,
        node,
        scene: node.scene!,
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

/** runs the factory body; split out from `initScriptInstance` so the swap path can restore a snapshot before firing onInit. */
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

    // query membership hooks first: each exit hook fires once more for every node still matching, before onDispose runs.
    for (const record of instance.queryHooks) {
        releaseQueryHook(record);
    }
    instance.queryHooks.length = 0;

    for (const fn of instance.onDispose) {
        try {
            fn();
        } catch (err) {
            logScriptError(`script '${id}'.onDispose @${nodeId}`, err);
        }
    }

    if (instance.node.scene) {
        for (const q of instance.queries) {
            SceneTree.releaseQuery(instance.node.scene, q);
        }
    }
    instance.queries.clear();

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

/** fire join hooks on all script instances in a scene graph */
export function fireJoinHooks(
    runtime: SceneTreeContext,
    client: ClientId,
    user: User,
    joinData: Record<string, JsonValue>,
    mode: PlayerMode,
    playerNode: SceneTree.Node,
    avatar: Avatar,
): void {
    const args: JoinArgs = {
        client,
        playerNode,
        user,
        joinData,
        mode,
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

/** fire leave hooks on all script instances in a scene graph */
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
    // factory runs first to register onSwap/onInit, then des() rehydrates state before onInit fires.
    runFactory(newInstance);
    if (snapshot !== undefined && newInstance.onSwap) {
        newInstance.onSwap.des(snapshot);
    }
    fireOnInit(newInstance);
    return newInstance;
}

/** drops an orphaned `script()` call from its owning trait def; `applyTraitSwap` then disposes the live instance. */
export function pruneRemovedScript(def: ScriptDef): void {
    const traitHandle = traitStore.handles.get(def.traitId);
    if (!traitHandle) return;
    const scripts = traitHandle.def.scripts;
    const scriptIndex = scripts.findIndex((script) => script.scriptId === def.scriptId);
    if (scriptIndex === -1) return;
    scripts.splice(scriptIndex, 1);
}

/** re-runs every live script factory so HMR edits take effect; pass `dirtyScriptIds` null to re-run every instance. */
export function applyTraitSwap(runtime: SceneTreeContext, dirtyScriptIds: ReadonlySet<string> | null = null): void {
    for (const [nodeId, nodeInstances] of runtime.instances) {
        for (const [instanceKey, oldInstance] of nodeInstances) {
            if (dirtyScriptIds && !dirtyScriptIds.has(instanceKey)) continue;
            const { traitId, scriptId } = oldInstance.def;

            const newTraitHandle = traitStore.handles.get(traitId);
            const newDef = newTraitHandle && scriptsById(newTraitHandle).get(scriptId)?.reg;

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
