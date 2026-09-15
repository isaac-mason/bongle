# bongle API reference

The exhaustive signature list for the public `bongle` surface, generated from the
package's exports. For a guided, read-top-to-bottom introduction with runnable
examples, see [the guide](./docs.md).

## Scene graph & nodes

Create nodes, compose them with traits, and walk the tree.

#### `Node`

```ts
export type Node = {
    /** runtime-only numeric ID, not persisted. */
    id: number;

    name: string | undefined;

    parent: Node | null;

    children: Node[];

    /** cached sibling index, revalidated by {@link childIndexOf} before use. */
    childIndex: number;

    /** the scene tree this node belongs to, or null if detached. */
    scene: SceneTree | null;

    /** null = server-owned. Keyed per-Player rather than per-Client so one client holding multiple Players doesn't collapse onto one body. */
    owner: PlayerId | null;

    /** whether this node is saved to scene files; still replicated and hot-reloaded when false. default true. */
    persist: boolean;

    /** which side(s) this node lives on / is replicated to; see {@link Realm}. Realm boundaries cascade implicitly through 'inherit' descendants. */
    realm: Realm;

    /** trait instances indexed by trait slot; holes for slots the node doesn't carry. */
    traits: Array<TraitBase | undefined>;

    /** traits whose def isn't in the registry, keyed by trait id. */
    unresolved: Map<string, Record<string, unknown> | undefined> | null;

    bitset: Bitset;

    /** bumped on structural changes to the node. */
    version: number;

    /** if non-null, this node is a prefab instance; only the prefab config is persisted, its children have persist: false. */
    prefab: PrefabConfig | null;
};
```

#### `Realm`

```ts
/** Which side(s) a node lives on: 'inherit' (default, takes the nearest non-inherit ancestor's realm), 'shared', 'client', 'server', or 'each' (server and every client get an independent copy). */
export type Realm = 'inherit' | 'shared' | 'client' | 'server' | 'each';
```

#### `addChild`

```ts
/** Adds a child node to a parent; if the child already has a parent it's removed first, and if the parent is in a scene tree the child registers into it. */
export function addChild(parent: Node, child: Node): void;
```

#### `findAncestor`

```ts
/** Walks up the tree from `node.parent` toward the root and returns the first ancestor that has all of the given traits, as a tuple, or null; ad-hoc, not reactive. */
export function findAncestor<const Args extends TraitHandle[]>(node: Node, traits: Args): [
    ...traits: {
        [K in keyof Args]: Args[K] extends TraitHandle<infer T> ? T : never;
    }
] | null;
```

#### `findChildByName`

```ts
/** Finds the first descendant of `node` (depth-first) whose `name` matches `name`, or null; `node` itself is not considered a match. */
export function findChildByName(node: Node, name: string): Node | null;
```

#### `findChildrenByName`

```ts
/** Finds every descendant of `node` (depth-first) whose `name` matches `name`; prefer `findChildByName` for unique lookups. */
export function findChildrenByName(node: Node, name: string): Node[];
```

#### `getTrait`

```ts
export function getTrait<T extends TraitBase>(node: Node, handle: TraitHandle<T>): T | undefined;
```

#### `hasTrait`

```ts
export function hasTrait(node: Node, handle: TraitHandle): boolean;
```

#### `isLocalNode`

```ts
/** True iff this node was created locally (server allocates positive ids, a client negative ones); an origin test, unlike `isReplicable` (a realm-policy test). */
export function isLocalNode(node: Node): boolean;
```

#### `removeChild`

```ts
/** Removes a child from its parent; the child (and its descendants) are detached from the scene tree and removed from all queries. */
export function removeChild(parent: Node, child: Node): void;
```

#### `replaceChildren`

```ts
/** Replaces all children of `root` with `node`, destroying every other child; `node` must be a direct child of `root`. Mirrors the DOM's `replaceChildren()`. */
export function replaceChildren(root: Node, node: Node): void;
```

#### `traverse`

```ts
/**
 * depth-first pre-order traversal of a node and all its descendants.
 *
 * the callback receives each node. return `false` to skip that node's
 * children (prune). return anything else (or nothing) to continue.
 */
export function traverse(node: Node, callback: (node: Node) => boolean | void): void;
```

#### `cloneNode`

```ts
/**
 * clone a node and all its descendants. the returned subtree is **detached**,
 * attach with `addChild(parent, clone)` to wake it up.
 */
export function cloneNode(node: Node): Node;
```

#### `cloneModel`

```ts
/**
 * Clone a node for the visual scene: same as `cloneNode`, plus a `TransformTrait`
 * on the clone root so it can be positioned once attached. Reserve `cloneNode`
 * for non-visual duplication.
 *
 * @example
 * const instance = cloneModel(wizard.scene);
 * const hat = cloneModel(wizard.nodes.HatA);
 */
export function cloneModel(node: Node): Node;
```

#### `createNode`

```ts
/**
 * create a detached node (no parent, no scripts fired, not in queries).
 * attach with `addChild(parent, node)` to make it live; an id is allocated at
 * attach time (negative on the client, positive on the server).
 *
 * `realm` controls which side(s) the node lives on (default `'inherit'`,
 * resolving to the nearest ancestor's realm). Use `'server'` for nodes that
 * must never replicate, or `'client'` for purely local nodes.
 */
export function createNode(options?: {
    name?: string;
    persist?: boolean;
    realm?: Realm;
}): Node;
```

#### `addTrait`

```ts
/**
 * add a trait to a node. returns the new trait instance.
 */
export function addTrait<T extends TraitBase>(node: Node, traitHandle: TraitHandle<T>, props?: TraitProps<T>): T;
```

#### `removeTrait`

```ts
/**
 * remove a trait from a node.
 */
export function removeTrait(node: Node, traitHandle: TraitHandle): void;
```

#### `destroyNode`

```ts
/**
 * destroy a node and detach it from the scene.
 */
export function destroyNode(node: Node): void;
```

#### `findByName`

```ts
/**
 * depth-first search from `from` (inclusive) by node name.
 * returns the first matching node, or null if not found.
 */
export function findByName(from: Node, name: string): Node | null;
```
#### `TransformTrait`

```ts
export const TransformTrait;
```
#### `WorldTrait`

```ts
export const WorldTrait;
```

#### `attachWorldTrait`

```ts
/** idempotent, attaches WorldTrait to the scene root if it isn't already there. */
export function attachWorldTrait(root: Node): void;
```

## Transforms

Read and write node positions, rotations, and scales in local and world space.

#### `resetInterpolation`

```ts
/** re-seed prev pose from the node's current local TRS after a hard snap/teleport; no-op if not enrolled. */
export function resetInterpolation(node: Node): void;
```

#### `setInterpolation`

```ts
/** enroll/unenroll a node in the per-frame interpolation pass; idempotent and safe on nodes without TransformTrait. */
export function setInterpolation(node: Node, on: boolean): void;
```

#### `setPosition`

```ts
/** set local position and mark dirty. only the position slice replicates. */
export function setPosition(transform: TransformTrait, position: Vec3): void;
```

#### `setQuaternion`

```ts
/** set local quaternion and mark dirty. only the quaternion slice replicates. */
export function setQuaternion(transform: TransformTrait, quaternion: Quat): void;
```

#### `setScale`

```ts
/** set local scale and mark dirty. only the scale slice replicates. */
export function setScale(transform: TransformTrait, scale: Vec3): void;
```

#### `setTransform`

```ts
/** set all local transform fields and mark dirty (single dirty pass). */
export function setTransform(transform: TransformTrait, position: Vec3, quaternion: Quat, scale: Vec3): void;
```

#### `setWorldPosition`

```ts
export function setWorldPosition(transform: TransformTrait, worldPosition: Vec3): void;
```

#### `setWorldQuaternion`

```ts
export function setWorldQuaternion(transform: TransformTrait, worldQuaternion: Quat): void;
```

Also exported: `getVisualWorldMatrix`, `getVisualWorldPosition`, `getVisualWorldQuaternion`, `getVisualWorldScale`, `getWorldMatrix`, `getWorldPosition`, `getWorldQuaternion`, `getWorldScale`, `worldToLocalPosition`, `worldToLocalQuaternion`.

## Traits & schemas

Define traits and the schemas behind editor controls (`prop`) and network packing (`pack`).

#### `dirty`

```ts
/** `dirty` policy constructors. Byte-diff is the default; set-once fields that don't reliably byte-change opt into `explicit` and mark themselves via `SyncHandle.dirty()`. */
export const dirty: {
    diff: () => "diff";
    explicit: () => "explicit";
};
```

#### `rate`

```ts
/** `rate` policy constructors: the maximum send cadence for a dirty value. */
export const rate: {
    hz: (hz: number) => {
        hz: number;
    };
    realtime: () => "realtime";
};
```

#### `ControlDef`

```ts
/** Stored ControlDef, body + `{ traitId, controlId }`. */
export type ControlDef<T extends TraitBase = TraitBase, V = unknown> = ControlBody<T, V> & TraitChildStamp<'controlId'>;
```

#### `DirtyConfig`

```ts
/** What counts as a change worth sending: 'diff' (default) fires when the packed bytes differ, 'explicit' only via SyncHandle.dirty(). */
export type DirtyConfig = 'diff' | 'explicit';
```

#### `RateConfig`

```ts
/** Max send cadence for a dirty value: 'realtime' (default) sends every dirty tick, `{ hz }` caps the rate and sends the latest value once it elapses. */
export type RateConfig = 'realtime' | {
    hz: number;
};
```

#### `SyncDef`

```ts
/** Stored SyncDef, body + `{ traitId, syncId }`; wire envelope keys by registration index, not syncId. */
export type SyncDef<T extends TraitBase = TraitBase, S = unknown> = SyncBody<T, S> & TraitChildStamp<'syncId'>;
```

#### `SyncHandle`

```ts
/** Returned by sync() at registration time; dirty(instance) marks it changed without byte-diffing. */
export type SyncHandle<T extends TraitBase = TraitBase> = {
    readonly index: number;
    dirty(instance: T): void;
};
```

#### `TraitBase`

```ts
export type TraitBase = {
    _node: Node;
    _def: TraitDef;
    /** Allocated only when the trait has syncs. */
    _sync?: TraitSyncState;
};
```

#### `TraitBody`

```ts
/** Trait body: literal values are shared as the default, factories build a fresh value per instance. */
export type TraitBody = Record<string, unknown>;
```

#### `TraitDef`

```ts
/** The authored data for one trait; pure data, no back-references. */
export type TraitDef = {
    id: string;
    name: string;
    body: Record<string, unknown>;
    persist: boolean;
    icon: string | null;
    controls: ControlDef[];
    sync: SyncDef[];
    scripts: ScriptDef[];
};
```

#### `TraitHandle`

```ts
/** The handle returned by trait(). Used with getTrait, addTrait, hasTrait, query, findAncestor, etc. */
export type TraitHandle<T extends TraitBase = TraitBase> = {
    readonly id: string;
    /** Stable integer identity assigned the first time trait(id, ...) runs; distinct from netIndex. */
    readonly slot: number;
    readonly dependency: DepKey;
    def: TraitDef;
    /** Wire position stamped by reindexRegistry each flush; survives re-declaration. */
    netIndex: number | undefined;

    /** Phantom; carries the instance type for inference, not present at runtime. */
    readonly __type: T;
};
```

#### `TraitInstance`

```ts
export type TraitInstance<S extends TraitBody> = TraitBase & {
    [K in keyof S as K extends ReservedTraitKey ? never : K]: ResolveField<S[K], TraitInstance<S>>;
};
```

#### `TraitOptions`

```ts
export type TraitOptions = {
    name?: string;
    /** Default true; false for runtime-only traits. */
    persist?: boolean;
    /** sprite id drawn for the trait in the hierarchy, inspector and markers. */
    icon?: string;
};
```

#### `TraitType`

```ts
export type TraitType<H extends TraitHandle> = H['__type'];
```

#### `Self`

```ts
/** Placeholder for a field referencing this trait's own instance type; TraitInstance substitutes the real type. */
export type Self = TraitBase & {
    readonly [SELF_MARKER]: true;
};
```

#### `control`

```ts
/** register a control on a trait, callable multiple times per trait; `controlId` is the persisted key in scene files. */
export function control<T extends TraitBase, V>(handle: TraitHandle<T>, controlId: string, body: ControlBody<T, V>): void;
```

#### `sync`

```ts
/** register a sync on a trait, callable multiple times per trait; returns a SyncHandle for producer-side dirty hints. */
export function sync<T extends TraitBase, S>(handle: TraitHandle<T>, syncId: string, body: SyncBody<T, S>): SyncHandle<T>;
```

#### `trait`

```ts
/** define a trait; registers it in the global capture area and returns a handle used with getTrait, addTrait, hasTrait, query, etc. */
export function trait<S extends TraitBody = Record<string, never>>(id: string, body?: S, options?: TraitOptions): TraitHandle<TraitInstance<S>>;
```
#### `propToPack`

```ts
/** Converts a prop schema (prop.number, prop.vec3, etc.) to a packcat schema for binary serialization. Returns null for types that can't be cleanly mapped. */
export function propToPack(schema: PropSchema): PackcatSchema | null;
```

Also exported: `prop`.
Also exported: `pack`.

## Scripts & lifecycle

Attach behaviour and register lifecycle hooks.

#### `system`

```ts
/**
 * register a system: scene-scoped logic hosted on the always-attached
 * `WorldTrait`, running once per scene per side. sugar for
 * `script(WorldTrait, id, factory, opts)`, the preferred spelling for logic
 * that queries entities globally with `query(ctx, [...])`.
 *
 * @example
 * ```ts
 * system('character-animation', (ctx) => {
 *     if (!env.client) return;
 *     const q = query(ctx, [CharacterTrait, CharacterControllerTrait, TransformTrait]);
 *     onFrame(ctx, ({ delta }) => {
 *         for (const [ch, cc, transform] of q.matches) {
 *             // drive bones, read camera, etc.
 *         }
 *     });
 * });
 * ```
 */
export function system(id: string, factory: ScriptFactory<WorldScriptBase>, opts?: ScriptOptions): ScriptDef;
```

#### `ClientId`

```ts
/** numeric id assigned to a connected client. 0 = unassigned. */
export type ClientId = number;
```

#### `Condition`

```ts
export type Condition<T extends TraitHandle = TraitHandle, O extends Oper = Oper, S extends Src = Src> = {
    trait: T;
    oper: O;
    src: S;
};
```

#### `ConditionArgs`

```ts
export type ConditionArgs = TraitHandle | Condition<any, any, any>;
```

#### `Ancestor`

```ts
/** `t` strictly above this node: parent, then parents of parents. */
export function Ancestor<T extends TraitHandle>(t: T): Condition<T, Oper.And, Src.Ancestor>;
```

#### `Not`

```ts
/** node does not have `t`. contributes no tuple slot. */
export function Not<T extends TraitHandle>(t: T): Condition<T, Oper.Not, Src.Self>;
```

#### `Optional`

```ts
/**
 * make a term non-filtering: the node matches whether or not the trait
 * resolves, and its tuple slot is `null` when it doesn't. wraps `With`, `Up`
 * or `Ancestor`. `Optional(Not(...))` is meaningless and doesn't typecheck.
 */
export function Optional<T extends TraitHandle>(t: T): Condition<T, Oper.Optional, Src.Self>;
```

#### `Up`

```ts
/** `t` on this node, else on its nearest ancestor bearing it. */
export function Up<T extends TraitHandle>(t: T): Condition<T, Oper.And, Src.Up>;
```

#### `With`

```ts
/** node has `t`. a bare trait handle in a query arg list means this. */
export function With<T extends TraitHandle>(t: T): Condition<T, Oper.And, Src.Self>;
```

#### `QueryMatch`

```ts
/** one element of {@link QueryMatches}, the trait tuple a single query result yields. */
export type QueryMatch<Args extends ConditionArgs[]> = QueryMatches<Args>[number];
```

#### `QueryMatches`

```ts
/** The full `matches` array of a query, keyed by the same condition args passed to {@link query}. */
export type QueryMatches<Args extends ConditionArgs[]> = Query<ConditionArgsToConditions<Args>>['matches'];
```

#### `ClientContext`

```ts
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
```

#### `EditorPlayData`

```ts
/** editor viewpoint pose passed under `EDITOR_JOIN_KEY` in join data. */
export type EditorPlayData = {
    position: [number, number, number];
    quaternion: [number, number, number, number];
};
```

#### `FrameArgs`

```ts
export type FrameArgs = {
    delta: number;
};
```

#### `JoinArgs`

```ts
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
```

#### `LeaveArgs`

```ts
export type LeaveArgs = {
    client: ClientId;
    playerNode: SceneTree.Node;
};
```

#### `PhysicsContactArgs`

```ts
/** args passed to onPhysicsContact callbacks, raw crashcat types */
export type PhysicsContactArgs = {
    bodyA: RigidBody;
    bodyB: RigidBody;
    manifold: ContactManifold;
    settings: ContactSettings;
};
```

#### `ScriptContext`

```ts
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
```

#### `ScriptDef`

```ts
/** stored ScriptDef; `key` is the composed `${traitId}.${scriptId}`, don't parse it apart, read `traitId`/`scriptId` directly. */
export type ScriptDef = ScriptBody & {
    traitId: string;
    scriptId: string;
    key: string;
    /** lets the AST rewrite wrap `script(...)` calls with `__addDeps(h, [...])`. */
    dependency: { registry: 'scripts'; id: string };
};
```

#### `TickArgs`

```ts
/** the fixed simulation step, in seconds: `1 / tickRate` on the server, `1 / 60` on the
 *  client. Constant for the life of a room, and NOT the wall time since the previous
 *  tick: a server that overruns drops backlog rather than passing a longer step. */
export type TickArgs = {
    step: number;
};
```

#### `UpdateArgs`

```ts
/** real elapsed time since the previous frame, in seconds; varies frame to frame. */
export type UpdateArgs = {
    delta: number;
};
```

#### `editorPlayData`

```ts
/**
 * read the editor viewpoint from join data, if this session was launched via
 * the editor "play" button. returns `null` for normal joins so a game can
 * fall back to its usual spawn.
 */
export function editorPlayData(joinData: Record<string, JsonValue>): EditorPlayData | null;
```

#### `script`

```ts
/** register a script (behavior) on a trait, callable multiple times per trait; attaching the trait instantiates one ScriptInstance per script. */
export function script<T extends TraitBase>(handle: TraitHandle<T>, scriptId: string, factory: ScriptFactory<T>, opts?: ScriptOptions): ScriptDef;
```

#### `broadcast`

```ts
export function broadcast<S extends Scripts.Schema>(ctx: ScriptContext, handle: CommandHandle<S, 'server_to_client'>, data: Scripts.SchemaType<S>): void;
```

#### `filter`

```ts
export function filter<const Args extends ConditionArgs[]>(ctx: ScriptContext, conditions: Args): SceneTree.Node[];
```

#### `first`

```ts
export function first<T extends TraitBase>(ctx: ScriptContext, trait: TraitHandle<T>): T | null;
```

#### `isOwner`

```ts
/** true if the caller has write authority over `node`: on a client the active Player owns it, on the server it has no client owner. */
export function isOwner(ctx: ScriptContext, node: SceneTree.Node): boolean;
```

#### `listen`

```ts
export function listen<S extends Scripts.Schema>(ctx: ScriptContext, handle: CommandHandle<S, 'client_to_server'>, fn: (data: Scripts.SchemaType<S>, from: Client) => void): Unsubscribe;
```

#### `onBlockBreak`

```ts
/** fires when a block of `block`'s type is broken (replaced with air or a different block); authority-only. */
export function onBlockBreak(ctx: ScriptContext, block: import('../voxels/blocks').BlockHandle, fn: (event: import('../voxels/blocks').BlockChangeCtx) => void): Unsubscribe;
```

#### `onBlockBuild`

```ts
/** fires when a block of `block`'s type is built (placed where air or a different block was); authority-only. */
export function onBlockBuild(ctx: ScriptContext, block: import('../voxels/blocks').BlockHandle, fn: (event: import('../voxels/blocks').BlockChangeCtx) => void): Unsubscribe;
```

#### `onBlockStateChange`

```ts
/** fires when a block of `block`'s type changes state in place (same block-type, different stateId); authority-only. */
export function onBlockStateChange(ctx: ScriptContext, block: import('../voxels/blocks').BlockHandle, fn: (event: import('../voxels/blocks').BlockStateChangeCtx) => void): Unsubscribe;
```

#### `onDispose`

```ts
export function onDispose(ctx: ScriptContext, fn: () => void): Unsubscribe;
```

#### `onEnter`

```ts
/** fires when this script's node enters the scene tree: initial attach and every reparent, after the new parent is set. */
export function onEnter(ctx: ScriptContext, fn: (parent: SceneTree.Node) => void): Unsubscribe;
```

#### `onExit`

```ts
/** fires when this script's node exits the scene tree: detach and before every reparent detach. */
export function onExit(ctx: ScriptContext, fn: (parent: SceneTree.Node) => void): Unsubscribe;
```

#### `onFrame`

```ts
export function onFrame(ctx: ScriptContext, fn: (args: FrameArgs) => void): Unsubscribe;
```

#### `onInit`

```ts
export function onInit(ctx: ScriptContext, fn: () => void): Unsubscribe;
```

#### `onInput`

```ts
/** fires at the very start of each frame, before onUpdate/onTick/onFrame; iteration order matches onFrame. client-only. */
export function onInput(ctx: ScriptContext, fn: (args: FrameArgs) => void): Unsubscribe;
```

#### `onJoin`

```ts
/** fires when a client joins the room; authority-only, no-op on a client connected to a remote server. */
export function onJoin(ctx: ScriptContext, fn: (args: JoinArgs) => void): Unsubscribe;
```

#### `onLeave`

```ts
/** fires when a client leaves the room; authority-only, no-op on a client connected to a remote server. */
export function onLeave(ctx: ScriptContext, fn: (args: LeaveArgs) => void): Unsubscribe;
```

#### `onPhysicsBodyPairValidate`

```ts
/** fires during broadphase to validate body pairs; rejected if any registered callback returns false. */
export function onPhysicsBodyPairValidate(ctx: ScriptContext, fn: (bodyA: RigidBody, bodyB: RigidBody) => boolean): Unsubscribe;
```

#### `onPhysicsContact`

```ts
/** fires during the physics step when a contact is added or persists; modify `settings` to customize contact behavior. */
export function onPhysicsContact(ctx: ScriptContext, event: 'added' | 'persisted', fn: (args: PhysicsContactArgs) => void): Unsubscribe;
```

#### `onPostAnimate`

```ts
/** fires after animator sampling, before world-matrix recompute; good for head-look, springs/dampers, and constraint clamps. */
export function onPostAnimate(ctx: ScriptContext, fn: (args: FrameArgs) => void): Unsubscribe;
```

#### `onPostPhysicsStep`

```ts
/** fires after each physics step; use to read collision results and updated positions/velocities. */
export function onPostPhysicsStep(ctx: ScriptContext, fn: (args: TickArgs) => void): Unsubscribe;
```

#### `onPrePhysicsStep`

```ts
/** fires before each physics step; use to apply forces, set velocities, or prepare body state. */
export function onPrePhysicsStep(ctx: ScriptContext, fn: (args: TickArgs) => void): Unsubscribe;
```

#### `onPreRender`

```ts
/** fires after onFrame, animation, onPostAnimate and world-matrix concatenation, before visibility and draw: the last point in the frame, for anything that reads final poses. client-only. */
export function onPreRender(ctx: ScriptContext, fn: (args: FrameArgs) => void): Unsubscribe;
```

#### `onQueryEnter`

```ts
/** react to a node starting to match `q`; fires immediately for every node already matching. paired with `onQueryExit`. */
export function onQueryEnter<Conditions extends Condition[]>(ctx: ScriptContext, q: SceneTree.Query<Conditions>, fn: QueryListener<Conditions>): Unsubscribe;
```

#### `onQueryExit`

```ts
/** react to a node stopping matching `q`; fires once more, for every still-matching node, when unsubscribed or disposed. */
export function onQueryExit<Conditions extends Condition[]>(ctx: ScriptContext, q: SceneTree.Query<Conditions>, fn: QueryListener<Conditions>): Unsubscribe;
```

#### `onSwap`

```ts
export function onSwap(ctx: ScriptContext, ser: () => unknown, des: (data: unknown) => void): void;
```

#### `onTick`

```ts
export function onTick(ctx: ScriptContext, fn: (args: TickArgs) => void): Unsubscribe;
```

#### `onUpdate`

```ts
/** fires once per frame, before the fixed-timestep tick loop; client-only, no-op on the server. */
export function onUpdate(ctx: ScriptContext, fn: (args: UpdateArgs) => void): Unsubscribe;
```

#### `query`

```ts
/** register (or reuse) a live query tied to this script instance's lifetime; released when the instance disposes. */
export function query<const Args extends ConditionArgs[]>(ctx: ScriptContext, conditions: Args): SceneTree.Query<ConditionArgsToConditions<Args>>;
```

#### `send`

```ts
export function send<S extends Scripts.Schema, Direction extends Rpc.RpcDirection>(ctx: ScriptContext, handle: CommandHandle<S, Direction>, data: Scripts.SchemaType<S>, client?: Direction extends typeof Rpc.SERVER_TO_CLIENT ? Client : never): void;
```

Also exported: `Oper`, `Src`.

## Logging & environment

Tagged logging and the build-time `env` / `platform` flags.

#### `debug.log`

```ts
/** log an info-level message tagged with the script's trait + node. */
export function log(ctx: ScriptContext, ...args: unknown[]): void;
```

#### `debug.warn`

```ts
/** log a warning tagged with the script's trait + node. */
export function warn(ctx: ScriptContext, ...args: unknown[]): void;
```

#### `debug.error`

```ts
/** log an error tagged with the script's trait + node. */
export function error(ctx: ScriptContext, ...args: unknown[]): void;
```

#### `debug.panel`

```ts
/**
 * open a floating debug panel on the shared dashboard, scoped to this script.
 * closed automatically when the script instance disposes. client-only,
 * returns `null` on the server. `title` defaults to the script's trait/node tag.
 */
export function panel(ctx: ScriptContext, opts: PanelOptions = {

}): Panel | null;
```
#### `env`

```ts
/** Build-time flags replaced with literals for dead code elimination; `editor` is true only in dev. */
export const env: {
    client: boolean;
    server: boolean;
    editor: boolean;
};
```
#### `platform`

```ts
/**
 * Game-facing bridge to the active host platform (CrazyGames / Poki / none).
 * Client-only; standalone hosts wire these to an inert impl so a game can
 * call them unconditionally. Covers ad moments only the game knows the
 * timing of (between rounds, on death); audio muting is handled automatically.
 */
export const platform: {
    commercialBreak(ctx: ScriptContext): Promise<void>;
    rewardedBreak(ctx: ScriptContext): Promise<boolean>;
};
```

## Assets

Declare textures, models, sounds, and sprites, and keep data-only handles alive.

#### `asset`

```ts
/** Module-relative reference to a baked asset; pass `import.meta.url` as `base`. */
export function asset(rel: string, base: string): string;
```
#### `texture`

```ts
/** declare a texture: one picture, from disk or computed from other textures; a consumer's `frames` is where animation lives. */
export function texture<I extends Record<string, TextureHandle>, P extends DrawParams>(id: string, options: TextureOptions<I, P>): TextureHandle;
```

#### `TextureComputedOptions`

```ts
/** A texture computed at bake time from other textures. */
export type TextureComputedOptions<I extends Record<string, TextureHandle>, P extends DrawParams> = {
    /** Output canvas dims in pixels. */
    size: [number, number];
    /** Other textures this one is drawn from, keyed by the name `fn` destructures. */
    inputs?: I;
    /** Scalar tweak knobs. Hashed, so a change here invalidates; a value the `fn` closes over instead is invisible to change detection. */
    params?: P;
    /** Drawn at bake time. Sync, and pure with respect to its three arguments. */
    fn: DrawFn<DrawInputs, P>;
};
```

#### `TextureDef`

```ts
/** The declared data for one texture, hashed and swapped wholesale on re-declaration. `inputs` holds `DepKey`s rather than live handles so the def stays plain data. */
export type TextureDef =
    | { id: string; from: 'file'; src: string }
    | { id: string; from: 'region'; of: DepKey; region: [number, number, number, number] }
    | {
          id: string;
          from: 'computed';
          size: [number, number];
          inputs: Record<string, DepKey>;
          params: DrawParams;
          fn: DrawFn<DrawInputs, DrawParams>;
      };
```

#### `TextureFileOptions`

```ts
/** A texture from a file: a project-relative path or an `asset()` href. */
export type TextureFileOptions = {
    src: string;
};
```

#### `TextureHandle`

```ts
/** Stable wrapper around a `TextureDef`; the data is read through `.def`, which is re-pointed on every re-declaration. */
export type TextureHandle = {
    /** The declared id, identity, never changes. */
    readonly id: string;
    readonly dependency: DepKey;
    /** Re-pointed on every re-declaration. */
    def: TextureDef;
};
```

#### `TextureOptions`

```ts
export type TextureOptions<
    I extends Record<string, TextureHandle> = Record<string, TextureHandle>,
    P extends DrawParams = DrawParams,
> = TextureFileOptions | TextureComputedOptions<I, P> | TextureRegionOptions;
```
#### `getModel`

```ts
/**
 * Look up a model's handle, gated on payload readiness. Returns null until
 * the bytes are parsed; poll each frame and key off the null-to-non-null
 * transition. The handle is identity-stable across HMR/re-registration.
 */
export function getModel(ctx: ScriptContext, id: string): ModelDef | null;
```

#### `ensureModel`

```ts
/**
 * Kick the lazy payload load for an already-registered model. Idempotent;
 * use when referencing a bundled model directly instead of through the
 * avatar pipeline, which ensures on your behalf. No-op if unregistered.
 */
export function ensureModel(ctx: ScriptContext, id: string): void;
```

#### `LoadModelOptions`

```ts
export type LoadModelOptions = {
    /** Fetch URL. Pass a single string when both sides hit the same URL,
     *  or `{ client, server }` when the URLs differ per side. */
    url: string | { client: string; server: string };
    /** Content hash; surfaces in the handle for cache-busting. */
    hash?: string;
    /** Payload size in bytes; informational. */
    size?: number;
};
```

#### `loadModel`

```ts
/**
 * Register a runtime model and resolve once its payload is hydrated.
 * Idempotent against the same id; re-calls bump the refcount. Pair with
 * `releaseModel` so refcounts stay honest. Rejects on fetch/parse failure
 * after retries give up, or if released before it loads.
 */
export function loadModel(ctx: ScriptContext, id: string, options: LoadModelOptions): Promise<ModelDef>;
```

#### `releaseModel`

```ts
/**
 * Release a previously-loaded runtime model. Decrements the refcount; at
 * zero, drops bytes and the URL entry. No-op for an unknown or bundled id.
 */
export function releaseModel(ctx: ScriptContext, id: string): void;
```
#### `SoundDef`

```ts
/** the declared + codegen'd data for one sound. pure data: hashed for change detection,
 *  swapped wholesale when the barrel re-registers (see `declare`). */
export type SoundDef = {
    readonly soundId: string;
    /** display name for editor UIs; defaults to `soundId` when the author didn't
     *  supply one, so readers can show `handle.name` unconditionally. */
    readonly name: string;
    /** search words for editor UIs, normalised (see `AssetMeta`). */
    readonly tags: readonly string[];
    readonly src: string;
    readonly long: boolean;
    /** clip duration in seconds, ffprobed at codegen. zero on the placeholder handle
     *  that `sound()` returns before codegen has run for this id. */
    readonly duration: number;
    /** bumped on HMR via registry.touch(). */
    version: number;
};
```

#### `SoundHandle`

```ts
/** Stable wrapper around a `SoundDef`; identity plus the live def. */
export type SoundHandle = {
    /** the declared id (identity, never changes). */
    readonly id: string;
    /** DepGraph dependency + the brand `isHandle` tests. */
    dependency: { registry: 'sounds'; id: string };
    /** the declared data. re-pointed on every re-declaration. */
    def: SoundDef;
};
```

#### `SoundHandleMap`

```ts
/** empty base interface, augmented by the codegen'd registry barrel
 *  (`src/generated/sounds.ts`) via declaration merging to map sound ids to their
 *  precise handle types. mirrors ModelHandleMap. */
export interface SoundHandleMap {

}
```

#### `SoundOptions`

```ts
export type SoundOptions = AssetMeta & {
    /** source audio (.wav/.mp3/.ogg/.flac): a string path relative to project root, or a
     *  module-relative `asset('./clip.ogg', import.meta.url)` ref for engine builtins and
     *  3rd-party deps shipping audio alongside their modules. */
    src: string;
    /** opts out of the audio atlas, ships + decodes standalone. default false. use for
     *  long-form audio where adding to the atlas would bloat the eager-at-boot fetch;
     *  first play pays a fetch + decode latency, later plays are instant. */
    long?: boolean;
};
```

#### `sound`

```ts
/** declare an audio clip; called at module scope, returns the codegen'd `SoundHandle`. */
export function sound<const Id extends string>(id: Id, options: SoundOptions): Id extends keyof SoundHandleMap ? SoundHandleMap[Id] : SoundHandle;
```
#### `sprite`

```ts
/** declare a sprite; single entry gives a static sprite, array gives flipbook frames. */
export function sprite(id: string, options: SpriteOptions): SpriteHandle;
```

#### `ImageSource`

```ts
/** A project-relative path or an `asset()` href. A composed image is a `texture()` instead, which has an id, a hash and real dep edges. */
export type ImageSource = string;
```

#### `SpriteHandle`

```ts
/** Stable wrapper around a `SpriteDef`; identity plus the live def. */
export type SpriteHandle = {
    /** The declared id, identity, never changes. */
    readonly id: string;
    dependency: { registry: 'sprites'; id: string };
    /** Re-pointed on every re-declaration. */
    def: SpriteDef;
};
```

#### `SpriteOptions`

```ts
export type SpriteOptions = AssetMeta & {
    /** Source image(s): single entry for static sprites, array for flipbooks (one entry per frame). Each entry declares a texture. */
    src?: ImageSource | ImageSource[];

    /** The textures this sprite's frames come from directly; `src` is sugar that declares textures for you. */
    frames?: TextureHandle[];

    /** Gutter pixels in the atlas to avoid bleed at mip levels. Default 1. */
    padding?: number;
    /** Generate mips for this sprite. Default true; set false for a crisp pixel-art look. */
    mipmap?: boolean;
};
```

#### `DrawFn`

```ts
export type DrawFn<I extends DrawInputs, P extends DrawParams> = (
    ctx: CanvasRenderingContext2D,
    inputs: { [K in keyof I]: CanvasImageSource },
    params: P,
) => void;
```

#### `DrawInputs`

```ts
/** The shape `DrawFn` keys its resolved input images by; only the keys matter here. */
export type DrawInputs = Record<string, unknown>;
```

#### `DrawParams`

```ts
/** Scalar param values, string/number/boolean only, so they JSON-serialize cleanly into the registry `structuralHash`. */
export type DrawParams = Record<string, string | number | boolean>;
```

#### `DEFAULT_PIXELS_PER_UNIT`

```ts
/** Default world units per source pixel. Matches `SpriteTrait`'s `worldScale` default. */
export const DEFAULT_PIXELS_PER_UNIT;
```

#### `spriteWorldSize`

```ts
/**
 * World-space `[width, height]` of a sprite, derived from its native pixel
 * dims (frame 0 for a flipbook) divided by `pixelsPerUnit`. Returns `null`
 * server-side, before the client has booted, or before the atlas has this sprite.
 */
export function spriteWorldSize(ctx: ScriptContext, sprite: SpriteHandle, opts?: {
    pixelsPerUnit?: number;
}): [
    number,
    number
] | null;
```
#### `use`

```ts
/**
 * Keep a handle alive through bundler tree-shaking. If a game never
 * references a `block()`/`model()`/`sound()`/`tile()` handle in code (e.g.
 * blocks listed only in a scene's voxel palette), bundlers may drop the
 * declaration as dead code and its registration never runs.
 *
 * @example
 * import { use } from 'bongle';
 * import { blocks } from 'bongle/kit';
 * use(blocks.stone, blocks.dirt);
 */
export function use(..._handles: unknown[]): void;
```

## Scenes & prefabs

Reference authored scenes and instantiate prefabs.

#### `scene`

```ts
/** declare a scene resource at module scope; returns a stable handle whose fields the engine populates once the scene loads. */
export function scene(id: string, options?: SceneOptions): SceneHandle;
```

#### `cloneVoxels`

```ts
/** Deep-copy a Voxels instance into a fresh one whose chunk data mutations won't affect the source; registry is shared by reference. */
export function cloneVoxels(src: Voxels): Voxels;
```

#### `copyVoxels`

```ts
/** Copy all non-air blocks from `src` into `out` at the same world positions; existing blocks in `out` elsewhere are left alone. */
export function copyVoxels(out: Voxels, src: Voxels): void;
```

Also exported: `SceneHandle`, `SceneOptions`.
#### `PrefabHandle`

```ts
/** stable wrapper around a `PrefabDef`; data is read through `.def` rather than copied out. */
export type PrefabHandle<Args = unknown> = {
    readonly id: string;
    dependency: { registry: 'prefabs'; id: string };
    def: PrefabDef;
    readonly __args: Args;
};
```

#### `prefab`

```ts
/** declare a prefab def at module scope. */
export function prefab<T extends PrefabType, S extends Schema>(id: string, options: PrefabOptions<T, S>): PrefabHandle<SchemaType<S>>;
```

#### `PrefabType`

```ts
/**
 * what a prefab produces when instantiated: `'voxels'` populates `ctx.voxels`,
 * `'nodes'` attaches children under `ctx.scene`, `'composite'` does both.
 */
export type PrefabType = 'voxels' | 'nodes' | 'composite';
```

#### `PrefabDef`

```ts
export type PrefabDef<Args = unknown> = {
    id: string;
    /** human-readable display name for editor UIs. always set,
     *  defaults to `id` when the author didn't supply one. */
    name: string;
    type: PrefabType;
    deps: ReadonlyArray<DepHandle>;
    argsSchema: Schema;
    /** default args value, used when callers omit args. `{}` when args isn't set. */
    defaultArgs: Args;
    node?: { realm?: Realm };
    apply: (ctx: PrefabApplyContext, args: Args) => void;
};
```

#### `PrefabOptions`

```ts
export type PrefabOptions<T extends PrefabType, S extends Schema> = AssetMeta & {
    /** what this prefab produces, voxels, nodes, or both. required. */
    type: T;
    /** producer handles whose changes trigger re-instantiation in edit mode. */
    deps?: ReadonlyArray<DepHandle>;
    /** args schema + default value; default is required when args is set. */
    args?: { schema: S; default: SchemaType<S> };
    fn?: (ctx: PrefabApplyContext<T>, args: SchemaType<S>) => void;
    /** authored anchor defaults, applied to the node createPrefab returns when the caller doesn't override. */
    node?: { realm?: Realm };
};
```

#### `emptyArgsSchema`

```ts
export const emptyArgsSchema;
```

#### `noopApply`

```ts
export function noopApply(): () => void;
```

#### `createPrefab`

```ts
/**
 * create a detached prefab node; attach explicitly with `addChild(parent, node)`.
 * instantiation happens on the next prefab tick.
 */
export function createPrefab<Args = unknown>(_ctx: ScriptContext, handle: PrefabHandle<Args>, opts?: {
    name?: string;
    args?: Args;
    realm?: Realm;
}): Node;
```

Also exported: `PrefabApplyContext`.

## Voxels & blocks

Define block types, read and write the voxel grid, and react to changes.

#### `ClipChannel`

```ts
/** One animated property of one node, keyframes-only; sampling lives in the animator. Times are seconds, monotonically increasing. */
export type ClipChannel = {
    /** Target node by name within the rig (matches a node in `ModelHandle.nodes`). */
    nodeName: string;
    /** Which transform field this channel drives. */
    property: ClipChannelProperty;
    /** glTF interpolation mode. CUBICSPLINE keys are 3x wider (in/value/out). */
    interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
    /** Keyframe times in seconds. */
    times: Float32Array;
    /** Keyframe values, packed; stride determined by `property`. */
    values: Float32Array;
};
```

#### `ClipChannelProperty`

```ts
/** Which transform field a channel drives. */
export type ClipChannelProperty = 'translation' | 'rotation' | 'scale';
```

#### `ClipChannels`

```ts
/** Parsed clip data, channels + clip duration. Loaded lazily into `Resources.modelPayloads[modelId].clips[name]`. */
export type ClipChannels = {
    /** Total clip length in seconds (max keyframe time across channels). */
    duration: number;
    channels: ClipChannel[];
};
```

#### `ClipDef`

```ts
/**
 * Singleton clip ref, exported by reference from the sidecar (`wizard.animations.idle`). The animator keys its
 * action Map by ref identity and looks up channels lazily via `Resources.modelClipChannels(resources, clip)`.
 */
export type ClipDef = {
    readonly name: string;
    readonly modelId: string;
};
```

#### `MeshId`

```ts
/**
 * Compound id for a single mesh inside a model. `modelId` scopes by model file, `meshName` within it.
 * Wire format: length-prefixed modelId + length-prefixed meshName.
 */
export type MeshId = {
    readonly modelId: string;
    readonly meshName: string;
};
```

#### `ModelDef`

```ts
/**
 * Static handle for one model. Codegen'd into `<basename>.glb.generated.ts`, never constructed at runtime.
 * Pure data: hashed for change detection and swapped wholesale when the barrel re-registers.
 */
export type ModelDef<NodeNames extends string = string, MeshNames extends string = string, ClipNames extends string = string> = {
    /** user-chosen id from `model('wizard', { src })`; stable handle. */
    readonly modelId: string;
    /** display name for editor UIs; defaults to `modelId`. */
    readonly name: string;
    /** search words for editor UIs, normalised (see `AssetMeta`). */
    readonly tags: readonly string[];
    /** source path relative to project root (e.g. 'characters/wizard.glb'). */
    readonly src: string;
    /** per-side public URLs for the packed payload; the engine picks the right side and fetches. Empty on the empty handle. */
    readonly bin: {
        readonly client: string;
        readonly server: string;
    };
    /** detached Node tree codegen'd from the gltf hierarchy, TransformTrait + MeshTrait already wired. Clone with `cloneNode()` before use. */
    readonly scene: Node;
    /**
     * bind-pose axis-aligned bounding box in root-local space, union of every mesh's AABB via its node's TRS chain.
     * `[minX, minY, minZ, maxX, maxY, maxZ]`. Static; animation can push verts outside it at runtime.
     */
    readonly aabb: Box3;
    /** flat-name index of every named gltf node (mesh-bearing or not); values are by-reference pointers into `scene`. */
    readonly nodes: { readonly [K in NodeNames]: Node };
    /** flat-name index for mesh-surgery, `meshTrait.meshId = wizard.meshes.HatA.id`, each with its bind-pose local-space AABB. */
    readonly meshes: { readonly [K in MeshNames]: { readonly id: MeshId; readonly aabb: Box3 } };
    /** Clip refs (singletons). Pass directly to Animation.clip(). */
    readonly animations: { readonly [K in ClipNames]: ClipDef };
    /** monotonic counter bumped when this handle's payload reloads; list in `prefab()` deps to re-trigger edit-time preview. Read-only for user code. */
    version: number;
};
```

#### `ModelHandle`

```ts
/** Stable wrapper around a `ModelDef`; identity plus the live def, re-pointed on every codegen pass so a held handle stays current. */
export type ModelHandle<D extends ModelDef = ModelDef> = {
    /** the declared id (identity, never changes). */
    readonly id: string;
    /** DepGraph dependency + the brand `isHandle` tests. */
    dependency: { registry: 'models'; id: string };
    /** the codegen'd data. re-pointed on every re-registration. */
    def: D;

    // forwarding accessors, not stored copies, so they never go stale when `def` is re-pointed.
    // the engine reads `ModelDef` directly, so per-frame paths pay nothing for these.

    /** @see ModelDef.name */
    readonly name: string;
    /** @see ModelDef.src */
    readonly src: string;
    /** @see ModelDef.scene */
    readonly scene: D['scene'];
    /** @see ModelDef.aabb */
    readonly aabb: D['aabb'];
    /** @see ModelDef.nodes */
    readonly nodes: D['nodes'];
    /** @see ModelDef.meshes */
    readonly meshes: D['meshes'];
    /** @see ModelDef.animations */
    readonly animations: D['animations'];
};
```

#### `ModelHandleMap`

```ts
/**
 * Empty base interface, augmented by the codegen'd registry barrel (`src/generated/models.ts`)
 * via declaration merging to map model ids to their precise handle types.
 *
 * @example codegen output:
 * ```ts
 * declare module 'bongle' {
 *     interface ModelHandleMap {
 *         wizard: typeof wizard;
 *         dragon: typeof dragon;
 *     }
 * }
 * ```
 */
export interface ModelHandleMap {

}
```

#### `ModelOptions`

```ts
export type ModelOptions = AssetMeta & {
    /**
     * source .gltf/.glb: a string path relative to project root, or a module-relative
     * `asset('./model.glb', import.meta.url)` ref so 3rd-party packs can ship gltf alongside their modules.
     */
    src: string;
};
```

#### `BUILTIN_BASE_AVATAR_ID`

```ts
/** Stable id for the builtin avatar. Imported by the service to short-
 *  circuit the resolve endpoint (it returns `{ modelId: BUILTIN_BASE_AVATAR_ID }`
 *  without a clientUrl/serverUrl since the engine already has it). */
export const BUILTIN_BASE_AVATAR_ID;
```

#### `baseAvatar`

```ts
export const baseAvatar;
```

#### `block`

```ts
/** declare a block type; called at module scope, returns a handle used for getting global state ids in gameplay code. */
export function block<const P extends PropsDef = {

}>(id: string, options: BlockOptions<P> = {

}): BlockHandle<P>;
```

#### `model`

```ts
/** declare a model; called at module scope, returns the codegen'd `ModelHandle`. */
export function model<const Id extends string>(id: Id, options: ModelOptions): Id extends keyof ModelHandleMap ? ModelHandleMap[Id] : ModelHandle;
```

#### `tile`

```ts
/** declare a tile: one 16x16 entry in the voxel atlas, made of textures; returns a handle passed to block model definitions. */
export function tile(id: string, options: TileOptions): TileHandle;
```

#### `AABB`

```ts
/** [minX, minY, minZ, maxX, maxY, maxZ] in block-local [0,1]^3. */
export type AABB = readonly [number, number, number, number, number, number];
```

#### `BlockShape`

```ts
export type BlockShape = BlockShapeCube | BlockShapeAabbs;
```

#### `BlockShapeAabbs`

```ts
export type BlockShapeAabbs = {
    type: 'aabbs';
    boxes: AABB[];
};
```

#### `BlockShapeCube`

```ts
export type BlockShapeCube = {
    type: 'cube';
};
```

#### `blockShape.AABB`

```ts
/** [minX, minY, minZ, maxX, maxY, maxZ] in block-local [0,1]^3. */
export type AABB = readonly [number, number, number, number, number, number];
```

#### `blockShape.BlockShapeCube`

```ts
export type BlockShapeCube = {
    type: 'cube';
};
```

#### `blockShape.BlockShapeAabbs`

```ts
export type BlockShapeAabbs = {
    type: 'aabbs';
    boxes: AABB[];
};
```

#### `blockShape.BlockShape`

```ts
export type BlockShape = BlockShapeCube | BlockShapeAabbs;
```

#### `blockShape.cube`

```ts
export function cube(): BlockShapeCube;
```

#### `blockShape.aabbs`

```ts
export function aabbs(boxes: AABB[]): BlockShapeAabbs;
```

#### `blockShape.rotateY`

```ts
/** Rotates a block shape around the Y axis (viewed from +Y) in 90-degree CW steps (0..3), around block center (0.5, y, 0.5). Input shape is not mutated. */
export function rotateY(shape: BlockShape, steps: number): BlockShape;
```

#### `blockShape.blockShapeToShape`

```ts
export function blockShapeToShape(shape: Exclude<BlockShape, BlockShapeCube>): crashcat.Shape;
```

#### `SetBlockFlags`

```ts
export const SetBlockFlags;
```

#### `blockModel.quad`

```ts
/** create a single quad from 4 CCW vertices in block-local [0,1] space. */
export function quad(verts: [
    Vec3,
    Vec3,
    Vec3,
    Vec3
], normal: Vec3, tile: TileHandle, options?: {
    uvs?: [
        Vec2,
        Vec2,
        Vec2,
        Vec2
    ];
    cullFace?: CullFace;
    material?: MaterialType;
    shade?: boolean;
}): BlockQuad;
```

#### `blockModel.box`

```ts
/** generate the 6 quads of an axis-aligned box in block-local [0,1] space. */
export function box(from: Vec3, to: Vec3, tiles: CubeTiles, options?: {
    exclude?: FaceDir[];
    cull?: boolean | Partial<Record<FaceDir, boolean>>;
    material?: MaterialType;
    uvs?: 'stretch' | 'local';
}): BlockQuad[];
```

#### `blockModel.rotateY`

```ts
/** rotate quads around Y by `steps` x 90 degrees CW about the block center; `uvlock` pins top/bottom UVs to world axes. */
export function rotateY(quads: BlockQuad[], steps: number, options?: {
    uvlock?: boolean;
}): BlockQuad[];
```

#### `blockModel.mirrorX`

```ts
export function mirrorX(quads: BlockQuad[]): BlockQuad[];
```

#### `blockModel.rotateAxis`

```ts
/** rotate quads by `angleDeg` around `axis` through `pivot` (block-local space, right-hand rule); clears cullFace. */
export function rotateAxis(quads: BlockQuad[], axis: 'x' | 'y' | 'z', angleDeg: number, pivot: Vec3): BlockQuad[];
```

#### `blockModel.shearByHeight`

```ts
/** shear quads along `axis` as a linear function of height: a vertex at `yBase` is unmoved, one at `yBase + ySpan` shifts by `delta`. */
export function shearByHeight(quads: BlockQuad[], axis: 'x' | 'z', yBase: number, ySpan: number, delta: number): BlockQuad[];
```

#### `blockModel.translate`

```ts
/** translate an array of BlockQuad by `delta` (block-local space). */
export function translate(quads: BlockQuad[], delta: Vec3): BlockQuad[];
```

#### `blockModel.layer`

```ts
/** create one up-facing quad covering the cell at height `y` (block units). */
export function layer(tile: TileHandle, y: number, options?: {
    material?: MaterialType;
}): BlockQuad[];
```

#### `blockModel.cross`

```ts
/** create two intersecting double-sided diagonal planes (4 quads) for vegetation. */
export function cross(tile: TileHandle, options?: {
    height?: number;
    tileBlocks?: number;
    material?: MaterialType;
}): BlockQuad[];
```

#### `blockModel.hash`

```ts
/** create four axis-aligned vertical planes (8 quads) on the quarter marks, reading as a hash from above; used for crops. */
export function hash(tile: TileHandle, options?: {
    lean?: number;
    material?: MaterialType;
}): BlockQuad[];
```

#### `blockModel.plus`

```ts
/** create two axis-aligned vertical planes (4 quads) crossing at the cell center, reading as a plus from above. */
export function plus(tile: TileHandle, options?: {
    material?: MaterialType;
}): BlockQuad[];
```

#### `blockModel.FLUFF_LEAN_DEG`

```ts
/** default lean in degrees; stacked blocks sit ~0.05 apart while the clumps still read upright. */
export const FLUFF_LEAN_DEG;
```

#### `blockModel.fluff`

```ts
/** create the four crossed, overhanging, unshaded leaning planes (8 quads) that soften a foliage cube's silhouette. */
export function fluff(tile: TileHandle, options?: {
    lean?: number;
    material?: MaterialType;
}): BlockQuad[];
```

#### `blockPlace.Facing4`

```ts
export type Facing4 = 'north' | 'east' | 'south' | 'west';
```

#### `blockPlace.Facing6`

```ts
export type Facing6 = Facing4 | 'up' | 'down';
```

#### `blockPlace.Axis`

```ts
export type Axis = 'x' | 'y' | 'z';
```

#### `blockPlace.FACING4_STEPS`

```ts
/** clockwise step index per cardinal (north=0, east=1, south=2, west=3). */
export const FACING4_STEPS: Record<Facing4, number>;
```

#### `blockPlace.FACING4_ORDER`

```ts
export const FACING4_ORDER: readonly Facing4[];
```

#### `blockPlace.axisFromPlaceCtx`

```ts
/** dominant axis of the hit normal (logs, pillars). */
export function axisFromPlaceCtx(ctx: BlockPlaceCtx): Axis;
```

#### `blockPlace.facing6FromPlaceCtx`

```ts
/** 6-dir facing from the hit normal, block points away from the clicked
 *  surface (pistons, observers). */
export function facing6FromPlaceCtx(ctx: BlockPlaceCtx): Facing6;
```

#### `blockPlace.facing4FromPlaceCtx`

```ts
/** 4-dir facing toward the placer: wall click resolves to the opposite of the clicked face (hit-normal direction); floor/ceiling click uses camera yaw. Ladders, stairs, doors, signs. */
export function facing4FromPlaceCtx(ctx: BlockPlaceCtx): Facing4;
```

#### `blockPlace.halfFromPlaceCtx`

```ts
/** top/bottom half for slab/stair/trapdoor/door: a top-face click resolves to the bottom of the cell above, a bottom-face click to top, and a wall click to whichever half was clicked. */
export function halfFromPlaceCtx(ctx: BlockPlaceCtx): 'bottom' | 'top';
```

#### `blockPlace.FACING4_FLIP_X`

```ts
export const FACING4_FLIP_X: Record<Facing4, Facing4>;
```

#### `blockPlace.FACING4_FLIP_Z`

```ts
export const FACING4_FLIP_Z: Record<Facing4, Facing4>;
```

#### `blockPlace.rotateFacing4`

```ts
/** rotate a cardinal 90 degrees around Y. cw = looking down +Y. */
export function rotateFacing4(f: Facing4, cw: boolean): Facing4;
```

#### `blockPlace.flipFacing4`

```ts
/** mirror a cardinal across the plane perpendicular to `axis`. a Y flip is
 *  identity for a horizontal facing. */
export function flipFacing4(f: Facing4, axis: Axis): Facing4;
```

#### `blockPreset.CubePresetOptions`

```ts
export type CubePresetOptions = PresetOptions & {
    tiles: CubeTilesInput;
    /** draw this cube at one of four y rotations picked from world position (stable across remeshes, identical on
     *  every client) so a large flat expanse doesn't sit on a visible grid. */
    varyRotation?: boolean;
};
```

#### `blockPreset.ColumnPresetOptions`

```ts
export type ColumnPresetOptions = PresetOptions & {
    tiles: {
        end: TileHandle;
        side: TileHandle;
    };
};
```

#### `blockPreset.StairsPresetOptions`

```ts
export type StairsPresetOptions = Omit<PresetOptions, 'cull'> & {
    tiles: CubeTilesInput;
};
```

#### `blockPreset.SlabPresetOptions`

```ts
export type SlabPresetOptions = Omit<PresetOptions, 'cull'> & {
    tiles: CubeTilesInput;
};
```

#### `blockPreset.LeavesPresetOptions`

```ts
export type LeavesPresetOptions = Omit<PresetOptions, 'cull' | 'vertexAnimation'> & {
    tiles: CubeTilesInput;
    /** four crossed, overhanging, unshaded, leaning planes so the canopy doesn't end on a hard cube edge; costs 8
     *  extra quads with no culling, so opt-in per leaf type. pass a round masked leaf blob, not a square tile. */
    fluff?: TileHandle;
    /** draw at one of four y rotations picked from world position; odd rotations also mirror the fluff lean. */
    varyRotation?: boolean;
};
```

#### `blockPreset.FencePresetOptions`

```ts
export type FencePresetOptions = Omit<PresetOptions, 'cull'> & {
    tiles: CubeTilesInput;
};
```

#### `blockPreset.PanePresetOptions`

```ts
export type PanePresetOptions = Omit<PresetOptions, 'cull'> & {
    tiles: CubeTilesInput;
};
```

#### `blockPreset.CarpetPresetOptions`

```ts
export type CarpetPresetOptions = Omit<PresetOptions, 'cull'> & {
    tiles: CubeTilesInput;
};
```

#### `blockPreset.LitterPresetOptions`

```ts
export type LitterPresetOptions = Omit<PresetOptions, 'cull' | 'collision' | 'lightOpacity' | 'vertexAnimation'> & {
    /** one tile, or several picked per world position (see `cross`). */
    tiles: TileHandle | readonly TileHandle[];
    /** draw at one of four y rotations, picked per world position. default true. */
    varyRotation?: boolean;
};
```

#### `blockPreset.TrapdoorPresetOptions`

```ts
export type TrapdoorPresetOptions = Omit<PresetOptions, 'cull'> & {
    tiles: CubeTilesInput;
};
```

#### `blockPreset.WallPresetOptions`

```ts
export type WallPresetOptions = Omit<PresetOptions, 'cull'> & {
    tiles: CubeTilesInput;
};
```

#### `blockPreset.CrossPresetOptions`

```ts
export type CrossPresetOptions = Omit<PresetOptions, 'cull' | 'collision' | 'lightOpacity' | 'vertexAnimation'> & {
    /** one tile, or several: with a list the mesher picks one per world position. */
    tiles: TileHandle | readonly TileHandle[];
    /** per-position offset, `xz` in blocks either way and `y` downward (see `BlockOptions.jitter`). */
    jitter?: BlockOptions['jitter'];
    /** plane height in blocks (default 1); taller planes want a tile `ceil(height)` blocks tall (see `blockModel.cross`). */
    height?: number;
    /** how many blocks tall the tile is, when the plane is shorter than it. */
    tileBlocks?: number;
    /** selection shape, for a plant smaller than the default 12x13x12 box. */
    shape?: BlockOptions['shape'];
};
```

#### `blockPreset.LadderPresetOptions`

```ts
export type LadderPresetOptions = Omit<PresetOptions, 'cull' | 'collision' | 'climbable'> & {
    tiles: TileHandle;
};
```

#### `blockPreset.PlatePresetOptions`

```ts
export type PlatePresetOptions = Omit<PresetOptions, 'cull' | 'collision'> & {
    tiles: TileHandle;
};
```

#### `blockPreset.ChainPresetOptions`

```ts
export type ChainPresetOptions = Omit<PresetOptions, 'cull' | 'lightOpacity'> & {
    tiles: TileHandle;
};
```

#### `blockPreset.LanternPresetOptions`

```ts
export type LanternPresetOptions = Omit<PresetOptions, 'cull' | 'lightOpacity' | 'emissive'> & {
    tiles: { lit: TileHandle; unlit: TileHandle }; // the lit sheet (animate it for a flicker) and the sheet shown when out
};
```

#### `blockPreset.TorchPresetOptions`

```ts
export type TorchPresetOptions = Omit<PresetOptions, 'cull' | 'collision' | 'emissive'> & {
    tiles: TileHandle;
};
```

#### `blockPreset.DoorPresetOptions`

```ts
export type DoorPresetOptions = Omit<PresetOptions, 'cull'> & {
    tiles: {
        top: TileHandle;
        bottom: TileHandle;
    };
};
```

#### `blockPreset.LiquidPresetOptions`

```ts
export type LiquidPresetOptions = Pick<PresetOptions, 'name' | 'tags' | 'sounds' | 'material'> & {
    tiles: CubeTilesInput;
    viscosity?: number;
    translucent?: boolean;
    levels?: number;
    fluidGroup?: string;
    tint?: ScreenTintSpec; // screen tint applied when the camera eye sits inside the filled band
    maxHeight?: number; // scales the surface for every level; 1 = full cube at max level, lower gives a visible meniscus. default 1
    lightEmission?: [number, number, number]; // per-channel light output (0..15), set for lava-style glow
    emissive?: boolean; // mark the texture as self-lit so it stays bright in shadow
};
```

#### `blockPreset.cube`

```ts
export function cube(id: string, {
    tiles: tilesInput, varyRotation, ...options;
}: CubePresetOptions);
```

#### `blockPreset.column`

```ts
export function column(id: string, {
    tiles, ...options;
}: ColumnPresetOptions);
```

#### `blockPreset.stairs`

```ts
export function stairs(id: string, {
    tiles: tilesInput, ...options;
}: StairsPresetOptions);
```

#### `blockPreset.slab`

```ts
export function slab(id: string, {
    tiles: tilesInput, ...options;
}: SlabPresetOptions);
```

#### `blockPreset.cross`

```ts
export function cross(id: string, {
    tiles, height, tileBlocks, shape, ...options;
}: CrossPresetOptions);
```

#### `blockPreset.leaves`

```ts
export function leaves(id: string, {
    tiles: tilesInput, fluff, varyRotation, ...options;
}: LeavesPresetOptions);
```

#### `blockPreset.ladder`

```ts
export function ladder(id: string, {
    tiles: tile, ...options;
}: LadderPresetOptions);
```

#### `blockPreset.WATER_DEFAULT_TINT`

```ts
export const WATER_DEFAULT_TINT: ScreenTintSpec;
```

#### `blockPreset.LAVA_DEFAULT_TINT`

```ts
export const LAVA_DEFAULT_TINT: ScreenTintSpec;
```

#### `blockPreset.LiquidHandle`

```ts
export type LiquidHandle = BlockHandle & {
    /** state key for a specific level (1..levels). returns the default for stateless liquids. */
    level(n: number): string;
    /** state key for the highest level (full surface height). */
    max(): string;
};
```

#### `blockPreset.liquid`

```ts
export function liquid(id: string, {
    tiles: tilesInput, ...options;
}: LiquidPresetOptions): LiquidHandle;
```

#### `blockPreset.fence`

```ts
export function fence(id: string, {
    tiles: tilesInput, ...options;
}: FencePresetOptions);
```

#### `blockPreset.pane`

```ts
export function pane(id: string, {
    tiles: tilesInput, ...options;
}: PanePresetOptions);
```

#### `blockPreset.carpet`

```ts
export function carpet(id: string, {
    tiles: tilesInput, ...options;
}: CarpetPresetOptions);
```

#### `blockPreset.litter`

```ts
export function litter(id: string, {
    tiles, varyRotation = true, ...options;
}: LitterPresetOptions);
```

#### `blockPreset.trapdoor`

```ts
export function trapdoor(id: string, {
    tiles: tilesInput, ...options;
}: TrapdoorPresetOptions);
```

#### `blockPreset.plate`

```ts
export function plate(id: string, {
    tiles: tile, ...options;
}: PlatePresetOptions);
```

#### `blockPreset.wall`

```ts
export function wall(id: string, {
    tiles: tilesInput, ...options;
}: WallPresetOptions);
```

#### `blockPreset.torch`

```ts
export function torch(id: string, {
    tiles: tile, ...options;
}: TorchPresetOptions);
```

#### `blockPreset.chain`

```ts
export function chain(id: string, {
    tiles: tile, ...options;
}: ChainPresetOptions);
```

#### `blockPreset.lantern`

```ts
export function lantern(id: string, {
    tiles, ...options;
}: LanternPresetOptions);
```

#### `blockPreset.getLanternLit`

```ts
/** whether the lantern at (x,y,z) is lit. false if the cell isn't a lantern. */
export function getLanternLit(voxels: Voxels, x: number, y: number, z: number): boolean;
```

#### `blockPreset.setLanternLit`

```ts
/** light or put out the lantern at (x,y,z), keeping how it hangs. no-op if the
 *  cell isn't a lantern or already matches.
 *  toggle = `setLanternLit(v, x, y, z, !getLanternLit(v, x, y, z))`. */
export function setLanternLit(voxels: Voxels, x: number, y: number, z: number, lit: boolean): void;
```

#### `blockPreset.door`

```ts
export function door(id: string, {
    tiles, ...options;
}: DoorPresetOptions);
```

#### `blockPreset.getDoorOpen`

```ts
/** whether the door at (x,y,z) is open. false if the cell isn't a door. */
export function getDoorOpen(voxels: Voxels, x: number, y: number, z: number): boolean;
```

#### `blockPreset.setDoorOpen`

```ts
/** set the open state of the door at (x,y,z), writes both halves (partner
 *  re-derived from `half`). no-op if the cell isn't a door or already matches.
 *  toggle = `setDoorOpen(v, x, y, z, !getDoorOpen(v, x, y, z))`. */
export function setDoorOpen(voxels: Voxels, x: number, y: number, z: number, open: boolean): void;
```

#### `getDoorOpen`

```ts
/** whether the door at (x,y,z) is open. false if the cell isn't a door. */
export function getDoorOpen(voxels: Voxels, x: number, y: number, z: number): boolean;
```

#### `getLanternLit`

```ts
/** whether the lantern at (x,y,z) is lit. false if the cell isn't a lantern. */
export function getLanternLit(voxels: Voxels, x: number, y: number, z: number): boolean;
```

#### `setDoorOpen`

```ts
/** set the open state of the door at (x,y,z), writes both halves (partner
 *  re-derived from `half`). no-op if the cell isn't a door or already matches.
 *  toggle = `setDoorOpen(v, x, y, z, !getDoorOpen(v, x, y, z))`. */
export function setDoorOpen(voxels: Voxels, x: number, y: number, z: number, open: boolean): void;
```

#### `setLanternLit`

```ts
/** light or put out the lantern at (x,y,z), keeping how it hangs. no-op if the
 *  cell isn't a lantern or already matches.
 *  toggle = `setLanternLit(v, x, y, z, !getLanternLit(v, x, y, z))`. */
export function setLanternLit(voxels: Voxels, x: number, y: number, z: number, lit: boolean): void;
```

#### `BlockRegistryData`

```ts
export type BlockRegistryData = {
    /** total number of global state ids across all blocks (including air + missing). */
    totalStates: number;
    /** number of registered block types (not counting the implicit missing sentinel). */
    blockCount: number;

    defs: BlockDef[]; // declaration order, dense; NOT aligned with stateToBlockIndex
    idToDef: Map<string, BlockDef>;
    handles: BlockHandle[]; // keyed by reserved block index (holes for removed ids); use with stateToBlockIndex
    idToHandle: Map<string, BlockHandle>;

    stateToBlockIndex: Uint16Array; // global state id -> dense block type index
    stateToLocalIndex: Uint16Array; // global state id -> local state index within that block

    /** global state id -> model type (MODEL_NONE=0, MODEL_CUBE=1, MODEL_MESH=2, MODEL_LIQUID=3). */
    modelType: Uint8Array;

    /** per-state cube texture indices, stride 6, face order top/bottom/north/south/east/west, indexed as stateId*6+faceIdx. */
    cubeTexIndices: Uint16Array;

    /** per-state cube face UVs, stride 48 (6 faces x 4 corners x 2), rotation-baked, matches the mesher's face emit order. */
    cubeFaceUVs: Uint8Array;

    variantCount: Uint8Array; // global state id -> per-position model variant count; 0 or 1 means none
    /** global state id -> first of `variantCount` consecutive bases (a cubeTexIndices/cubeFaceUVs slot for cubes, a meshId for meshes). */
    variantBase: Uint32Array;
    jitterXz: Uint8Array; // global state id -> max horizontal render offset, in 1/255 of a block
    jitterY: Uint8Array; // global state id -> max downward render offset, in 1/255 of a block

    meshId: Uint16Array; // global state id -> dense mesh index (0 = not a mesh, 1+ = valid)
    meshQuads: BlockQuad[][]; // index 0 is unused (sentinel)
    meshTexIndices: Uint16Array[]; // parallel to meshQuads
    /** dense per-quad material (MaterialType enum); quads without an explicit material get the block's default. parallel to meshQuads. */
    meshQuadMaterials: Uint8Array[];

    meshQuadUnshaded: Uint8Array[]; // per-quad `shade: false` flag (1 = skip directional face shade)

    meshQuadShape: Uint8Array[]; // per-quad shape tag (SHAPE_FLAT..SHAPE_IRREGULAR)
    meshQuadFaceDir: Uint8Array[]; // per-quad primary face direction (0..5, or FACE_DIR_NONE for IRREGULAR)
    meshQuadCullFaceDir: Uint8Array[]; // per-quad cull-face direction (0..5, or FACE_DIR_NONE), pre-resolved from BlockQuad.cullFace
    meshQuadDepth: Float32Array[]; // per-quad uniform inset depth in [0,1]; meaningful for ALIGNED_*/PARALLEL only
    meshQuadVertDepth: Float32Array[]; // length quads.length*4, only populated (else zero) for NON_PARALLEL quads
    meshQuadVertNormal: Float32Array[]; // length quads.length*12, only populated (else zero) for IRREGULAR quads

    meshQuadCornerUV: Float32Array[]; // per-vertex (u,w) on the chosen face plane, length quads.length*8; zero for FLAT/IRREGULAR
    meshQuadCornerPos: Float32Array[]; // IRREGULAR only: per-vertex 3D position in [0,1]^3, length quads.length*12
    meshQuadCornerNormSq: Float32Array[]; // IRREGULAR only: per-vertex (nx^2,ny^2,nz^2) weights summing to 1, length quads.length*12

    meshQuadNormal: Float32Array[]; // length quads.length*3, flattened from BlockQuad.normal
    meshQuadUVs: Float32Array[]; // length quads.length*8, flattened from BlockQuad.uvs (default [0,1][1,1][1,0][0,0])
    meshQuadVerts: Float32Array[]; // length quads.length*12, flattened from BlockQuad.verts

    colliderId: Uint16Array; // global state id -> dense collider index (0 = cube fast path, 1+ indexes colliderShapes)

    /** dense pre-built crashcat shapes, index 0 unused, indexed by colliderId (1-based); source of truth for the KCC + rigid-body narrow-phase. */
    colliderShapes: Shape[];

    shapeKind: Uint8Array; // indexed by colliderId; index 0 holds SHAPE_CUBE as a sentinel
    shapeAabbs: AABB[][]; // block-local [0,1]^3, indexed by colliderId; populated for shapeKind=SHAPE_AABBS

    cull: Uint8Array; // global state id -> cull type (CullType enum, uint8)
    blockTypeId: Uint16Array; // global state id -> dense block type index; all states of one block() share the same value
    material: Uint8Array; // global state id -> material type (MaterialType enum, uint8)
    vertexAnimation: Uint8Array; // global state id -> vertex animation type (VertexAnimation enum, encoded as uint8)

    lightEmission: Uint16Array; // global state id -> packed light emission (0RGB in uint16, channels in bits 11..8/7..4/3..0)
    lightOpacity: Uint8Array; // global state id -> light opacity (0-15 in uint8); 0 = transparent, 15 = fully opaque
    emissive: Uint8Array; // global state id -> emissive flag (0 or 1 in uint8)
    flags: Uint32Array; // global state id -> bitmask of BLOCK_FLAG_* bits

    friction: Float32Array; // global state id -> friction coefficient, multiplied with per-body friction; defaults to 1.0
    restitution: Float32Array; // global state id -> restitution coefficient, multiplied with per-body restitution; defaults to 0
    liquidViscosity: Float32Array; // global state id -> liquid viscosity (0..1); meaningful only when BLOCK_FLAG_LIQUID is set
    surfaceHeight: Float32Array; // global state id -> surface height (0..1); meaningful only for MODEL_LIQUID states, 1.0 elsewhere
    fluidGroup: Uint16Array; // global state id -> fluid group id (uint16); 0 = not a liquid
    screenTint: Float32Array; // global state id -> screen tint (r,g,b,a), stride 4; a===0 means no tint; read client-side only

    sounds: (BlockSoundConfig | undefined)[]; // global state id -> sounds config; undefined for air, missing, and blocks without one
    particles: (BlockParticleConfig | undefined)[]; // global state id -> particles config; undefined for `particles: false` and models with no dust

    /** global state id -> string key (e.g. "oak_log[axis=y]"). air -> "air", missing -> "". */
    stateToKey: string[];
    keyToState: Map<string, number>;

    textures: string[]; // all unique texture layer entries, including animation frames
    textureIndex: Map<string, number>; // texture id -> base atlas layer index

    texAnimData: Float32Array; // stride 4: [frameCount, fps, interpolate(0/1), pad], indexed as layerIdx*4
    textureCutout: Uint8Array; // per-layer alpha-cutout flag (1 = used by a TRANSPARENT face/quad)
};
```

#### `AIR`

```ts
/** global state id for air. always 0. */
export const AIR;
```

#### `BLOCK_FLAG_CLIMBABLE`

```ts
/** block is climbable (ladder-like). character bypasses gravity inside it. */
export const BLOCK_FLAG_CLIMBABLE;
```

#### `BLOCK_FLAG_COLLISION`

```ts
/** block participates in physics collision. */
export const BLOCK_FLAG_COLLISION;
```

#### `BLOCK_FLAG_FENCE`

```ts
/** block is a fence, fences connect to other fence-flagged blocks. */
export const BLOCK_FLAG_FENCE;
```

#### `BLOCK_FLAG_LIQUID`

```ts
/** block is a liquid. character swims while submerged. */
export const BLOCK_FLAG_LIQUID;
```

#### `BLOCK_FLAG_PANE`

```ts
/** block is a glass pane / bars, panes connect to other pane-flagged blocks. */
export const BLOCK_FLAG_PANE;
```

#### `BLOCK_FLAG_PATHFINDABLE`

```ts
/** a navigating agent may occupy/pass through this cell; defaults to the inverse of collision, overridable via block({ pathfindable }). */
export const BLOCK_FLAG_PATHFINDABLE;
```

#### `BLOCK_FLAG_SELECTION`

```ts
/** block can be targeted by selection raycasts. */
export const BLOCK_FLAG_SELECTION;
```

#### `BLOCK_FLAG_SNEAK_GUARD`

```ts
/** crouched character can edge-guard (anchor + clamp) on this block. */
export const BLOCK_FLAG_SNEAK_GUARD;
```

#### `BLOCK_FLAG_WALL`

```ts
/** block is a wall, walls connect to other wall-flagged blocks. */
export const BLOCK_FLAG_WALL;
```

#### `encodeVertexAnimation`

```ts
/** pack VertexAnimation enum into uint8 for flat lookup tables. */
export function encodeVertexAnimation(va: VertexAnimation | undefined): number;
```

#### `keyToBlock`

```ts
/** Map a block key to its block handle, ignoring block-state; prefer `stateToBlock` in hot paths to skip the key-string resolve. */
export function keyToBlock(registry: Blocks, key: string): BlockHandle;
```

#### `MISSING`

```ts
/** global state id for missing/unresolved blocks. always 1. */
export const MISSING;
```

#### `stateToBlock`

```ts
/** Map a global state id to the block handle that owns it; air and unresolved (stale, pre-rebuild) states resolve to the air handle. */
export function stateToBlock(registry: Blocks, state: number): BlockHandle;
```

#### `blockState.BoolPropDef`

```ts
/** a boolean property (false=0, true=1). cardinality 2. */
export type BoolPropDef = {
    readonly type: 'bool';
    readonly cardinality: 2;
};
```

#### `blockState.EnumPropDef`

```ts
/** an enum property with string literal values. cardinality = values.length. */
export type EnumPropDef<V extends readonly string[]> = {
    readonly type: 'enum';
    readonly values: V;
    readonly cardinality: V['length'];
};
```

#### `blockState.IntPropDef`

```ts
/** an integer range property [min, max] inclusive. cardinality = max - min + 1. */
export type IntPropDef<Min extends number = number, Max extends number = number> = {
    readonly type: 'int';
    readonly min: Min;
    readonly max: Max;
    readonly cardinality: number;
};
```

#### `blockState.PropDef`

```ts
export type PropDef = BoolPropDef | EnumPropDef<readonly string[]> | IntPropDef;
```

#### `blockState.PropsDef`

```ts
/** map from property name to property definition. */
export type PropsDef = {
    readonly [key: string]: PropDef;
};
```

#### `blockState.bool`

```ts
/** boolean property (false=0, true=1). */
export function bool(): BoolPropDef;
```

#### `blockState.enumeration`

```ts
/** enum property from string literal values. */
export function enumeration<const V extends readonly string[]>(values: V): EnumPropDef<V>;
```

#### `blockState.int`

```ts
/** integer range property [min, max] inclusive. */
export function int<const Min extends number, const Max extends number>(min: Min, max: Max): IntPropDef<Min, Max>;
```

#### `blockState.PropValue`

```ts
/** infer the ts type for a single property value. */
export type PropValue<P extends PropDef> = P extends BoolPropDef
    ? boolean
    : P extends EnumPropDef<infer V>
      ? V[number]
      : P extends IntPropDef
        ? number
        : never;
```

#### `blockState.PropsValues`

```ts
/** infer a full property values object from a props definition. */
export type PropsValues<P extends PropsDef> = {
    readonly [K in keyof P]: PropValue<P[K]>;
};
```

#### `blockState.BlockStateDef`

```ts
export type BlockStateDef<P extends PropsDef = PropsDef> = {
    /** the property definitions. */
    readonly props: P;

    /** total number of states (product of all property cardinalities). */
    readonly totalStates: number;

    /**
     * pack property values into a local state index (0..totalStates-1).
     * all properties must be provided. O(n) where n = property count.
     */
    encode(values: PropsValues<P>): number;

    /**
     * unpack a local state index into property values.
     * O(n) where n = property count.
     */
    decode(index: number): PropsValues<P>;

    /**
     * extract a single property value from a local state index. O(1).
     */
    get<K extends string & keyof P>(index: number, prop: K): PropValue<P[K]>;

    /**
     * return a new local state index with one property changed. O(1).
     */
    with<K extends string & keyof P>(index: number, prop: K, value: PropValue<P[K]>): number;

    /**
     * The stride (place-value multiplier) of a single property: how much the encoded index changes when this prop's value advances by 1.
     * Capture strides at module scope to inline encode in a hot path without allocating a props object. O(1).
     *
     * ```ts
     * const N = FenceState.stride('north');
     * const E = FenceState.stride('east');
     * // hot path:
     * const localIdx = (north ? N : 0) + (east ? E : 0) + ...;
     * ```
     */
    stride<K extends string & keyof P>(prop: K): number;
};
```

#### `blockState.create`

```ts
/**
 * create a block state schema. self-contained object with encode/decode
 * operations on local state indices (0..totalStates-1).
 *
 * ```ts
 * import * as bs from './block-states';
 *
 * const LogStates = bs.create({
 *     axis: bs.enumeration(['x', 'y', 'z'] as const),
 * });
 *
 * LogStates.encode({ axis: 'y' }); // 1
 * LogStates.decode(1);             // { axis: 'y' }
 * LogStates.get(2, 'axis');        // 'z'
 * LogStates.with(0, 'axis', 'z');  // 2
 * ```
 */
export function create<const P extends PropsDef>(props: P): BlockStateDef<P>;
```

#### `BlockHandle`

```ts
/** Stable wrapper around a `BlockDef`: identity, the live def, and the state-id helpers gameplay code calls. */
export type BlockHandle<P extends PropsDef = PropsDef> = {
    readonly id: string; // the declared id (identity, never changes)
    dependency: { registry: 'blocks'; id: string }; // DepGraph dependency + the brand `isHandle` tests
    def: BlockDef<P>; // the declared data, re-pointed on every re-declaration

    _index: number; // dense block type index, set by the registry builder at freeze time
    _baseStateId: number; // first global state id, set by the registry builder at freeze time
    _hooks: number; // bitmask of hooks this block has (intrinsic + observer)

    // per-block dust particles, derived from the default state's model, shared as the fallback for any unset particle slot.
    _defaultDust: readonly ParticleHandle[] | null;

    stateId(props: PropsValues<P>): number; // get the global state id for specific property values

    // lift a pre-computed local state index into a global state id, skipping the props-object allocation stateId() needs.
    stateIdLocal(localIdx: number): number;

    defaultId(): number; // get the default global state id, driven by `defaultState`
    stateKey(props: PropsValues<P>): string; // get the stable string key for specific property values (e.g. "oak_log[axis=y]")
    defaultKey(): string; // get the stable string key for the default state
};
```

#### `BlockModel`

```ts
export type BlockModel = CubeModel | CustomModel;
```

#### `BlockOptions`

```ts
export type BlockOptions<P extends PropsDef = PropsDef> = AssetMeta & {
    states?: BlockStateDef<P>; // block state schema. omit for stateless blocks
    defaultState?: PropsValues<P>; // authoritative default state, drives defaultId()/defaultKey() and the inventory icon
    model?: (props: PropsValues<P>) => BlockModel | BlockModel[]; // geometry per state; an array return declares per-position variants
    cull?: CullType | ((props: PropsValues<P>) => CullType); // face culling between adjacent blocks. default CullType.SOLID
    material?: MaterialType | ((props: PropsValues<P>) => MaterialType); // which render pass geometry goes to. default MaterialType.OPAQUE
    vertexAnimation?: VertexAnimation | ((props: PropsValues<P>) => VertexAnimation); // @default VertexAnimation.NONE
    jitter?: { xz?: number; y?: number }; // small render-only world-position-derived offset so a field of blocks isn't on a grid
    lightEmission?: [number, number, number] | ((props: PropsValues<P>) => [number, number, number]); // rgb, each channel 0-15
    lightOpacity?: number | ((props: PropsValues<P>) => number); // 0-15, 0 = transparent, 15 = opaque; default by cull type
    emissive?: boolean | ((props: PropsValues<P>) => boolean); // renders at full brightness regardless of surrounding light. @default false
    collision?: boolean | ((props: PropsValues<P>) => boolean); // participates in physics collision. @default true
    selection?: boolean | ((props: PropsValues<P>) => boolean); // targetable by raycasts for mining/placing/picking. @default true
    shape?: BlockShape | ((props: PropsValues<P>) => BlockShape); // physics/selection shape in block-local [0,1] space; omit for the unit box fast path
    climbable?: boolean | ((props: PropsValues<P>) => boolean); // treated as a ladder (gravity bypassed). @default false
    liquid?: { viscosity: number } | null | ((props: PropsValues<P>) => { viscosity: number } | null); // character swims while submerged, drag scales with viscosity
    pathfindable?: boolean | ((props: PropsValues<P>) => boolean); // may a navigating agent occupy/pass through this cell? @default !collision
    friction?: number | ((props: PropsValues<P>) => number); // 0 = perfect ice, ~0.1 = slippery, ~2.0 = sticky. @default 1.0
    restitution?: number | ((props: PropsValues<P>) => number); // bounciness. 0 = no bounce, 1 = elastic. @default 0
    sneakGuard?: boolean | ((props: PropsValues<P>) => boolean); // crouched character anchors and can't walk off edges. default true for collidable blocks
    flags?: number; // extra bits OR'd into the block's flags bitmask (BLOCK_FLAG_FENCE, BLOCK_FLAG_WALL, ...)
    surfaceHeight?: number | ((props: PropsValues<P>) => number); // (0..1), opts this block into MODEL_LIQUID
    fluidGroup?: string; // states sharing a group string cull faces between each other when surface heights line up
    screenTint?: ScreenTintSpec | ((props: PropsValues<P>) => ScreenTintSpec | undefined); // fullscreen overlay while camera is inside this block
    sounds?: BlockSoundConfig | ((props: PropsValues<P>) => BlockSoundConfig); // footstep/dig/break/place sounds; omit to leave silent
    onNeighbourUpdate?: OnNeighbourUpdateFn; // pure state recompute after any neighbour changes; must be pure
    onNeighbourChanged?: OnNeighbourChangedFn; // imperative side-effect hook after any neighbour changes; server-only
    place?: PlaceFn; // pick the placed stateId from hit context; falls back to the prop-name convention when undefined
    rotate?: RotateFn; // rotate a stateId 90 degrees around `axis`; falls back to the prop-name convention
    flip?: FlipFn; // mirror a stateId across the plane perpendicular to `axis`; falls back to the prop-name convention
    particles?: BlockParticleConfig | ((props: PropsValues<P>) => BlockParticleConfig) | false; // missing slots auto-derive from the top-face texture
};
```

#### `BlockQuad`

```ts
export type BlockQuad = {
    verts: [Vec3, Vec3, Vec3, Vec3]; // 4 vertices in CCW order as [x, y, z] in block-local space [0,1]
    normal: Vec3;
    tile: TileHandle;
    uvs?: [Vec2, Vec2, Vec2, Vec2]; // defaults to full-texture [[0,1],[1,1],[1,0],[0,0]]

    // hidden when the neighbor in this direction is a full opaque cube; undefined = never culled; only for quads flush with the block boundary.
    cullFace?: 'north' | 'south' | 'east' | 'west' | 'up' | 'down';

    shade?: boolean; // `false` skips per-face directional shade (AO still applies); foliage uses it to read as one soft mass. default true
    material?: MaterialType; // render pass for this quad; defaults to the block's material
    ao?: boolean; // receives smooth-light + AO sampling; set false for quads that should stay flat-lit. default true
};
```

#### `BlockSoundConfig`

```ts
export type BlockSoundConfig = {
    footstep?: readonly SoundHandle[]; // walking on this block, and, for liquid blocks, entry splash and each swim stroke
    dig?: readonly SoundHandle[]; // looped while the block is being mined (before the final break)
    break?: readonly SoundHandle[]; // one-shot on the final break
    place?: readonly SoundHandle[]; // one-shot when a block of this type is placed by a player
};
```

#### `CubeFaceRotation`

```ts
/** UV rotation for a cube face, 0/90/180/270 ccw. default 0. */
export type CubeFaceRotation = 0 | 90 | 180 | 270;
```

#### `CubeFaceSpec`

```ts
export type CubeFaceSpec = TileHandle | {
    tile: TileHandle;
    rotation?: CubeFaceRotation;
};
```

#### `CubeModel`

```ts
/** cube model, standard solid block. */
export type CubeModel = {
    type: 'cube';
    tiles: CubeTiles;
};
```

#### `CubeTiles`

```ts
/** per-face tile assignment for a cube model. */
export type CubeTiles =
    | { all: CubeFaceSpec }
    | { top: CubeFaceSpec; bottom: CubeFaceSpec; sides: CubeFaceSpec }
    | {
          top: CubeFaceSpec;
          bottom: CubeFaceSpec;
          north: CubeFaceSpec;
          south: CubeFaceSpec;
          east: CubeFaceSpec;
          west: CubeFaceSpec;
      };
```

#### `CustomModel`

```ts
export type CustomModel = {
    type: 'custom';
    quads: BlockQuad[]; // the mesher emits these directly; the registry build rejects non-quad input
};
```

#### `TileDef`

```ts
/** The declared data for one tile; hashed and swapped wholesale on re-declaration. */
export type TileDef = {
    id: string; // tile string id (e.g. 'lava')
    frames: DepKey[]; // textures this tile's frames sample, in order: one entry for a static tile, N for a flipbook
    fps: number; // animation speed in frames per second
    interpolate: boolean;
};
```

#### `TileHandle`

```ts
/** Stable wrapper around a `TileDef`: identity plus the live def, referenced by handle rather than id string so resolving needs no registry lookup. */
export type TileHandle = {
    readonly id: string; // the declared id (identity, never changes)
    dependency: { registry: 'tiles'; id: string }; // DepGraph dependency + the brand `isHandle` tests
    def: TileDef; // the declared data, re-pointed on every re-declaration
};
```

#### `TileOptions`

```ts
export type TileOptions = {
    src?: ImageSource | ImageSource[]; // source image(s): single entry for static, array for animated; a path or an asset() ref
    frames?: TextureHandle[]; // the textures this tile's frames come from, the direct form; `src` is sugar for this
    fps?: number; // animation speed in frames per second, default 1; ignored if single frame
    interpolate?: boolean; // interpolate between frames (smooth water). default false
};
```

#### `faceRotation`

```ts
/** the rotation a face spec carries, 0 when it is a bare handle. */
export function faceRotation(spec: CubeFaceSpec): CubeFaceRotation;
```

#### `faceTile`

```ts
/** the tile a face spec names, in either form. */
export function faceTile(spec: CubeFaceSpec): TileHandle;
```

#### `tileFrame`

```ts
/** The texture backing one of a tile's frames, resolved through the texture store; null when the tile has no such frame. */
export function tileFrame(tile: TileHandle, index = 0): TextureHandle | null;
```

#### `propagateAllLight`

```ts
/** full light recompute: zeros all light, seeds sky columns + emitters, then spreads each channel; used on initial load or a drastic world change. */
export function propagateAllLight(voxels: Voxels): void;
```

#### `relightChunks`

```ts
/** scoped light recompute over a chunk set plus a one-ring neighbour margin, treating chunks outside the working set as a fixed boundary; driven by the batch-edit commit path so bulk edits relight in one pass instead of per-block incremental BFS. */
export function relightChunks(voxels: Voxels, dirty: Set<Chunk>): void;
```

#### `VoxelSweepHit`

```ts
/** result of a voxel sweep. mutated in place. */
export type VoxelSweepHit = {
    /** time of impact in [0, 1]. */
    toi: number;
    /** colliding axis (0=X, 1=Y, 2=Z) or -1 if no hit. dominant-axis hint. */
    axis: number;
    /** sign of normal on that axis (+1 or -1, in moving box's frame). */
    sign: number;
    /** contact normal (world space, unit length, axis-aligned). */
    normalX: number;
    normalY: number;
    normalZ: number;
    /** world voxel coords. */
    vx: number;
    vy: number;
    vz: number;
    /** global state id at that voxel. */
    stateId: number;
    /** sub-AABB index within the block's shapeAabbs[cid] list, or -1 for cube. */
    subAabbIndex: number;
    /** the world-space box that won (in case the caller needs the geometry). */
    boxMinX: number;
    boxMinY: number;
    boxMinZ: number;
    boxMaxX: number;
    boxMaxY: number;
    boxMaxZ: number;
    /** penetration depth along the contact normal; non-zero only when toi < 0. */
    overlapDepth: number;
    /** the passable (non-colliding) cells the box swept through this call, when
     *  the sweep was asked to `collect` them; empty otherwise. pooled: the caller
     *  resets `crossed.count` before a fresh sweep (or sequence of segment
     *  sweeps), the sweep only appends. see {@link CrossedVoxels}. */
    crossed: CrossedVoxels;
};
```

#### `createVoxelSweepHit`

```ts
export function createVoxelSweepHit(): VoxelSweepHit;
```

#### `sweepAabbVsVoxels`

```ts
/**
 * sweep an AABB through the voxel grid. used by VCC and any future
 * voxel-aware character controller.
 *
 * the nearest-solid-hit fields of `out` are reset internally; on return,
 * `out.axis === -1` iff no hit.
 *
 * when `collect` is true, the passable (non-colliding) cells the box sweeps
 * through are appended to `out.crossed` (liquid / trigger detection). the hit
 * fields reset each call but `out.crossed` does NOT, so a caller doing a
 * sequence of segment sweeps unions them, and resets `out.crossed.count` itself
 * before the sequence. when `collect` is false, `out.crossed` is left untouched.
 */
export function sweepAabbVsVoxels(out: VoxelSweepHit, voxels: Voxels, mcX: number, mcY: number, mcZ: number, mhX: number, mhY: number, mhZ: number, dx: number, dy: number, dz: number, collect: boolean): boolean;
```

#### `VoxelRaycastResult`

```ts
export type VoxelRaycastResult = {
    hit: boolean;
    /** world-space hit point */
    px: number;
    py: number;
    pz: number;
    /** hit surface normal */
    nx: number;
    ny: number;
    nz: number;
    /** distance from ray origin */
    distance: number;
    /** integer world coords of the hit block */
    voxelX: number;
    voxelY: number;
    voxelZ: number;
    /** global state id of the hit block */
    stateId: number;
    /**
     * for cubes: face index (0=east+x, 1=west-x, 2=up+y, 3=down-y, 4=south+z, 5=north-z).
     * for custom models: triangle index in the model's tris array.
     * -1 if no hit.
     */
    hitIndex: number;
};
```

#### `createVoxelRaycastResult`

```ts
export function createVoxelRaycastResult(): VoxelRaycastResult;
```

#### `raycastVoxels`

```ts
/**
 * Casts a ray through the voxel world using DDA. Skips empty/missing chunks via nonAirCount; cube blocks (colliderId=0) resolve from the DDA step itself, others test against the prebuilt crashcat shape.
 * `requiredFlags` is a bitmask of block flags required for a hit (0 = no filtering).
 */
export function raycastVoxels(out: VoxelRaycastResult, voxels: Voxels, registry: Blocks, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDistance: number, requiredFlags: number): VoxelRaycastResult;
```

#### `Chunk`

```ts
export type Chunk = {
    cx: number;
    cy: number;
    cz: number;

    wx: number; // world coordinates of chunk corner (cx*16, cy*16, cz*16), cached for meshing
    wy: number;
    wz: number;

    nonAirCount: number;
    solidCount: number; // fully-occluding (CullType.SOLID) blocks, always <= nonAirCount; === CHUNK_VOLUME means fully opaque

    // stable string keys per palette slot; paletteKeys[0] is always "air", the persistence/network identity, survives registry rebuilds; append-only across a session or shrinking/reordering would silently re-alias set voxels.
    paletteKeys: string[];

    palette: number[]; // runtime numeric ids per palette slot (resolved from registry); rebuilt from paletteKeys on registry change
    paletteMap: Map<string, number>; // reverse lookup: string key -> local palette index, kept in sync with paletteKeys
    data: Uint16Array; // packed voxel data, one local palette index (not a global state id) per entry, length CHUNK_VOLUME

    // per-voxel light, length CHUNK_VOLUME; each entry packs 4 channels into 16 bits: 15..12 sky, 11..8 red, 7..4 green, 3..0 blue.
    light: Uint16Array;

    dirty: boolean; // set when data changes, cleared by mesher

    // monotonically increasing version of this chunk's mesh-relevant state, bumped by every mutation that would change the mesh output; the worker dispatcher echoes it back so voxel-visuals can detect a stale result. starts at 1.
    meshGen: number;

    // monotonically increasing version of this chunk's persisted data (blocks, light, palette), bumped by every mutation that changes the bytes saveVoxels would write, but NOT by mesh-only changes. starts at 1.
    version: number;

    lightDirty: boolean; // set when light[] changes, cleared after network flush

    // per-voxel dirty mask for incremental light deltas, byte-per-voxel, length CHUNK_VOLUME, server-only. idle chunks alias the shared EMPTY_LIGHT_MASK singleton; setLight COWs on first write.
    lightDirtyMask: Uint8Array;
    lightDirtyCount: number; // set bytes in lightDirtyMask, a cheap threshold check without scanning the mask

    compressedSnapshot: Uint8Array | null; // cached compressed snapshot for chunk_full encoding; invalidated on data/light change
    snapshotPalette: number[] | null; // cached per-slot global state ids at snapshot time (the wire palette for voxel_chunk_full)
    compressedLight: { sky: Uint8Array; rgb: Uint8Array } | null; // cached compressed light streams for chunk_light encoding

    // neighbor chunk refs for cross-chunk traversal, 26 slots (the mesher's 3x3x3 apron): slots 0-5 are the 6 faces in light.ts's direction convention, slots 6-25 are the 12 edges + 8 corners. null if that neighbor isn't loaded.
    neighbors: (Chunk | null)[];
    knownNeighbourCount: number; // non-null entries in `neighbors` (0-26); streaming defers meshing until the full apron is present
    lightWaitSince: number; // frame the light volume first wanted to re-bake this chunk while its neighbourhood was incomplete, or -1
    lightWanted: boolean; // the AOI wants this chunk rendered, so it may hold a light tile
    lightUrgent: boolean; // this chunk's own light changed (vs apron-dirtied by a neighbour); urgent rebakes are never deferred
};
```

#### `Voxels`

```ts
export type Voxels = {
    chunks: Map<string, Chunk>;

    // dirty index, sidecar to chunk.dirty/chunk.lightDirty flags. `blocks` is the renderer tier, consumed by voxel-visuals.update(). `light` is the server network tier, consumed by discovery's chunk_light streaming (kept separate so the server doesn't filter a growing `blocks` set). `removed` is dropped chunk keys.
    dirty: {
        blocks: Set<Chunk>;
        light: Set<Chunk>;
        lightVolume: Set<Chunk>;
        lightVolumeUrgent: Set<Chunk>;
        removed: Set<string>;
    };

    columns: Map<string, Chunk[]>; // xz-column index, chunks at (cx, cz) sorted by cy descending; lets sky-light/heightmap code walk without scanning the world bbox
    regions: Map<string, Set<Chunk>>; // AOI region occupancy index; an emptied region's entry is deleted so churn doesn't leave stale Sets behind
    registry: Blocks; // block registry, flat lookup tables; hot reload reassigns this field and calls resolveAllChunks() per room
    authority: VoxelsAuthority | null;
    lighting: VoxelsLighting;
};
```

#### `VoxelsAuthority`

```ts
/** Authoritative-emission bundle, populated when this Voxels owns the truth; null on a read-only mirror (today's clients). */
export type VoxelsAuthority = {
    changes: VoxelChanges; // per-tick change log for block ops, light updates, and new chunks
    observers: Map<number, BlockObserverEntry> | null; // per-room onBuild/onBreak/onStateChange registry, keyed by block-type index; lazy-init
    hookDepth: number; // current block-hook recursion depth, bounds a runaway chained-setBlock cascade
};
```

#### `CHUNK_BITS`

```ts
export const CHUNK_BITS;
```

#### `CHUNK_SIZE`

```ts
export const CHUNK_SIZE;
```

#### `CHUNK_SIZE_SQ`

```ts
export const CHUNK_SIZE_SQ;
```

#### `CHUNK_VOLUME`

```ts
export const CHUNK_VOLUME;
```

#### `REGION_CHUNK_SHIFT`

```ts
export const REGION_CHUNK_SHIFT;
```

#### `REGION_CHUNKS_PER_AXIS`

```ts
export const REGION_CHUNKS_PER_AXIS;
```

#### `REGION_BITS`

```ts
export const REGION_BITS;
```

#### `REGION_SIZE`

```ts
export const REGION_SIZE;
```

#### `REGION_VOLUME`

```ts
export const REGION_VOLUME;
```

#### `REGION_LOCAL_CHUNK_OFFSETS`

```ts
export const REGION_LOCAL_CHUNK_OFFSETS: [
    number,
    number,
    number
][];
```

#### `BLOCK_AIR`

```ts
/** the air key. always "air". */
export const BLOCK_AIR;
```

#### `voxelIndex`

```ts
/** flat index within a chunk for local coords (x, y, z). YZX order. */
export function voxelIndex(x: number, y: number, z: number): number;
```

#### `chunkKey`

```ts
/** chunk coordinate key for use as a Map key. */
export function chunkKey(cx: number, cy: number, cz: number): string;
```

#### `chunkColumnKey`

```ts
/** chunk xz-column key, groups chunks sharing (cx, cz) so callers can walk a column top-down without scanning the world bbox. */
export function chunkColumnKey(cx: number, cz: number): string;
```

#### `regionKey`

```ts
/** region coordinate key, same string convention as chunkKey, one level coarser. */
export function regionKey(rx: number, ry: number, rz: number): string;
```

#### `toChunkCoord`

```ts
/** block coordinate -> chunk coordinate; caller floors first, since this truncates toward zero. */
export function toChunkCoord(worldCoord: number): number;
```

#### `chunkToRegionCoord`

```ts
/** chunk coordinate -> region coordinate (floored division by REGION_CHUNKS_PER_AXIS). */
export function chunkToRegionCoord(chunkCoord: number): number;
```

#### `toRegionCoord`

```ts
/** world position -> region coordinate directly, without the intermediate chunk coordinate; caller floors first. */
export function toRegionCoord(worldCoord: number): number;
```

#### `toLocalCoord`

```ts
/** world position -> local coordinate within chunk. */
export function toLocalCoord(worldCoord: number): number;
```

#### `worldToBlockCoord`

```ts
/** world position (any axis) -> block index on that axis; block N occupies world [N, N+1), so this is a floor. */
export function worldToBlockCoord(worldCoord: number): number;
```

#### `blockTopCenter`

```ts
/** world-space point at the center of a block's top face, i.e. where feet land standing on top of `block`. */
export function blockTopCenter(out: Vec3, block: Vec3): Vec3;
```

#### `createChunk`

```ts
/** create a new empty chunk (all air). */
export function createChunk(cx: number, cy: number, cz: number): Chunk;
```

#### `newNeighbors`

```ts
/** fresh 26-slot neighbor array, all null. */
export function newNeighbors(): (Chunk | null)[];
```

#### `EMPTY_DATA`

```ts
export const EMPTY_DATA;
```

#### `EMPTY_LIGHT`

```ts
export const EMPTY_LIGHT;
```

#### `EMPTY_LIGHT_MASK`

```ts
export const EMPTY_LIGHT_MASK;
```

#### `createEmptyChunk`

```ts
/** Create a Chunk stub for a chunk the server confirmed is empty; `data`/`light` alias module-level singletons to stay cheap. */
export function createEmptyChunk(cx: number, cy: number, cz: number): Chunk;
```

#### `NEIGHBOR_COUNT`

```ts
/** number of neighbour slots on `Chunk.neighbors` (full 3x3x3 minus self). */
export const NEIGHBOR_COUNT;
```

#### `neighbourSlot`

```ts
/** slot index in `neighbors[]` for the neighbour at chunk-offset (dx,dy,dz), each in [-1,1]; -1 for (0,0,0) / out of range. */
export function neighbourSlot(dx: number, dy: number, dz: number): number;
```

#### `linkChunkNeighbors`

```ts
/** wire up bidirectional neighbor refs for a chunk just added to voxels.chunks, bumping `knownNeighbourCount` on both sides. */
export function linkChunkNeighbors(voxels: Voxels, chunk: Chunk): void;
```

#### `unlinkChunkNeighbors`

```ts
/** null out neighbor refs when a chunk is about to be removed from voxels.chunks, decrementing each surviving neighbour's count. */
export function unlinkChunkNeighbors(chunk: Chunk): void;
```

#### `loadChunk`

```ts
/** Insert (or update in place) a chunk from already-decoded parts, for the mesh worker's mirror loading a packet. */
export function loadChunk(voxels: Voxels, cx: number, cy: number, cz: number, version: number, data: Uint16Array, light: Uint16Array, palette: number[]): Chunk;
```

#### `removeChunk`

```ts
/** Remove a chunk from `voxels.chunks`, unlinking the neighbour graph and its `voxels.regions` entry (`columns` has no removal path, left alone). */
export function removeChunk(voxels: Voxels, cx: number, cy: number, cz: number): void;
```

#### `getChunkBlock`

```ts
/** get the global state id at a local position within a chunk, the mesher's fast path; no bounds checking. */
export function getChunkBlock(chunk: Chunk, x: number, y: number, z: number): number;
```

#### `getChunkBlockKey`

```ts
/** get the string key at a local position within a chunk, for persistence/inspection/debugging; not hot-path. */
export function getChunkBlockKey(chunk: Chunk, x: number, y: number, z: number): string;
```

#### `ensureChunkPaletteSlot`

```ts
/** get-or-allocate the chunk-local palette index for a block key. */
export function ensureChunkPaletteSlot(chunk: Chunk, key: string, registry: Blocks): number;
```

#### `chunkData`

```ts
/** the chunk's writable voxel-data array, COWing out of the shared EMPTY_DATA stub first so a direct write can't corrupt it. */
export function chunkData(chunk: Chunk): Uint16Array;
```

#### `chunkLight`

```ts
/** Writable light for a chunk, copy-on-write off `EMPTY_LIGHT` (every empty stub aliases that one buffer). */
export function chunkLight(chunk: Chunk): Uint16Array;
```

#### `setChunkBlock`

```ts
/** Set a block at a chunk-local position: writes the cell, maintains counts/mesh gen, routes lighting; op/hook recording is authority-side. */
export function setChunkBlock(voxels: Voxels, chunk: Chunk, x: number, y: number, z: number, key: string, flags: number = SetBlockFlags.DEFAULT): void;
```

#### `invalidateChunk`

```ts
/** Reconcile a chunk after tier-1 raw writes into `chunkData(chunk)`: rescans counts, marks mesh-dirty, schedules light. No ops, no hooks. */
export function invalidateChunk(voxels: Voxels, chunk: Chunk): void;
```

#### `setLight`

```ts
/** Write a packed light value at a chunk-local voxel index, marking the per-chunk dirty mask; callers must still call markChunkLightDirty. */
export function setLight(chunk: Chunk, index: number, value: number): void;
```

#### `resolveChunk`

```ts
/** Re-resolve all palette keys against a new registry (unresolved keys become MISSING); call on hot reload. */
export function resolveChunk(chunk: Chunk, registry: Blocks): void;
```

#### `repackChunkSnapshot`

```ts
/** Compute a compacted snapshot of a chunk's palette + data without mutating the chunk (the save path; the live chunk keeps its append-only palette). */
export function repackChunkSnapshot(chunk: Chunk): {
    paletteKeys: string[];
    data: Uint16Array;
};
```

#### `VoxelBlockOp`

```ts
export type VoxelBlockOp = {
    kind: 0;
    cx: number;
    cy: number;
    cz: number;
    index: number;
    data: number; // chunk-local palette index, what the network sends to clients
    wx: number; // world coords, saves recomputing per delta for hook dispatch
    wy: number;
    wz: number;
    oldStateId: number; // global state id before this op
    newStateId: number; // global state id after this op
};
```

#### `VoxelDeleteOp`

```ts
export type VoxelDeleteOp = {
    kind: 2;
    cx: number;
    cy: number;
    cz: number;
};
```

#### `VoxelOp`

```ts
export type VoxelOp = VoxelBlockOp | VoxelDeleteOp;
```

#### `VoxelChanges`

```ts
/** Per-tick accumulator of authoritative voxel mutations; light-recompute work lives separately in `Voxels.lighting`. */
export type VoxelChanges = {
    ops: VoxelOp[]; // append-only log of block ops this tick; block-hooks settles hooks inline, discovery ships the log
    addedChunks: Set<Chunk>; // chunks created this tick; discovery rewinds each player's cursor to stream them without a full re-walk
};
```

#### `createVoxelChanges`

```ts
export function createVoxelChanges(): VoxelChanges;
```

#### `clearVoxelChanges`

```ts
export function clearVoxelChanges(changes: VoxelChanges): void;
```

#### `FloodFillLightingState`

```ts
export type FloodFillLightingState = {
    enabled: boolean;
    minLevel: number; // 15 = fully lit, 0 = pitch black except emitters
};
```

#### `VoxelsLighting`

```ts
export type VoxelsLighting = {
    floodFill: FloodFillLightingState;
    blocks: Array<{ wx: number; wy: number; wz: number; oldStateId: number }>; // DEFAULT writes -> per-block incremental relight
    chunks: Set<Chunk>; // BULK writes / invalidateChunk -> scoped whole-chunk relight
    newChunks: Chunk[]; // new chunks needing sky light seeded before incremental updates run
    epoch: number; // bumped by propagateAllLight (a full recompute) so clients discard buffered incremental ops; outlives a tick
};
```

#### `createVoxelsLighting`

```ts
export function createVoxelsLighting(): VoxelsLighting;
```

#### `createVoxelsAuthority`

```ts
export function createVoxelsAuthority(): VoxelsAuthority;
```

#### `clearVoxelsAuthority`

```ts
/** clear per-tick state inside the authority bundle; the observer registry is NOT cleared, it outlives a tick. */
export function clearVoxelsAuthority(authority: VoxelsAuthority): void;
```

#### `createVoxels`

```ts
export function createVoxels(registry: Blocks): Voxels;
```

#### `markChunkDirty`

```ts
/** mark `chunk` as needing a remesh, so the renderer's per-frame scan can iterate `voxels.dirty.blocks` instead of the whole Map. */
export function markChunkDirty(voxels: Voxels, chunk: Chunk): void;
```

#### `markLightVolumeDirty`

```ts
/** queue `chunk` for a light-volume rebake at bulk priority (nearest-first, may defer for an incomplete neighbourhood); use for streaming/whole-world relights. */
export function markLightVolumeDirty(voxels: Voxels, chunk: Chunk): void;
```

#### `markLightVolumeUrgent`

```ts
/** queue `chunk` at urgent priority (skips the neighbourhood deferral); reserve for edits, since marking a bulk relight urgent would starve the nearest-first order. */
export function markLightVolumeUrgent(voxels: Voxels, chunk: Chunk): void;
```

#### `markLightVolumeDirtyForCell`

```ts
/** Queue the rebake implied by one cell of `chunk` changing. Just the chunk: no other tile holds a copy of that cell. */
export function markLightVolumeDirtyForCell(voxels: Voxels, chunk: Chunk, index: number): void;
```

#### `markChunkLightDirty`

```ts
/** mark `chunk` as needing a relight (dirty.light + light volume), deliberately not dirty.blocks since a light-only change never alters the mesh. */
export function markChunkLightDirty(voxels: Voxels, chunk: Chunk): void;
```

#### `rebuildSpatialIndexes`

```ts
/** rebuild `voxels.columns` and `voxels.regions` from `voxels.chunks`; used by deserialize and as a defensive reconcile when callers bypass `ensureChunk`. */
export function rebuildSpatialIndexes(voxels: Voxels): void;
```

#### `getChunk`

```ts
/** get the loaded chunk at the given chunk coordinates, or undefined. */
export function getChunk(voxels: Voxels, cx: number, cy: number, cz: number): Chunk | undefined;
```

#### `getChunkAt`

```ts
/** get the loaded chunk containing a block coordinate, or undefined; block coordinates, not chunk ones. */
export function getChunkAt(voxels: Voxels, wx: number, wy: number, wz: number): Chunk | undefined;
```

#### `ensureChunk`

```ts
/** get or create a chunk at the given chunk coordinates. */
export function ensureChunk(voxels: Voxels, cx: number, cy: number, cz: number): Chunk;
```

#### `getBlock`

```ts
/** get the string key at a world position. returns "air" if chunk doesn't exist. */
export function getBlock(voxels: Voxels, wx: number, wy: number, wz: number): string;
```

#### `getBlockState`

```ts
/** get the global state id at a world position. returns AIR if chunk doesn't exist. */
export function getBlockState(voxels: Voxels, wx: number, wy: number, wz: number): number;
```

#### `getBlockStateRelative`

```ts
export function getBlockStateRelative(voxels: Voxels, chunk: Chunk, lx: number, ly: number, lz: number): number;
```

#### `forEachBlock`

```ts
/** iterate every non-air block in a voxels instance, yielding world coords and string key. */
export function forEachBlock(voxels: Voxels, cb: (wx: number, wy: number, wz: number, key: string) => void): void;
```

#### `setBlock`

```ts
/** Set a block at a world position, creating the chunk if needed; `flags` controls script observers (`DEFAULT` fires them, `BULK` does not). */
export function setBlock(voxels: Voxels, wx: number, wy: number, wz: number, key: string, flags: number = SetBlockFlags.DEFAULT): void;
```

#### `resolveAllChunks`

```ts
/** re-resolve all chunks against the current registry; call on hot reload when the registry rebuilds. */
export function resolveAllChunks(voxels: Voxels): void;
```

#### `cloneVoxels`

```ts
/** Deep-copy a Voxels instance into a fresh one whose chunk data mutations won't affect the source; registry is shared by reference. */
export function cloneVoxels(src: Voxels): Voxels;
```

#### `copyVoxels`

```ts
/** Copy all non-air blocks from `src` into `out` at the same world positions; existing blocks in `out` elsewhere are left alone. */
export function copyVoxels(out: Voxels, src: Voxels): void;
```

Also exported: `CullType`, `MaterialType`, `VertexAnimation`.

## Rendering & visuals

The camera, lighting and sky, and the traits that draw a node.

#### `CameraTrait`

```ts
/**
 * plain projection data (fov/near/far) for a scene-tree node. World pose lives on the sibling
 * TransformTrait; a controller or the editor lens owns the camera node and writes its pose each
 * frame. The active camera node is `client.camera`, which the renderer composes the render camera
 * from. `persist: false`, runtime-only.
 */
export const CameraTrait;
```
#### `getCamera`

```ts
/**
 * The active render camera node, composed each frame from its TransformTrait pose and
 * CameraTrait projection. Defaults to the room's camera node. Server-side, ctx.client is
 * undefined and this returns null.
 */
export function getCamera(ctx: ScriptContext): sceneTree.Node | null;
```

#### `getSubject`

```ts
/**
 * The client's current subject: the node local input drives and the engine treats as this
 * client's point of view (renderer + audio). Scripts compare their own ctx.node to it to
 * gate per-frame work that should only run on the active subject. Server-side, ctx.client
 * is undefined and this returns null.
 */
export function getSubject(ctx: ScriptContext): sceneTree.Node | null;
```

#### `setCamera`

```ts
/** Points the active render camera at `node`. Client-only, a no-op on the server. */
export function setCamera(ctx: ScriptContext, node: sceneTree.Node): void;
```

#### `setSubject`

```ts
/** Swaps the client's subject; pass `null` to clear. Client-only, a no-op on the server. Purely local: it never changes ownership or the server-side streaming anchor. */
export function setSubject(ctx: ScriptContext, node: sceneTree.Node | null): void;
```
#### `configureFloodFillLighting`

```ts
/**
 * configure flood-fill light propagation for this room's voxel world.
 * fields default to their current value, pass only what you want to change.
 * call from a shared-realm system so client and server stay in sync, since a
 * config skew between the two sides diverges silently.
 *
 * - `enabled`: when false, `setBlock` and new chunks skip the BFS queue and
 *   inline-seed `chunk.light` from block emission + `minLevel` sky instead.
 * - `minLevel`: sky-channel seed used by inline writes (0-15). `15` keeps
 *   the world fully lit; `0` is pitch black except for block emission.
 */
export function configureFloodFillLighting(ctx: ScriptContext, o: {
    enabled?: boolean;
    minLevel?: number;
}): void;
```
#### `SkyPreset`

```ts
export type SkyPreset = 'overworld';
```

#### `SkyStop`

```ts
export type SkyStop = {
    /** wraps in [0,1]; sun position = `t * 2 * PI` */
    t: number;
    zenith: Vec3;
    horizon: Vec3;
    nadir: Vec3;
};
```

#### `EnvironmentConfig`

```ts
/** Input shape for {@link setEnvironment}, every field optional; shallow-merges into current state. */
export type EnvironmentConfig = {
    enabled?: boolean;
    sky?: { preset?: SkyPreset; stops?: SkyStop[] };
    sun?: { enabled?: boolean; intensity?: number };
    moon?: { enabled?: boolean };
    stars?: { enabled?: boolean; density?: number };
    /**
     * Planar cloud layer at `altitude` world units. `thickness` is the virtual depth the shader
     * marches through for a fake 3D volume; `density` is coverage in [0,1]; `wind` drifts the
     * noise field over `envTime`.
     */
    clouds?: { enabled?: boolean; density?: number; wind?: Vec2; altitude?: number; thickness?: number };
    /**
     * Distance fog, fading from `start` to `end`.
     *
     *   `end`     world units, or `'view'` (default) to track the client's own view radius,
     *             fading the world out at the streamed chunk boundary.
     *   `start`   fraction of `end` where the fade begins, not world units.
     *   `color`   `'sky'` tracks the sky LUT's horizon at the current time of day, or a linear
     *             rgb triple pins it.
     *   `opacity` how opaque fog gets at `end`; 1 fully replaces the colour.
     */
    fog?: { enabled?: boolean; color?: Vec3 | 'sky'; end?: number | 'view'; start?: number; opacity?: number };
};
```

#### `PRESETS`

```ts
/** Named sky LUT tables. Only `overworld` is tuned right now. */
export const PRESETS: Record<SkyPreset, SkyStop[]>;
```

#### `ENVIRONMENT_DEFAULT`

```ts
/** Default resolved environment config when a room boots. */
export const ENVIRONMENT_DEFAULT: ClientEnvironment.ResolvedEnvironment;
```

#### `ENVIRONMENT_OVERWORLD`

```ts
export const ENVIRONMENT_OVERWORLD: ClientEnvironment.ResolvedEnvironment;
```

#### `setEnvironmentTime`

```ts
/**
 * Advances the environment time, in hours (0 = midnight, 6 = sunrise, 12 = noon, 18 = sunset,
 * wraps mod 24). Hot path, one f32 uniform write; safe to call every frame.
 */
export function setEnvironmentTime(ctx: ScriptContext, hours: number): void;
```

#### `getEnvironmentTime`

```ts
/** Current environment time in hours, in [0, 24). */
export function getEnvironmentTime(ctx: ScriptContext): number;
```

#### `setEnvironment`

```ts
/**
 * Merges a partial config into the room's environment (see {@link EnvironmentConfig}). Slow
 * path, repacks and re-uploads the config buffer: call from script init or game events, never
 * every frame (use {@link setEnvironmentTime} for per-frame time-of-day). Merges per-field;
 * omitted groups and fields keep their current value. No-ops without an active client environment.
 *
 * @example
 * setEnvironment(ctx, {
 *     sun: { intensity: 0.2 },
 *     clouds: { enabled: true, density: 0.9, thickness: 4 },
 * });
 */
export function setEnvironment(ctx: ScriptContext, config: EnvironmentConfig): void;
```
#### `MeshTrait`

```ts
export const MeshTrait;
```
#### `VoxelModel`

```ts
/**
 * Pure voxel data container: a Voxels grid plus derived bounds, dimensions, count, and a default origin.
 * Renderer-agnostic; VoxelMeshTrait references one for rendering, and the same data can drive crashcat shape factories.
 * The underlying Voxels must not be mutated after construction; consumers cache derived geometry keyed by VoxelModel identity.
 */
export class VoxelModel {
    voxels: Voxels;
    boundsMin: Vec3;
    boundsMax: Vec3;
    dimensions: Vec3;
    voxelCount: number;
    origin: Vec3;
    constructor(voxels: Voxels) {
        this.voxels = voxels;
        const { boundsMin, boundsMax, voxelCount } = scanBounds(voxels);
        this.boundsMin = boundsMin;
        this.boundsMax = boundsMax;
        this.voxelCount = voxelCount;
        this.dimensions = [boundsMax[0] - boundsMin[0], boundsMax[1] - boundsMin[1], boundsMax[2] - boundsMin[2]];
        this.origin = [(boundsMin[0] + boundsMax[0]) / 2, (boundsMin[1] + boundsMax[1]) / 2, (boundsMin[2] + boundsMax[2]) / 2];
    }
}
```

#### `createVoxelModelShape`

```ts
/**
 * Builds a static compound shape for `model`, one axis-aligned box per greedy-merged run of non-air voxels (greedy 3D merge along x, then z, then y).
 * Positions are offset by -model.origin, matching VoxelMeshTrait's vertex space, so a body sharing the trait's transform gets matching collision and visuals. Returns null when the model has no non-air voxels.
 */
export function createVoxelModelShape(model: VoxelModel): crashcat.Shape | null;
```

#### `createVoxelModel`

```ts
/**
 * create a VoxelModel from a populated Voxels, computing bounds, dimensions,
 * voxel count, and a default origin at the center of the bounding box.
 * The Voxels should not be mutated after this call.
 */
export function createVoxelModel(voxels: Voxels): VoxelModel;
```

#### `VoxelMeshTrait`

```ts
export const VoxelMeshTrait;
```
#### `SpriteMode`

```ts
export type SpriteMode = 'world' | 'billboard' | 'y-billboard';
```

#### `SpriteTrait`

```ts
export const SpriteTrait;
```
#### `ExtrudedSpriteMeshTrait`

```ts
export const ExtrudedSpriteMeshTrait;
```
#### `ShadowCasterTrait`

```ts
export const ShadowCasterTrait;
```
#### `particleUpdate`

```ts
/** the curated motion vocabulary. drop a `particleUpdate.X` straight
 *  into `particle({ ..., update: particleUpdate.X })`, or compose the
 *  primitives into a custom fn. all share the `(pool, i, dt, voxels)`
 *  per-particle signature. */
export const particleUpdate: {
    gravity: (pool: ParticlePool, i: number, dt: number, g: number) => void;
    drag: (pool: ParticlePool, i: number, dt: number, k: number) => void;
    integrate: (pool: ParticlePool, i: number, dt: number) => void;
    collideSlide: (pool: ParticlePool, i: number, _dt: number, voxels: Voxels) => void;
    collideLand: (pool: ParticlePool, i: number, _dt: number, voxels: Voxels) => void;
    collideBounce: (pool: ParticlePool, i: number, _dt: number, voxels: Voxels, b: number) => void;
    collideDestroy: (pool: ParticlePool, i: number, _dt: number, voxels: Voxels) => void;
    fadeRgb: (pool: ParticlePool, i: number, dt: number, rate: number) => void;
    fadeAlpha: (pool: ParticlePool, i: number, dt: number, rate: number) => void;
    dust: ParticleUpdateFn;
    smoke: ParticleUpdateFn;
    spark: ParticleUpdateFn;
    snow: ParticleUpdateFn;
    rain: ParticleUpdateFn;
};
```

#### `ParticleHandle`

```ts
/** Stable wrapper around a `ParticleDef`; identity plus the live def. */
export type ParticleHandle = {
    /** the declared id (identity, never changes). */
    readonly id: string;
    /** DepGraph dependency + the brand `isHandle` tests. */
    dependency: { registry: 'particles'; id: string };
    /** the declared data. re-pointed on every re-declaration. */
    def: ParticleDef;
};
```

#### `ParticleOptions`

```ts
export type ParticleOptions = AssetMeta & {
    /** the sprite handle whose frames drive the particle's visuals. */
    sprite: SpriteHandle;
    /** how `age / total` (or `age * fps`) maps to the sprite's frame
     *  timeline. `'stretch'` requires spawn opts to pass `lifetime`. */
    playback: ParticlePlayback;
    /** required for `'loop'` / `'once'` on multi-frame sprites; ignored
     *  for `'stretch'`. single-frame sprites degenerate to "show frame
     *  0" in all modes. */
    fps?: number;
    /** per-particle update fn. one indirect call per alive slot per
     *  tick. compose primitives from `particleUpdate.*` or write your
     *  own. */
    update: ParticleUpdateFn;
    /** spawn-time default for the per-particle glow (self-illumination)
     *  level [0,1]. 0 = fully sample world light (lit like models /
     *  voxel-meshes), 1 = fully lit / shadow-free, matching mesh/sprite
     *  `glow`. the update fn can mutate `pool.glow[i]` per-frame for
     *  fades. default 0. */
    glow?: number;
    /** spawn-time default RGBA tint multiplier. RGB multiplies the
     *  shaded color, A the sprite alpha. the update fn can mutate
     *  `pool.tintR/G/B/A[i]` per-frame for fades. default [1,1,1,1]. */
    tint?: [r: number, g: number, b: number, a: number];
};
```

#### `ParticlePlayback`

```ts
/** how a particle's sprite frame timeline maps onto its lifetime. */
export type ParticlePlayback = 'stretch' | 'loop' | 'once';
```

#### `ParticlePool`

```ts
/** Per-room SoA pool (impl lives in render/particles/particles.ts). Alive
 *  prefix is `[0, count)`; dead slots are compacted by `particleUpdate`
 *  (client). The type is declared here so `ParticleUpdateFn` (also here) can
 *  name its first param without forcing a core->client import; the runtime
 *  that allocates / mutates it lives in client. Both halves agree on the
 *  layout via this single declaration. */
export type ParticlePool = {
    /** max slots. */
    capacity: number;
    /** live slots, alive prefix is `[0, count)`. */
    count: number;

    /** particle handle per slot, renderer reads `.sprite` / `.playback`
     *  / `.fps` to drive frame selection + atlas lookup. null on free slots. */
    handle: Array<ParticleHandle | null>;
    /** per-particle update fn resolved at spawn time. dispatch target,
     *  redundant with `handle[i].update` but kept as a direct pointer so
     *  the tick loop's inner indirect-call doesn't chase through the
     *  handle struct. null on free slots. */
    updateFn: Array<ParticleUpdateFn | null>;

    posX: Float32Array;
    posY: Float32Array;
    posZ: Float32Array;
    prevX: Float32Array;
    prevY: Float32Array;
    prevZ: Float32Array;
    velX: Float32Array;
    velY: Float32Array;
    velZ: Float32Array;

    /** absolute clock anchor for `age = now - spawnTime[i]`. */
    spawnTime: Float32Array;
    /** absolute deadline. death = `expiresAt[i] <= now`. default
     *  `Infinity`. motion fns kill by writing `0`. */
    expiresAt: Float32Array;
    /** per-particle render size (multiplies sprite world dims). */
    size: Float32Array;
    /** per-particle glow (self-illumination) in [0,1]. raises the
     *  lighting floor so the particle lights up in its own colour,
     *  0 = lit by world voxel light, 1 = fully lit / shadow-free,
     *  matching mesh/sprite `glow`. mutate from the update fn to
     *  animate (e.g. fire embers fade 1 → 0 over lifetime). */
    glow: Float32Array;
    /** per-particle RGBA tint multiplier. RGB multiplies the shaded
     *  color (so [0,0,0] fades to black), A multiplies the sprite alpha
     *  (so 0 fades to transparent). default [1,1,1,1] = no tint. mutate
     *  from the update fn to animate (e.g. fade RGB or A over lifetime).
     *  decomposed per-channel to match the posX/Y/Z SoA convention. */
    tintR: Float32Array;
    tintG: Float32Array;
    tintB: Float32Array;
    tintA: Float32Array;
    /** deterministic per-particle jitter seed. */
    seed: Uint32Array;
};
```

#### `ParticleUpdateFn`

```ts
/** per-particle update fn, owns motion, collision, and death.
 *  invoked once per tick per alive slot. write `pool.expiresAt[i] = 0`
 *  to kill from inside the fn. `voxels` is the room's voxel world,
 *  threaded so `collide*` primitives can query `BLOCK_FLAG_COLLISION`
 *  without the pool carrying a back-ref. pure-motion fns ignore it. */
export type ParticleUpdateFn = (pool: ParticlePool, i: number, dt: number, voxels: Voxels) => void;
```

#### `particle`

```ts
/** declare a particle type; called at module scope, returns a pure-data handle resolved by id at spawn time. */
export function particle(id: string, options: ParticleOptions): ParticleHandle;
```

#### `SpawnOpts`

```ts
/** Spawn-time opt overrides. Unset fields fall back to the engine default. */
export type SpawnOpts = {
    velX?: number;
    velY?: number;
    velZ?: number;
    /** duration in seconds, engine writes `expiresAt[i] = now + lifetime`. */
    lifetime?: number;
    size?: number;
    /** start mid-animation by passing `now - offset`. default = now. */
    spawnTime?: number;
    /** explicit seed. default = random u32. */
    seed?: number;
    /** override the handle's spawn-default glow (0..1). 1 = fully lit /
     *  shadow-free, 0 = sample world light. */
    glow?: number;
    /** override the handle's spawn-default RGBA tint multiplier. RGB
     *  multiplies the shaded color, A the sprite alpha. [1,1,1,1] = none. */
    tint?: [r: number, g: number, b: number, a: number];
};
```

#### `spawnParticle`

```ts
/**
 * spawn a particle of the given type at world `pos` into the active room's
 * pool. returns the slot index, or `null` when there's no client room or
 * the pool is full. `opts` overrides default-init fields (see `SpawnOpts`);
 * type-specific knobs live inside the particle's `update` fn.
 */
export function spawnParticle(ctx: ScriptContext, type: ParticleHandle, pos: Vec3, opts?: SpawnOpts): number | null;
```

## Models, characters & animation

Rigged glTF characters and clip playback.

#### `CharacterTrait`

```ts
export const CharacterTrait;
```

#### `modelIdSync`

```ts
/** clients pair the synced id with a client-side .glb url via `Resources.setModel`. */
export const modelIdSync;
```

#### `ensureCharacterRig`

```ts
/** synchronously mounts the placeholder rig if `node` has none yet, so a server `onJoin` hook sees bones immediately. */
export function ensureCharacterRig(node: Node): void;
```

#### `addCharacter`

```ts
/** adds `CharacterTrait` and mounts its rig immediately, so bones are available the same tick for attaching held items. */
export function addCharacter(node: Node, props?: TraitProps<CharacterTrait>): CharacterTrait;
```
#### `CharacterView`

```ts
/** the character's look ray this frame: eye `origin` (world space) plus unit `direction` from `input.look`. */
export type CharacterView = {
    origin: Vec3;
    direction: Vec3;
};
```

#### `CharacterControllerTrait`

```ts
export const CharacterControllerTrait;
```

#### `applyNoclipDisplacement`

```ts
export function applyNoclipDisplacement(cc: CharacterControllerTrait, transform: TransformTrait, physics: Physics, velocity: Vec3, dt: number): void;
```

#### `setCharacterLook`

```ts
/** point a character at yaw (+ optional pitch). leaves pitch alone if omitted. */
export function setCharacterLook(cc: CharacterControllerTrait, yaw: number, pitch?: number): void;
```

#### `setCharacterLookAt`

```ts
/** orient a character at a world target, using its `state.eyeHeight` as the look origin. */
export function setCharacterLookAt(cc: CharacterControllerTrait, transform: TransformTrait, target: Vec3): void;
```
#### `AnimatorTrait`

```ts
export const AnimatorTrait;
```
#### `AnimationAction`

```ts
export type AnimationAction = {
    clip: ClipDef;
    /** 0..1. */
    weight: number;
    /** crossfade destination, set by crossFadeTo. */
    targetWeight: number;
    /** weight delta per second; 0 = no fade. */
    fadeRate: number;
    /** playback time in seconds. */
    time: number;
    /** playback rate, default 1. */
    speed: number;
    loopMode: 'once' | 'repeat';
    enabled: boolean;
    /** ascending = composite later, replacing lower layers' values for the nodes they write. default 0. */
    layer: number;
    /** filter clip channels by node name; null means no filtering. */
    mask: ReadonlySet<string> | null;
    /** 'replace' (default) contributes to the layer's weighted sum, 'additive' adds the delta from the clip's first frame on top. */
    blendMode: BlendMode;
    /** resolved at top of tick, preserved across ticks so _boneIndices can detect a payload swap by ref identity. */
    _channels: ClipChannels | null;
    /** parallel to _channels.channels: target bone index in state.boneOrder per channel, or -1 if unresolved or masked out. */
    _boneIndices: Int32Array | null;
    /** matches state.boneOrderEpoch when valid; a mismatch triggers a rebuild. */
    _boneIndicesEpoch: number;
    _boneIndicesChannelsRef: ClipChannels | null;
    _boneIndicesMaskRef: ReadonlySet<string> | null;
    /** parallel to _channels.channels: last-found keyframe lo index per channel, threaded through findKeyLow as search start and write-back. */
    _lastKeyIdx: Int32Array | null;
    /** resolved channel indices bucketed by property, so the tick body runs three monomorphic loops instead of a switch per channel. */
    _idxTranslation: Int32Array | null;
    _idxRotation: Int32Array | null;
    _idxScale: Int32Array | null;
};
```

#### `AnimatorState`

```ts
export type AnimatorState = {
    /** keyed by ClipDef ref identity (sidecar singleton), lookup-only. */
    actions: Map<ClipDef, AnimationAction>;
    /** flat list parallel to `actions`, iterated by the tick body since Map iteration was measurably slower. */
    actionsList: AnimationAction[];

    /** cached parent-first DFS of the rig's TransformTraits; call `Animation.invalidateRig` after restructuring the rig. */
    boneOrder: TransformTrait[];
    /** parallel to `boneOrder`: direct refs to each bone's position/quaternion/scale; layer passes write into them, world matrices recompose lazily. */
    bonePos: Vec3[];
    boneQuat: Quat[];
    boneScale: Vec3[];
    /** name to index in `boneOrder`, populated alongside it. */
    boneIndex: Map<string, number>;
    /** bumped each time `rebuildBoneOrder` runs, so actions can detect their cached `_boneIndices` are stale. */
    boneOrderEpoch: number;

    /** per-bone weighted sum for the current layer's replace pass (cap x 13). */
    layerAccum: Float32Array;
    /** exclusive end index of each bone's DFS subtree in `boneOrder` (descendants of `bi` are `[bi+1, subtreeEnd[bi])`); lets a write mark a whole subtree dirty in one range fill. */
    subtreeEnd: Int32Array;
    /** subtree dirty bitmap: 1 = this tick wrote bone `bi` or an ancestor; the end-of-tick sweep stamps `_dirty = TRANSFORM_DIRTY_ALL` on each marked bone. */
    subtreeDirty: Uint8Array;
    /** capacity of layerAccum / subtreeEnd / subtreeDirty in bones. */
    accumCapacity: number;

    /** the rig's renderable meshes, cached when `boneOrder` is (re)built. */
    _cullMeshes: MeshTrait[];

    /** current LOD stride: 1 (every frame) / 2 / 4 / 8. */
    _lodStride: number;
    /** per-rig phase offset from a room-scoped counter, so same-stride rigs split across frames instead of sampling in lockstep; -1 until assigned. */
    _lodPhase: number;
    /** `Animations.frameCount` when classification last ran. */
    _lodClassifiedAtFrame: number;
    /** previous frame's rig visibility (0/1); a false-to-true transition forces a sample so a rig coming on-screen doesn't show a stale pose. */
    _lastVisible: number;
};
```

#### `Animation.BlendMode`

```ts
export type BlendMode = 'replace' | 'additive';
```

#### `Animation.AnimationAction`

```ts
export type AnimationAction = {
    clip: ClipDef;
    /** 0..1. */
    weight: number;
    /** crossfade destination, set by crossFadeTo. */
    targetWeight: number;
    /** weight delta per second; 0 = no fade. */
    fadeRate: number;
    /** playback time in seconds. */
    time: number;
    /** playback rate, default 1. */
    speed: number;
    loopMode: 'once' | 'repeat';
    enabled: boolean;
    /** ascending = composite later, replacing lower layers' values for the nodes they write. default 0. */
    layer: number;
    /** filter clip channels by node name; null means no filtering. */
    mask: ReadonlySet<string> | null;
    /** 'replace' (default) contributes to the layer's weighted sum, 'additive' adds the delta from the clip's first frame on top. */
    blendMode: BlendMode;
    /** resolved at top of tick, preserved across ticks so _boneIndices can detect a payload swap by ref identity. */
    _channels: ClipChannels | null;
    /** parallel to _channels.channels: target bone index in state.boneOrder per channel, or -1 if unresolved or masked out. */
    _boneIndices: Int32Array | null;
    /** matches state.boneOrderEpoch when valid; a mismatch triggers a rebuild. */
    _boneIndicesEpoch: number;
    _boneIndicesChannelsRef: ClipChannels | null;
    _boneIndicesMaskRef: ReadonlySet<string> | null;
    /** parallel to _channels.channels: last-found keyframe lo index per channel, threaded through findKeyLow as search start and write-back. */
    _lastKeyIdx: Int32Array | null;
    /** resolved channel indices bucketed by property, so the tick body runs three monomorphic loops instead of a switch per channel. */
    _idxTranslation: Int32Array | null;
    _idxRotation: Int32Array | null;
    _idxScale: Int32Array | null;
};
```

#### `Animation.AnimatorState`

```ts
export type AnimatorState = {
    /** keyed by ClipDef ref identity (sidecar singleton), lookup-only. */
    actions: Map<ClipDef, AnimationAction>;
    /** flat list parallel to `actions`, iterated by the tick body since Map iteration was measurably slower. */
    actionsList: AnimationAction[];

    /** cached parent-first DFS of the rig's TransformTraits; call `Animation.invalidateRig` after restructuring the rig. */
    boneOrder: TransformTrait[];
    /** parallel to `boneOrder`: direct refs to each bone's position/quaternion/scale; layer passes write into them, world matrices recompose lazily. */
    bonePos: Vec3[];
    boneQuat: Quat[];
    boneScale: Vec3[];
    /** name to index in `boneOrder`, populated alongside it. */
    boneIndex: Map<string, number>;
    /** bumped each time `rebuildBoneOrder` runs, so actions can detect their cached `_boneIndices` are stale. */
    boneOrderEpoch: number;

    /** per-bone weighted sum for the current layer's replace pass (cap x 13). */
    layerAccum: Float32Array;
    /** exclusive end index of each bone's DFS subtree in `boneOrder` (descendants of `bi` are `[bi+1, subtreeEnd[bi])`); lets a write mark a whole subtree dirty in one range fill. */
    subtreeEnd: Int32Array;
    /** subtree dirty bitmap: 1 = this tick wrote bone `bi` or an ancestor; the end-of-tick sweep stamps `_dirty = TRANSFORM_DIRTY_ALL` on each marked bone. */
    subtreeDirty: Uint8Array;
    /** capacity of layerAccum / subtreeEnd / subtreeDirty in bones. */
    accumCapacity: number;

    /** the rig's renderable meshes, cached when `boneOrder` is (re)built. */
    _cullMeshes: MeshTrait[];

    /** current LOD stride: 1 (every frame) / 2 / 4 / 8. */
    _lodStride: number;
    /** per-rig phase offset from a room-scoped counter, so same-stride rigs split across frames instead of sampling in lockstep; -1 until assigned. */
    _lodPhase: number;
    /** `Animations.frameCount` when classification last ran. */
    _lodClassifiedAtFrame: number;
    /** previous frame's rig visibility (0/1); a false-to-true transition forces a sample so a rig coming on-screen doesn't show a stale pose. */
    _lastVisible: number;
};
```

#### `Animation.play`

```ts
/** mark enabled and snap weight to 1 (no fade). use crossFadeTo for blending in. */
export function play(action: AnimationAction): void;
```

#### `Animation.stop`

```ts
/** mark disabled. weight + time preserved so a subsequent play resumes from here. */
export function stop(action: AnimationAction): void;
```

#### `Animation.crossFadeTo`

```ts
/** Blends `from` out and `to` in over `duration` seconds; safe to re-call mid-fade, sets fresh targets and continues smoothly. */
export function crossFadeTo(from: AnimationAction, to: AnimationAction, duration: number): void;
```

#### `Animation.setEffectiveWeight`

```ts
/** snap weight + target to `w`. clears any in-progress crossfade. */
export function setEffectiveWeight(action: AnimationAction, w: number): void;
```

#### `Animation.clip`

```ts
/** get the AnimationAction for a clip on this animator, creating it if absent. */
export function clip(animator: AnimatorTrait, clipDef: ClipDef): AnimationAction;
```

#### `Animation.invalidateRig`

```ts
/** Drops the animator's cached bone order so the next tick rebuilds it; call after restructuring the rig subtree. */
export function invalidateRig(animator: AnimatorTrait): void;
```

#### `Animation.descendants`

```ts
/** Names of every descendant of `root` in the animator's rig; `root` can also match the animator's own node name. */
export function descendants(animator: AnimatorTrait, root: string, opts?: {
    includeRoot?: boolean;
}): Set<string>;
```

#### `Animation.Animations`

```ts
/** Per-room state for the animation tick; caches the `[AnimatorTrait]` query so the per-frame walk doesn't rebuild it each call. */
export type Animations = {
    animators: ReturnType<typeof query<[typeof AnimatorTrait]>>;
    /** monotonic per-room frame counter; drives LOD stride/phase gating. */
    frameCount: number;
    /** room-scoped counter handed out as `_lodPhase` to each animator on its first tick. */
    nextLodPhase: number;
};
```

#### `Animation.init`

```ts
export function init(sceneTree: SceneTree): Animations;
```

#### `Animation.tick`

```ts
/** Advances every animator (time, crossfade weights, sampling, blending) and writes the result back into the rig's TransformTraits. */
export function tick(animations: Animations, resources: Resources.Resources, dt: number): void;
```

## Avatars

Platform avatars for players and NPCs.

#### `assignAvatar`

```ts
/** Points a `CharacterTrait` node at an already-loaded avatar; the rig reconciler mounts it once the payload lands. No-op if `node` has no `CharacterTrait`. */
export function assignAvatar(node: Node, modelId: string, rigType: string = RIG_TYPE_6BONE): void;
```

#### `sampleAvatars`

```ts
/**
 * Pull a batch of avatars for populating NPCs. Opaque + unordered + non-stable,
 * the host owns what's in it and may return fewer than you'd like (or none).
 * Resolves to an empty array off-server (or when the host's pool is empty), so
 * callers just fall back to their default avatar. Bulk: call once and round-robin
 * the result onto your NPCs, not per-NPC.
 */
export function sampleAvatars(ctx: ScriptContext): Promise<ResolvedAvatar[]>;
```

#### `loadAvatar`

```ts
/**
 * Load a resolved avatar's model (acquire + ensure) and bump its refcount (runtime;
 * bundled = ensure-only). Returns `{ modelId, rigType }` to hand to `assignAvatar`.
 * Balance each call with one `releaseAvatar`. Must precede `assignAvatar` for runtime
 * avatars (acquire registers the entry the reconciler loads from).
 */
export function loadAvatar(ctx: ScriptContext, avatar: ResolvedAvatar): {
    modelId: string;
    rigType: string;
};
```

#### `releaseAvatar`

```ts
/**
 * Drop the runtime refcount for an avatar model, call on NPC despawn / round
 * reset so the pool doesn't accrete. No-op for bundled models or unknown ids.
 */
export function releaseAvatar(ctx: ScriptContext, modelId: string): void;
```

#### `randomDisplayName`

```ts
/** A plausible display name for an ambient NPC, in the shape
 *  `AdjectiveNoun12345` (e.g. `BluePanda102837`). */
export function randomDisplayName(): string;
```
#### `Avatar`

```ts
export type Avatar = {
    /** Resolved model id, registered with `Resources`, written onto the
     *  player's `CharacterTrait.modelId`. */
    modelId: string;

    /** Rig contract this avatar implements, e.g. `RIG_TYPE_6BONE`. Lets
     *  game code branch on rig family before reaching for bones. */
    rigType: string;
};
```

## Physics

Rigid bodies, AABB bodies, contacts, and the physics layers and groups.

#### `Physics`

```ts
export type Physics = {
    /** rigid-body sub-world: full broadphase, manifolds, sleep. */
    rigid: RigidPhysics.World;
    /** AABB physics sub-world, items / particles / throwables. analytical sweep. */
    aabb: AabbPhysics.World;

    /** global contact stream, pairs un-normalized (A to B), with added/persisted/removed lifecycle. */
    contacts: PhysicsContacts;
    rigidBodyContactPool: RigidBodyContactPool;
    aabbBodyContactPool: AabbBodyContactPool;
    voxelContactPool: VoxelContactPool;
    /** pool of ContactPair instances backing `contacts.*` lists. */
    contactPairPool: ContactPairPool;
    /** cached query for fan-out, built once at init so we don't pay hash+lookup each tick. */
    contactsQuery: ReturnType<typeof query<[typeof ContactsTrait]>>;

    /** sink passed into `AabbPhysics.tick`. drains pairs into `contacts`. */
    aabbPairSink: AabbPhysics.PairSink;

    /** VCC body contacts staged for replay into `contacts` each tick (see `ingestVccRigidContacts`). */
    vccRigidContacts: VccRigidContact[];
    vccRigidContactCount: number;

    /** VCC voxel contacts staged for replay into `contacts` each tick (see `ingestVccVoxelContacts`). */
    vccVoxelContacts: VccVoxelContact[];
    vccVoxelContactCount: number;

    /** nodes currently enrolled in interpolation because a subsystem has a body for them. */
    _companionNodes: Set<number>;
};
```

#### `objectLayerForMotionType`

```ts
export function objectLayerForMotionType(mt: MotionType): number;
```

#### `COLLISION_GROUP_CHARACTERS`

```ts
export const COLLISION_GROUP_CHARACTERS;
```

#### `COLLISION_GROUP_NODES`

```ts
export const COLLISION_GROUP_NODES;
```

#### `COLLISION_GROUP_VOXELS`

```ts
export const COLLISION_GROUP_VOXELS;
```

#### `OBJECT_LAYER_NODE_MOVING`

```ts
export const OBJECT_LAYER_NODE_MOVING;
```

#### `OBJECT_LAYER_NODE_NOT_MOVING`

```ts
export const OBJECT_LAYER_NODE_NOT_MOVING;
```

#### `OBJECT_LAYER_VOXELS`

```ts
export const OBJECT_LAYER_VOXELS;
```

#### `RESERVED_COLLISION_GROUP_BITS`

```ts
/** number of low bits reserved by the engine (voxels=0, nodes=1, characters=2).
 *  games' own groups start at this bit. */
export const RESERVED_COLLISION_GROUP_BITS;
```

#### `defineCollisionGroups`

```ts
/** declare a game's collision groups once, in a stable order, and get a named
 *  bit for each. bit assignment is positional (first name gets the first free
 *  bit above the reserved range) and not synced, so a game must declare them
 *  the same way everywhere: call this once at module load with a fixed list.
 *
 *  @example
 *  const G = defineCollisionGroups('enemies', 'pickups', 'playerBullets');
 *  // enemies pass through each other, like characters:
 *  //   { collisionGroups: G.enemies, collisionMask: exceptGroups(G.enemies) }
 *  // pickups only interact with characters:
 *  //   { collisionGroups: G.pickups, collisionMask: onlyGroups(COLLISION_GROUP_CHARACTERS) }
 */
export function defineCollisionGroups<const K extends string>(...names: K[]): Record<K, number>;
```

#### `onlyGroups`

```ts
/** mask of ONLY the given groups (collide with these and nothing else). */
export function onlyGroups(...groups: number[]): number;
```

#### `exceptGroups`

```ts
/** mask of everything EXCEPT the given groups (collide with all but these). */
export function exceptGroups(...groups: number[]): number;
```

Also exported: `aabbBody`.
#### `AutoShapeDef`

```ts
export const AutoShapeDef;
```

#### `ColliderShape`

```ts
/** a box or sphere in the body's frame; a nonzero `center` offsets it. */
export const ColliderShape;
```

#### `TransformedShapeDef`

```ts
/** a collider placed by its own pose inside the body. */
export const TransformedShapeDef;
```

#### `CompoundShapeDef`

```ts
export const CompoundShapeDef;
```

#### `ShapeDef`

```ts
export const ShapeDef;
```

#### `RigidBodyDef`

```ts
/** declarative body recipe; when the trait carries a `def`, the installer builds + owns the body from it. */
export const RigidBodyDef;
```

#### `RigidBodyTrait`

```ts
export const RigidBodyTrait;
```

Also exported: `MaterialCombineMode`, `MotionQuality`, `MotionType`.
#### `AabbBodyMotionType`

```ts
export const AabbBodyMotionType;
```

#### `AabbBodyTrait`

```ts
export const AabbBodyTrait;
```
#### `ContactsTrait`

```ts
/**
 * per-step contact lifecycle for a node, populated by the physics fan-out phase after the world
 * step. Normals point away from this node.
 *
 * Contact references are valid until the start of the next physics step; the underlying Contact
 * instance is released to the pool afterward, so copy any fields a script needs to retain.
 *
 * A Contact in `added` last step appears in `persisted` this step with different object identity
 * but identical-meaning fields. Key by `nodeId`+`subShapeId` or `(voxelX, voxelY, voxelZ)`, not by reference.
 */
export const ContactsTrait;
```

## Controllers

The player, fly, and orbit controller traits.

#### `PlayerTrait`

```ts
/**
 * marks a node as the in-scene body of a specific Player, one (client, room, mode) view.
 * `persist: false`, player nodes are ephemeral, created at Player join time.
 *
 * playerId/client/userId/username are server-set runtime state, replicated as explicit-dirty
 * syncs. server code that mutates them must call `<field>Sync.dirty(t)`.
 */
export const PlayerTrait;
```

#### `playerIdSync`

```ts
export const playerIdSync;
```

#### `clientSync`

```ts
export const clientSync;
```

#### `userIdSync`

```ts
export const userIdSync;
```

#### `usernameSync`

```ts
export const usernameSync;
```

#### `viewRadiusSync`

```ts
export const viewRadiusSync;
```
#### `Perspective`

```ts
export type Perspective = 'first' | 'third-back' | 'third-front';
```

#### `ControlsConfig`

```ts
/** input + HUD wiring for the player controller: one master switch plus grouped sub-knobs for desktop and touch behaviours.
 *  Fields are mutated live: flip `enabled` for pause menus/cutscenes, individual sub-flags for settings UIs. */
export type ControlsConfig = {
    /** master switch. false = trait wires no input and mounts no HUD. */
    enabled: boolean;

    desktop: {
        /** double-tap W activates sprint until W releases. off for games
         *  where sprint is RMB-held or always-on. */
        doubleTapSprint: boolean;
        /** double-tap Space toggles noclip (free-fly), off by default; the noclip movement itself lives on the CC.
         *  the editor flips this on for its character mode. */
        doubleTapNoclip: boolean;
    };

    touch: {
        /** auto-mount the default 'move' joystick on mobile; the joystick id is read into cc.move regardless.
         *  set false to suppress only the default mount, e.g. to mount your own at a custom position. */
        joystick: boolean;
        /** auto-mount default 'jump' button on mobile. */
        jumpButton: boolean;
        /** auto-mount 'sprint' button on mobile (off by default, joystick
         *  magnitude drives sprint instead). always-read regardless. */
        sprintButton: boolean;
        /** auto-mount 'crouch' button on mobile (off by default). */
        crouchButton: boolean;
        /** while noclip is active, mount a vertical up/down joystick in place of the jump button. on by default. */
        noclipVerticalJoystick: boolean;
        /** mount a fly/walk toggle button that flips noclip on tap, off by default; the touch counterpart to `doubleTapNoclip`.
         *  opt in where free-fly is allowed, same as the editor. */
        flyToggleButton: boolean;
        /** right-half canvas drag maps to cc.look on touch devices. */
        canvasLook: boolean;
    };
};
```

#### `PlayerControllerTouchIds`

```ts
/** touch control ids that PlayerControllerTrait reads from `TouchInput` when `controls.enabled` is true. */
export const PlayerControllerTouchIds;
```

#### `PlayerControllerTrait`

```ts
export const PlayerControllerTrait;
```
#### `FlyControllerTrait`

```ts
/** fly controller tunables. `speed` is the live move speed, updated by the wheel-adjust path
 *  while pointer-locked; the rest are caps and rates configurable via inspector. */
export const FlyControllerTrait;
```
#### `OrbitControllerTrait`

```ts
/**
 * orbit controller. attaching it wires up the orbit camera script (left-drag rotate,
 * right-drag pan, wheel dolly).
 *
 * `target` is the world-space focal point the camera orbits / pans around; mutable, pan writes
 * back into it. `eye` is the initial world-space camera position, consumed once on attach;
 * leave the default (null) to use whatever pose the camera transform already carries.
 */
export const OrbitControllerTrait;
```

## Pathfinding

Grid pathfinding over the voxel world.

#### `nav.Walkable`

```ts
/** strategy: can the agent stand/be at this cell? scalar args so the A* inner loop allocates nothing. */
export type Walkable = (voxels: Voxels, x: number, y: number, z: number) => boolean;
```

#### `nav.groundWalkable`

```ts
/** ground agent, needs solid support below; default body is 1x2x1 (2 blocks high). */
export function groundWalkable(size: Vec3 = [1, 2, 1]): Walkable;
```

#### `nav.Move`

```ts
/** one candidate offset for the fixed-move case, input to `gridActions`. */
export type Move = {
    offset: Vec3;
    cost: number;
};
```

#### `nav.StepFn`

```ts
/** the sink a successor calls once per reachable neighbour cell; the search supplies it, so a successor never builds a list. */
export type StepFn = (x: number, y: number, z: number, cost: number) => void;
```

#### `nav.Actions`

```ts
/** the pluggable successor function `findPath`/`floodFill` search over: expand a cell by calling `step` for each reachable neighbour. */
export type Actions = (voxels: Voxels, x: number, y: number, z: number, step: StepFn) => void;
```

#### `nav.Heuristic`

```ts
/** admissible-ish distance estimate between two cells. */
export type Heuristic = (fromX: number, fromY: number, fromZ: number, toX: number, toY: number, toZ: number) => number;
```

#### `nav.Shortcut`

```ts
/** line-of-sight test used by `smoothPath`: can the agent travel `from` to `to` directly, skipping intermediate waypoints? */
export type Shortcut = (voxels: Voxels, from: Vec3, to: Vec3) => boolean;
```

#### `nav.gridActions`

```ts
/** build an `Actions` from a fixed candidate offset set + a walkability test. */
export function gridActions(moves: readonly Move[], walkable: Walkable): Actions;
```

#### `nav.groundMoves`

```ts
/** the default ground move set; spread + extend it and feed `gridActions` for a custom successor. */
export const groundMoves: readonly Move[];
```

#### `nav.groundActions`

```ts
/** the ready-made ground successor (default 1x2x1 agent). */
export const groundActions: Actions;
```

#### `nav.groundDropActions`

```ts
/** ground successor that also lets the agent walk off a ledge and drop to the first landing below, up to `maxDrop` (must be finite). */
export function groundDropActions(opts?: {
    size?: Vec3;
    maxDrop?: number;
    dropCost?: number;
}): Actions;
```

#### `nav.SearchType`

```ts
/** how the frontier is scored: 'shortest' = classic A* (g + h); 'greedy' = best-first (h only), faster, not optimal. */
export type SearchType = 'shortest' | 'greedy';
```

#### `nav.FindPathOptions`

```ts
export type FindPathOptions = {
    /** cap on A* iterations; returns null once exceeded, the guard against an unreachable/disconnected goal. */
    maxIterations?: number;
    /** frontier scoring, default 'shortest'. */
    searchType?: SearchType;
    /** distance estimate for A*, default euclidean. */
    heuristic?: Heuristic;
};
```

#### `nav.Path`

```ts
/** a route, caller-owned and poolable: cells plus how many are live. Never read or truncate past `count`. */
export type Path = {
    cells: Vec3[];
    count: number;
};
```

#### `nav.createPath`

```ts
/** an empty `Path`; grows to its high-water mark, then stops allocating. */
export function createPath(): Path;
```

#### `nav.findPath`

```ts
/** find a path of cells from `start` to `goal` under `actions`, into `out`; returns whether the goal was reached. */
export function findPath(out: Path, voxels: Voxels, start: Vec3, goal: Vec3, actions: Actions, options?: FindPathOptions): boolean;
```

#### `nav.smoothPath`

```ts
/** drop redundant waypoints: keep a cell only when the agent can't travel directly from the last kept cell to the one after it. */
export function smoothPath(out: Path, voxels: Voxels, path: Path, shortcut: Shortcut): Path;
```

#### `nav.groundShortcut`

```ts
/** swept-box line-of-sight with gravity descent over a precomputed diagonal trace, the standard ground smoother for `smoothPath`. */
export function groundShortcut(walkable: Walkable = groundWalkable()): Shortcut;
```

#### `nav.FloodMap`

```ts
/** a `Flood`'s own coord -> cell-index map, the "have I seen this cell" set that also backs `floodIndexOf`. Treat as internal. */
export type FloodMap = {
    cap: number;
    mask: number;
    keyX: Int32Array;
    keyY: Int32Array;
    keyZ: Int32Array;
    /** generation stamp per slot; a slot is live iff `gen[i] === generation`. */
    gen: Int32Array;
    /** index into `Flood.cells` for the cell in this slot. */
    cell: Int32Array;
    generation: number;
    count: number;
};
```

#### `nav.Flood`

```ts
/** a completed flood: the cells reached, the BFS tree that reached them, and the map to look a cell up by coordinate. */
export type Flood = {
    /** cells reached, start first, roughly nearest-first. */
    cells: Vec3[];
    /** for each cell, the index it was discovered from; `-1` at the start. */
    parent: number[];
    /** how many entries of `cells`/`parent` this fill wrote. */
    count: number;
    /** coord to cell index; internal, go through `floodIndexOf`. */
    map: FloodMap;
};
```

#### `nav.createFlood`

```ts
/** an empty `Flood`, ready to be filled; grows to its high-water mark, then stops allocating. */
export function createFlood(): Flood;
```

#### `nav.floodFill`

```ts
/** breadth-first expansion of every cell reachable from `start` under `actions`, written into `out`; caps at `maxIterations` cells. */
export function floodFill(out: Flood, voxels: Voxels, start: Vec3, actions: Actions, maxIterations: number): Flood;
```

#### `nav.floodIndexOf`

```ts
/** the index of `(x,y,z)` in `flood.cells`, or `-1` if the fill never reached it. */
export function floodIndexOf(flood: Flood, x: number, y: number, z: number): number;
```

#### `nav.floodReached`

```ts
/** did this fill reach `(x,y,z)`? the question `floodIndexOf` answers, when you only want yes/no. */
export function floodReached(flood: Flood, x: number, y: number, z: number): boolean;
```

#### `nav.floodPath`

```ts
/** the route from the fill's start to `cells[index]`, start-first; free, since the flood already found it (just walks the parent chain). */
export function floodPath(out: Path, flood: Flood, index: number): Path;
```

## Players & input

Reading mouse, keyboard, and touch input.

#### `CanvasTouch`

```ts
/** single canvas touch (one finger): raw position/start/delta state, plus latched gesture edge flags. */
export type CanvasTouch = {
    pointerId: number;
    /** current position, CSS px from canvas top-left. */
    x: number;
    y: number;
    /** accumulated movement since last reset, CSS px. */
    dx: number;
    dy: number;
    /** position at pointerdown, CSS px from canvas top-left. */
    startX: number;
    startY: number;
    /** Date.now() at pointerdown, ms. */
    downAt: number;

    justStarted: boolean;
    /** last frame; only set on entries in _canvasTouchesEnded. */
    justEnded: boolean;
    /** ended within TAP_MAX_MS and TAP_MAX_DRIFT_PX. */
    tapped: boolean;
    /** crossed LONG_PRESS_MIN_MS without leaving LONG_PRESS_MAX_DRIFT_PX. */
    longPressed: boolean;
    /** ended with velocity above SWIPE_MIN_VELOCITY_PX_PER_MS. */
    swiped: boolean;
    /** direction of the swipe (CSS px from startX/Y to endX/Y), 0 if !swiped. */
    swipeDx: number;
    swipeDy: number;

    _maxDriftSq: number;
    _longPressLatched: boolean;
    _recentSamples: { t: number; x: number; y: number }[];
};
```

#### `Cursor`

```ts
/** position of the primary pointer over the shared display canvas; ndc is pinned to (0, 0) while pointer-locked. */
export type Cursor = {
    x: number;
    y: number;
    ndcX: number;
    ndcY: number;
};
```

#### `Input`

```ts
export type Input = {
    mouseKeyboard: MouseKeyboardInput;
    touch: TouchInput;
    /** persistent room intent, set via `setPointerLock`; survives a controller being removed and re-added with no relock dance. */
    _lockWanted: boolean;
    /** whether the room's controller has declared its lock intent at least once, so a fresh `_lockWanted=false` reads as pending. */
    _lockDeclared: boolean;
};
```

#### `JoystickState`

```ts
export type JoystickState = {
    /** [-1, 1] on each axis with deadzone applied; (0, 0) when idle. */
    x: number;
    y: number;
    /** true while a finger is pressing the joystick. */
    active: boolean;
    /** previous-frame `active`, for edge predicates. */
    _prevActive: boolean;
};
```

#### `MouseButton`

```ts
export type MouseButton = 'left' | 'middle' | 'right';
```

#### `MouseKeyboardInput`

```ts
export type MouseKeyboardInput = {
    _keyState: Map<string, boolean>;
    /** key state from the previous frame; just-down uses _keyJustPressed instead. */
    _prevKeyState: Map<string, boolean>;
    /** codes with a non-repeat keydown since last reset, so macOS doesn't drop presses when Cmd+letter swallows the letter's keyup. */
    _keyJustPressed: Set<string>;
    /** `mod` is cmd-on-mac / ctrl-on-win (e.metaKey || e.ctrlKey) */
    _mods: ModifierState;
    _prevMods: ModifierState;
    _dx: number;
    _dy: number;
    _buttons: { left: boolean; right: boolean; middle: boolean };
    /** written by the canvas pointer listeners, so only the active room's cursor moves. */
    _cursor: Cursor;
    _wheelDeltaY: number;
    _gestures: { left: MouseButtonGesture; middle: MouseButtonGesture; right: MouseButtonGesture };
    /** snapshotted once per frame so `is/was/just` agree within a frame, since raw `document.pointerLockElement` can flip mid-frame. */
    _locked: boolean;
    _prevLocked: boolean;
    /** mirrors InputManager._lockReleases: true while a UI surface is holding pointer input, so viewport wheel gestures ignore it. */
    _pointerCapturedByUi: boolean;
};
```

#### `TouchButtonState`

```ts
export type TouchButtonState = {
    down: boolean;
    /** previous-frame `down`, for just-down / just-up edges. */
    _prevDown: boolean;
    /** `look:true` buttons also drive the camera while held; their drag is forwarded into the same look pipeline as a canvas drag. */
    look: boolean;
    /** CSS-px drag accumulated since the last consume; meaningful only when `look`. */
    _dragX: number;
    _dragY: number;
};
```

#### `TouchInput`

```ts
export type TouchInput = {
    _canvasTouches: Map<number, CanvasTouch>;
    /** touches that ended this frame; cleared by reset. */
    _canvasTouchesEnded: Map<number, CanvasTouch>;
    /** inter-touch distance last frame (for pinch). 0 when !=2 touches. */
    _pinchPrevDist: number;
    _joysticks: Map<string, JoystickState>;
    _buttons: Map<string, TouchButtonState>;
};
```

#### `consumeTouchButtonLookDrag`

```ts
/** sums the drag accumulated by every `look:true` button since the last call, zeroing it; lets a fire button double as an aim surface. */
export function consumeTouchButtonLookDrag(t: TouchInput): {
    dx: number;
    dy: number;
};
```

#### `getCanvasTouch`

```ts
export function getCanvasTouch(t: TouchInput, pointerId: number): CanvasTouch | null;
```

#### `getCanvasTouches`

```ts
export function getCanvasTouches(t: TouchInput): ReadonlyMap<number, CanvasTouch>;
```

#### `getCanvasTouchesJustEnded`

```ts
export function getCanvasTouchesJustEnded(t: TouchInput): ReadonlyMap<number, CanvasTouch>;
```

#### `getCursor`

```ts
/** the returned object is the live cursor, read it, don't hold it across frames. */
export function getCursor(mouseKeyboard: MouseKeyboardInput): Readonly<Cursor>;
```

#### `getJoystick`

```ts
export function getJoystick(t: TouchInput, id: string): Readonly<JoystickState>;
```

#### `getPinchDelta`

```ts
/** change in inter-touch distance this frame (CSS px), 0 if !=2 touches. */
export function getPinchDelta(t: TouchInput): number;
```

#### `getPinchScale`

```ts
/** currentDist / lastFrameDist, 1.0 if not pinching. */
export function getPinchScale(t: TouchInput): number;
```

#### `isJoystickJustActive`

```ts
export function isJoystickJustActive(t: TouchInput, id: string): boolean;
```

#### `isJoystickJustReleased`

```ts
export function isJoystickJustReleased(t: TouchInput, id: string): boolean;
```

#### `isKeyDown`

```ts
export function isKeyDown(mouseKeyboard: MouseKeyboardInput, code: string): boolean;
```

#### `isKeyJustDown`

```ts
export function isKeyJustDown(mouseKeyboard: MouseKeyboardInput, code: string): boolean;
```

#### `isKeyJustUp`

```ts
export function isKeyJustUp(mouseKeyboard: MouseKeyboardInput, code: string): boolean;
```

#### `isMouseDown`

```ts
export function isMouseDown(mouseKeyboard: MouseKeyboardInput, button: MouseButton): boolean;
```

#### `isMouseDragStart`

```ts
/** fires for one frame the moment a held button crosses the drag threshold; use in place of `isMouseJustDown` for drag-commit actions. */
export function isMouseDragStart(mouseKeyboard: MouseKeyboardInput, button: MouseButton): boolean;
```

#### `isMouseJustDown`

```ts
/** fires for one frame when the button went down, latched at the event so a press-then-release within a frame is still seen. */
export function isMouseJustDown(mouseKeyboard: MouseKeyboardInput, button: MouseButton): boolean;
```

#### `isMouseJustLocked`

```ts
/** Fires for one frame the moment the pointer becomes locked (unlocked to locked). */
export function isMouseJustLocked(mouseKeyboard: MouseKeyboardInput): boolean;
```

#### `isMouseJustUp`

```ts
export function isMouseJustUp(mouseKeyboard: MouseKeyboardInput, button: MouseButton): boolean;
```

#### `isMouseLocked`

```ts
/** Is the pointer locked this frame? (mouse-look / cursor captured.) */
export function isMouseLocked(mouseKeyboard: MouseKeyboardInput): boolean;
```

#### `isMouseTap`

```ts
/** fires for one frame on button-up when the press never crossed the drag threshold; use for click-commit actions. */
export function isMouseTap(mouseKeyboard: MouseKeyboardInput, button: MouseButton): boolean;
```

#### `isPointerCapturedByUi`

```ts
/** true while a UI overlay is holding pointer input; viewport wheel gestures check this so a scroll over a panel drives the panel. */
export function isPointerCapturedByUi(mouseKeyboard: MouseKeyboardInput): boolean;
```

#### `isTouchButtonDown`

```ts
export function isTouchButtonDown(t: TouchInput, id: string): boolean;
```

#### `isTouchButtonJustDown`

```ts
export function isTouchButtonJustDown(t: TouchInput, id: string): boolean;
```

#### `isTouchButtonJustUp`

```ts
export function isTouchButtonJustUp(t: TouchInput, id: string): boolean;
```

#### `wasMouseLocked`

```ts
/** Was the pointer locked last frame? Pair with `isMouseLocked` for edge logic. */
export function wasMouseLocked(mouseKeyboard: MouseKeyboardInput): boolean;
```
#### `isTouchDevice`

```ts
/** Device is touch-capable (touch-only or hybrid), true on touchscreen laptops too.
 *  Use `isTouchPrimary` to decide whether touch is actually being used. */
export function isTouchDevice(ctx: ScriptContext): boolean;
```

#### `isTouchPrimary`

```ts
/**
 * Touch is the input being used right now, from real pointer events. Unlike
 * `isMobile` this is viewport-independent; unlike `isTouchDevice` it's false
 * on a touchscreen laptop driven by its trackpad, and flips live on a hybrid
 * device. Use to gate on-screen touch controls, checked per-tick.
 */
export function isTouchPrimary(ctx: ScriptContext): boolean;
```

#### `isMobileViewport`

```ts
/** Viewport width below the 768px breakpoint. Fragile alone (a phone whose host
 *  page renders desktop-style reports ~980px), so `isMobile` uses it only as an
 *  extra catch on top of the device signal. */
export function isMobileViewport(): boolean;
```

#### `isMobile`

```ts
/** A phone-class device, for compact HUD layout. Reads the viewport-independent
 *  device probe so it holds even when the host page renders desktop-width; the
 *  narrow-viewport check is only an extra catch. For gating touch controls use
 *  `isTouchPrimary` instead, which is also true on tablets. */
export function isMobile(ctx: ScriptContext): boolean;
```
#### `createTouchJoystick`

```ts
/**
 * Mounts a virtual joystick under the room's touch overlay. Returns a
 * disposer (call from `onDispose`). Returns `null` on the server.
 */
export function createTouchJoystick(ctx: ScriptContext, opts: CreateTouchJoystickOpts): {
    dispose(): void;
} | null;
```

#### `createTouchButton`

```ts
/**
 * Mounts a virtual touch button under the room's touch overlay. Returns
 * a disposer (call from `onDispose`). Returns `null` on the server.
 */
export function createTouchButton(ctx: ScriptContext, opts: CreateTouchButtonOpts): {
    dispose(): void;
} | null;
```

Also exported: `CreateTouchButtonOpts`, `CreateTouchJoystickOpts`.
#### `setPointerLock`

```ts
/**
 * Declare whether this room wants the pointer locked for mouse-look. Persistent
 * intent, unlike the web's one-shot `element.requestPointerLock()`. Setting `true`
 * locks immediately if called during a user gesture, otherwise on the next
 * desktop click. Never locks on touch.
 */
export function setPointerLock(ctx: ScriptContext, wanted: boolean): void;
```

#### `isPointerLocked`

```ts
/**
 * Is the pointer locked right now? Acquisition is async, so the click that
 * grabs the lock still reads `false`, naturally swallowing that click. Always
 * `false` on touch and while any UI holds the cursor free.
 */
export function isPointerLocked(_ctx: ScriptContext): boolean;
```

#### `releasePointer`

```ts
/**
 * Free the cursor while an in-game panel is open. Stacks, so nested panels
 * are fine. Does not freeze gameplay input, pair with `controls.enabled =
 * false` if movement should also stop.
 *
 * `restore()` re-locks synchronously; call it from the panel's close handler
 * for a seamless re-lock, or it falls back to re-locking on the next click.
 */
export function releasePointer(ctx: ScriptContext): {
    restore(): void;
};
```

## Audio

Declaring and playing sounds.

#### `PlaybackHandle`

```ts
export type PlaybackHandle = Audio.PlaybackHandle;
```

#### `PlayOpts`

```ts
export type PlayOpts = Audio.PlayOpts;
```

#### `SpatialOpts`

```ts
export type SpatialOpts = Audio.SpatialOpts;
```

#### `Falloff`

```ts
export type Falloff = Audio.Falloff;
```

#### `playMono`

```ts
/** non-positional play, output goes straight to the room's master gain.
 *  use for UI sounds, music, and anything else that shouldn't pan. */
export function playMono(ctx: ScriptContext, sound: SoundHandle, opts?: PlayOpts): PlaybackHandle | null;
```

#### `playAt`

```ts
/** play at a fixed world-space position. position is sampled once at
 *  call time, for moving sources use `playOnNode` instead. */
export function playAt(ctx: ScriptContext, sound: SoundHandle, pos: readonly [
    number,
    number,
    number
], opts?: SpatialOpts): PlaybackHandle | null;
```

#### `playOnNode`

```ts
/** play following a scene node, panner position refreshes every frame
 *  from the node's interpolated world transform. cancels automatically
 *  when the node is removed from the scene graph. */
export function playOnNode(ctx: ScriptContext, sound: SoundHandle, node: Node, opts?: SpatialOpts): PlaybackHandle | null;
```
#### `AudioListenerTrait`

```ts
/**
 * client-only override for the room's audio listener pose source. By default the audio runtime
 * reads listener position + orientation from the client's `pov` node's TransformTrait. Attach this
 * trait to a different node to decouple hearing from the camera pose; the first node carrying an
 * active `AudioListenerTrait` wins, the POV node is only a fallback. `persist: false`, this is a
 * runtime routing concern. Disable temporarily via `active: false` rather than removing the trait.
 */
export const AudioListenerTrait;
```

## UI

World-anchored HTML, canvases, and layering.

#### `HtmlMode`

```ts
export type HtmlMode = 'screen' | 'world' | 'billboard' | 'y-billboard';
```

#### `HtmlTrait`

```ts
export const HtmlTrait;
```
#### `CanvasMode`

```ts
export type CanvasMode = 'world' | 'billboard' | 'y-billboard';
```

#### `CanvasTrait`

```ts
export const CanvasTrait;
```
<!-- RenderModule: module not found: client/ui-layers -->

## Persistence

Server-only key-value stores.

#### `projectStorage`

```ts
/** Project-scoped KV, shared across every room and player of this project. */
export const projectStorage: {
    get(ctx: ScriptContext, key: string): Promise<StorageEntry | null>;
    set(ctx: ScriptContext, key: string, value: JsonValue, opts?: {
        ifVersion?: string;
    }): Promise<StorageSetResult>;
    delete(ctx: ScriptContext, key: string, opts?: {
        ifVersion?: string;
    }): Promise<StorageDeleteResult>;
    list(ctx: ScriptContext, opts?: StorageListOpts): Promise<StorageListPage>;
};
```

#### `userStorage`

```ts
/**
 * Per-(project, user) KV, private to one player within this project. `userId`
 * is the durable platform identity (`User.id`). Resolve it from a
 * `Client` via `clientToUser(ctx, client).id`.
 */
export const userStorage: {
    get(ctx: ScriptContext, userId: string, key: string): Promise<StorageEntry | null>;
    set(ctx: ScriptContext, userId: string, key: string, value: JsonValue, opts?: {
        ifVersion?: string;
    }): Promise<StorageSetResult>;
    delete(ctx: ScriptContext, userId: string, key: string, opts?: {
        ifVersion?: string;
    }): Promise<StorageDeleteResult>;
    list(ctx: ScriptContext, userId: string, opts?: StorageListOpts): Promise<StorageListPage>;
};
```

## Multiplayer & rooms

RPC, matchmaking, room management, and chat.

#### `CommandHandle`

```ts
/** stable wrapper around a `CommandDef`, returned by `command()`. Identity
 *  plus the live def; the schema and codec are read through `.def` rather
 *  than copied out (see `declare`). */
export type CommandHandle<S extends pack.Schema, D extends RpcDirection> = {
    /** the declared id (identity, never changes). */
    readonly id: string;
    /** DepGraph dependency + the brand `isHandle` tests. */
    dependency: { registry: 'commands'; id: string };
    /** the declared data. re-pointed on every re-declaration. */
    def: CommandDef & { direction: D; schema: S; serdes: ReturnType<typeof pack.build<S>> };
};
```

#### `Direction`

```ts
export type Direction = typeof CLIENT_TO_SERVER | typeof SERVER_TO_CLIENT;
```

#### `CLIENT_TO_SERVER`

```ts
export const CLIENT_TO_SERVER;
```

#### `SERVER_TO_CLIENT`

```ts
export const SERVER_TO_CLIENT;
```

#### `command`

```ts
/** define a command: a typed network message; handlers aren't part of the definition, they're registered via listen(). */
export function command<S extends pack.Schema, D extends RpcDirection>(id: string, direction: D, schema: S): CommandHandle<S, D>;
```
<!-- RenderModule: module not found: api/matchmaking -->
#### `rooms.create`

```ts
/**
 * Create a new room. With `o.sceneId`, boots from that scene's content;
 * without it, boots empty (root node, empty voxels, no content file) for the
 * caller to author itself, e.g. a procedurally generated world via `setBlock`.
 *
 * Server allocates a room in the caller's namespace and returns its roomId;
 * client creates a local-only ClientRoom.
 */
export function create(ctx: ScriptContext, o?: {
    sceneId?: string;
    mode?: PlayerMode;
    sourceRoomId?: string;
}): string;
```

#### `rooms.stop`

```ts
/**
 * Stop a room. Server destroys the server room (forbidden across namespaces);
 * client disposes a local ClientRoom, throws on server-mirrored rooms (those
 * are membership-driven, not script-controlled).
 */
export function stop(ctx: ScriptContext, roomId: string): void;
```

#### `rooms.recreate`

```ts
/**
 * Recreate the caller's room: boot a fresh room from the same on-disk scene,
 * move every client into it, then destroy the old room, a whole-map reset for
 * a new round. Server-only. The fresh room re-runs every script's onInit and
 * each client re-joins via the normal onJoin path (reset to spawn).
 *
 * Runs inline: destroyRoom is safe mid-tick because tick stages iterate
 * queries, and destroyNode removes dying nodes from every query as it goes.
 */
export function recreate(ctx: ScriptContext): void;
```

#### `rooms.activate`

```ts
/**
 * Activate a room, make it the focused view.
 *
 * Server form (4 args): instructs `client` to activate (roomId, mode), sending
 * an `activate_room` message over the per-client outbox.
 *
 * Client form (3 args): switches the local active view among rooms the
 * client already observes (server-mirrored or local).
 */
export function activate(ctx: ScriptContext, client: Client, roomId: string, o?: {
    mode?: PlayerMode;
}): void;
```

#### `rooms.list`

```ts
/**
 * List rooms visible to the caller: all roomIds in the caller's
 * namespace (server) or all roomIds the client observes (client).
 */
export function list(ctx: ScriptContext): string[];
```

#### `rooms.view`

```ts
/**
 * Return a ScriptContext pointing at another room, or null if the target is
 * unknown (or in a different namespace, server) or not observed (client).
 * Mutation through the returned context bypasses the calling room's tick
 * boundaries.
 */
export function view(ctx: ScriptContext, roomId: string, o?: {
    mode?: PlayerMode;
}): ScriptContext | null;
```

#### `rooms.join`

```ts
/**
 * Add `client` as a Player in `roomId`. Does not activate; pair with
 * rooms.activate when the new view should become focused.
 */
export function join(ctx: ScriptContext, client: Client, roomId: string, o?: {
    mode?: PlayerMode;
}): void;
```

#### `rooms.leave`

```ts
/**
 * Remove `client`'s Player from `roomId`. Does not auto-destroy the
 * room when empty, use rooms.stop explicitly.
 */
export function leave(ctx: ScriptContext, client: Client, roomId: string, o?: {
    mode?: PlayerMode;
}): void;
```

#### `rooms.swap`

```ts
/**
 * Move `client` from one room to another. Composes leave + join +
 * activate. `fromRoomId` defaults to the client's currently active
 * room. mode defaults to the destination room's mode.
 */
export function swap(ctx: ScriptContext, client: Client, toRoomId: string, o?: {
    fromRoomId?: string;
    mode?: PlayerMode;
}): void;
```

#### `rooms.active`

```ts
/** The client's active room view, or null. */
export function active(ctx: ScriptContext): {
    roomId: string;
    mode: PlayerMode;
} | null;
```

#### `rooms.observed`

```ts
/** Every (roomId, mode) the client is currently observing. */
export function observed(ctx: ScriptContext): {
    roomId: string;
    mode: PlayerMode;
    local: boolean;
}[];
```
#### `chat.command`

```ts
/**
 * register a chat command spec. returns a handle; attach a runtime handler
 * with `chat.listen(ctx, handle, fn)`. auto-removed on script dispose.
 */
export function command(ctx: ScriptContext, spec: CommandSpec): CommandHandle;
```

#### `chat.listen`

```ts
/**
 * attach a handler for `handle`'s command, scoped to ctx. a matched command
 * is consumed by the listener, not forwarded onward.
 */
export function listen(ctx: ScriptContext, handle: CommandHandle, fn: CommandHandler): () => void;
```

#### `chat.onMessage`

```ts
/**
 * listen for plain chat messages broadcast to this room. client-only;
 * server scripts should register a `chat.command` instead.
 */
export function onMessage(ctx: ScriptContext, fn: MessageHandler): () => void;
```

#### `chat.message`

```ts
/**
 * emit a chat message. on the server, broadcasts to every client in the room
 * as a system message. on the client, forwards the text as if the user typed it.
 *
 * text may carry inline formatting tags: `[#rrggbb]` sets colour, `[b]` `[i]`
 * `[u]` `[s]` turn on bold/italic/underline/strike, `[/]` resets both. tags
 * are cumulative until `[/]`; unrecognised bracketed text renders verbatim.
 *
 * @example
 * // "Alice" aqua+bold, the verb grey, "Bob" red+bold
 * chat.message(ctx, `[#55ffff][b]Alice[/] [#aaaaaa]slew[/] [#ff5555][b]Bob[/]`);
 */
export function message(ctx: ScriptContext, text: string): void;
```

#### `chat.setEnabled`

```ts
/**
 * enable or disable chat for the calling script's room (per-room, not global).
 * on the client it hides the chat UI; on the server it drops inbound and
 * outbound chat traffic. default is enabled.
 */
export function setEnabled(ctx: ScriptContext, enabled: boolean): void;
```

#### `chat.argType`

```ts
/** define a reusable arg type (e.g. an `item` resolver). */
export function argType<T>(t: ArgType<T>): ArgType<T>;
```

#### `chat.enumType`

```ts
/** inline enum arg type, one-shot, no global registration. */
export function enumType<T extends string>(values: T[]): ArgType<T>;
```

Also exported: `chat.ArgType`, `chat.CommandHandle`, `chat.CommandInvocation`, `chat.CommandSpec`, `chat.MessageHandler`, `chat.ParseResult`, `chat.Suggestion`.
#### `client`

```ts
export const client: {
    transfer(ctx: ScriptContext, o?: {
        project?: string;
        options?: Record<string, string | number | boolean>;
        joinData?: Record<string, JsonValue>;
    }): Promise<boolean>;
};
```
#### `clientToUser`

```ts
export function clientToUser(ctx: ScriptContext, client: Client): User;
```
