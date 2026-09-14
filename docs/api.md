# bongle API reference

The exhaustive signature list for the public `bongle` surface, generated from the
package's exports. For a guided, read-top-to-bottom introduction with runnable
examples, see [the guide](./docs.md).

## Scene graph & nodes

Create nodes, compose them with traits, and walk the tree.

#### `Node`

```ts
export type Node = {
    /** runtime-only numeric ID, assigned by the scene tree's incrementing counter. not persisted. */
    id: number;

    /** optional name, a non-unique label. */
    name: string | undefined;

    /** parent node, or null if this is a root node */
    parent: Node | null;

    /** ordered list of child nodes */
    children: Node[];

    /** our index in the parent, or */
    childIndex: number;

    /** the scene tree this node belongs to, or null if detached */
    scene: SceneTree | null;

    /**
     * which Player owns this node. null = server-owned (default).
     * Ownership is keyed per-Player (not per-Client) so parallel
     * memberships, same client with multiple Players in a room, don't
     * collapse onto one body.
     */
    owner: PlayerId | null;

    /**
     * whether this node is saved to scene files. default: true.
     * non-persistent nodes are still included in network replication
     * and hot-reload round-trips.
     */
    persist: boolean;

    /**
     * which side(s) this node lives on / is replicated to:
     * - `'inherit'`: take effective realm from nearest non-inherit ancestor (default)
     * - `'shared'`: server-owned, replicated to all clients
     * - `'client'`: lives only on the client that created it; never replicated
     * - `'server'`: lives only on the server; never replicated to clients
     * - `'each'`: server AND every client get their own independent copy on attach
     *
     * realm boundaries cascade through the tree implicitly: an `'inherit'`
     * descendant of a `'server'` node behaves as `'server'`. consumers that walk
     * the tree (replication, prefab tick) thread the inherited realm through
     * the recursion so each node sees its effective value in O(1).
     */
    realm: Realm;

    /** trait instances indexed by trait slot; holes for slots the node doesn't carry. */
    traits: Array<TraitBase | undefined>;

    /** traits whose def isn't in the registry, keyed by trait id  */
    unresolved: Map<string, Record<string, unknown> | undefined> | null;

    /** bitset for trait query matching */
    bitset: Bitset;

    /** bumped on structural changes to the node */
    version: number;

    /**
     * if non-null, this node is a prefab instance. its children are
     * instantiated from the referenced scene. only the prefab config
     * is persisted, children have persist: false.
     */
    prefab: PrefabConfig | null;
};
```

#### `Realm`

```ts
/**
 * which side(s) a node lives on. see {@link Node.realm}.
 *
 * - `'inherit'`: take the effective realm from the nearest non-inherit ancestor (default)
 * - `'shared'`: server-owned, replicated to all clients
 * - `'client'`: lives only on the client that created it; never replicated
 * - `'server'`: lives only on the server; never replicated
 * - `'each'`: server AND every client get their own independent copy on attach
 *
 * the scene tree root is always `'shared'`, so an `'inherit'` node with no
 * explicit realm anywhere in its chain resolves to `'shared'`.
 */
export type Realm = 'inherit' | 'shared' | 'client' | 'server' | 'each';
```

#### `addChild`

```ts
/**
 * add a child node to a parent. if the child already has a parent, it is
 * removed from the old parent first. if the parent is in a scene tree, the
 * child (and its descendants) are registered in that scene tree.
 */
export function addChild(parent: Node, child: Node): void;
```

#### `findAncestor`

```ts
/**
 * walk up the tree from `node.parent` toward the root and return the first
 * ancestor that has **all** of the given traits. returns a tuple of
 * `[...traitValues]`, or `null` if no ancestor matches. access the ancestor
 * node via any returned trait's `.node` property.
 *
 * this is an ad-hoc traversal, it is **not** reactive. call it when you
 * need to resolve inherited / contextual data from the hierarchy.
 *
 * @example
 * ```ts
 * const result = findAncestor(node, [Physics]);
 * if (result) {
 *   const [physics] = result;
 *   console.log(physics.gravity);
 *   console.log(physics.node); // the ancestor node
 * }
 * ```
 */
export function findAncestor<const Args extends TraitHandle[]>(node: Node, traits: Args): [
    ...traits: {
        [K in keyof Args]: Args[K] extends TraitHandle<infer T> ? T : never;
    }
] | null;
```

#### `findChildByName`

```ts
/**
 * find the first descendant of `node` (depth-first) whose `name` matches `name`.
 * returns null if none found. `node` itself is not considered a match.
 *
 * useful for resolving rig joint targets in animations and similar
 * name-keyed lookups (mirrors three.js `Object3D.getObjectByName`).
 */
export function findChildByName(node: Node, name: string): Node | null;
```

#### `findChildrenByName`

```ts
/**
 * find every descendant of `node` (depth-first) whose `name` matches `name`.
 * returns an empty array if none found. `node` itself is not considered a match.
 *
 * use when you genuinely need to handle multiple matches (e.g. counted-suffix
 * names from non-unique gltf labels). prefer `findChildByName` for unique lookups.
 */
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
/**
 * True iff this node was created locally on the current runtime rather than
 * allocated by the server. The server allocates positive ids (and nodes
 * replicated in from the server keep their positive server id); a client
 * allocates negative ids for nodes it creates locally (see id assignment in
 * the attach path above). So on a client this is false for server-owned
 * (replicated-in) nodes and true for client-only ones, a true *origin* test,
 * unlike `isReplicable` (a realm-policy test). Use it to decide who authors a
 * node's derived content (e.g. the character rig): the server builds for its
 * nodes, a client builds only its own local ones and otherwise defers to
 * replication.
 */
export function isLocalNode(node: Node): boolean;
```

#### `removeChild`

```ts
/**
 * remove a child from its parent. the child (and its descendants) are
 * detached from the scene tree and removed from all queries.
 */
export function removeChild(parent: Node, child: Node): void;
```

#### `replaceChildren`

```ts
/**
 * replace all children of `root` with `node`, destroying every other child.
 * `node` must be a direct child of `root`. analogous to the DOM's
 * `replaceChildren()`, useful after eager prefab instantiation when you
 * want to keep only one sub-node and discard the rest.
 */
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
 * Clone a node intended for the **visual scene**, same as `cloneNode`, plus a
 * `ModelTrait` (a lighting group, one shared voxel-light value for every mesh
 * under the clone) installed on the clone root. Reserve `cloneNode` for
 * non-visual subtree duplication (e.g. detached prefab data), or for meshes you
 * want lit individually — a mesh outside any group renders fine and samples at
 * its own AABB centre.
 *
 * Typical usage:
 * ```ts
 * const instance = cloneModel(wizard.scene);
 * // or for a sub-mesh:
 * const hat = cloneModel(wizard.nodes.HatA);
 * ```
 *
 * Frustum culling is per-mesh and derived automatically by the renderer from
 * each mesh's own geometry, so there's nothing cull-related for the caller to
 * supply or maintain. If the source already has a `ModelTrait`, the existing
 * one is left in place.
 *
 * The new `ModelTrait`'s `lightOffset` is seeded to the centre of the clone's
 * own mesh AABBs, so voxel light samples from inside the model's body rather
 * than at its origin (which for a model authored standing on y=0 is the floor
 * block it sits on). Assign `lightOffset` afterwards to override it.
 *
 * The clone root is also guaranteed a `TransformTrait`: a bake omits it on an
 * identity-TRS, meshless root, but `ModelLighting` samples the `[ModelTrait,
 * TransformTrait]` pair each frame, so without one the group would silently
 * never be lit (stuck full-bright, `lightOffset` dead). An added identity
 * transform is faithful, that's exactly the TRS the bake elided.
 */
export function cloneModel(node: Node): Node;
```

#### `createNode`

```ts
/**
 * create a new **detached** node, no parent, no scripts fired, not in queries.
 * attach with `addChild(parent, node)` to make it live; an id is allocated at
 * attach time (negative on the client, positive on the server).
 *
 * `realm` controls which side(s) the node lives on (default `'inherit'`, which
 * resolves to the nearest ancestor's realm, i.e. `'shared'` under the scene
 * root). Use `'server'` for server-only nodes that must never replicate, or
 * `'client'` for purely local client-side nodes.
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
/** idempotent, attach WorldTrait to the scene root if it isn't already
 *  there. called from room creation on both sides, and again after
 *  `loadSceneTree` on the server (which clears `root._traits` and
 *  repopulates from persisted data, which never includes WorldTrait
 *  because `persist: false`). */
export function attachWorldTrait(root: Node): void;
```

## Transforms

Read and write node positions, rotations, and scales in local and world space.

#### `resetInterpolation`

```ts
/**
 * re-seed prev pose from the node's current local TRS. mirrors godot's
 * `reset_physics_interpolation`, call after a hard snap / teleport /
 * authoritative state load where the prev pose would otherwise cause a
 * visual rubber-band on the next interpolate frame.
 *
 * no-op for nodes that aren't enrolled in interpolation.
 */
export function resetInterpolation(node: Node): void;
```

#### `setInterpolation`

```ts
/**
 * enroll/unenroll a node in the per-frame interpolation pass. mirrors
 * godot's `set_physics_interpolated`.
 *
 * on enable: flips `interpolate` flag, seeds prev pose from the current
 * local pose, and adds the transform to the per-room `interpolating` set,
 * which the per-frame `interpolate()` loop in `render/interpolation.ts`
 * iterates.
 *
 * on disable: flips the flag off, clears `_interpolated` (so visual getters
 * fall back to the world chain), and removes from the set.
 *
 * idempotent: re-enabling a node that is already on is a no-op; same for
 * disabling. nodes without TransformTrait are silently ignored.
 *
 * server-safe: `interpolating` exists on both sides but is never iterated
 * server-side. calling this from shared script code (onInit/onDispose) is
 * fine.
 */
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
/**
 * set a node's local position such that its world position matches worldPos.
 * fast path when no transformed parent, just copies into t.position.
 * marks dirty after writing.
 */
export function setWorldPosition(transform: TransformTrait, worldPosition: Vec3): void;
```

#### `setWorldQuaternion`

```ts
/**
 * set a node's local quaternion such that its world rotation matches worldQuat.
 * fast path when no transformed parent, just copies into t.quaternion.
 * marks dirty after writing.
 */
export function setWorldQuaternion(transform: TransformTrait, worldQuaternion: Quat): void;
```

Also exported: `getVisualWorldMatrix`, `getVisualWorldPosition`, `getVisualWorldQuaternion`, `getVisualWorldScale`, `getWorldMatrix`, `getWorldPosition`, `getWorldQuaternion`, `getWorldScale`, `worldToLocalPosition`, `worldToLocalQuaternion`.

## Traits & schemas

Define traits and the schemas behind editor controls (`prop`) and network packing (`pack`).

#### `dirty`

```ts
/**
 * `dirty` policy constructors — what counts as a change worth sending. byte-diff is
 * the default; producers that don't reliably byte-change (set-once fields) opt into
 * `explicit` and mark themselves dirty via `SyncHandle.dirty()`.
 */
export const dirty: {
    diff: () => "diff";
    explicit: () => "explicit";
};
```

#### `rate`

```ts
/**
 * `rate` policy constructors — the maximum send cadence for a dirty value.
 */
export const rate: {
    hz: (hz: number) => {
        hz: number;
    };
    realtime: () => "realtime";
};
```

#### `ControlDef`

```ts
/** stored ControlDef. body + `{ traitId, controlId }`. */
export type ControlDef<T extends TraitBase = TraitBase, V = unknown> = ControlBody<T, V> & TraitChildStamp<'controlId'>;
```

#### `DirtyConfig`

```ts
/**
 * DIRTINESS policy: what counts as a change worth sending. orthogonal to `rate`
 * (how often) — nothing un-dirty ever sends, regardless of rate.
 * - 'diff' (default), dirty whenever the packed bytes differ.
 * - 'explicit', never auto-dirty; only `SyncHandle.dirty()` marks it (set-once
 *   fields whose value the byte-diff can't be trusted to catch cheaply).
 */
export type DirtyConfig = 'diff' | 'explicit';
```

#### `RateConfig`

```ts
/**
 * RATE policy: the maximum send cadence for a dirty value. orthogonal to `dirty`.
 * - 'realtime' (default), send every tick the value is dirty (no throttle).
 * - { hz }, send at most `hz` times/sec — a dirty value that comes up before the
 *   interval elapses waits, then sends its latest (Quake's snapshotMsec gate).
 */
export type RateConfig = 'realtime' | {
    hz: number;
};
```

#### `SyncDef`

```ts
/** stored SyncDef. body + `{ traitId, syncId }`. wire envelope keys by
 *  registration index (`SyncHandle.index`), not `syncId`. */
export type SyncDef<T extends TraitBase = TraitBase, S = unknown> = SyncBody<T, S> & TraitChildStamp<'syncId'>;
```

#### `SyncHandle`

```ts
/**
 * returned by sync() at registration time. carries the sync index and a
 * producer-side hint to skip byte-diffing.
 *   const poseSync = sync(TransformTrait, { schema, pack, unpack });
 *   poseSync.dirty(t);   // "I changed this, emit on next diff pass
 *                        //  without bothering to byte-diff."
 */
export type SyncHandle<T extends TraitBase = TraitBase> = {
    readonly index: number;
    dirty(instance: T): void;
};
```

#### `TraitBase`

```ts
/** base shape of every trait instance, has `_node` back-ref + def back-ref. */
export type TraitBase = {
    /** reference to the node this trait instance belongs to */
    _node: Node;
    /** the TraitDef this instance was built from */
    _def: TraitDef;
    /**
     * per-instance replication working-state, dirty bits + diff snapshots,
     * array-indexed by sync slice. allocated in buildTraitInstance when the
     * trait has syncs; undefined otherwise (helpers no-op in that case).
     */
    _sync?: TraitSyncState;
};
```

#### `TraitBody`

```ts
/**
 * trait body, a plain object literal whose values are either:
 * - a literal (number, string, boolean, null) shared as the default, or
 * - a factory `() => T` called once per instance to build a fresh value
 *   (required for any mutable default, Vec3, Quat, Mat4, arrays, objects).
 *
 * trait-level options (e.g. persist) live in the third arg to `trait()`,
 * keeping the body purely instance-field shaped.
 */
export type TraitBody = Record<string, unknown>;
```

#### `TraitDef`

```ts
/** The authored data for one trait. Everything DERIVED from it — the compiled
 *  constructor, the codec memos, the by-id indexes, the wire index — lives on the
 *  handle, so this stays pure data: hashable, serializable, no back-references. */
export type TraitDef = {
    id: string;
    /** human-readable display name for editor UIs. always set,
     *  defaults to `id` when the author didn't supply one. */
    name: string;
    /** raw body of the trait, literals + factories, indexed by field name. */
    body: Record<string, unknown>;
    /** whether instances of this trait are saved to scene files. default true. */
    persist: boolean;
    /** appended by this module's `control()` calls, right after `trait()` returns. */
    controls: ControlDef[];
    /** appended by this module's `sync()` calls. */
    sync: SyncDef[];
    /** appended by this module's `script()` calls. */
    scripts: ScriptDef[];
};
```

#### `TraitHandle`

```ts
/**
 * the handle returned by trait(). used with getTrait, addTrait, hasTrait,
 * query, findAncestor, etc. the __type field carries the instance type for
 * inference; it does not exist at runtime.
 */
export type TraitHandle<T extends TraitBase = TraitBase> = {
    /** the declared id (identity, never changes). */
    readonly id: string;
    /**
     * runtime slot, stable integer identity assigned the first time `trait(id, ...)`
     * runs, cached in `traitSlots[id]` for the process lifetime. Used as the key
     * in `node._traits: Map<number, TraitBase>` and anywhere runtime code indexes
     * a trait. Distinct from the *wire index* (`netIndex`, recomputed per flush).
     */
    readonly slot: number;
    /** DepGraph dependency, see SceneHandle.dependency. */
    readonly dependency: DepKey;
    /** the authored data. re-pointed on every re-declaration. */
    def: TraitDef;
    /** sort-by-id wire position, stamped by `reindexRegistry` each flush. Not
     *  derived from the def but from the registry's ordering, same as a block's
     *  `_baseStateId`, so it lives on the handle and survives re-declaration. */
    netIndex: number | undefined;

    /** phantom, carries the instance type for inference. not present at runtime. */
    readonly __type: T;
};
```

#### `TraitInstance`

```ts
/**
 * map a TraitBody to its instance shape: factory values are unwrapped
 * to their return type, literals pass through.
 */
export type TraitInstance<S extends TraitBody> = TraitBase & {
    [K in keyof S as K extends ReservedTraitKey ? never : K]: ResolveField<S[K], TraitInstance<S>>;
};
```

#### `TraitOptions`

```ts
/** trait-level options, passed as the third arg to `trait()`. */
export type TraitOptions = {
    /** human-readable display name for editor UIs (trait pickers,
     *  inspectors). falls back to the string id when omitted. */
    name?: string;
    /**
     * whether instances of this trait round-trip through scene files.
     * default `true`. set to `false` for traits attached at runtime that
     * should never appear on disk (e.g. character controllers, gizmos).
     * for tag traits (no controls), `persist: false` still strips the
     * trait from saved scenes, its mere presence on the node is the data
     * being filtered.
     */
    persist?: boolean;
};
```

#### `TraitType`

```ts
/** extract the instance type from a trait handle. */
export type TraitType<H extends TraitHandle> = H['__type'];
```

#### `Self`

```ts
/**
 * Placeholder for "this trait's own instance type", for a field that points at
 * another instance of the trait it is declared on. A trait body cannot name the
 * type being inferred from it, so `Self` stands in and `TraitInstance`
 * substitutes the real type:
 *
 * ```ts
 * const T = trait('transform', { _parent: null as any });
 * const q = query([Ancestor(Self)]); // inside T's own declarations, Self is T
 * ```
 *
 * Extends `TraitBase` so it satisfies `TraitHandle`'s constraint; the brand is
 * what `TraitInstance` matches on to make the substitution.
 */
export type Self = TraitBase & {
    readonly [SELF_MARKER]: true;
};
```

#### `control`

```ts
/**
 * register a control on a trait. callable multiple times per trait.
 * declared *after* the trait() literal so `t` is fully typed in get/set.
 * `id` is a stable string used as the persisted key in scene files and
 * the inspector lookup key.
 */
export function control<T extends TraitBase, V>(handle: TraitHandle<T>, controlId: string, body: ControlBody<T, V>): void;
```

#### `sync`

```ts
/**
 * register a sync on a trait. callable multiple times per trait.
 * `id` is a stable string used for debug and per-attachment diff tracking.
 * returns a SyncHandle for producer-side dirty hints; wire envelope still
 * keys by `SyncHandle.index` (the slot in def.sync).
 */
export function sync<T extends TraitBase, S>(handle: TraitHandle<T>, syncId: string, body: SyncBody<T, S>): SyncHandle<T>;
```

#### `trait`

```ts
/**
 * define a trait. registers it in the global capture area and returns
 * a handle used with getTrait, addTrait, hasTrait, query, etc.
 *
 * @example
 * ```ts
 * const TransformTrait = trait('transform', {
 *     position: () => vec3.create(),
 *     scale:    () => vec3.fromValues(1, 1, 1),
 *     teleport: 0,
 *     interpolate: false,
 * });
 *
 * control(TransformTrait, 'position', {
 *     schema: prop.vec3(),
 *     get: (t) => t.position,
 *     set: (t, v) => { vec3.copy(t.position, v); markDirty(t); },
 * });
 *
 * const poseSync = sync(TransformTrait, 'pose', {
 *     schema: pack.tuple([pack.position(), pack.quaternion()]),
 *     pack: (t) => [t.position, t.quaternion],
 *     unpack: ([p, q], t) => { vec3.copy(t.position, p); quat.copy(t.quaternion, q); markDirty(t); },
 * });
 * ```
 */
export function trait<S extends TraitBody = Record<string, never>>(id: string, body?: S, options?: TraitOptions): TraitHandle<TraitInstance<S>>;
```
#### `propToPack`

```ts
/**
 * convert a prop schema (prop.number, prop.vec3, etc.) to a packcat
 * schema for binary serialization. returns null for types that can't
 * be cleanly mapped (shouldn't happen for well-formed schemas).
 */
export function propToPack(schema: PropSchema): PackcatSchema | null;
```

Also exported: `prop`.
Also exported: `pack`.

## Scripts & lifecycle

Attach behaviour and register lifecycle hooks.

#### `system`

```ts
/**
 * register a **system**: scene-scoped logic hosted on the always-attached
 * `WorldTrait`, running once per scene per side. sugar for
 * `script(WorldTrait, id, factory, opts)`, and the preferred spelling.
 *
 * use for logic that operates "globally" e.g. via querying entities based on their composition with `query(ctx, [...])`
 *
 * @example
 * ```ts
 * system('character-animation', (ctx) => {
 *     if (!env.client) return;
 *     const q = query(ctx, [CharacterTrait, CharacterControllerTrait, TransformTrait]);
 *     onFrame(ctx, ({ delta }) => {
 *         for (const [ch, cc, transform] of q.matches) {
 *             // …drive bones, read camera, etc.
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
/**
 * the full `matches` array of a query, keyed by the same condition args you pass to {@link query}
 * (e.g. `QueryMatches<[typeof ScoreTrait, typeof TransformTrait]>`). use it to type a function that
 * receives query matches without hand-respelling the trait tuple:
 *
 * ```ts
 * const fighters = query(ctx, [ScoreTrait, TransformTrait]);
 * const positions = (matches: QueryMatches<[typeof ScoreTrait, typeof TransformTrait]>) => ...;
 * positions(fighters.matches);
 * ```
 */
export type QueryMatches<Args extends ConditionArgs[]> = Query<ConditionArgsToConditions<Args>>['matches'];
```

#### `ClientContext`

```ts
export type ClientContext = {
    /** the gpucat render scenes this client renders into */
    render: RenderScenes;

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

    /**
     * per-room overlay viewport div, stacked above the single shared render canvas
     * (a backdrop sibling). scripts can append HTML overlays here (debug HUDs, custom
     * UI). the viewport hides/shows with the active room and is removed when the room
     * is disposed, so script overlays automatically follow room lifecycle.
     *
     * has `pointer-events: none` so empty-area gestures fall through to the canvas
     * below; overlays that need interactivity must set `pointer-events: auto` on
     * themselves.
     */
    viewport: HTMLDivElement;

    /**
     * per-room touch overlay div under `viewport`, appended AFTER the html UI overlay
     * so it stacks visually above everything by DOM order alone. touch controls helpers
     * (joystick / button) mount their roots here; pointer events live on the helper
     * roots, not on this container (which stays `pointer-events: none`).
     */
    touchOverlay: HTMLDivElement;

    /** our own client id */
    clientId: ClientId | undefined;

    /**
     * client debug surface. `dashboard` is the shared `Dashboard` —
     * games dock their own panels on it (or via the scoped `debug.panel(ctx, …)`
     * helper, which auto-cleans on script dispose). the raw handle is the
     * escape hatch for full dashboard control. built lazily on first access.
     *
     * future home for the client-global metrics/logs handles + open flag
     * that currently live on the store / ClientRoom.
     */
    debug: ClientDebugState;

    /** client input state, read keyboard/mouse here in onFrame hooks */
    input: Input;

    /** top-level client engine state, populated by engine-client on room creation */
    state?: EngineClient;

    /** the client room this script is running in */
    room?: ClientRoom;
};
```

#### `EditorPlayData`

```ts
/** editor viewpoint pose passed under `EDITOR_JOIN_KEY` in join data. */
export type EditorPlayData = {
    /** editor camera world position at play time. */
    position: [number, number, number];
    /** editor camera world orientation at play time. */
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
    /** the mode the player joined in: 'edit' for an editor (including one
     *  inspecting a play room), 'play' otherwise. */
    mode: PlayerMode;
    /** Model id the player renders with, resolved upstream (matchmaker /
     *  builtin) and already stamped onto `playerNode`'s CharacterTrait
     *  before this fires. */
    characterModelId: string;
    /** Rig contract of that model, e.g. `RIG_TYPE_6BONE`, lets onJoin
     *  branch on rig family without reaching for the trait. */
    rigType: string;
};
```

#### `LeaveArgs`

```ts
/** args passed to onLeave callbacks */
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
    /** the mode of the room this script is running in */
    mode: 'edit' | 'play';

    /** the trait instance this script is bound to. fully typed for the
     *  TraitHandle passed to `script()`. */
    trait: T;

    /** the node the bound trait is attached to (shortcut for `ctx.trait._node`) */
    node: SceneTree.Node;

    /** the scene tree this script is running in */
    scene: SceneTree.SceneTree;

    /** per-room voxel data */
    voxels: Voxels;

    /** per-room physics world */
    physics: Physics;

    /** per-room game clock (monotonic seconds, advances at tick cadence) */
    clock: Clock;

    /** block registry, flat lookup tables for block type/state info.
     *  DERIVED from `voxels.registry` (a getter at the construction site), never a
     *  captured copy: `registry-dispatch.refreshBlockResources` repoints
     *  `voxels.registry` and re-resolves every chunk palette to the new state ids on
     *  an HMR block change. A second cached `Blocks` misses that swap and then indexes
     *  new state ids into the old, shorter typed arrays. */
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
```

#### `TickArgs`

```ts
export type TickArgs = {
    delta: number;
};
```

#### `UpdateArgs`

```ts
export type UpdateArgs = {
    delta: number;
};
```

#### `editorPlayData`

```ts
/**
 * read the editor viewpoint from join data, if this session was launched via
 * the editor "play" button. returns `null` for normal joins (the key is
 * absent), so a game can fall back to its usual spawn. games use this to offer
 * "play from here" during development.
 */
export function editorPlayData(joinData: Record<string, JsonValue>): EditorPlayData | null;
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
/** returns true if the caller has write authority over `node`:
 *  - on a client, true iff the active Player in this script's room is the node's owner.
 *  - on the server, true iff the node has no client owner (server is the implicit
 *    owner of unowned nodes, so server-driven NPCs / props tick from the server side). */
export function isOwner(ctx: ScriptContext, node: SceneTree.Node): boolean;
```

#### `listen`

```ts
export function listen<S extends Scripts.Schema>(ctx: ScriptContext, handle: CommandHandle<S, 'client_to_server'>, fn: (data: Scripts.SchemaType<S>, from: Client) => void): Unsubscribe;
```

#### `onBlockBreak`

```ts
/**
 * register a callback that fires when a block of `block`'s type is broken
 * (replaced with air or a different block). authority-only (server room or
 * local/standalone room).
 */
export function onBlockBreak(ctx: ScriptContext, block: import('../voxels/blocks').BlockHandle, fn: (ev: import('../voxels/blocks').BlockChangeCtx) => void): Unsubscribe;
```

#### `onBlockBuild`

```ts
/**
 * register a callback that fires when a block of `block`'s type is built
 * (placed where air or a different block was). authority-only (server room
 * or local/standalone room). handler receives the world coords + new state id; close over
 * `ctx` for scene/room access (e.g. spawn an item, play a sound).
 */
export function onBlockBuild(ctx: ScriptContext, block: import('../voxels/blocks').BlockHandle, fn: (ev: import('../voxels/blocks').BlockChangeCtx) => void): Unsubscribe;
```

#### `onBlockStateChange`

```ts
/**
 * register a callback that fires when a block of `block`'s type changes
 * state in place (same block-type, different stateId). authority-only (server
 * room or local/standalone room).
 * handler receives both old and new state ids on the event payload.
 */
export function onBlockStateChange(ctx: ScriptContext, block: import('../voxels/blocks').BlockHandle, fn: (ev: import('../voxels/blocks').BlockStateChangeCtx) => void): Unsubscribe;
```

#### `onDispose`

```ts
export function onDispose(ctx: ScriptContext, fn: () => void): Unsubscribe;
```

#### `onEnter`

```ts
/**
 * register a callback that fires when this script's node enters the scene tree.
 * fires on initial attach and on every reparent (after the new parent is set).
 */
export function onEnter(ctx: ScriptContext, fn: (parent: SceneTree.Node) => void): Unsubscribe;
```

#### `onExit`

```ts
/**
 * register a callback that fires when this script's node exits the scene tree.
 * fires on detach and before every reparent detach.
 */
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
/**
 * register a callback that fires at the very start of each frame, before
 * onUpdate / onTick / onFrame. intended for input pre-processing, e.g. an
 * editor consuming mouse deltas before player controllers read them.
 *
 * iteration order matches onFrame (flat over runtime.instances). consumers
 * relying on "X runs before Y" should rely on script registration order.
 * client-only, no-op on the server.
 */
export function onInput(ctx: ScriptContext, fn: (args: FrameArgs) => void): Unsubscribe;
```

#### `onJoin`

```ts
/**
 * register a callback that fires when a client joins the room.
 * authority-only: runs on the server room, or on a client-only
 * local/standalone room; a no-op on a client connected to a remote server.
 */
export function onJoin(ctx: ScriptContext, fn: (args: JoinArgs) => void): Unsubscribe;
```

#### `onLeave`

```ts
/**
 * register a callback that fires when a client leaves the room.
 * authority-only: runs on the server room, or on a client-only
 * local/standalone room; a no-op on a client connected to a remote server.
 */
export function onLeave(ctx: ScriptContext, fn: (args: LeaveArgs) => void): Unsubscribe;
```

#### `onPhysicsBodyPairValidate`

```ts
/**
 * register a callback that fires during broadphase to validate body pairs.
 * return false to reject collision detection for this pair.
 * if any registered callback returns false, the pair is rejected.
 */
export function onPhysicsBodyPairValidate(ctx: ScriptContext, fn: (bodyA: RigidBody, bodyB: RigidBody) => boolean): Unsubscribe;
```

#### `onPhysicsContact`

```ts
/**
 * register a callback that fires during the physics step when a contact is detected.
 * receives raw crashcat body/manifold/settings, you can modify settings to customize
 * contact behavior (e.g. zero friction for ice surfaces, set isSensor).
 */
export function onPhysicsContact(ctx: ScriptContext, event: 'added' | 'persisted', fn: (args: PhysicsContactArgs) => void): Unsubscribe;
```

#### `onPostAnimate`

```ts
/**
 * register a callback that fires after animator sampling, before world-matrix
 * recompute. ideal for procedural post-processing, head-look at the camera,
 * springs/dampers driven by parent motion, simple constraint clamps. local
 * TRS values are set; world matrices for this tick haven't been recomputed yet.
 */
export function onPostAnimate(ctx: ScriptContext, fn: (args: TickArgs) => void): Unsubscribe;
```

#### `onPostPhysicsStep`

```ts
/**
 * register a callback that fires after each physics step.
 * use this to read collision results, updated positions/velocities,
 * or react to physics simulation output.
 */
export function onPostPhysicsStep(ctx: ScriptContext, fn: (args: TickArgs) => void): Unsubscribe;
```

#### `onPrePhysicsStep`

```ts
/**
 * register a callback that fires before each physics step.
 * use this to apply forces, set velocities, or prepare body state
 * before the physics world is stepped.
 */
export function onPrePhysicsStep(ctx: ScriptContext, fn: (args: TickArgs) => void): Unsubscribe;
```

#### `onQueryEnter`

```ts
/**
 * react to a node **starting** to match `q`.
 *
 * `q` must come from `query(ctx, ...)`, so this instance holds it. the handler
 * receives the same trait tuple `q.matches` yields, spread.
 *
 * **subscribing is itself an enter**: the handler fires straight away for every
 * node already matching. a system registered after the scene loaded (the normal
 * case, and every case after a hot reload) therefore sees the whole set, with no
 * hand-written backfill loop over `q.matches`.
 *
 * fires once the node is fully live: its subtree is registered and its own
 * scripts have run `onInit`. paired with `onQueryExit`, exactly one exit follows
 * every enter, so a per-node resource opened here cannot leak.
 *
 * @example
 * ```ts
 * system('spawn-markers', (ctx) => {
 *     const q = query(ctx, [SpawnPointTrait, TransformTrait]);
 *     const markers = new Map<SpawnPointTrait, Marker>();
 *     onQueryEnter(ctx, q, (spawn, transform) => markers.set(spawn, addMarker(transform)));
 *     onQueryExit(ctx, q, (spawn) => {
 *         removeMarker(markers.get(spawn)!);
 *         markers.delete(spawn);
 *     });
 * });
 * ```
 */
export function onQueryEnter<Conditions extends Condition[]>(ctx: ScriptContext, q: SceneTree.Query<Conditions>, fn: QueryListener<Conditions>): Unsubscribe;
```

#### `onQueryExit`

```ts
/**
 * react to a node **stopping** matching `q`. mirror of {@link onQueryEnter}.
 *
 * **unsubscribing is itself an exit**: when the returned function is called, or
 * when this script instance disposes, the handler fires one last time for every
 * node still matching. that is what makes teardown and hot reload safe, the
 * instance going away closes everything it opened.
 */
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
/**
 * register a callback that fires once per frame, before the fixed-timestep tick
 * loop. use this for input polling and camera updates, reads fresh input state
 * and drives the camera before any physics/kcc ticks run that frame.
 * client-only, no-op on the server.
 */
export function onUpdate(ctx: ScriptContext, fn: (args: UpdateArgs) => void): Unsubscribe;
```

#### `query`

```ts
/**
 * register (or reuse) a live query tied to this script instance's lifetime.
 * the returned `Query` is the same handle for any caller with identical
 * conditions; calling twice on the same instance dedups to one refcount.
 * the query is released when the script instance disposes, do not hold
 * references across `onSwap` boundaries.
 */
export function query<const Args extends ConditionArgs[]>(ctx: ScriptContext, conditions: Args): SceneTree.Query<ConditionArgsToConditions<Args>>;
```

#### `send`

```ts
export function send<S extends Scripts.Schema, Direction extends Rpc.RpcDirection>(ctx: ScriptContext, handle: CommandHandle<S, Direction>, data: Scripts.SchemaType<S>, client?: Direction extends typeof Rpc.SERVER_TO_CLIENT ? Client : never): void;
```

#### `script`

```ts
/**
 * register a script (behavior) on a trait. callable multiple times per trait,
 * each call appends to the trait def's `scripts` array. attaching the trait to
 * a live node instantiates one ScriptInstance per registered script. the
 * factory runs at attach time with `ctx.trait` typed for the handle.
 *
 * `id` is a stable user-supplied string (without trait prefix). the runtime
 * identifier becomes `${trait.id}.${id}`, used as the instance map key,
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
export function script<T extends TraitBase>(handle: TraitHandle<T>, scriptId: string, factory: ScriptFactory<T>, opts?: ScriptOptions): ScriptDef;
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
 * open a floating debug panel on the shared dashboard, scoped to this script: it
 * is closed automatically when the script instance disposes (room teardown, node
 * removal, hot-reload), so game debug UI can't leak. the returned `Panel`
 * takes the full control surface — `add` (options), `monitor`, `graph`, `log`,
 * `stat`, `tabs`, etc. — alongside the engine's panels.
 *
 * client-only: returns `null` on the server. `title` defaults to the script's
 * trait/node tag, mirroring how `log` tags its source. for full control (or
 * manual lifecycle) reach `ctx.client.debug.dashboard` directly.
 */
export function panel(ctx: ScriptContext, opts: PanelOptions = {

}): Panel | null;
```
#### `env`

```ts
/**
 * Environment flags for conditional code.
 *
 * All flags are replaced at build time by the blocks-env Vite plugin with
 * true/false literals, enabling dead code elimination.
 *
 * - `env.client`, true in the client bundle, false in the server bundle.
 * - `env.server`, true in the server bundle, false in the client bundle.
 * - `env.editor`, true when the project was started with the editor (dev
 *   mode), false in production deploys. Editor-specific code (inspector UI,
 *   debug overlays, editor scripts) can be gated behind this flag and
 *   stripped in production builds.
 *
 * The asset pipeline does NOT use a flag, it's a separate engine entry
 * (`EngineAssetPipeline`), not a headless variant of the client. Its realm runs
 * NEUTRAL: all three flags stay false. Declarations register ungated, so the bake
 * sees the whole registry either way. The bake runs no behaviour: its icon rooms
 * instantiate no scripts and no systems, so a prefab icon shows only what its
 * apply places up front.
 *
 * Note: there is no `env.edit` or `env.play`. Mode is per-room and
 * available on the script context as `ctx.mode`.
 */
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
 * Client-only. The transport lives on the ClientDriver supplied at engine init,
 * this just hands off to it. Standalone / bongle-dev hosts wire these to an
 * inert impl, so a game can call them unconditionally regardless of where it's
 * running.
 *
 * Loading/gameplay lifecycle is NOT here, the host infers that from the
 * connection. These are the ad moments only the game knows the timing of
 * (between rounds, on death, etc.). Audio muting for the ad's duration is
 * handled by `Ads` + the update loop, so games don't think about it.
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
export function asset(rel: string, base: string): string;
```
#### `texture`

```ts
/**
 * Declare a texture: one picture, from disk or computed from other textures.
 *
 * ```ts
 * const stone = texture('kit:stone', { src: asset('./stone.png', import.meta.url) });
 *
 * const dust = texture('kit:stone:dust0', {
 *     size: [8, 8],
 *     inputs: { tex: stone },
 *     params: { seed: 1234 },
 *     fn: (ctx, inputs, params) => { ... },
 * });
 * ```
 *
 * Consumers (`sprite()`, and the voxel-atlas tile kind) hold textures in their `frames`,
 * so animation is the consumer's concern and a texture stays exactly one picture.
 */
export function texture<I extends Record<string, TextureHandle>, P extends DrawParams>(id: string, options: TextureOptions<I, P>): TextureHandle;
```

#### `TextureComputedOptions`

```ts
/** a texture computed at bake time from other textures. */
export type TextureComputedOptions<I extends Record<string, TextureHandle>, P extends DrawParams> = {
    /** output canvas dims in pixels. */
    size: [number, number];
    /** other textures this one is drawn from, keyed by the name `fn` destructures. */
    inputs?: I;
    /** scalar tweak knobs. Hashed, so a change here invalidates; a value the `fn` closes
     *  over instead of taking through here is INVISIBLE to change detection. */
    params?: P;
    /** drawn at bake time. Sync, and pure with respect to its three arguments. */
    fn: DrawFn<DrawInputs, P>;
};
```

#### `TextureDef`

```ts
/**
 * The declared data for one texture. Pure: hashed wholesale, swapped wholesale on
 * re-declaration. `inputs` holds `DepKey`s rather than live handles so the def stays plain
 * data — the bake resolves them through the store, which is safe because by bake time
 * every declaration has run.
 */
export type TextureDef =
    | { id: string; from: 'file'; src: string }
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
/** a texture from a file: a project-relative path or an `asset()` href. */
export type TextureFileOptions = {
    src: string;
};
```

#### `TextureHandle`

```ts
/** Stable wrapper around a `TextureDef`; the data is read through `.def`, which is
 *  re-pointed on every re-declaration (see `declare`). */
export type TextureHandle = {
    /** the declared id (identity, never changes). */
    readonly id: string;
    /** DepGraph dependency + the brand `isHandle` tests. */
    readonly dependency: DepKey;
    /** the declared data. re-pointed on every re-declaration. */
    def: TextureDef;
};
```

#### `TextureOptions`

```ts
export type TextureOptions<
    I extends Record<string, TextureHandle> = Record<string, TextureHandle>,
    P extends DrawParams = DrawParams,
> = TextureFileOptions | TextureComputedOptions<I, P>;
```
#### `getModel`

```ts
/**
 * Look up a model's handle, gated on payload readiness. Returns null
 * until `Resources` has parsed the bytes and hydrated the handle,
 * consumers can poll this each frame and key off the null→non-null
 * transition (the character reconciler is the canonical example).
 *
 * The returned handle is identity-stable: `setModel` constructs the
 * shell on first registration and `ensureModel` hydrates it in place,
 * so a non-null result keeps the same object reference across HMR /
 * re-registrations of the same id.
 */
export function getModel(ctx: ScriptContext, id: string): ModelDef | null;
```

#### `ensureModel`

```ts
/**
 * Kick the lazy payload load for an already-registered (bundled or
 * runtime) model. Idempotent and safe to call every tick, it's the
 * trigger that flips a declared `model()` from "URL known" to "bytes
 * fetched + parsed", after which `getModel` returns non-null. Use when
 * you reference a bundled model directly (e.g. set `CharacterTrait.modelId`
 * on an NPC) rather than going through the player avatar pipeline, which
 * ensures on your behalf. Warns (no-op) if the id isn't registered.
 */
export function ensureModel(ctx: ScriptContext, id: string): void;
```

#### `LoadModelOptions`

```ts
export type LoadModelOptions = {
    /** Fetch URL the engine will pull bytes from. Pass a single string
     *  when both sides hit the same URL (the common case, public R2
     *  URLs, blob: URLs in standalone client-only contexts). Pass an
     *  object when client and server URLs differ (signed URLs with
     *  per-side scopes, dev where the server reads disk and the client
     *  goes via a dev-server route). */
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
 * Idempotent against the same id, re-calls bump the refcount instead
 * of re-registering, and resolve immediately if the payload is already
 * ready.
 *
 * Pair every successful `loadModel` with a `releaseModel` at the end of
 * the consumer's lifetime so refcounts stay honest. Forgetting is
 * cheap (the entry sits in memory for the engine's life) but accretes.
 *
 * Rejects with the underlying fetch/parse error if the payload reaches
 * its retry give-up, or if the model is released before it loads. Until
 * then, transient failures retry in the background and the promise stays
 * pending, the load self-drives its own retries while awaited.
 */
export function loadModel(ctx: ScriptContext, id: string, options: LoadModelOptions): Promise<ModelDef>;
```

#### `releaseModel`

```ts
/**
 * Release a previously-loaded runtime model. Decrements the refcount;
 * at zero, drops bytes + URL entry. Safe to call against an unknown id
 * or a bundled entry (both no-ops).
 */
export function releaseModel(ctx: ScriptContext, id: string): void;
```
#### `SoundDef`

```ts
/** The declared + codegen'd data for one sound. Pure data: hashed for change
 *  detection, swapped wholesale when the barrel re-registers (see `declare`). */
export type SoundDef = {
    readonly soundId: string;
    /** human-readable display name for editor UIs. always set,
     *  defaults to `soundId` when the author didn't supply one, so
     *  readers can show `handle.name` unconditionally. */
    readonly name: string;
    /** search words for editor UIs, normalised (see `AssetMeta`). */
    readonly tags: readonly string[];
    readonly src: string;
    readonly long: boolean;
    /**
     * clip duration in seconds, ffprobed at codegen and baked into the
     * sidecar. zero on the placeholder handle that `sound()` returns when
     * codegen hasn't run yet for this id; the barrel mutates it in place
     * on the next pipeline pass.
     */
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
/**
 * Empty base interface, augmented by the codegen'd registry barrel
 * (`src/generated/sounds.ts`) via declaration merging to map sound ids
 * to their precise handle types. Mirrors ModelHandleMap.
 *
 * @example codegen output:
 * ```ts
 * declare module 'bongle' {
 *     interface SoundHandleMap {
 *         footstep: typeof footstep;
 *         ambient: typeof ambient;
 *     }
 * }
 * ```
 */
export interface SoundHandleMap {

}
```

#### `SoundOptions`

```ts
export type SoundOptions = AssetMeta & {
    /**
     * source audio (.wav/.mp3/.ogg/.flac): either a string path relative to
     * project root, or a module-relative `asset('./clip.ogg', import.meta.url)`
     * ref. The `asset()` form lets engine builtins + 3rd-party deps ship audio
     * alongside their modules — it resolves relative to the calling module
     * wherever it's installed, and the pipeline reads the resolved path.
     */
    src: string;
    /**
     * opt out of the audio atlas, ship + decode standalone. default false.
     *
     * use for long-form audio (background tracks, voice lines, ambient
     * loops) where adding to the atlas would bloat the eager-at-boot
     * fetch. first play of a long clip pays a fetch + decodeAudioData
     * latency; subsequent plays are instant (decoded buffer is cached).
     */
    long?: boolean;
};
```

#### `sound`

```ts
/**
 * Declare an audio clip. Called at module scope.
 *
 * Returns the codegen'd `SoundHandle` (typed via `SoundHandleMap` if the
 * cli has emitted the registry barrel yet, generic `SoundHandle` otherwise).
 *
 * ```ts
 * import { sound } from 'bongle';
 * const Footstep = sound('footstep', { src: 'audio/footstep.wav' });
 * const Ambient  = sound('ambient', { src: 'audio/ambient.ogg', long: true });
 * ```
 *
 * The bongle asset pipeline reads `soundsRegistry` on every flush and
 * builds the atlas (long:false bucket) + standalone files (long:true
 * bucket) into `resources/client/`, then codegens per-id sidecars +
 * barrel under `src/generated/sounds*`. Playback is via the script APIs
 * in `api/audio.ts` (`playMono` / `playAt` / `playOnNode`).
 */
export function sound<const Id extends string>(id: Id, options: SoundOptions): Id extends keyof SoundHandleMap ? SoundHandleMap[Id] : SoundHandle;
```
#### `sprite`

```ts
/**
 * declare a sprite. called at module scope.
 *
 * single entry → static sprite; array → flipbook frames.
 *
 * returns a pure-data handle that the asset pipeline reads to pack the
 * sprite atlas and the runtime consults (by id) for uvRect + sizePx.
 *
 * @example
 * ```ts
 * const Sword = sprite('sword', { src: 'items/sword.png' });
 * const FlamingSword = sprite('flaming-sword', {
 *     src: ['items/flaming_0.png', 'items/flaming_1.png'],
 * });
 * ```
 */
export function sprite(id: string, options: SpriteOptions): SpriteHandle;
```

#### `ImageSource`

```ts
/** one image source: a project-relative path or an `asset()` href. Composition is no
 *  longer expressible here — a composed image is a computed `texture()`, which has an id,
 *  a hash and real dep edges. */
export type ImageSource = string;
```

#### `SpriteHandle`

```ts
/** Stable wrapper around a `SpriteDef`; identity plus the live def. */
export type SpriteHandle = {
    /** the declared id (identity, never changes). */
    readonly id: string;
    /** DepGraph dependency + the brand `isHandle` tests. */
    dependency: { registry: 'sprites'; id: string };
    /** the declared data. re-pointed on every re-declaration. */
    def: SpriteDef;
};
```

#### `SpriteOptions`

```ts
export type SpriteOptions = AssetMeta & {
    /**
     * source image(s). single entry for static sprites, array for
     * flipbooks (one entry per frame). Sugar: each entry declares a texture.
     *
     * URLs are normalized to `.href` at registration, same convention
     * as `tile()`. The URL form lets 3rd-party packs ship sprite
     * pixels bundled alongside their modules (vite rewrites
     * `new URL(...)` in the client bundle; the asset pipeline resolves
     * `file://` URLs via `fileURLToPath` at bake time).
     */
    src?: ImageSource | ImageSource[];

    /** the textures this sprite's frames come from. The direct form; `src` is sugar
     *  that declares textures for you. */
    frames?: TextureHandle[];

    /** gutter pixels in the atlas to avoid bleed at mip levels. default 1. */
    padding?: number;
    /** generate mips for this sprite. default true. set false for crisp
     *  pixel-art look (typical for particles). */
    mipmap?: boolean;
};
```

#### `DrawFn`

```ts
/** generic over the inputs/params maps so the user fn args are typed. At runtime the bake
 *  resolves each input to a `CanvasImageSource` (skia `Image` for file textures, skia
 *  `Canvas` for computed ones, both structurally compatible with the DOM type). */
export type DrawFn<I extends DrawInputs, P extends DrawParams> = (
    ctx: CanvasRenderingContext2D,
    inputs: { [K in keyof I]: CanvasImageSource },
    params: P,
) => void;
```

#### `DrawInputs`

```ts
/** the shape `DrawFn` keys its resolved input images by. The values are erased: only the
 *  KEYS matter here, since the bake resolves each to a `CanvasImageSource`. */
export type DrawInputs = Record<string, unknown>;
```

#### `DrawParams`

```ts
/** scalar param values, string / number / boolean only. JSON-serializes cleanly into the
 *  registry `structuralHash` and covers the seed + tweak knobs use case. Widen later
 *  (arrays, nested) only when a real consumer demands it. */
export type DrawParams = Record<string, string | number | boolean>;
```

#### `DEFAULT_PIXELS_PER_UNIT`

```ts
/**
 * Default world units per source pixel. Matches `SpriteTrait`'s
 * `worldScale` default and Minecraft's 1px = 1/16 block convention.
 * Pulled out as a named constant so the open question (plan §"Open
 * questions" #1: global pixels-per-unit) has a single sticky value to
 * revisit when it's settled.
 */
export const DEFAULT_PIXELS_PER_UNIT;
```

#### `spriteWorldSize`

```ts
/**
 * World-space `[width, height]` of a sprite, derived from its native
 * pixel dims (frame 0 if the sprite is a flipbook) divided by
 * `pixelsPerUnit` (defaults to `DEFAULT_PIXELS_PER_UNIT`). Returns
 * `null` server-side, before the client has booted, or before the
 * asset pipeline has emitted this sprite into the atlas.
 *
 * Reads the CPU atlas metadata (`Resources.spriteAtlas`) directly, no
 * renderer involvement, pixel dims are asset data, not a GPU resource.
 *
 * Convenience for keeping an `AabbBody` size in sync with the visual,
 * body owns its own size concern per "own table for sub-concepts",
 * this helper just removes the manual arithmetic at the call site.
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
 * Keep a handle alive through bundler tree-shaking.
 *
 * `block()` / `model()` / `sound()` / `tile()` register into the
 * engine's registries when their declaration is evaluated. If a game
 * never references a handle in code (e.g. blocks listed only in a
 * scene's voxel palette, models referenced only by prefab id), prod
 * bundlers may drop the declaration as dead code, the registration
 * then never happens and the scene fails to load.
 *
 * `use()` is a non-pure call that takes the handles you depend on:
 *
 *   import { use } from 'bongle';
 *   import { blocks } from 'bongle/kit';
 *
 *   // scene data references `kit:stone`, keep its declaration alive.
 *   use(blocks.stone, blocks.dirt);
 *
 * Bundlers preserve the call (can't prove it pure across module
 * boundaries), which forces the argument expressions to evaluate, which
 * keeps the referenced declarations, and therefore the registrations
 * in the bundle.
 *
 * No runtime effect.
 */
export function use(..._handles: unknown[]): void;
```

## Scenes & prefabs

Reference authored scenes and instantiate prefabs.

#### `scene`

```ts
/**
 * declare a scene resource at module scope. returns a stable handle whose
 * fields the engine populates once the scene is loaded (or arrives from the
 * server). reference identity is permanent for the lifetime of this module
 * load, closures over `handle.node` survive any number of hot reloads.
 *
 * idempotent within a single module load: a second `scene('id', ...)` call
 * returns the same handle (options on later calls are ignored, declare the
 * options on the first call).
 *
 * @example
 * ```ts
 * const PenguinScene = scene('penguin');
 * const Navmesh = scene('navmesh', { client: false });
 *
 * // read directly:
 * const blocks = PenguinScene.voxels;
 * const nodes = PenguinScene.node.children;
 *
 * // observe changes:
 * onTick(ctx, () => {
 *     if (PenguinScene.version > lastSeen) {
 *         lastSeen = PenguinScene.version;
 *         // rebuild whatever depends on it
 *     }
 * });
 * ```
 */
export function scene(id: string, options?: SceneOptions): SceneHandle;
```

#### `cloneVoxels`

```ts
/**
 * deep-copy a Voxels instance into a fresh one. the new instance owns its
 * chunk data, mutations don't affect the source. registry is shared by
 * reference; if you need a different registry, reassign `.registry` and
 * call resolveAllChunks() on the result.
 */
export function cloneVoxels(src: Voxels): Voxels;
```

#### `copyVoxels`

```ts
/**
 * copy all non-air blocks from `src` into `out`. preserves source coords,
 * blocks land at the same world positions in `out`. existing blocks in
 * `out` at those positions are overwritten; blocks at positions not
 * present in the source are left alone.
 */
export function copyVoxels(out: Voxels, src: Voxels): void;
```

Also exported: `SceneHandle`, `SceneOptions`.
#### `PrefabHandle`

```ts
/** Stable wrapper around a `PrefabDef`. Carries identity plus the live def; the
 *  data itself is read through `.def` rather than copied out (see `declare`). */
export type PrefabHandle<Args = unknown> = {
    /** the declared id (identity, never changes). */
    readonly id: string;
    /** DepGraph dependency + the brand `isHandle` tests. */
    dependency: { registry: 'prefabs'; id: string };
    /** the declared data. re-pointed on every re-declaration. */
    def: PrefabDef;
    /** phantom, carries the args type for inference. not present at runtime. */
    readonly __args: Args;
};
```

#### `prefab`

```ts
/**
 * declare a prefab def at module scope.
 */
export function prefab<T extends PrefabType, S extends Schema>(id: string, options: PrefabOptions<T, S>): PrefabHandle<SchemaType<S>>;
```

#### `PrefabType`

```ts
/**
 * what a prefab produces when instantiated.
 *   - 'voxels', voxel content only (`fn` populates the empty `ctx.voxels` canvas)
 *   - 'nodes', node children only (`fn` attaches children under `ctx.scene`)
 *   - 'composite', both voxels and nodes
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
    /**
     * producer handles whose changes trigger re-instantiation in edit mode.
     * accepts anything with a DepGraph `dependency` stamp, scene, model,
     * block, trait, command, prefab handles, etc. usually injected by the
     * AST rewriter from identifiers the body closes over; list manually
     * for procedural cases the rewriter can't see.
     */
    deps?: ReadonlyArray<DepHandle>;
    /**
     * args schema + default value. `default` is required when present,
     * it's used for caller-omitted args, inspector pre-fill, and preview rendering.
     */
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
 * create a **detached** prefab node, sets `node.prefab` with the given config
 * but does NOT attach it to the scene graph. attach explicitly with
 * `addChild(parent, node)`; instantiation happens on the next prefab tick.
 *
 * use `addChild` then read `node.children` after a tick to inspect the result.
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
/**
 * One animated property of one node, keyframes-only, sampling lives in
 * the animator (W3.3). Times are seconds, monotonically increasing.
 * Values stride is 3 for translation/scale, 4 for rotation (xyzw quats).
 */
export type ClipChannel = {
    /** Target node by name within the rig (matches a node in `ModelHandle.nodes`). */
    nodeName: string;
    /** Which transform field this channel drives. */
    property: ClipChannelProperty;
    /** glTF interpolation mode. CUBICSPLINE keys are 3× wider (in/value/out). */
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
/**
 * Parsed clip data, channels + clip duration. Stored in
 * `Resources.modelPayloads[modelId].clips[name]` once the bin loads;
 * consumed by the animator via `Resources.modelClipChannels(resources, clip)`.
 */
export type ClipChannels = {
    /** Total clip length in seconds (max keyframe time across channels). */
    duration: number;
    channels: ClipChannel[];
};
```

#### `ClipDef`

```ts
/**
 * Singleton clip ref. Per (model, clip name), exported by reference from
 * the sidecar (`wizard.animations.idle`). Pure value type, channel data
 * lives in `Resources.modelPayloads[modelId].clips[name]` and is fetched
 * lazily when the model bin loads. User code passes the ref to
 * `Animation.clip()`; the animator keys its action Map by ref identity,
 * and looks up channels each tick via
 * `Resources.modelClipChannels(resources, clip)`.
 */
export type ClipDef = {
    readonly name: string;
    readonly modelId: string;
};
```

#### `MeshId`

```ts
/**
 * Compound id for a single mesh inside a model.
 * modelId is the user-chosen string id from `model('wizard', { src })`,
 * scopes by model file. meshName scopes within the file.
 *
 * Wire format: length-prefixed modelId + length-prefixed meshName.
 */
export type MeshId = {
    readonly modelId: string;
    readonly meshName: string;
};
```

#### `ModelDef`

```ts
/** The codegen'd data for one model. Pure data: hashed for change detection and
 *  swapped wholesale when the barrel re-registers (see `declare`). */
export type ModelDef<NodeNames extends string = string, MeshNames extends string = string, ClipNames extends string = string> = {
    /** User-chosen id from `model('wizard', { src })`. Stable handle. */
    readonly modelId: string;
    /** human-readable display name for editor UIs. always set,
     *  defaults to `modelId` when the author didn't supply one. */
    readonly name: string;
    /** search words for editor UIs, normalised (see `AssetMeta`). */
    readonly tags: readonly string[];
    /** Source path (relative to project root, e.g. 'characters/wizard.glb'). Informational. */
    readonly src: string;
    /**
     * Per-side public URLs for the packed payload, codegen'd as plain
     * strings pointing at `/generated/models/<id>.<hash>.<side>.bin` (the cli writes
     * the bins under `public/generated/models/`). Engine picks the right side and
     * fetches; user code doesn't touch it. Empty strings on the empty
     * handle.
     */
    readonly bin: {
        readonly client: string;
        readonly server: string;
    };
    /**
     * Detached Node tree, codegen'd from the gltf hierarchy. Carries
     * TransformTrait values (baked from gltf node TRS) and MeshTrait with
     * meshIds wired to the right structs. Clone with cloneNode() before use;
     * treat as immutable by convention.
     */
    readonly scene: Node;
    /**
     * Bind-pose axis-aligned bounding box in root-local space, union of every
     * mesh's AABB transformed by its node's accumulated TRS chain to the scene
     * root. Static (computed at codegen). Use for spawn/framing/coarse colliders;
     * animation can push verts outside this box at runtime.
     *
     * math `Box3`: `[minX, minY, minZ, maxX, maxY, maxZ]`. Empty handle:
     * zero box at origin.
     */
    readonly aabb: Box3;
    /**
     * Flat-name index of every named gltf node (mesh-bearing or not).
     * Each value is a by-reference pointer into `scene`, clone with
     * cloneNode() to materialize, or reference by name via `model(handle, nodeName)`.
     */
    readonly nodes: { readonly [K in NodeNames]: Node };
    /**
     * Flat-name index for mesh-surgery: `meshTrait.meshId = wizard.meshes.HatA.id`.
     * Each entry also carries the mesh's bind-pose local-space AABB
     * (math `Box3`), handy for mesh-level framing or coarse colliders
     * without paying for the runtime payload fetch.
     */
    readonly meshes: { readonly [K in MeshNames]: { readonly id: MeshId; readonly aabb: Box3 } };
    /** Clip refs (singletons). Pass directly to Animation.clip(). */
    readonly animations: { readonly [K in ClipNames]: ClipDef };
    /**
     * monotonic counter bumped when this handle's payload reloads. starts
     * at 0. let prefab() callers list the handle in `deps` to re-trigger
     * preview at edit time when the model changes. mutated by the engine;
     * user code treats it as read-only.
     */
    version: number;
};
```

#### `ModelHandle`

```ts
/** Stable wrapper around a `ModelDef`; identity plus the live def. The barrel
 *  re-points `def` on every codegen pass, so a user-held handle stays current. */
export type ModelHandle<D extends ModelDef = ModelDef> = {
    /** the declared id (identity, never changes). */
    readonly id: string;
    /** DepGraph dependency + the brand `isHandle` tests. */
    dependency: { registry: 'models'; id: string };
    /** the codegen'd data. re-pointed on every re-registration. */
    def: D;

    // ── scripting-API convenience ────────────────────────────────────
    //
    // Forwarding accessors, not stored copies: the def is re-pointed whenever
    // codegen re-registers, so a copy would go stale. These exist because the
    // documented model API is field access — `wizard.nodes.Body`,
    // `wizard.meshes.Head`, `wizard.animations.idle` — and game code reads it at
    // spawn/setup. The ENGINE never comes through here: it takes a `ModelDef`
    // from `Resources.modelDef()` or `CharacterTrait.state.modelDef`, so the
    // per-frame paths are plain field loads and pay nothing for these.

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
 * Empty base interface, augmented by the codegen'd registry barrel
 * (`src/generated/models.ts`) via declaration merging to map model ids
 * to their precise handle types.
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
     * source .gltf/.glb: either a string path relative to project root, or a
     * module-relative `asset('./model.glb', import.meta.url)` ref. The `asset()`
     * form lets 3rd-party packs ship gltf alongside their modules — it resolves
     * relative to the calling module wherever it's installed, and the pipeline
     * reads the resolved path.
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
/**
 * declare a block type. called at module scope, the definition is
 * captured and frozen into a registry when the module is loaded.
 *
 * returns a handle used for getting global state ids in gameplay code.
 */
export function block<const P extends PropsDef = {

}>(id: string, options: BlockOptions<P> = {

}): BlockHandle<P>;
```

#### `model`

```ts
/**
 * Declare a model. Called at module scope.
 *
 * Returns the codegen'd `ModelHandle` (typed via `ModelHandleMap` if the
 * cli has emitted the registry barrel yet, generic `ModelHandle` otherwise).
 *
 * ```ts
 * import { model } from 'bongle';
 * const wizard = model('wizard', { src: 'characters/wizard.glb' });
 * // wizard.scene, wizard.nodes.Body, wizard.meshes.Head, wizard.animations.idle
 * ```
 */
export function model<const Id extends string>(id: Id, options: ModelOptions): Id extends keyof ModelHandleMap ? ModelHandleMap[Id] : ModelHandle;
```

#### `tile`

```ts
/**
 * declare a tile: one 16x16 entry in the voxel atlas, made of textures.
 *
 * pass a single `src` for a static tile, or an array for an animated one
 * (one entry per frame) — `src` is sugar that declares a texture per frame.
 * `frames` takes texture handles directly.
 *
 * returns a handle that can be passed to block model definitions.
 */
export function tile(id: string, options: TileOptions): TileHandle;
```

#### `AABB`

```ts
/** [minX, minY, minZ, maxX, maxY, maxZ] in block-local [0,1]³. */
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
/** [minX, minY, minZ, maxX, maxY, maxZ] in block-local [0,1]³. */
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
/**
 * rotate a block shape around the Y axis by steps × 90° CW.
 * rotation is around block center (0.5, y, 0.5).
 *
 * @param shape - input shape (not mutated)
 * @param steps - rotation steps: 0=0°, 1=90° CW, 2=180°, 3=270° CW (viewed from +Y)
 */
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
/**
 * create a single quad. quad-only authoring is the convention,
 * the mesher rejects non-quad input at registry-build time.
 *
 * @param verts - 4 vertices in CCW order, block-local [0,1] space
 * @param normal - face normal
 * @param tile - the tile this quad samples
 * @param options - optional uvs, cullFace, material
 */
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
/**
 * generate 6 quads (one per face) from an axis-aligned box.
 *
 * @param from - min corner [x, y, z] in block-local space [0, 1]
 * @param to - max corner [x, y, z] in block-local space [0, 1]
 * @param tiles - per-face tile assignment, same format as CubeTiles
 * @param options - optionally exclude faces or override cull behavior
 */
export function box(from: Vec3, to: Vec3, tiles: CubeTiles, options?: {
    exclude?: FaceDir[];
    cull?: boolean | Partial<Record<FaceDir, boolean>>;
    material?: MaterialType;
    uvs?: 'stretch' | 'local';
}): BlockQuad[];
```

#### `blockModel.rotateY`

```ts
/**
 * rotate an array of BlockQuad around the Y axis by `steps` × 90° CW.
 * positions rotate around block center (0.5, y, 0.5).
 * normals and cullFace directions rotate accordingly.
 *
 * uvs are preserved by default (texture orientation stays fixed relative to the
 * face, so it spins with the geometry). pass `uvlock: true` to instead pin the
 * top/bottom faces' texture to world axes (see lockUvsY) — this is what keeps a
 * directional top texture (e.g. wood grain on stairs) aligned across facings.
 * because uvlock derives ±Y uvs from world position, it applies even at steps=0
 * so the reference facing matches the rotated ones.
 */
export function rotateY(quads: BlockQuad[], steps: number, options?: {
    uvlock?: boolean;
}): BlockQuad[];
```

#### `blockModel.mirrorX`

```ts
/**
 * mirror an array of BlockQuad across the plane x = 0.5 (block-local).
 * involutive: mirrorX(mirrorX(q)) === q.
 */
export function mirrorX(quads: BlockQuad[]): BlockQuad[];
```

#### `blockModel.rotateAxis`

```ts
/**
 * rotate an array of BlockQuad by `angleDeg` around `axis` through `pivot`
 * (block-local space). positive angles follow the right-hand rule. cullFace
 * is cleared because tilted faces no longer align to a block boundary.
 */
export function rotateAxis(quads: BlockQuad[], axis: 'x' | 'y' | 'z', angleDeg: number, pivot: Vec3): BlockQuad[];
```

#### `blockModel.shearByHeight`

```ts
/**
 * shear an array of BlockQuad along `axis` as a linear function of height:
 * a vertex at y=`yBase` is unmoved, one at y=`yBase + ySpan` shifts by
 * `delta` along `axis`, with a proportional shift in between. unlike
 * rotateAxis (which introduces sin/cos and pulls vertices off the lattice),
 * a shear by lattice-aligned `delta`/`ySpan` keeps every input vertex on the
 * 1/16 grid, so geometry survives the voxel vertex format's 1/16 position
 * quantization with uniform thickness, instead of rounding unevenly per
 * corner. used for the wall torch's grid-aligned lean. normals are left
 * as-is: callers shear emissive geometry (face-shade bypassed) and gpucat
 * culls by winding, which the shear preserves.
 */
export function shearByHeight(quads: BlockQuad[], axis: 'x' | 'z', yBase: number, ySpan: number, delta: number): BlockQuad[];
```

#### `blockModel.translate`

```ts
/** translate an array of BlockQuad by `delta` (block-local space). */
export function translate(quads: BlockQuad[], delta: Vec3): BlockQuad[];
```

#### `blockModel.layer`

```ts
/**
 * create one up-facing quad covering the cell at height `y` (block units),
 * for ground cover that has no thickness (leaf litter, petals). same uv
 * orientation as a cube's top face, so `rotateY` keeps it in step with the
 * block below. nothing faces down: the block under it is what it lies on.
 */
export function layer(tile: TileHandle, y: number, options?: {
    material?: MaterialType;
}): BlockQuad[];
```

#### `blockModel.cross`

```ts
/**
 * create two intersecting diagonal planes (4 quads, front + back per plane).
 * used for vegetation: flowers, tall grass, saplings, mushrooms, etc.
 */
export function cross(tile: TileHandle, options?: {
    material?: MaterialType;
}): BlockQuad[];
```

#### `blockModel.hash`

```ts
/**
 * create four axis-aligned vertical planes (8 quads, front + back per plane),
 * two facing X and two facing Z, on the quarter marks. viewed from above the
 * arrangement reads as a `#`, where `cross` reads as an `x`.
 *
 * used for crops. the planes line up with the block grid across neighbouring
 * cells, so a tilled field reads as rows; `cross`'s diagonals read as one
 * isolated clump per cell instead.
 *
 * @param tile - the tile every plane samples
 */
export function hash(tile: TileHandle, options?: {
    lean?: number;
    material?: MaterialType;
}): BlockQuad[];
```

#### `blockModel.plus`

```ts
/**
 * create two axis-aligned vertical planes (4 quads, front + back per plane),
 * one facing X and one facing Z, crossing on the cell's centre line. viewed
 * from above it reads as a `+`.
 *
 * the sparse sibling of `hash`: same grid alignment, half the geometry. `cross`
 * has the same quad count but sits diagonally, so it clumps where this still
 * lines up with the cells either side.
 *
 * @param tile - the tile every plane samples
 */
export function plus(tile: TileHandle, options?: {
    material?: MaterialType;
}): BlockQuad[];
```

#### `blockModel.FLUFF_LEAN_DEG`

```ts
/** default lean, degrees. Enough that stacked blocks sit ~0.05 apart and the
 *  planes show from above; small enough that the clumps still read upright. */
export const FLUFF_LEAN_DEG;
```

#### `blockModel.fluff`

```ts
/**
 * create the four crossed, overhanging, unshaded, leaning planes (8 quads)
 * that soften a foliage cube's silhouette. meant to be concatenated onto a
 * `box`, not used alone; `leaves()` adds the y rotations.
 *
 * costs 8 quads per block with no culling, so a canopy multiplies its quad
 * count. the transparent pass is capped and truncates silently
 * (`MAX_QUADS_PER_PASS`), so measure before shipping it on every leaf type.
 *
 * @param tile - the round blob every plane samples (`textures.leavesFluff`);
 *   a square leaf tile here reads as a card, not foliage
 * @param options.lean - degrees each plane tilts about its own horizontal
 *   axis, the -22.5 pair by `+lean` and the +22.5 pair by `-lean` (default
 *   `FLUFF_LEAN_DEG`); pass the negative to mirror the splay
 */
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
/** 4-dir facing toward the placer, wall click → opposite of the clicked face
 *  (hit-normal direction); floor/ceiling click → camera yaw. ladders, stairs,
 *  doors, signs. */
export function facing4FromPlaceCtx(ctx: BlockPlaceCtx): Facing4;
```

#### `blockPlace.halfFromPlaceCtx`

```ts
/** top/bottom half for slab/stair/trapdoor/door, top face click → bottom of
 *  the cell above; bottom face → top; wall click → by where on the wall. */
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
/** rotate a cardinal 90° around Y. cw = looking down +Y. */
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
    /**
     * draw this cube at one of the four y rotations, picked from its world
     * position, so a large flat expanse does not sit on a visible 16px grid.
     * Minecraft does exactly this for grass_block, dirt, sand, podzol, mycelium
     * and all sixteen concrete powders.
     *
     * For a cube whose four sides match — every block that wants this — a y
     * rotation only turns the top and bottom faces, so it costs four UV sets and
     * no extra geometry.
     *
     * The choice is a pure function of world position, NOT random: it is stable
     * across remeshes and identical on every client. That is why this is not
     * called `randomRotation`.
     *
     * A boolean rather than a list of angles because every texture that wants
     * this is an isotropic noise field, where all four turns are equally good.
     * An anisotropic one (visible grain or strata on its top face) would want
     * half turns only, to keep the grain running one way; that widens this to
     * `true | readonly QuarterTurn[]` without breaking any caller, so it can
     * wait until something actually needs it.
     */
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
    /**
     * add four crossed, overhanging, unshaded, leaning planes so the canopy
     * does not end on a hard cube edge. costs 8 extra quads per block with no
     * culling, so it is opt-in per leaf type rather than the default. see
     * `blockModel.fluff`.
     *
     * Pass the TILE the planes sample: the round masked 32x32 leaf blob
     * (`textures.leavesFluff`). A square leaf tile here reads as a green card
     * stuck through the block rather than as foliage.
     */
    fluff?: TileHandle;
    /**
     * draw the block at one of the four y rotations, picked from its world
     * position, so a canopy is not the same shape repeated. Odd rotations also
     * mirror the planes' lean, so the four read as eight.
     */
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
    /** draw at one of four y rotations, picked per world position, so a
     *  scattering of litter is not one sprite repeated. default true. */
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
    /** one tile, or several: with a list the mesher picks one per world
     *  position, so a meadow is not one sprite stamped on a grid. */
    tiles: TileHandle | readonly TileHandle[];
    /** per-position offset, `xz` in blocks either way and `y` downward (see
     *  `BlockOptions.jitter`). vanilla's short grass uses `{ xz: 0.25, y: 0.2 }`. */
    jitter?: BlockOptions['jitter'];
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
export type LiquidPresetOptions = Pick<PresetOptions, 'name' | 'sounds' | 'material'> & {
    tiles: CubeTilesInput;
    viscosity?: number;
    translucent?: boolean;
    levels?: number;
    fluidGroup?: string;
    /** screen tint applied when the camera eye sits inside the filled band. */
    tint?: ScreenTintSpec;
    /** scales the surface for every level. 1 = full cube at max level; lower
     * (e.g. 15/16) gives a visible meniscus from above. defaults to 1. */
    maxHeight?: number;
    /** per-channel light output (0..15), set for lava-style glow. */
    lightEmission?: [number, number, number];
    /** mark the texture as self-lit so it stays bright in shadow. */
    emissive?: boolean;
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
    tiles, ...options;
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

#### `setDoorOpen`

```ts
/** set the open state of the door at (x,y,z), writes both halves (partner
 *  re-derived from `half`). no-op if the cell isn't a door or already matches.
 *  toggle = `setDoorOpen(v, x, y, z, !getDoorOpen(v, x, y, z))`. */
export function setDoorOpen(voxels: Voxels, x: number, y: number, z: number, open: boolean): void;
```

#### `BlockRegistryData`

```ts
export type BlockRegistryData = {
    /** total number of global state ids across all blocks (including air + missing). */
    totalStates: number;
    /** number of registered block types (not counting the implicit missing sentinel). */
    blockCount: number;

    /** block defs in registration order. indexed by dense block type index. */
    defs: BlockDef[];
    /** block string id → def. */
    idToDef: Map<string, BlockDef>;
    /** block handles in registration order. */
    handles: BlockHandle[];
    /** block string id → handle. */
    idToHandle: Map<string, BlockHandle>;

    /** global state id → dense block type index. */
    stateToBlockIndex: Uint16Array;
    /** global state id → local state index within that block. */
    stateToLocalIndex: Uint16Array;

    /**
     * global state id → model type (MODEL_NONE=0, MODEL_CUBE=1, MODEL_MESH=2).
     * used to branch in the mesher/raycast/physics without touching any object.
     */
    modelType: Uint8Array;

    // ── cube-only data ──────────────────────────────────────────────

    /**
     * per-state cube texture indices. 6 entries per state, stride=6.
     * face order: top(0), bottom(1), north(2), south(3), east(4), west(5).
     * indexed as stateId * 6 + faceIdx. only meaningful for MODEL_CUBE states
     * but allocated for all states (unused entries are 0).
     */
    cubeTexIndices: Uint16Array;

    /**
     * per-state cube face UVs. 48 entries per state (6 faces × 4 corners × 2
     * components), stride=48. baked from the canonical FACE_UVS pattern with
     * per-face rotation applied at build time. mesher reads these directly
     * instead of the global FACE_UVS constant, so per-face rotation costs
     * nothing in the hot loop. values are 0 or 1.
     *
     * face-order indexing matches the mesher's emit order (east, west, up,
     * down, south, north, driven by FACE_TEX_OFFSET).
     */
    cubeFaceUVs: Uint8Array;

    // ── per-position variation ──────────────────────────────────────

    /**
     * global state id → how many per-position model variants this state has.
     * 0 or 1 means none; the mesher then reads the state's own base.
     */
    variantCount: Uint8Array;
    /**
     * global state id → the first of `variantCount` CONSECUTIVE bases. a cube
     * base is a slot into cubeTexIndices/cubeFaceUVs, a mesh base is a meshId,
     * so the mesher's arithmetic (`base + (hash & mask)`) is the same either way.
     */
    variantBase: Uint32Array;
    /** global state id → max horizontal render offset, in 1/255 of a block. */
    jitterXz: Uint8Array;
    /** global state id → max downward render offset, in 1/255 of a block. */
    jitterY: Uint8Array;

    // ── mesh-only data (dense, indexed by meshId) ───────────────────

    /**
     * global state id → dense mesh index (0 = not a mesh, 1+ = valid).
     * only non-zero for MODEL_MESH states.
     */
    meshId: Uint16Array;
    /** dense quad arrays. index 0 is unused (sentinel). */
    meshQuads: BlockQuad[][];
    /** dense pre-resolved texture indices per quad. parallel to meshQuads. */
    meshTexIndices: Uint16Array[];
    /**
     * dense per-quad material (MaterialType enum). parallel to meshQuads.
     * always allocated, quads without explicit material get the block's default.
     */
    meshQuadMaterials: Uint8Array[];

    /** per-quad `shade: false` flag (1 = skip directional face shade). parallel
     *  to meshQuads; always allocated. */
    meshQuadUnshaded: Uint8Array[];

    /**
     * per-quad shape tag (SHAPE_FLAT..SHAPE_IRREGULAR) routing the mesher
     * into the matching AO/smooth-light emit path. parallel to meshQuads.
     */
    meshQuadShape: Uint8Array[];
    /**
     * per-quad primary face direction (0..5 mesher face order, or
     * FACE_DIR_NONE=0xff for IRREGULAR). populated for ALIGNED_FULL,
     * ALIGNED_PARTIAL, PARALLEL, NON_PARALLEL. parallel to meshQuads.
     */
    meshQuadFaceDir: Uint8Array[];
    /**
     * per-quad cull-face direction (0..5 mesher face order, or
     * FACE_DIR_NONE=0xff for "no cull face"). pre-resolved from the
     * `cullFace?: 'east'|'west'|'up'|'down'|'south'|'north'` BlockQuad
     * field so the mesher hot loop reads one Uint8 instead of a
     * string-keyed Record lookup per quad. parallel to meshQuads.
     */
    meshQuadCullFaceDir: Uint8Array[];
    /**
     * per-quad uniform inset depth ∈ [0,1] along the face direction.
     * 0 = on the face plane (offset face data), 1 = on the opposite face
     * plane (non-offset face data). meaningful for ALIGNED_FULL,
     * ALIGNED_PARTIAL, PARALLEL. unused for NON_PARALLEL/IRREGULAR. parallel
     * to meshQuads.
     */
    meshQuadDepth: Float32Array[];
    /**
     * per-vertex inset depth, only populated for NON_PARALLEL quads.
     * length = quads.length * 4. zero-filled for other shapes (cheap; mesh
     * models are small).
     */
    meshQuadVertDepth: Float32Array[];
    /**
     * per-vertex normal, only populated for IRREGULAR quads. length =
     * quads.length * 4 * 3. zero-filled for other shapes. when a BlockQuad
     * doesn't supply per-vertex normals we replicate the face normal.
     */
    meshQuadVertNormal: Float32Array[];

    /**
     * per-vertex (u, w) coords on the quad's chosen face plane, in [0,1].
     * length = quads.length * 8 (4 corners × 2 floats). populated for
     * ALIGNED_FULL / ALIGNED_PARTIAL / PARALLEL / NON_PARALLEL. zero for
     * FLAT and IRREGULAR (IRREGULAR uses meshQuadCornerPos).
     *
     * relight reads these to bilerp the 4 face-corner light samples without
     * re-deriving projections from BlockQuad.verts.
     */
    meshQuadCornerUV: Float32Array[];
    /**
     * IRREGULAR only: per-vertex 3D position within the block ([0,1]³).
     * length = quads.length * 12 (4 corners × 3 floats). zero-filled for
     * other shapes.
     *
     * sodium's irregular blend samples one face cache per axis. each axis
     * derives its bilerp (u, w) and depth from the same 3D position:
     * - x-axis: u = vz, w = vy, depth = nx≥0 ? 1-vx : vx
     * - y-axis: u = vx, w = vz, depth = ny≥0 ? 1-vy : vy
     * - z-axis: u = vx, w = vy, depth = nz≥0 ? 1-vz : vz
     * Storing 12 floats instead of 24 (the old per-axis-UV layout was a
     * redundant copy of the same 3 components).
     */
    meshQuadCornerPos: Float32Array[];
    /**
     * IRREGULAR only: per-vertex (n.x², n.y², n.z²) weights summing to 1.
     * length = quads.length * 12 (4 corners × 3 floats). zero-filled for
     * other shapes. pre-squaring saves a multiply per vert per relight.
     */
    meshQuadCornerNormSq: Float32Array[];

    /**
     * per-quad face normal (nx, ny, nz). length = quads.length * 3. flattens
     * `BlockQuad.normal` into a dense per-mesh table so the mesher hot loop
     * reads typed-array entries instead of indexing into the `BlockQuad`
     * object array. parallel to meshQuads. populated for all mesh quads.
     */
    meshQuadNormal: Float32Array[];

    /**
     * per-vert atlas UV (u, v). length = quads.length * 8 (4 corners × 2).
     * flattens `BlockQuad.uvs` into a dense per-mesh table; when a quad
     * leaves `uvs` undefined we bake in the default
     * `[0,1] [1,1] [1,0] [0,0]` pattern. parallel to meshQuads.
     */
    meshQuadUVs: Float32Array[];

    /**
     * per-vert block-local position (x, y, z) ∈ [0,1]³. length =
     * quads.length * 12 (4 corners × 3). flattens `BlockQuad.verts` so the
     * hot loop emits world-space quad coords from typed-array reads instead
     * of dereferencing the BlockQuad object. parallel to meshQuads.
     */
    meshQuadVerts: Float32Array[];

    // ── collider data ──────────────────────────────────────────────

    /**
     * global state id → dense collider index (0 = cube fast path, 1+ = valid).
     * same indirection pattern as meshId. 0 means unit box (COLLIDER_CUBE),
     * non-zero indexes into colliderShapes[].
     */
    colliderId: Uint16Array;

    /**
     * dense pre-built crashcat shapes. index 0 is unused (sentinel).
     * indexed by colliderId values (1-based). derived from the per-shape
     * data below at registry freeze; this is the source of truth for the
     * KCC + rigid-body narrow-phase.
     */
    colliderShapes: Shape[];

    /**
     * dense per-shape kind, indexed by colliderId. index 0 holds SHAPE_CUBE
     * as a sentinel, collider-id 0 is the cube fast path and never reads
     * shapeAabbs. consumers (e.g. VCC's analytical sweep) read this to
     * dispatch.
     */
    shapeKind: Uint8Array;

    /**
     * dense per-shape AABB list (block-local [0,1]³). populated for
     * shapeKind=SHAPE_AABBS; empty array for cube entries. indexed by
     * colliderId.
     */
    shapeAabbs: AABB[][];

    // ── per-state typed arrays (dense, indexed by stateId) ──────────

    /**
     * global state id → cull type (CullType enum, uint8).
     * NONE=0, SOLID=1, SELF=2, PARTIAL=3.
     */
    cull: Uint8Array;
    /**
     * global state id → dense block type index (Uint16).
     * all states of the same block() share the same blockTypeId.
     * used by the mesher for self-cull comparisons.
     */
    blockTypeId: Uint16Array;
    /**
     * global state id → material type (MaterialType enum, uint8).
     * OPAQUE=0, TRANSLUCENT=1. controls which render pass geometry goes to.
     */
    material: Uint8Array;
    /**
     * global state id → vertex animation type (encoded as uint8).
     * 0 = none, 1 = wave, 2 = sway.
     */
    vertexAnimation: Uint8Array;

    /**
     * global state id → packed light emission (0RGB in uint16).
     * 0 for non-emitting blocks. channels in bits 11..8, 7..4, 3..0.
     */
    lightEmission: Uint16Array;

    /**
     * global state id → light opacity (0-15 in uint8).
     * 0 = transparent to light, 15 = fully opaque.
     */
    lightOpacity: Uint8Array;

    /**
     * global state id → emissive flag (0 or 1 in uint8).
     * 1 = renders at full brightness regardless of surrounding light.
     */
    emissive: Uint8Array;

    /**
     * global state id → bitmask of block flags (BLOCK_FLAG_COLLISION, BLOCK_FLAG_SELECTION, etc.).
     * air/missing/invisible blocks have 0. use bitwise AND to test.
     */
    flags: Uint32Array;

    /**
     * global state id → friction coefficient. multiplied with per-body
     * friction (rigid body / aabb body) to produce contact friction, and
     * with the vcc character controller's `groundDragRate` for grounded
     * motion (values < 1 produce slippery surfaces like ice; values > 1
     * produce grippy surfaces like mud). defaults to 1.0 (no-op multiplier).
     */
    friction: Float32Array;

    /**
     * global state id → restitution (bounciness) coefficient. multiplied
     * with per-body restitution to produce contact restitution. defaults
     * to 0 (no bounce, multiplies any per-body restitution down to zero,
     * matching today's behaviour for non-restitutive blocks).
     */
    restitution: Float32Array;

    /**
     * global state id → liquid viscosity (0..1). only meaningful when
     * BLOCK_FLAG_LIQUID is set. drives swim drag in the character controller.
     */
    liquidViscosity: Float32Array;

    /**
     * global state id → surface height (0..1). only meaningful for
     * MODEL_LIQUID states; the mesher reads this to position the top quad
     * and clip the side quads. 1.0 for everything else (full block).
     */
    surfaceHeight: Float32Array;

    /**
     * global state id → fluid group id (uint16). 0 = not a liquid. all states
     * of a single liquid block share the same group; states from different
     * liquid blocks with the same group string also share it. used by the
     * mesher to cull faces between same-fluid neighbours when surface height
     * allows.
     */
    fluidGroup: Uint16Array;

    /**
     * global state id → screen tint (r,g,b,a) packed as 4 floats per state.
     * indexed as stateId * 4. a (opacity) === 0 means "no tint", the
     * fast path on the per-frame lookup. read by the client renderer when
     * the camera sits inside a block; never touched server-side.
     */
    screenTint: Float32Array;

    /**
     * global state id → sounds config (footstep / dig / break / place).
     * `undefined` for air, missing, and blocks without a sounds option.
     * common case: every state of a block shares the same ref (static
     * `sounds: preset` declarations); per-state authors get distinct refs.
     * read on the footstep hot path via `cc.groundBlockState`.
     */
    sounds: (BlockSoundConfig | undefined)[];

    /**
     * global state id → particles config (dust / build / break slots).
     * `undefined` for `particles: false`, air, missing, and blocks
     * without a cube model + no author-supplied slots. default dust is
     * derived once per block (from default state's model) and shared
     * across every state, see `deriveBlockDust` in blocks.ts.
     */
    particles: (BlockParticleConfig | undefined)[];

    /** global state id → string key (e.g. "oak_log[axis=y]"). air → "air", missing → "". */
    stateToKey: string[];
    /** string key → global state id. */
    keyToState: Map<string, number>;

    /** all unique texture layer entries (including animation frames). */
    textures: string[];
    /** texture id → base atlas layer index. built once at freeze time. */
    textureIndex: Map<string, number>;

    /**
     * per-layer animation metadata. 4 floats per layer, stride=4.
     * layout: [frameCount, fps, interpolate (0 or 1), _pad].
     * indexed as layerIdx * 4. for non-animated layers, frameCount=1.
     * the shader uses this to compute the actual layer to sample.
     */
    texAnimData: Float32Array;

    /**
     * per-layer alpha-cutout flag (1 = used by a TRANSPARENT face/quad). built
     * at freeze time by scanning every cube face and mesh quad. consumed by the
     * mip-pyramid builder, which gives cutout layers coverage-preserving alpha
     * so foliage/glass keeps its silhouette at distance instead of eroding.
     */
    textureCutout: Uint8Array;
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
/** a navigating agent may occupy/pass through this cell. defaults to the
 *  inverse of `collision` at registration, overridable via
 *  `block({ pathfindable })`, e.g. open doors pathable, hazards not. read by
 *  the voxel pathfinding utils (core/nav). mirrors Minecraft `isPathfindable`. */
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
/**
 * map a block key (e.g. from `getBlock`) to its block handle, ignoring
 * block-state. unknown keys resolve to the air handle. prefer `stateToBlock`
 * in hot paths to skip the key-string resolve.
 */
export function keyToBlock(registry: Blocks, key: string): BlockHandle;
```

#### `MISSING`

```ts
/** global state id for missing/unresolved blocks. always 1. */
export const MISSING;
```

#### `stateToBlock`

```ts
/**
 * map a global state id to the block handle that owns it. every state of a
 * block shares one handle, so `stateToBlock(blocks, s) === Lava` tests block
 * kind regardless of block-state. pairs with `getBlockState` and raycast hits,
 * which report the same state id. air and unresolved states resolve to the air
 * handle, so the result is never null.
 */
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
     * the stride (place-value multiplier) of a single property, the
     * amount the encoded local index changes when this prop's value
     * advances by 1. for an all-bool schema the strides are 1, 2, 4, 8…
     * (a bitmask); for mixed schemas they're a mixed-radix sequence.
     *
     * use to inline encode in a hot path without allocating a props
     * object: capture each stride at module scope and sum the
     * contributions positionally. O(1).
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
 * LogStates.encode({ axis: 'y' }); // → 1
 * LogStates.decode(1);             // → { axis: 'y' }
 * LogStates.get(2, 'axis');        // → 'z'
 * LogStates.with(0, 'axis', 'z');  // → 2
 * ```
 */
export function create<const P extends PropsDef>(props: P): BlockStateDef<P>;
```

#### `BlockHandle`

```ts
/** Stable wrapper around a `BlockDef`; identity, the live def, and the state-id
 *  helpers gameplay code calls. The `_`-prefixed slots are DERIVED, not declared
 *  data, which is why they live here rather than on the def: `blockHash` walks
 *  the def, and dust derived FROM a block feeding back into that block's own hash
 *  would make every rebuild look like a content change. */
export type BlockHandle<P extends PropsDef = PropsDef> = {
    /** the declared id (identity, never changes). */
    readonly id: string;
    /** DepGraph dependency + the brand `isHandle` tests. */
    dependency: { registry: 'blocks'; id: string };
    /** the declared data. re-pointed on every re-declaration. */
    def: BlockDef<P>;

    /** dense block type index. set by the registry builder at freeze time. */
    _index: number;
    /** first global state id. set by the registry builder at freeze time. */
    _baseStateId: number;
    /**
     * bitmask of hooks this block has (intrinsic + any observer handlers
     * registered at module scope). populated by the registry builder at
     * freeze time. drives the fast-path filter in the hook dispatcher.
     * see BlockHooks enum in block-hooks.ts.
     */
    _hooks: number;
    /**
     * per-block dust particles, derived from the default state's model by
     * `block()` itself and shared across every state as the fallback for any
     * particle slot the author left unset. `null` when the block opted out with
     * `particles: false`, declared no model, or the model names no tile.
     *
     * Derived at DECLARATION time, in the declaring module's own scope, so the
     * ordinary per-module sweep reclaims it when the block is deleted.
     */
    _defaultDust: readonly ParticleHandle[] | null;

    /** get the global state id for specific property values. */
    stateId(props: PropsValues<P>): number;

    /**
     * lift a pre-computed local state index (0..totalStates-1) into a
     * global state id by adding `_baseStateId`. lets a hot path encode
     * the local index inline (e.g. with `states.stride()`) and skip the
     * props-object allocation that `stateId()` requires.
     */
    stateIdLocal(localIdx: number): number;

    /** get the default global state id. driven by the `defaultState`
     *  option (falls back to local index 0). */
    defaultId(): number;

    /** get the stable string key for specific property values (e.g. "oak_log[axis=y]"). */
    stateKey(props: PropsValues<P>): string;

    /** get the stable string key for the default state. driven by the
     *  `defaultState` option (falls back to local index 0). */
    defaultKey(): string;
};
```

#### `BlockModel`

```ts
export type BlockModel = CubeModel | CustomModel;
```

#### `BlockOptions`

```ts
export type BlockOptions<P extends PropsDef = PropsDef> = AssetMeta & {
    /** block state schema. omit for stateless blocks. */
    states?: BlockStateDef<P>;

    /**
     * authoritative default state, drives `defaultId()`/`defaultKey()`, the
     * inventory icon, and any caller that places this block without specifying
     * props. when omitted, the default is the first encoded state (local index
     * 0), which can look broken for neighbour-driven shapes (standalone
     * fence/pane post renders invisible) or for level-encoded blocks (water at
     * level=1 is a sliver). neighbour-aware blocks correct themselves via
     * `onNeighbourUpdate` after placement regardless of the default.
     */
    defaultState?: PropsValues<P>;

    /**
     * model function. receives decoded props, returns geometry description.
     * called once per state at freeze time, cached for zero-cost meshing.
     *
     * omit for invisible blocks (air).
     */
    /**
     * the block's geometry for a given state.
     *
     * returning an ARRAY declares per-position variants: the mesher picks one
     * by hashing the block's world position, so the same block does not look
     * identical everywhere. the array IS the variant set, so the count is
     * derived and cannot drift out of step with what the entries actually are.
     *
     * every entry must share a `type` (a list mixing 'cube' and 'custom' has no
     * single mesher path) and the list must be non-empty. a one-entry array
     * behaves exactly like returning that entry directly.
     *
     * ```ts
     * model: () => [0, 1, 2, 3].map((r) => ({ type: 'custom', quads: rotateY(base, r) }))
     * ```
     */
    model?: (props: PropsValues<P>) => BlockModel | BlockModel[];

    /**
     * cull type, controls face culling between adjacent blocks.
     * defaults to CullType.SOLID. can be a static value or a function
     * of props for per-state cull behavior (called once per state at
     * freeze time).
     */
    cull?: CullType | ((props: PropsValues<P>) => CullType);

    /**
     * material type, controls which render pass geometry goes to.
     * defaults to MaterialType.OPAQUE. can be a static value or a
     * function of props for per-state material (called once per state
     * at freeze time). for per-tri material on custom models, set
     * material on individual BlockQuad instead.
     */
    material?: MaterialType | ((props: PropsValues<P>) => MaterialType);

    /**
     * vertex animation type. the shader applies displacement based on
     * this. can be a static value or a function of props.
     * @default VertexAnimation.NONE
     */
    vertexAnimation?: VertexAnimation | ((props: PropsValues<P>) => VertexAnimation);

    /**
     * offset this block's geometry by a small amount derived from its world
     * position, so a field of them does not sit on a visible grid. rendering
     * only; collision and occupancy stay on the cell.
     *
     * `xz` is the max horizontal offset in blocks, `y` the max downward one
     * (plants sink, never float). the hash deliberately ignores world Y, so a
     * vertical stack of the same block shares one offset and a two-block plant
     * cannot tear apart.
     */
    jitter?: { xz?: number; y?: number };

    /**
     * rgb light emission, each channel 0-15. blocks with this set act
     * as light sources for flood fill lighting. can be state-dependent
     * (e.g. torch on/off). omit for non-emitters.
     */
    lightEmission?: [number, number, number] | ((props: PropsValues<P>) => [number, number, number]);

    /**
     * light opacity: how much light is absorbed per step through this
     * block (0-15). 0 = fully transparent to light (air, glass).
     * 15 = fully opaque (stone). can be state-dependent.
     * default is based on cull type:
     *   SOLID=15, SELF=1, PARTIAL=0, NONE=0.
     */
    lightOpacity?: number | ((props: PropsValues<P>) => number);

    /**
     * emissive: renders at full brightness regardless of surrounding
     * light. useful for lamp blocks whose surfaces should glow.
     * can be state-dependent.
     * @default false
     */
    emissive?: boolean | ((props: PropsValues<P>) => boolean);

    /**
     * collision: does this block participate in physics collision?
     * when false, dynamic bodies (players, projectiles) pass through.
     * can be state-dependent.
     * @default true
     */
    collision?: boolean | ((props: PropsValues<P>) => boolean);

    /**
     * selection: can this block be targeted by raycasts for interaction?
     * (mining, placing, editor picking). when false, selection rays
     * pass through. can be state-dependent.
     * @default true
     */
    selection?: boolean | ((props: PropsValues<P>) => boolean);

    /**
     * physics/selection shape for this block.
     *
     * omit → unit box collider (the default for all blocks, fast path).
     * BlockShape → use this shape for collision and selection.
     *
     * the shape is in block-local [0,1] space. at runtime, translated to
     * the voxel's world position. use blockShape.rotateY() for rotation
     * data at define time.
     *
     * can be state-dependent: (props) => BlockShape
     */
    shape?: BlockShape | ((props: PropsValues<P>) => BlockShape);

    /**
     * climbable: when true, the character controller treats this block as a
     * ladder, gravity is bypassed inside it, jump ascends, crouch descends.
     * climbable blocks usually want `collision: false` so the character can
     * actually enter them. defaults to false.
     * @default false
     */
    climbable?: boolean | ((props: PropsValues<P>) => boolean);

    /**
     * liquid: when set, the character swims while submerged in this block,
     * gravity is replaced by a small downward sink, drag scales with
     * `viscosity` (0..1), and jump/crouch swim up/down. liquids should usually
     * have `collision: false`.
     * @default undefined (not a liquid)
     */
    liquid?: { viscosity: number } | null | ((props: PropsValues<P>) => { viscosity: number } | null);

    /**
     * pathfindable: may a navigating agent (see core/nav voxel pathfinding)
     * occupy/pass through this cell? defaults to the inverse of `collision`, so
     * normal blocks need no annotation. override to mark colliding-but-passable
     * cells (open doors) or passable-but-avoided cells (hazards). can be
     * state-dependent.
     * @default !collision
     */
    pathfindable?: boolean | ((props: PropsValues<P>) => boolean);

    /**
     * friction coefficient. multiplied with the body's per-rigid-body /
     * per-aabb-body friction to produce the effective contact friction
     * (and with the vcc character controller's `groundDragRate` when the
     * character stands on this block). 0 = perfect ice regardless of
     * body; ~0.1 = slippery; ~2.0 = sticky.
     * @default 1.0
     */
    friction?: number | ((props: PropsValues<P>) => number);

    /**
     * restitution (bounciness) coefficient. multiplied with the body's
     * per-rigid-body / per-aabb-body restitution to produce the effective
     * contact restitution. 0 = no bounce regardless of body; 1 = elastic.
     * @default 0
     */
    restitution?: number | ((props: PropsValues<P>) => number);

    /**
     * sneak-guard: when crouched, the character anchors to this block and
     * cannot walk off its edges. defaults to true for any collidable block.
     * set false for blocks the player should be able to slide off even while
     * crouched (ice, conveyor belts).
     * defaults to true for collidable blocks, false otherwise
     */
    sneakGuard?: boolean | ((props: PropsValues<P>) => boolean);

    /**
     * extra bits OR'd into the block's flags bitmask. used to mark
     * connection groups (BLOCK_FLAG_FENCE, BLOCK_FLAG_WALL, BLOCK_FLAG_PANE)
     * so neighbour-aware blocks can check membership without string compares.
     */
    flags?: number;

    /**
     * surface height (0..1), opts this block into MODEL_LIQUID. the mesher
     * emits a cube with the top quad lowered to this height and the side
     * quads height-clipped. omit for normal full-cube blocks. can be
     * state-dependent so a single block can register multiple heights.
     */
    surfaceHeight?: number | ((props: PropsValues<P>) => number);

    /**
     * fluid group id (e.g. 'water'). all states sharing a group string cull
     * faces between each other when surface heights line up. used only by
     * MODEL_LIQUID blocks; future flow/sim work keys off the same identity.
     */
    fluidGroup?: string;

    /**
     * screen tint applied as a fullscreen overlay when the camera sits
     * inside this block. color is linear RGB (0..1), opacity is 0..1.
     * for MODEL_LIQUID blocks the tint only applies while the camera Y is
     * below the cell's surfaceHeight band. omit (or return undefined from
     * the function form) for no tint.
     */
    screenTint?: ScreenTintSpec | ((props: PropsValues<P>) => ScreenTintSpec | undefined);

    /**
     * sounds played for footstep / dig / break / place events on this
     * block. compose via `blockSoundPresets.*` bundles or build fully
     * custom. omit to leave the block silent across all four slots.
     *
     * static config applies to every state of the block. for blocks
     * whose sounds vary per state (e.g. waterlogged → water footsteps,
     * lit/unlit redstone → different break clip), pass a function of
     * decoded props instead, called once per state at registry freeze
     * time, baked into a per-state lookup table for hot-path reads.
     */
    sounds?: BlockSoundConfig | ((props: PropsValues<P>) => BlockSoundConfig);

    /**
     * pure neighbour-driven state recompute. called after any neighbour of
     * a block of this type changes (and once when the block itself is placed).
     * read neighbours via ctx.voxels; return a new global state id, or the
     * same id for "no change". the engine fast-paths the unchanged case.
     *
     * runs in both editor and server runtime, must be pure (no world
     * mutation beyond returning a new stateId).
     */
    onNeighbourUpdate?: OnNeighbourUpdateFn;

    /**
     * imperative side-effect hook fired after any neighbour changes. drop
     * items, schedule ticks, ignite, etc. server-only, never runs in editor.
     */
    onNeighbourChanged?: OnNeighbourChangedFn;

    /**
     * pick the placed stateId from hit context (camera + face + click point).
     * called once when the build tool places a block of this type. when
     * undefined, the engine falls back to the prop-name convention
     * (`axis` / `facing` enum props auto-mutated from hit normal + yaw).
     */
    place?: PlaceFn;

    /**
     * rotate a stateId 90° around `axis` (cw = looking down the +axis).
     * called per-voxel by blueprint rotate and voxel-rotate. when undefined,
     * the engine falls back to the prop-name convention (`axis` / `facing`
     * remap tables).
     */
    rotate?: RotateFn;

    /**
     * mirror a stateId across the plane perpendicular to `axis`. called
     * per-voxel by blueprint flip. when undefined, the engine falls back
     * to the prop-name convention.
     */
    flip?: FlipFn;

    /**
     * named particle slots for this block. when omitted (or any slot
     * within is omitted), missing slots default to 3 auto-derived
     * `<id>:particle{0,1,2}` dust variants baked from the top-face
     * texture of the default state (cube models only; cost is 3 sprite
     * + 3 particle registrations per block at module-scope eval, free
     * at runtime).
     *
     * static config applies to every state. pass a function of decoded
     * props for per-state slots, called once per state at registry
     * freeze, baked into a per-state lookup. authors who want per-state
     * particles should hoist `particle()` declarations to module scope
     * (free dedup by id) and just reference them per state.
     *
     * default dust is derived **once from the default state's model**
     * and shared across every state, this is the dedup escape hatch
     * for blocks with many states (the registry never multiplies the
     * auto-dust set by state count).
     *
     * pass `false` to opt out entirely for all states, no dust
     * derivation, no slot defaults. invisible blocks (no model) never
     * derive regardless.
     *
     * defaulting all three slots to the same dust handles today is a
     * placeholder; when block-place + block-break systems land, `build`
     * and `break` will re-default to dedicated presets whose particles
     * have different physics (e.g. `build` won't collide; `break` will
     * be larger debris).
     */
    particles?: BlockParticleConfig | ((props: PropsValues<P>) => BlockParticleConfig) | false;
};
```

#### `BlockQuad`

```ts
/**
 * a single quad in a custom block model.
 *
 * coordinates are in block-local space [0, 1]. the mesher offsets
 * them by the block's world position.
 *
 * use bm.quad() for raw quads, bm.box() for axis-aligned boxes
 * (6 quads), bm.cross() for vegetation cross-quads (4 quads).
 */
export type BlockQuad = {
    /** 4 vertices in CCW order as [x, y, z] in block-local space [0,1]. */
    verts: [Vec3, Vec3, Vec3, Vec3];

    /** face normal as [nx, ny, nz]. */
    normal: Vec3;

    /** the tile this quad samples. */
    tile: TileHandle;

    /** uv coordinates for each vertex. defaults to full-texture [[0,1],[1,1],[1,0],[0,0]]. */
    uvs?: [Vec2, Vec2, Vec2, Vec2];

    /**
     * cull face direction. if the neighbor in this direction is a full
     * opaque cube, this quad is hidden. undefined = never culled.
     *
     * only applies to quads flush with the block boundary.
     * e.g. a slab's bottom face has cullFace: 'down', but its
     * top face (at y=0.5) has no cullFace because it's never
     * occluded by a neighbor.
     */
    cullFace?: 'north' | 'south' | 'east' | 'west' | 'up' | 'down';

    /**
     * `false` draws the quad without the per-face directional shade (top 1.0,
     * sides 0.6 / 0.8, bottom 0.5); AO still applies. Minecraft's element
     * `shade: false`. Foliage planes use it so a clump reads as one soft mass
     * rather than as lit cards. Default true.
     */
    shade?: boolean;

    /**
     * render pass for this quad. defaults to the block's material.
     * set explicitly for mixed-material custom models (e.g. cauldron
     * with opaque shell + translucent water quad).
     */
    material?: MaterialType;

    /**
     * receives smooth-light + AO sampling. defaults to true. set false
     * for quads that should stay flat-lit (emissive sub-quads like a
     * torch flame, or flat per-cell light for cheap fallback).
     */
    ao?: boolean;
};
```

#### `BlockSoundConfig`

```ts
/**
 * Block-level sound config, one handle array per category. Multiple
 * handles per slot let the driving system round-robin or random-cycle
 * across clips for variation; an empty array silences the category.
 *
 * Compose preset bundles from `blockSoundPresets.*` in
 * `bongle/kit` or build a fully custom config. All slots
 * optional; omit a category to leave it silent.
 *
 * NOTE: the systems that actually drive playback off these handles
 * (character-controller footstep tick, voxel break/place hooks) are
 * not yet wired, for now this is stored on the def for future use.
 */
export type BlockSoundConfig = {
    /** played while the character walks on top of this block, and, for
     *  liquid blocks, on the feet-enter edge (entry splash) and once
     *  per swim stroke while submerged. one slot covers all three; the
     *  controller swaps which block is sampled and the character trait
     *  varies volume between cadence and entry. */
    footstep?: readonly SoundHandle[];
    /** looped while the block is being mined (before the final break). */
    dig?: readonly SoundHandle[];
    /** one-shot on the final break (mining completes / block is destroyed). */
    break?: readonly SoundHandle[];
    /** one-shot when a block of this type is placed by a player. */
    place?: readonly SoundHandle[];
};
```

#### `CubeFaceRotation`

```ts
/** UV rotation for a cube face, 0/90/180/270 ccw. default 0. */
export type CubeFaceRotation = 0 | 90 | 180 | 270;
```

#### `CubeFaceSpec`

```ts
/**
 * per-face slot for a cube model. A bare handle is the common case; the object
 * form exists only to carry a rotation.
 */
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
/** custom model, quad list for arbitrary block shapes. */
export type CustomModel = {
    type: 'custom';
    /** list of quads. the mesher emits these directly.
     *  quad-only authoring (Minecraft + Sodium convention); the
     *  registry build rejects non-quad input. */
    quads: BlockQuad[];
};
```

#### `TileDef`

```ts
/** The declared data for one tile. Pure: hashed wholesale, swapped
 *  wholesale on re-declaration (see `declare`). */
export type TileDef = {
    /** tile string id (e.g. 'lava') */
    id: string;

    /** the textures this tile's frames sample, in order. one entry for a
     *  static tile, N for a flipbook. every frame is a multiple of 16 per side
     *  (see `BLOCK_TILE_SIZE`), and every frame of one tile is the same size. */
    frames: DepKey[];

    /** animation speed in frames per second. */
    fps: number;

    /** interpolate between frames. */
    interpolate: boolean;
};
```

#### `TileHandle`

```ts
/**
 * Stable wrapper around a `TileDef`; identity plus the live def.
 *
 * A tile is referenced by its HANDLE, never by id string. The handle carries
 * its own def, so resolving a reference needs no registry lookup and cannot
 * depend on declaration order — which is what lets a block derive its dust at
 * declaration time rather than deferring to the registry build. A string id
 * would reintroduce both: the lookup could miss simply because the tile was
 * declared later in the file.
 */
export type TileHandle = {
    /** the declared id (identity, never changes). */
    readonly id: string;
    /** DepGraph dependency + the brand `isHandle` tests. */
    dependency: { registry: 'tiles'; id: string };
    /** the declared data. re-pointed on every re-declaration. */
    def: TileDef;
};
```

#### `TileOptions`

```ts
export type TileOptions = {
    /**
     * source image(s). single entry for static, array for animated. each
     * entry may be a string path (project-root-relative) or a module-relative
     * `asset('./texture.png', import.meta.url)` ref.
     *
     * the `asset()` form lets 3rd-party packs ship textures alongside their
     * modules — it resolves relative to the calling module wherever it's
     * installed, and the pipeline reads the resolved path.
     */
    src?: ImageSource | ImageSource[];

    /** the textures this tile's frames come from. The direct form; `src`
     *  is sugar that declares textures for you. */
    frames?: TextureHandle[];

    /** animation speed in frames per second. default 1. ignored if single frame. */
    fps?: number;

    /** interpolate between frames (smooth water). default false. */
    interpolate?: boolean;
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
/**
 * The texture backing one of a tile's frames, resolved through the texture store.
 * `null` when the tile has no such frame.
 *
 * A tile stores frame REFERENCES, so reaching the texture is a lookup rather than a
 * field read. This is the supported way to draw from an existing tile — pass the
 * result as a `texture()` input.
 */
export function tileFrame(tile: TileHandle, index = 0): TextureHandle | null;
```

#### `propagateAllLight`

```ts
export function propagateAllLight(voxels: Voxels): void;
```

#### `relightChunks`

```ts
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
 * cast a ray through the voxel world using DDA.
 *
 * skips empty/missing chunks via nonAirCount. for cube blocks
 * (colliderId=0), the DDA step itself is the intersection test. for
 * custom collider shapes, tests against the prebuilt crashcat shape.
 *
 * @param out - result object (reused across calls, no allocation)
 * @param voxels - the voxel world
 * @param registry - block registry
 * @param ox, oy, oz - ray origin in world space
 * @param dx, dy, dz - normalized ray direction
 * @param maxDistance - maximum trace distance
 * @param requiredFlags - bitmask of block flags required for a hit. blocks missing any of these flags are skipped. 0 = no filtering.
 */
export function raycastVoxels(out: VoxelRaycastResult, voxels: Voxels, registry: Blocks, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDistance: number, requiredFlags: number): VoxelRaycastResult;
```

#### `Chunk`

```ts
/** chunk data structure */
export type Chunk = {
    /* chunk coordinates */
    cx: number;
    cy: number;
    cz: number;

    /* world coordinates of chunk corner (cx*16, cy*16, cz*16), cached for meshing. */
    wx: number;
    wy: number;
    wz: number;

    /** number of non-air blocks in the chunk */
    nonAirCount: number;

    /** number of fully-occluding (CullType.SOLID) blocks in the chunk.
     *  always ≤ nonAirCount. solidCount === CHUNK_VOLUME means the chunk is
     *  entirely opaque; a chunk whose 6 neighbors are also fully opaque
     *  has no visible surface and can skip remeshing (intended consumer:
     *  the enqueue path in render/voxels/voxel-visuals.ts). */
    solidCount: number;

    /**
     * stable string keys per palette slot.
     * paletteKeys[0] is always "air".
     *
     * these are the persistence/network identity. survives registry
     * rebuilds, block additions/removals.
     *
     * INVARIANT: append-only across a session. compaction happens only
     * when materialising save bytes via `saveVoxels`, which produces a
     * snapshot without mutating the live chunk. discovery ships this
     * array by reference in voxel_chunk_ops; clients cache the indices
     * and assume they stay stable. shrinking/reordering mid-session
     * silently re-aliases every already-set voxel → wrong-block-type
     * drift on the next remesh.
     */
    paletteKeys: string[];

    /**
     * runtime numeric ids per palette slot (resolved from registry).
     * palette[0] is always AIR (0).
     * unresolved keys get MISSING (1).
     *
     * rebuilt from paletteKeys on registry change (hot reload).
     */
    palette: number[];

    /**
     * reverse lookup: string key → local palette index.
     * kept in sync with paletteKeys. used by setBlock to find or
     * allocate a palette slot for a given string key.
     */
    paletteMap: Map<string, number>;

    /**
     * packed voxel data. each entry is a local palette index (not a
     * global state id). length = CHUNK_VOLUME (4096).
     *
     * Uint16Array supports up to 65535 palette entries per chunk,
     * which is more than enough (MC caps at ~4096 distinct states
     * per section in practice).
     */
    data: Uint16Array;

    /**
     * per-voxel light data. length = CHUNK_VOLUME (4096).
     * each entry packs 4 channels into 16 bits:
     *   bits 15..12 = sky   (0-15)
     *   bits 11..8  = red   (0-15)
     *   bits  7..4  = green (0-15)
     *   bits  3..0  = blue  (0-15)
     *
     * written by the light propagation engine, read by the mesher.
     * initialized to 0 (full dark).
     */
    light: Uint16Array;

    /** dirty flag, set when data changes, cleared by mesher. */
    dirty: boolean;

    /** monotonically increasing version of this chunk's mesh-relevant
     *  state. bumped by every primitive mutation that would change the
     *  mesh output: block edits (setChunkBlock), light edits (setLight),
     *  boundary-neighbour edits (via markBoundaryNeighborsDirty),
     *  registry rebuilds (resolveChunk), and full-light recomputes
     *  (propagateAllLight). the worker dispatcher echoes the gen on a
     *  result; voxel-visuals compares against the live `meshGen` to
     *  decide whether the result is fresh or stale.
     *
     *  starts at 1 so that "gen 0" can sentinel "never meshed".
     *  cloneChunk carries `src.meshGen + 1` so clones force a remesh on
     *  first observation. */
    meshGen: number;

    /** monotonically increasing version of this chunk's PERSISTED data,
     *  blocks, light, and palette. bumped by every mutation that changes the
     *  bytes `saveVoxels` would write (setChunkBlock, setLight, resolveChunk,
     *  propagateAllLight) but NOT by mesh-only changes (boundary-neighbour
     *  re-mesh). incremental scene save keys its per-chunk serialized-byte
     *  cache on this: a chunk re-serializes only when its `version` moves.
     *  starts at 1; cloneChunk carries `src.version` (clone has identical data). */
    version: number;

    /** light dirty flag, set when light[] changes, cleared after network flush. */
    lightDirty: boolean;

    /**
     * per-voxel dirty mask for incremental light deltas. byte-per-voxel,
     * length = CHUNK_VOLUME. set to 1 by setLight when light[i] is written;
     * cleared (released back to EMPTY_LIGHT_MASK) at end-of-tick after
     * dispatch. only meaningful on the server (the client never calls
     * setLight). idle chunks alias the shared EMPTY_LIGHT_MASK singleton,
     * setLight COWs on first write and end-of-tick releases when count
     * drops to zero so memory stays proportional to dirty-chunk count.
     */
    lightDirtyMask: Uint8Array;

    /** number of set bytes in lightDirtyMask, cheap threshold check for
     *  the dispatchLight delta-vs-whole-chunk branch without scanning the mask. */
    lightDirtyCount: number;

    /** cached compressed snapshot for chunk_full encoding. invalidated on any data/light change. */
    compressedSnapshot: Uint8Array | null;

    /** cached per-slot global state ids at the time of snapshot (the wire
     *  palette for voxel_chunk_full). invalidated alongside compressedSnapshot. */
    snapshotPalette: number[] | null;

    /** cached compressed light streams for chunk_light encoding (sky+rgb split,
     *  each RLE'd then deflated). invalidated when light changes. */
    compressedLight: { sky: Uint8Array; rgb: Uint8Array } | null;

    /**
     * neighbor chunk refs for fast cross-chunk traversal, 26 slots (the full
     * 3×3×3 apron the mesher reads for AO + smooth light).
     *   slots 0-5  = the 6 faces, in light.ts's direction convention
     *                (0=+X, 1=+Y, 2=+Z, 3=-Z, 4=-Y, 5=-X; opposites sum to 5).
     *                light propagation touches only these.
     *   slots 6-25 = the 12 edges + 8 corners (see NEIGHBOR_D{X,Y,Z}).
     * null if that neighbor chunk is not loaded.
     */
    neighbors: (Chunk | null)[];
    /**
     * count of non-null entries in `neighbors` (0-26). Maintained by
     * link/unlinkChunkNeighbors. The streaming client defers meshing a chunk
     * until this hits 26 (full apron present) so it meshes once with correct
     * boundary AO/light instead of re-meshing as each neighbor arrives.
     */
    knownNeighbourCount: number;
    /** frame the light volume first wanted to re-bake this chunk while its 26
     *  neighbourhood was still incomplete, or -1. */
    lightWaitSince: number;
    /** the AOI wants this chunk rendered, so it may hold a light tile. ADMISSION
     *  is the AOI's decision alone: everything else that marks the light volume
     *  may only REFRESH a tile that already exists. Without that, the light pool
     *  and the mesh arena are two residency systems with different working sets,
     *  and they thrash - the pool evicts by distance while the AOI re-requests. */
    lightWanted: boolean;
    /** this chunk's OWN light changed, as opposed to being apron-dirtied because
     *  a neighbour did. Urgent rebakes are never deferred: a deferred edit is a
     *  visible delay on the block the player just broke, while a deferred
     *  neighbour rebake only postpones a boundary plane. */
    lightUrgent: boolean;
};
```

#### `Voxels`

```ts
export type Voxels = {
    chunks: Map<string, Chunk>;
    /** dirty index, sidecar to chunk.dirty / chunk.lightDirty flags.
     *
     *  `blocks` is the renderer tier, populated by `markChunkDirty` and
     *  (post Stage 2b) also by `markChunkLightDirty` since meshChunk emits
     *  geometry+light in one pass. consumed by voxel-visuals.update().
     *
     *  `light` is the server network tier, populated by
     *  `markChunkLightDirty` only. consumed by discovery's per-client
     *  chunk_light streaming. kept separate from `blocks` so the server
     *  doesn't have to filter a growing `blocks` set every tick to find
     *  light-only changes.
     *
     *  `removed` is chunk keys the server dropped from `chunks`; the client
     *  renderer's `voxel-visuals.update` drains it to evict those meshes from
     *  the arena. Data-driven so the client stays room-agnostic — only the
     *  active room's arena is maintained; non-active rooms rebuild fresh on
     *  activation (which clears this set). */
    dirty: {
        blocks: Set<Chunk>;
        light: Set<Chunk>;
        lightVolume: Set<Chunk>;
        lightVolumeUrgent: Set<Chunk>;
        removed: Set<string>;
    };
    /** xz-column index, chunks at the same (cx, cz) sorted by cy descending.
     *  maintained by `ensureChunk` and rebuilt by `loadVoxels`. lets
     *  sky-light / heightmap / surface code walk only chunks that actually
     *  exist, instead of scanning a world bbox. */
    columns: Map<string, Chunk[]>;
    /** region occupancy index: which chunks exist within each AOI region. bare
     *  membership, not sorted like `columns` — nothing needs region-internal
     *  order, only "is this region non-empty" (discovery's classification,
     *  `.size > 0`) and "what's actually in it" (send-time bundling, iterate
     *  directly — cheaper than probing all REGION_CHUNKS_PER_AXIS³ positions
     *  through `chunks`, especially for a sparse region). maintained by
     *  `ensureChunk`/`removeChunk`; an emptied region's entry is deleted so
     *  churn doesn't leave stale Sets behind. */
    regions: Map<string, Set<Chunk>>;
    /** block registry, flat lookup tables for block type/state info.
     *  stored here so setBlock/resolveAllChunks don't need a trailing registry arg.
     *  on hot reload, registry-dispatch reassigns this field directly and
     *  calls resolveAllChunks() per room. */
    registry: Blocks;
    /** authoritative-emission bundle. null on read-only mirrors. see
     *  `VoxelsAuthority` doc. */
    authority: VoxelsAuthority | null;
    /** light scheduling + config. non-null on every Voxels, mirrors included.
     *  see `VoxelsLighting` doc. */
    lighting: VoxelsLighting;
};
```

#### `VoxelsAuthority`

```ts
/**
 * authoritative-emission bundle. populated when this Voxels owns the
 * truth: writes record ops, fire block-hook observers, and drive
 * flood-fill light propagation. null on a read-only mirror (today's
 * clients). a future client-side authoritative room allocates one of
 * these just like the server does, no type split, no env probe.
 */
export type VoxelsAuthority = {
    /** per-tick change log for block ops, light updates, and new chunks. */
    changes: VoxelChanges;
    /**
     * per-room observer registry for onBuild / onBreak / onStateChange
     * handlers registered via script-scope APIs. lazy-init on first
     * registration. null until any handler is registered. keyed by
     * block-type index. see block-hooks.ts for the entry shape.
     */
    observers: Map<number, BlockObserverEntry> | null;
    /** current block-hook recursion depth. a hook that issues a chained setBlock
     *  recurses through runBlockHooks; this bounds a runaway cascade. */
    hookDepth: number;
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
/** region = the AOI/streaming unit, a cube of REGION_CHUNKS_PER_AXIS³ chunks.
 *  decoupled from CHUNK_SIZE on purpose: storage/mesh/light stay chunk-sized
 *  (good locality for those), while discovery/eviction/entity-presence walk
 *  regions instead, so their per-tick cost scales with a much smaller sphere.
 *  v1: 4 chunks/axis = 64 blocks/axis. tune by changing this one constant. */
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
/** chunk slots in one region cube (REGION_CHUNKS_PER_AXIS³). shared by client
 *  and server: it's the length of a voxel_region_full message's `occupied`
 *  presence tuple, so both sides must agree on it exactly. */
export const REGION_VOLUME;
```

#### `REGION_LOCAL_CHUNK_OFFSETS`

```ts
/** every local (dx,dy,dz) chunk offset inside one region cube, relative to the
 *  region's minimum corner, in a fixed raster order. shared by client and
 *  server: a voxel_region_full message's `occupied`/`chunks` positions are
 *  implicit indices into this same order, so both sides must walk it
 *  identically to agree on which slot is which chunk. */
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
/** chunk xz-column key, used by voxels.columns to group chunks that share an
 *  (cx, cz) so callers (sky-light, heightmaps, surface queries) can walk a
 *  column top-down without scanning the world bbox. */
export function chunkColumnKey(cx: number, cz: number): string;
```

#### `regionKey`

```ts
/** region coordinate key, used by voxels.regions (AOI occupancy index) and by
 *  discovery/entity-presence's region-keyed knowledge sets. same string
 *  convention as chunkKey, one level coarser. */
export function regionKey(rx: number, ry: number, rz: number): string;
```

#### `toChunkCoord`

```ts
/** block coordinate → chunk coordinate. caller floors first: this truncates
 *  toward zero, so a raw negative float lands one chunk too high. */
export function toChunkCoord(worldCoord: number): number;
```

#### `chunkToRegionCoord`

```ts
/** chunk coordinate → region coordinate (floored division by REGION_CHUNKS_PER_AXIS). */
export function chunkToRegionCoord(chunkCoord: number): number;
```

#### `toRegionCoord`

```ts
/** world position → region coordinate directly, without the intermediate
 *  chunk coordinate. caller floors first, same convention as toChunkCoord. */
export function toRegionCoord(worldCoord: number): number;
```

#### `toLocalCoord`

```ts
/** world position → local coordinate within chunk. */
export function toLocalCoord(worldCoord: number): number;
```

#### `worldToBlockCoord`

```ts
/** world position (any axis) → block index on that axis. block N occupies
 *  world `[N, N+1)`, so this is a floor. */
export function worldToBlockCoord(worldCoord: number): number;
```

#### `blockTopCenter`

```ts
/** world-space point at the center of a block's top face, i.e. where
 *  feet land if standing on top of block `block`. block N occupies
 *  `[N, N+1)`, so the top-center is `(block[0] + 0.5, block[1] + 1, block[2] + 0.5)`. */
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
/**
 * shared all-AIR data + light arrays used by empty-chunk stubs on the client.
 * any writer that touches `chunk.data` or `chunk.light` MUST first compare
 * identity against these and clone (copy-on-write) before mutating, these
 * arrays are aliased by every empty stub in the world.
 *
 * EMPTY_LIGHT is pre-filled with sky=15 (packed = 0xF000): an empty chunk
 * has no blocks to block sky light, so every voxel sees full sky. without
 * this, entities (model/voxel-mesh visuals) that sample voxel light at a
 * world position inside a networked-empty chunk would read sky=0 and
 * render pitch black.
 */
export const EMPTY_DATA;
```

#### `EMPTY_LIGHT`

```ts
export const EMPTY_LIGHT;
```

#### `EMPTY_LIGHT_MASK`

```ts
/**
 * shared all-zero lightDirtyMask alias for chunks with no in-flight delta
 * changes. setLight (light.ts) compares identity and COWs on first write
 * so idle chunks cost only a reference. client-side chunks (no setLight
 * calls) keep this alias forever, so the per-voxel mask never materialises
 * client-side.
 */
export const EMPTY_LIGHT_MASK;
```

#### `createEmptyChunk`

```ts
/**
 * create a Chunk stub representing a chunk the server has confirmed is
 * empty (all air). `data` and `light` alias module-level singletons so the
 * stub costs ~a Chunk struct + a 1-entry palette. mesher/light skip it via
 * the existing `nonAirCount === 0` check; getBlock returns AIR for palette
 * index 0; neighbor links work like any other chunk.
 */
export function createEmptyChunk(cx: number, cy: number, cz: number): Chunk;
```

#### `NEIGHBOR_COUNT`

```ts
/** number of neighbour slots on `Chunk.neighbors` (full 3×3×3 minus self). */
export const NEIGHBOR_COUNT;
```

#### `neighbourSlot`

```ts
/** slot index in `neighbors[]` for the neighbour at chunk-offset (dx,dy,dz),
 *  each in [-1,1]. -1 for (0,0,0) / out of range. lets the mesher follow
 *  neighbour pointers instead of rebuilding chunk keys. */
export function neighbourSlot(dx: number, dy: number, dz: number): number;
```

#### `linkChunkNeighbors`

```ts
/** wire up bidirectional neighbor refs for a chunk that was just added to
 *  voxels.chunks, and bump the `knownNeighbourCount` on both sides. */
export function linkChunkNeighbors(voxels: Voxels, chunk: Chunk): void;
```

#### `unlinkChunkNeighbors`

```ts
/** null out neighbor refs when a chunk is about to be removed from
 *  voxels.chunks, decrementing each surviving neighbour's count. */
export function unlinkChunkNeighbors(chunk: Chunk): void;
```

#### `loadChunk`

```ts
/** insert (or update in place) a chunk from already-decoded parts — the mesh
 *  worker's mirror uses this to load chunks from a packet. a new chunk aliases
 *  the shared empty arrays then takes the given data/light/palette and links
 *  into the neighbour graph; an existing chunk is updated in place so its links
 *  survive. does NOT touch columns/dirty/light-seeding (this is a raw mirror
 *  load, not an authored/streamed edit). */
export function loadChunk(voxels: Voxels, cx: number, cy: number, cz: number, version: number, data: Uint16Array, light: Uint16Array, palette: number[]): Chunk;
```

#### `removeChunk`

```ts
/** remove a chunk from `voxels.chunks`, unlinking it from the neighbour graph.
 *  also removes it from `voxels.regions` (an under-count there would be a real
 *  bug — a region wrongly treated as permanently empty — unlike `columns`,
 *  which has no removal path today and is left alone here; over-counting is
 *  merely conservative, not incorrect). */
export function removeChunk(voxels: Voxels, cx: number, cy: number, cz: number): void;
```

#### `getChunkBlock`

```ts
/**
 * get the global state id at a local position within a chunk.
 * no bounds checking, caller must ensure 0 <= x,y,z < CHUNK_SIZE.
 *
 * this is the fast path for the mesher. returns numeric runtime ids.
 */
export function getChunkBlock(chunk: Chunk, x: number, y: number, z: number): number;
```

#### `getChunkBlockKey`

```ts
/**
 * get the string key at a local position within a chunk.
 * for persistence, inspection, debugging. not hot-path.
 */
export function getChunkBlockKey(chunk: Chunk, x: number, y: number, z: number): string;
```

#### `ensureChunkPaletteSlot`

```ts
/** get-or-allocate the chunk-local palette index for a block key. tier-1
 *  callers grab a slot once, then write `chunkData(chunk)[idx] = slot` directly. */
export function ensureChunkPaletteSlot(chunk: Chunk, key: string, registry: Blocks): number;
```

#### `chunkData`

```ts
/** the chunk's writable voxel-data array, COWing out of the shared EMPTY_DATA
 *  stub first so a direct write can't corrupt the singleton. for tier-1 raw
 *  fills: grab this, write/`.fill()` slots into it, then call invalidateChunk. */
export function chunkData(chunk: Chunk): Uint16Array;
```

#### `chunkLight`

```ts
/** Writable light for a chunk, copy-on-write off `EMPTY_LIGHT` — the twin of
 *  `chunkData`, and the enforcement of the aliasing contract above. Every empty
 *  stub the server ships aliases that one buffer, so a write straight through
 *  `chunk.light` does not darken one chunk, it darkens EVERY empty chunk in the
 *  world at once (and stays wrong until real light arrives for each). */
export function chunkLight(chunk: Chunk): Uint16Array;
```

#### `setChunkBlock`

```ts
export function setChunkBlock(voxels: Voxels, chunk: Chunk, x: number, y: number, z: number, key: string, flags: number = SetBlockFlags.DEFAULT): void;
```

#### `invalidateChunk`

```ts
/**
 * reconcile a chunk after tier-1 raw writes into `chunkData(chunk)`: rescans
 * nonAir/solid counts from the data + palette, marks the chunk mesh-dirty and
 * schedules its light (a tick-end whole-chunk relight, or an inline flat seed
 * when flood-fill is disabled). No ops, no hooks — the raw-write path trades
 * those away for speed. Light schedules on mirrors too, see `VoxelsLighting`.
 */
export function invalidateChunk(voxels: Voxels, chunk: Chunk): void;
```

#### `setLight`

```ts
/**
 * write a packed light value at a chunk-local voxel index, marking the
 * voxel in the per-chunk dirty mask used by dispatchLight to emit
 * per-block deltas. COWs the mask out of the shared EMPTY_LIGHT_MASK
 * singleton on first write. callers must still flag the chunk via
 * markChunkLightDirty (or the light.ts writeChunkLight helper that
 * folds both) to wire the chunk into the per-tick dispatch queue,
 * setLight only owns the data + mask, not the dirty-set membership.
 */
export function setLight(chunk: Chunk, index: number, value: number): void;
```

#### `resolveChunk`

```ts
/**
 * re-resolve all palette keys against a new registry.
 * call this on hot reload when the registry rebuilds.
 *
 * O(palette size), typically < 50 entries per chunk.
 * unresolved keys → MISSING. newly resolved keys → live again.
 */
export function resolveChunk(chunk: Chunk, registry: Blocks): void;
```

#### `repackChunkSnapshot`

```ts
/**
 * compute a compacted snapshot of a chunk's palette + data, without
 * mutating the chunk. used by the save path (saveVoxels) to write a
 * dense on-disk form while the live chunk keeps its append-only palette.
 *
 * INVARIANT: chunk.paletteKeys is append-only across a session. compaction
 * happens only when materialising save bytes via `saveVoxels`. mutating
 * the live palette mid-session is a protocol violation, discovery's
 * voxel_chunk_ops ships the live paletteKeys to clients by reference and
 * relies on indices staying stable.
 *
 * O(CHUNK_VOLUME + oldPaletteSize).
 */
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
    /** chunk-local palette index, what the network sends to clients. */
    data: number;
    /** world coords, saves recomputing per delta for hook dispatch. */
    wx: number;
    wy: number;
    wz: number;
    /** global state id before this op. */
    oldStateId: number;
    /** global state id after this op. */
    newStateId: number;
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
/**
 * per-tick accumulator of authoritative voxel mutations, grouped by the
 * consumer that drains each part:
 *   - `ops`         → block-hooks (settle, inline per write) + discovery (network)
 *   - `addedChunks` → discovery (streaming)
 *
 * light-recompute work is NOT here: it lives in `Voxels.lighting`, which
 * every Voxels owns, mirrors included. see `VoxelsLighting`.
 */
export type VoxelChanges = {
    /** append-only log of block ops this tick. block-hooks settles each op's
     *  hooks inline as it's written; discovery ships the log to clients. */
    ops: VoxelOp[];
    /** chunks created this tick, for streaming. drained by discovery, which
     *  rewinds each player's cursor so newly-existing chunks get streamed
     *  without re-walking the whole view sphere. holds the Chunk ref so
     *  consumers don't have to re-lookup. */
    addedChunks: Set<Chunk>;
};
```

#### `createVoxelChanges`

```ts
export function createVoxelChanges(): VoxelChanges;
```

#### `clearVoxelChanges`

```ts
/**
 * clear the network per-tick state after end-of-tick dispatch.
 */
export function clearVoxelChanges(changes: VoxelChanges): void;
```

#### `FloodFillLightingState`

```ts
/**
 * flood-fill light-propagation config. when `enabled` is false,
 * `flushPendingLight` is short-circuited and `setBlock` / `ensureChunk`
 * write a flat seed value instead of queueing for BFS. `minLevel` is the
 * sky-channel seed for inline writes, `15` keeps the world fully lit,
 * `0` is pitch black except where blocks emit their own light.
 *
 * must agree between server and client: a mirror running flood-fill against
 * a flat server (or a `minLevel` skew) diverges silently. not replicated —
 * configure it from a shared-realm system so both sides set it identically,
 * the same way the rest of a game's world setup runs on both realms.
 */
export type FloodFillLightingState = {
    enabled: boolean;
    minLevel: number;
};
```

#### `VoxelsLighting`

```ts
/**
 * light-recompute scheduling + config. present on EVERY Voxels, read-only
 * mirrors included: a networked client propagates light locally for blocks
 * it writes itself (script-predicted edits) instead of waiting for the
 * server to ship baked light.
 *
 * this is deliberately outside `VoxelsAuthority`. owning the truth governs
 * whether writes emit ops to peers and fire block hooks; it has nothing to
 * do with whether this Voxels can derive light from the blocks it holds.
 *
 * origin gating falls out of the write paths rather than a flag: the client
 * receive path (`applyChunkOps` / `applyChunkFull`) writes chunk data and
 * light directly and never routes through `setChunkBlock` / `ensureChunk` /
 * `invalidateChunk`, so nothing server-fed ever lands in these queues.
 */
export type VoxelsLighting = {
    /** flood-fill light-propagation config. see type doc. */
    floodFill: FloodFillLightingState;
    /** blocks changed by DEFAULT writes → per-block incremental relight. */
    blocks: Array<{ wx: number; wy: number; wz: number; oldStateId: number }>;
    /** chunks changed by BULK writes / invalidateChunk → scoped whole-chunk
     *  relight (relightChunks) instead of the per-block path. */
    chunks: Set<Chunk>;
    /** new chunks needing sky light seeded before incremental updates run. */
    newChunks: Chunk[];
    /** monotonically increasing; bumped by propagateAllLight (a full
     *  recompute), so clients discard buffered incremental ops. NOT
     *  per-tick — it outlives a tick. */
    epoch: number;
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
/** clear per-tick state inside the authority bundle. the observer registry
 *  is NOT cleared, it outlives a tick. */
export function clearVoxelsAuthority(authority: VoxelsAuthority): void;
```

#### `createVoxels`

```ts
export function createVoxels(registry: Blocks): Voxels;
```

#### `markChunkDirty`

```ts
/** mark `chunk` as needing a remesh. routes through here (instead of
 *  setting `chunk.dirty = true` directly) so the renderer's per-frame
 *  scan can iterate `voxels.dirty.blocks` instead of the whole Map. */
export function markChunkDirty(voxels: Voxels, chunk: Chunk): void;
```

#### `markLightVolumeDirty`

```ts
/**
 * Queue `chunk` for a light-volume rebake, at BULK priority.
 *
 * ONE chunk, not an apron. A tile is exactly the chunk's own cells, so nothing
 * else holds a copy of them. The 26-neighbour fan-out this used to do existed
 * because the tile carried a borrowed shell, and it cost a streaming chunk up to
 * 27 rebakes before its neighbourhood settled.
 *
 * Bulk work is drained NEAREST-FIRST and may be deferred while a chunk's
 * neighbourhood is still filling in. Streaming arrivals and whole-world relights
 * belong here: they are not latency-critical, and marking them urgent hands the
 * entire budget to insertion-order work that bypasses both.
 */
export function markLightVolumeDirty(voxels: Voxels, chunk: Chunk): void;
```

#### `markLightVolumeUrgent`

```ts
/**
 * Queue `chunk` at URGENT priority: the player just changed something here.
 *
 * Urgent work drains first and skips the neighbourhood deferral, because a
 * deferred edit is a visible delay on the block that was just placed. Reserve it
 * for edits - a bulk relight marking everything urgent starves the nearest-first
 * ordering it is meant to jump.
 */
export function markLightVolumeUrgent(voxels: Voxels, chunk: Chunk): void;
```

#### `markLightVolumeDirtyForCell`

```ts
/** Queue the rebake implied by one cell of `chunk` changing. Just the chunk:
 *  no other tile holds a copy of that cell. */
export function markLightVolumeDirtyForCell(voxels: Voxels, chunk: Chunk, index: number): void;
```

#### `markChunkLightDirty`

```ts
/** mark `chunk` as needing a relight: `dirty.light` for the server's chunk_light
 *  streaming path, and the light volume for the renderer's tile.
 *
 *  Deliberately NOT `dirty.blocks`. That was needed when meshChunk emitted
 *  geometry and light in one pass; quads carry no light now, so a light-only
 *  change cannot alter the mesh and a remesh here is pure waste. */
export function markChunkLightDirty(voxels: Voxels, chunk: Chunk): void;
```

#### `rebuildSpatialIndexes`

```ts
/** rebuild `voxels.columns` and `voxels.regions` from `voxels.chunks`. used by
 *  deserialize and as a defensive reconcile when callers bypass `ensureChunk`
 *  (tests/benches, savefile load, a full relight). */
export function rebuildSpatialIndexes(voxels: Voxels): void;
```

#### `getChunk`

```ts
/** get the loaded chunk at the given chunk coordinates, or undefined. */
export function getChunk(voxels: Voxels, cx: number, cy: number, cz: number): Chunk | undefined;
```

#### `getChunkAt`

```ts
/** get the loaded chunk containing a block coordinate, or undefined. block
 *  coordinates, not chunk ones: see `getChunk` for the coarser form. */
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
/**
 * set a block at a world position. creates the chunk if it doesn't exist.
 *
 * every write settles its block-def hooks (onNeighbourUpdate/onNeighbourChanged)
 * inline before returning, so a place-then-read sees settled state. `flags`
 * only controls script observers: `DEFAULT` fires them, `BULK` (worldgen, paste,
 * editor brush) does not. chained setBlocks from inside a hook are guarded
 * against re-entry, see block-hooks.runBlockHooks.
 */
export function setBlock(voxels: Voxels, wx: number, wy: number, wz: number, key: string, flags: number = SetBlockFlags.DEFAULT): void;
```

#### `resolveAllChunks`

```ts
/**
 * re-resolve all chunks against the current registry.
 * call this on hot reload when the registry rebuilds.
 */
export function resolveAllChunks(voxels: Voxels): void;
```

#### `cloneVoxels`

```ts
/**
 * deep-copy a Voxels instance into a fresh one. the new instance owns its
 * chunk data, mutations don't affect the source. registry is shared by
 * reference; if you need a different registry, reassign `.registry` and
 * call resolveAllChunks() on the result.
 */
export function cloneVoxels(src: Voxels): Voxels;
```

#### `copyVoxels`

```ts
/**
 * copy all non-air blocks from `src` into `out`. preserves source coords,
 * blocks land at the same world positions in `out`. existing blocks in
 * `out` at those positions are overwritten; blocks at positions not
 * present in the source are left alone.
 */
export function copyVoxels(out: Voxels, src: Voxels): void;
```

Also exported: `CullType`, `MaterialType`, `VertexAnimation`.

## Rendering & visuals

The camera, lighting and sky, and the traits that draw a node.

#### `CameraTrait`

```ts
/**
 * camera trait, plain projection data (fov/near/far) for a scene-tree node.
 * world pose lives on the sibling TransformTrait; a controller (player /
 * orbit / fly) or the editor lens owns the camera node and writes its pose
 * through TransformTrait each frame. the active camera node is `client.camera`
 * on the client state, which the renderer composes the render camera from.
 *
 * the renderer composes a per-room PerspectiveCamera each frame from
 * (camera node Transform + this trait), see `RenderCamera.syncRenderCamera`.
 *
 * persist: false, runtime-only; camera nodes are recreated on room spin-up and
 * never survive a scene round-trip.
 */
export const CameraTrait;
```
#### `getCamera`

```ts
/**
 * the active render camera node, what the renderer composes the render camera
 * from each frame (its TransformTrait pose + CameraTrait projection). defaults
 * to the room's camera node; the editor lens and DIY setups repoint it.
 *
 * server-side, ctx.client is undefined and this returns null.
 */
export function getCamera(ctx: ScriptContext): sceneTree.Node | null;
```

#### `getSubject`

```ts
/**
 * the client's current subject: the node local input drives and the engine
 * treats as this client's point of view (renderer + audio). scripts compare
 * their own ctx.node to it to gate per-frame work that should only run on the
 * active subject (camera writes, input-driven movement, etc.); other nodes
 * still run their remaining hooks unconditionally.
 *
 * a plain field on the single client state (`ctx.client.subject`), so a write
 * is observed everywhere without re-seating. server-side, ctx.client is
 * undefined and this returns null (server scripts shouldn't gate on POV).
 */
export function getSubject(ctx: ScriptContext): sceneTree.Node | null;
```

#### `setCamera`

```ts
/**
 * point the active render camera at `node`. plain in-place write to the single
 * client state (`ctx.client.camera`), observed by the renderer and every
 * script without re-seating. client-only: a no-op on the server.
 */
export function setCamera(ctx: ScriptContext, node: sceneTree.Node): void;
```

#### `setSubject`

```ts
/**
 * swap the client's subject. plain in-place write to `ctx.client.subject`.
 * pass `null` to clear. client-only: a no-op on the server. purely local, it
 * changes what this client controls/sees, never ownership or the server-side
 * streaming anchor (that stays the player node).
 */
export function setSubject(ctx: ScriptContext, node: sceneTree.Node | null): void;
```
#### `configureFloodFillLighting`

```ts
/**
 * configure flood-fill light propagation for this room's voxel world.
 *
 * fields default to their current value, pass only what you want to
 * change. shallow merge.
 *
 * - `enabled`: when false, `setBlock` and new chunks skip the BFS queue
 *   and inline-seed `chunk.light` from block emission + `minLevel` sky.
 * - `minLevel`: sky-channel seed used by inline writes (0-15). `15`
 *   keeps the world fully lit; `0` is pitch black except for block
 *   emission.
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
    /** wraps in [0,1]; sun position = `t * 2π` */
    t: number;
    zenith: Vec3;
    horizon: Vec3;
    nadir: Vec3;
};
```

#### `EnvironmentConfig`

```ts
/** input shape, every field optional. shallow-merges into current state. */
export type EnvironmentConfig = {
    enabled?: boolean;
    sky?: { preset?: SkyPreset; stops?: SkyStop[] };
    sun?: { enabled?: boolean; intensity?: number };
    moon?: { enabled?: boolean };
    stars?: { enabled?: boolean; density?: number };
    /**
     * planar cloud layer at `altitude` world-units. `thickness` controls the
     * virtual depth the fragment shader marches through to fake 3D volume,
     * larger values give chunkier, more parallaxing clouds. `density` is
     * coverage [0,1]; `wind` is a 2D drift velocity applied to the noise
     * field over `envTime`.
     */
    clouds?: { enabled?: boolean; density?: number; wind?: Vec2; altitude?: number; thickness?: number };
    /**
     * distance fog. fog runs from `start` to `end`, and by default `end` is
     * however far this client can actually see.
     *
     *   `end`     world units, or `'view'` (the default) to track the client's
     *             own view radius. `'view'` is what fades the world out at the
     *             streamed chunk boundary, and it is per-client, since view
     *             radius is a device performance setting a script can't know.
     *   `start`   FRACTION of `end` where the fade begins, not world units, so
     *             authoring never depends on knowing the view radius. 0.9 is a
     *             narrow lip at the boundary; 0.1 is fog across the whole view.
     *   `color`   `'sky'` tracks the sky LUT's horizon at the current time of
     *             day (so sunsets and night work unauthored), or a linear rgb
     *             triple pins it.
     *   `opacity` how opaque fog gets at `end`. 1 fully replaces the colour.
     *
     * Shaped after luanti's `set_sky{fog = {fog_distance, fog_start}}`, where
     * distance is client-controlled by default and start is a fraction of the
     * visible range (doc/lua_api.md).
     *
     * Setting a numeric `end` NEARER than the view radius does not re-expose the
     * chunk boundary: fog is already saturated well before it. Setting one
     * further out leaves the engine's own boundary fade in place underneath.
     *
     *   { end: 30, start: 0.1 }   near, thick, atmospheric fog
     *   { enabled: false }        no fog, world stops hard at the boundary
     */
    fog?: { enabled?: boolean; color?: Vec3 | 'sky'; end?: number | 'view'; start?: number; opacity?: number };
};
```

#### `PRESETS`

```ts
/**
 * named sky LUT tables. only `overworld` is tuned right now, additional
 * presets will land alongside their target room art (overcast, desert, etc.)
 * so the LUT and game palette get authored together.
 */
export const PRESETS: Record<SkyPreset, SkyStop[]>;
```

#### `ENVIRONMENT_DEFAULT`

```ts
/** default config when a room boots. resolved (no optionals). */
export const ENVIRONMENT_DEFAULT: ClientEnvironment.ResolvedEnvironment;
```

#### `ENVIRONMENT_OVERWORLD`

```ts
export const ENVIRONMENT_OVERWORLD: ClientEnvironment.ResolvedEnvironment;
```

#### `setEnvironmentTime`

```ts
/**
 * advance the environment time, in hours. hot path, one f32 uniform write.
 * safe to call every frame.
 *
 *   0 = midnight, 6 = sunrise, 12 = noon, 18 = sunset. wraps mod 24.
 *
 * the underlying uniform is normalised to [0,1) so a `0.25`-style fraction
 * still works (`setEnvironmentTime(0.25 * 24)`), but hours are the natural unit for
 * game scripts (`setEnvironmentTime(7.5)` reads as 7:30am).
 */
export function setEnvironmentTime(ctx: ScriptContext, hours: number): void;
```

#### `getEnvironmentTime`

```ts
/** current environment time in hours, in [0, 24). */
export function getEnvironmentTime(ctx: ScriptContext): number;
```

#### `setEnvironment`

```ts
/**
 * Merge a partial config into the room's environment. Slow path: this
 * repacks and re-uploads the config storage buffer, so call it from script
 * init or in response to game events, never every frame. For time-of-day
 * animation use `setEnvironmentTime`, which is the per-frame hot path.
 *
 * The merge is per-field, not just top-level. Only the fields you set change;
 * everything else keeps its current value, and any group you omit is left
 * entirely untouched. So `setEnvironment(ctx, { clouds: { density: 0.8 } })`
 * changes cloud density alone and leaves cloud wind, sun, sky, etc. as they
 * were. To reset a group, pass every field explicitly (or start from one of
 * the `ENVIRONMENT_*` presets).
 *
 * Groups and their fields:
 *   - `enabled`  master switch for the whole environment. When false, the
 *                renderer also hides the sky and cloud meshes, so this is the
 *                one flag that gates rendering, not just config values.
 *   - `sky`      `{ preset }` selects a named LUT (see `SkyPreset`); `{ stops }`
 *                supplies a custom 4-stop LUT. They are mutually exclusive at
 *                merge time: if both are set, `stops` wins. A preset compiles
 *                to its `stops` array here, so nothing distinguishes the two
 *                downstream.
 *   - `sun`      `enabled` toggles the directional light; `intensity` scales it.
 *   - `moon`     `enabled` toggles the moon sprite.
 *   - `stars`    `enabled` toggles stars; `density` is their coverage.
 *   - `clouds`   see `EnvironmentConfig.clouds` for the field meanings
 *                (altitude / thickness / density / wind).
 *   - `fog`      distance fog, from `start` (a fraction) to `end` (world units
 *                or `'view'`). On by default at `'view'`, which fades the world
 *                out at the streamed chunk boundary. See `EnvironmentConfig.fog`.
 *
 * Example, dim the sun and thicken the clouds on some game event:
 *
 *   setEnvironment(ctx, {
 *       sun: { intensity: 0.2 },
 *       clouds: { enabled: true, density: 0.9, thickness: 4 },
 *   });
 *
 * No-ops if the room has no active client environment (e.g. on the server).
 */
export function setEnvironment(ctx: ScriptContext, config: EnvironmentConfig): void;
```
#### `MeshTrait`

```ts
export const MeshTrait;
```
#### `VoxelModel`

```ts
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
 * build a static compound shape for `model`, one axis-aligned box per
 * greedy-merged run of non-air voxels. positions are offset by -model.origin
 * so the resulting shape pivots around the model's origin.
 *
 * returns null when the model has no non-air voxels.
 */
export function createVoxelModelShape(model: VoxelModel): crashcat.Shape | null;
```

#### `createVoxelModel`

```ts
/**
 * create a VoxelModel from a populated Voxels. scans the voxel data
 * to compute bounds, dimensions, voxel count, and a default origin at the
 * center of the bounding box. the Voxels should not be mutated after
 * this call.
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
/** how a particle's sprite frame timeline maps onto its lifetime.
 *  see plan §"Playback mode" for the full table. */
export type ParticlePlayback = 'stretch' | 'loop' | 'once';
```

#### `ParticlePool`

```ts
/** Per-room SoA pool. Alive prefix is `[0, count)`; dead slots are
 *  compacted by `particleUpdate` (client). The type is declared here
 *  so `ParticleUpdateFn` (also here) can name its first param without forcing a
 *  core→client import; the runtime that allocates / mutates it lives in
 *  client. Both halves agree on the layout via this single declaration. */
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
/**
 * declare a particle type. called at module scope.
 *
 * returns a pure-data handle. the runtime resolves particle types by id
 * at spawn time via `particlesRegistry`; no codegen barrel.
 *
 * @example
 * ```ts
 * const Smoke = particle('smoke', {
 *     sprite: SmokeSprite,
 *     playback: 'stretch',
 *     update: particleUpdate.smoke,
 * });
 * ```
 */
export function particle(id: string, options: ParticleOptions): ParticleHandle;
```

#### `SpawnOpts`

```ts
/** spawn-time opt overrides. universal fields the engine exposes for
 *  per-spawn customization. matches the plan §"Spawning" surface. unset
 *  → engine default. */
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
 * spawn a particle of the given type at world `pos` into the active
 * room's pool. returns the slot index, or `null` when there's no
 * client room (server-side, pre-join) or the pool is full.
 *
 * `pos` is splatted into `posX/posY/posZ`; `opts` overrides the
 * universal default-init fields (velocity, lifetime, size, seed,
 * spawnTime, see `SpawnOpts`). type-specific knobs live inside the
 * particle's `update` fn, not on this call.
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
/** server-set, dirty-synced. clients read `modelId` to know which url to
 *  fetch + register via `Resources.setModel` (the engine broadcast pairs
 *  the id with a client-side `.glb` url). */
export const modelIdSync;
```

#### `ensureCharacterRig`

```ts
/**
 * Synchronously mount the placeholder (baseAvatar.def) rig on `node` if it has no
 * rig yet, so code running before the reconciler's first frame sees the bones.
 *
 * The reconciler builds the rig in `onFrame`, which runs *after* the server's
 * join processing, so a server `onJoin` hook that does
 * `findByName(playerNode, 'hand_right')` would otherwise get null. The server
 * calls this at player-node creation (`createPlayerNode`) so bones exist by the
 * time join hooks fire; game code spawning characters that need bones
 * immediately can call it too.
 *
 * Idempotent (no-op once a rig is mounted) and a no-op on a node without
 * `CharacterTrait`. Mounts only the placeholder, the reconciler still swaps in
 * the resolved avatar once its model loads.
 */
export function ensureCharacterRig(node: Node): void;
```

#### `addCharacter`

```ts
/**
 * Add `CharacterTrait` to `node` and mount its rig immediately, so the bones
 * (`head`, `hand_right`, …) are available the same tick for attaching held
 * items / accessories. The higher-level sibling of
 * `addTrait(node, CharacterControllerTrait)`, the engine uses it for player
 * nodes (`createPlayerNode`) and game code uses it to spawn character NPCs.
 *
 * Returns the trait. Mounts the base/placeholder rig synchronously (via
 * `ensureCharacterRig`); the reconciler swaps in the resolved avatar later if
 * `props.modelId` names one that isn't loaded yet. Use `ensureCharacterRig`
 * directly when a node already carries `CharacterTrait` and you only need its
 * bones mounted now.
 */
export function addCharacter(node: Node, props?: TraitProps<CharacterTrait>): CharacterTrait;
```
#### `CharacterView`

```ts
/** the character's look ray this frame: eye `origin` (world space) + unit
 *  `direction` from `input.look`. populated every frame for every character,
 *  players AND npcs, so scripts can fire / raycast / aim from the eyes without
 *  reaching for the camera (which doesn't exist server-side or for npcs). */
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
/** orient a character at a world target. uses the character's current world
 *  position + its `state.eyeHeight` as the look origin so head-height entities
 *  aim through their eyes, not their feet. */
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
    /** current blend weight (0..1) */
    weight: number;
    /** crossfade destination (set by crossFadeTo) */
    targetWeight: number;
    /** weight delta per second; 0 = no fade */
    fadeRate: number;
    /** current playback time in seconds */
    time: number;
    /** playback rate (default 1) */
    speed: number;
    loopMode: 'once' | 'repeat';
    enabled: boolean;
    /** ascending = composite later. higher layers fully replace lower
     *  layers' values for nodes they write. default 0. */
    layer: number;
    /** filter clip channels by node name. null = no filtering (every
     *  channel in the clip drives its target). default null. */
    mask: ReadonlySet<string> | null;
    /** how this action composites within its layer.
     *  - 'replace' (default): contributes to the layer's weighted sum
     *  - 'additive': delta from clip's first frame, added on top */
    blendMode: BlendMode;
    /** scratch, channels resolved at top of tick. preserved across ticks
     *  so the boneIndices cache below can detect a payload swap by ref
     *  identity. cleared by `Resources.modelClipChannels` returning a
     *  fresh ref on resource reload, which forces a rebuild. */
    _channels: ClipChannels | null;
    /** parallel to `_channels.channels`, boneIndices[c] = the channel's
     *  target bone index in `state.boneOrder`, or -1 if the rig doesn't
     *  contain that bone, or if `mask` filters it out. lets the inner
     *  sample loops index directly instead of doing string-keyed
     *  `boneIndex.get` + `mask.has` per channel per tick. */
    _boneIndices: Int32Array | null;
    /** matches `state.boneOrderEpoch` when valid; mismatch ⇒ rebuild. */
    _boneIndicesEpoch: number;
    /** ref of the channels payload `_boneIndices` was built against. */
    _boneIndicesChannelsRef: ClipChannels | null;
    /** ref of the mask `_boneIndices` was built against. */
    _boneIndicesMaskRef: ReadonlySet<string> | null;
    /** parallel to `_channels.channels`, last-found keyframe `lo` index per
     *  channel. seeded to 0; sample functions read this as their search start
     *  and write back the new lo. for steady-time playback the typical case
     *  is 0-1 forward steps before hitting the right interval; only sudden
     *  rewinds / loop wraps fall through to binary search. (three.js-style
     *  cached-index hybrid in `findKeyLow`.) */
    _lastKeyIdx: Int32Array | null;
    /** channel-index buckets partitioned by property type, with masked-out /
     *  unresolved channels excluded. lets the tick body run three monomorphic
     *  loops (no `switch (channel.property)` dispatch inside the hot path);
     *  per animation.bench.ts (H1), this is ~1.2× faster than the
     *  unified-loop variant. built alongside `_boneIndices` in
     *  `rebuildActionBoneIndices`. */
    _idxTranslation: Int32Array | null;
    _idxRotation: Int32Array | null;
    _idxScale: Int32Array | null;
};
```

#### `AnimatorState`

```ts
export type AnimatorState = {
    /** keyed by ClipDef ref identity (sidecar singleton). lookup-only. */
    actions: Map<ClipDef, AnimationAction>;
    /** parallel flat list of every action in `actions`, in insertion order.
     *  the tick body iterates this, `Map.values()` was ~1.8× slower per
     *  pass in animation.bench.ts and the tick walks it three times. kept
     *  in sync with `actions` at `Animation.clip()` time. */
    actionsList: AnimationAction[];

    /**
     * cached parent-first DFS of the rig's TransformTraits, built once on
     * first tick (when `boneOrder.length === 0`) and reused. scripts that
     * restructure the rig (e.g. attach a sword to a hand bone and want it
     * eagerly tracked) call `Animation.invalidateRig(animator)` to force a
     * rebuild. parent-first ordering means the end-of-tick dirty
     * reconciliation pass walks bones in a single forward sweep.
     */
    boneOrder: TransformTrait[];
    /** parallel to `boneOrder`, direct refs to `t.position` / `t.quaternion`
     *  / `t.scale` for each bone, captured during `walkBones`. saves a
     *  hidden-class property lookup per bone per tick in the layer passes.
     *  these arrays ARE the canonical store, replace + additive write
     *  directly into them; world matrices are recomputed lazily via
     *  `getWorldMatrix` on read (Unity/three.js shape). */
    bonePos: Vec3[];
    boneQuat: Quat[];
    boneScale: Vec3[];
    /** name → index in `boneOrder`. populated alongside `boneOrder`. */
    boneIndex: Map<string, number>;
    /** bumped each time `rebuildBoneOrder` runs. actions stamp this onto
     *  their cached `_boneIndices` so a structural change invalidates them. */
    boneOrderEpoch: number;

    /** per-bone weighted sum for the current layer's replace pass (cap × 13). */
    layerAccum: Float32Array;
    /** for each bone, exclusive end index of its DFS subtree in `boneOrder`
     *  (descendants of `bi` are the contiguous range `[bi+1, subtreeEnd[bi])`).
     *  built once during `walkBones`. lets writes mark a bone-and-descendants
     *  range dirty in one `Uint8Array.fill` call, godot Skeleton3D's
     *  `nested_set_offset + nested_set_span` trick. */
    subtreeEnd: Int32Array;
    /** subtree dirty bitmap: 1 = this tick's sampling wrote to bone `bi`'s
     *  local TRS, OR an ancestor was written. cleared at top of layer
     *  composition; set by the replace-normalize loop and by `applyAdditiveTA`
     *  via `subtreeDirty.fill(1, bi, subtreeEnd[bi])`. End-of-tick reconcile
     *  walks this bitmap once and stamps `_dirty = TRANSFORM_DIRTY_ALL` on
     *  each marked bone so `getWorldMatrix` lazy-composes correctly. */
    subtreeDirty: Uint8Array;
    /** capacity of layerAccum / subtreeEnd / subtreeDirty in bones. */
    accumCapacity: number;

    /** the rig's renderable meshes, cached when `boneOrder` is (re)built.
     *  The per-rig tick gate + LOD fold these meshes' own `cull` entries
     *  (on `MeshVisualState.cull`, written by the Visibility culler): the
     *  rig is visible iff any mesh is, and coverage comes from the
     *  closest/largest one. "Is the model visible" = "is any child mesh
     *  visible", there's no rig-level cullable. */
    _cullMeshes: MeshTrait[];

    /** current LOD stride: 1 (sample every frame) / 2 / 4 / 8. Defaults 1
     *  until the first classify pass runs; that way the first visible frame
     *  always samples and the rig doesn't show a stale pose. */
    _lodStride: number;
    /** per-rig phase offset, assigned from a room-scoped counter at first
     *  tick. Spreads sampling across frames so N stride-2 rigs split into
     *  two phase buckets (half on even frames, half on odd) rather than
     *  all sampling on the same frame. -1 until assigned. */
    _lodPhase: number;
    /** `Animations._frameCount` when classification last ran. */
    _lodClassifiedAtFrame: number;
    /** previous frame's rig visibility (0/1). False→true transition forces
     *  a sample regardless of stride/phase so a rig coming on-screen doesn't
     *  show its up-to-8-frame-stale last pose. */
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
    /** current blend weight (0..1) */
    weight: number;
    /** crossfade destination (set by crossFadeTo) */
    targetWeight: number;
    /** weight delta per second; 0 = no fade */
    fadeRate: number;
    /** current playback time in seconds */
    time: number;
    /** playback rate (default 1) */
    speed: number;
    loopMode: 'once' | 'repeat';
    enabled: boolean;
    /** ascending = composite later. higher layers fully replace lower
     *  layers' values for nodes they write. default 0. */
    layer: number;
    /** filter clip channels by node name. null = no filtering (every
     *  channel in the clip drives its target). default null. */
    mask: ReadonlySet<string> | null;
    /** how this action composites within its layer.
     *  - 'replace' (default): contributes to the layer's weighted sum
     *  - 'additive': delta from clip's first frame, added on top */
    blendMode: BlendMode;
    /** scratch, channels resolved at top of tick. preserved across ticks
     *  so the boneIndices cache below can detect a payload swap by ref
     *  identity. cleared by `Resources.modelClipChannels` returning a
     *  fresh ref on resource reload, which forces a rebuild. */
    _channels: ClipChannels | null;
    /** parallel to `_channels.channels`, boneIndices[c] = the channel's
     *  target bone index in `state.boneOrder`, or -1 if the rig doesn't
     *  contain that bone, or if `mask` filters it out. lets the inner
     *  sample loops index directly instead of doing string-keyed
     *  `boneIndex.get` + `mask.has` per channel per tick. */
    _boneIndices: Int32Array | null;
    /** matches `state.boneOrderEpoch` when valid; mismatch ⇒ rebuild. */
    _boneIndicesEpoch: number;
    /** ref of the channels payload `_boneIndices` was built against. */
    _boneIndicesChannelsRef: ClipChannels | null;
    /** ref of the mask `_boneIndices` was built against. */
    _boneIndicesMaskRef: ReadonlySet<string> | null;
    /** parallel to `_channels.channels`, last-found keyframe `lo` index per
     *  channel. seeded to 0; sample functions read this as their search start
     *  and write back the new lo. for steady-time playback the typical case
     *  is 0-1 forward steps before hitting the right interval; only sudden
     *  rewinds / loop wraps fall through to binary search. (three.js-style
     *  cached-index hybrid in `findKeyLow`.) */
    _lastKeyIdx: Int32Array | null;
    /** channel-index buckets partitioned by property type, with masked-out /
     *  unresolved channels excluded. lets the tick body run three monomorphic
     *  loops (no `switch (channel.property)` dispatch inside the hot path);
     *  per animation.bench.ts (H1), this is ~1.2× faster than the
     *  unified-loop variant. built alongside `_boneIndices` in
     *  `rebuildActionBoneIndices`. */
    _idxTranslation: Int32Array | null;
    _idxRotation: Int32Array | null;
    _idxScale: Int32Array | null;
};
```

#### `Animation.AnimatorState`

```ts
export type AnimatorState = {
    /** keyed by ClipDef ref identity (sidecar singleton). lookup-only. */
    actions: Map<ClipDef, AnimationAction>;
    /** parallel flat list of every action in `actions`, in insertion order.
     *  the tick body iterates this, `Map.values()` was ~1.8× slower per
     *  pass in animation.bench.ts and the tick walks it three times. kept
     *  in sync with `actions` at `Animation.clip()` time. */
    actionsList: AnimationAction[];

    /**
     * cached parent-first DFS of the rig's TransformTraits, built once on
     * first tick (when `boneOrder.length === 0`) and reused. scripts that
     * restructure the rig (e.g. attach a sword to a hand bone and want it
     * eagerly tracked) call `Animation.invalidateRig(animator)` to force a
     * rebuild. parent-first ordering means the end-of-tick dirty
     * reconciliation pass walks bones in a single forward sweep.
     */
    boneOrder: TransformTrait[];
    /** parallel to `boneOrder`, direct refs to `t.position` / `t.quaternion`
     *  / `t.scale` for each bone, captured during `walkBones`. saves a
     *  hidden-class property lookup per bone per tick in the layer passes.
     *  these arrays ARE the canonical store, replace + additive write
     *  directly into them; world matrices are recomputed lazily via
     *  `getWorldMatrix` on read (Unity/three.js shape). */
    bonePos: Vec3[];
    boneQuat: Quat[];
    boneScale: Vec3[];
    /** name → index in `boneOrder`. populated alongside `boneOrder`. */
    boneIndex: Map<string, number>;
    /** bumped each time `rebuildBoneOrder` runs. actions stamp this onto
     *  their cached `_boneIndices` so a structural change invalidates them. */
    boneOrderEpoch: number;

    /** per-bone weighted sum for the current layer's replace pass (cap × 13). */
    layerAccum: Float32Array;
    /** for each bone, exclusive end index of its DFS subtree in `boneOrder`
     *  (descendants of `bi` are the contiguous range `[bi+1, subtreeEnd[bi])`).
     *  built once during `walkBones`. lets writes mark a bone-and-descendants
     *  range dirty in one `Uint8Array.fill` call, godot Skeleton3D's
     *  `nested_set_offset + nested_set_span` trick. */
    subtreeEnd: Int32Array;
    /** subtree dirty bitmap: 1 = this tick's sampling wrote to bone `bi`'s
     *  local TRS, OR an ancestor was written. cleared at top of layer
     *  composition; set by the replace-normalize loop and by `applyAdditiveTA`
     *  via `subtreeDirty.fill(1, bi, subtreeEnd[bi])`. End-of-tick reconcile
     *  walks this bitmap once and stamps `_dirty = TRANSFORM_DIRTY_ALL` on
     *  each marked bone so `getWorldMatrix` lazy-composes correctly. */
    subtreeDirty: Uint8Array;
    /** capacity of layerAccum / subtreeEnd / subtreeDirty in bones. */
    accumCapacity: number;

    /** the rig's renderable meshes, cached when `boneOrder` is (re)built.
     *  The per-rig tick gate + LOD fold these meshes' own `cull` entries
     *  (on `MeshVisualState.cull`, written by the Visibility culler): the
     *  rig is visible iff any mesh is, and coverage comes from the
     *  closest/largest one. "Is the model visible" = "is any child mesh
     *  visible", there's no rig-level cullable. */
    _cullMeshes: MeshTrait[];

    /** current LOD stride: 1 (sample every frame) / 2 / 4 / 8. Defaults 1
     *  until the first classify pass runs; that way the first visible frame
     *  always samples and the rig doesn't show a stale pose. */
    _lodStride: number;
    /** per-rig phase offset, assigned from a room-scoped counter at first
     *  tick. Spreads sampling across frames so N stride-2 rigs split into
     *  two phase buckets (half on even frames, half on odd) rather than
     *  all sampling on the same frame. -1 until assigned. */
    _lodPhase: number;
    /** `Animations._frameCount` when classification last ran. */
    _lodClassifiedAtFrame: number;
    /** previous frame's rig visibility (0/1). False→true transition forces
     *  a sample regardless of stride/phase so a rig coming on-screen doesn't
     *  show its up-to-8-frame-stale last pose. */
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
/**
 * blend `from` out and `to` in over `duration` seconds. both actions become
 * enabled; per-tick animator advances each weight toward its target. safe to
 * re-call mid-fade, sets fresh targets and the next tick continues smoothly.
 */
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
/**
 * drop the animator's cached bone order so the next tick rebuilds it.
 * call after restructuring the rig subtree (e.g. attaching a follower node
 * to a bone that should be eagerly transformed each tick alongside the
 * skeleton). a no-op if no state exists yet.
 *
 * does not invalidate `mask` sets returned by `Animation.descendants`,
 * call that again separately if needed.
 */
export function invalidateRig(animator: AnimatorTrait): void;
```

#### `Animation.descendants`

```ts
/**
 * names of every descendant of `root` in the animator's rig, walking the
 * subtree once. typical use: `aim.mask = Animation.descendants(animator,
 * 'Spine', { includeRoot: true })`. re-call to pick up structural changes.
 *
 * `root` can also match the animator's own node name; in that case the walk
 * starts from the animator node itself.
 */
export function descendants(animator: AnimatorTrait, root: string, opts?: {
    includeRoot?: boolean;
}): Set<string>;
```

#### `Animation.Animations`

```ts
/**
 * per-room state for the animation tick. caches the `[AnimatorTrait]` query
 * so the per-frame walk doesn't rebuild bitsets / hash each call.
 */
export type Animations = {
    animators: ReturnType<typeof query<[typeof AnimatorTrait]>>;
    /** monotonic per-room frame counter, drives LOD stride/phase gating in
     *  the per-animator tick. Wraps would only matter past ~10⁹ frames. */
    frameCount: number;
    /** room-scoped counter handed out as `_lodPhase` to each animator on its
     *  first tick. Ensures N rigs at stride 2 split across both phase buckets
     *  rather than all sampling on the same frame. */
    nextLodPhase: number;
};
```

#### `Animation.init`

```ts
export function init(sceneTree: SceneTree): Animations;
```

#### `Animation.tick`

```ts
export function tick(animations: Animations, resources: Resources.Resources, dt: number): void;
```

## Avatars

Platform avatars for players and NPCs.

#### `assignAvatar`

```ts
/**
 * Point a `CharacterTrait` node at an already-loaded avatar (acquire the model
 * first for runtime avatars). Sets the synced `modelId`/`rigType`; the rig
 * reconciler mounts it once the payload lands. No refcount, safe to call
 * repeatedly / swap freely. No-op if `node` has no `CharacterTrait`.
 */
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
    /** crashcat rigid body sub-world, full broadphase + manifolds + sleep. */
    rigid: RigidPhysics.World;
    /** AABB physics sub-world, items / particles / throwables. analytical sweep. */
    aabb: AabbPhysics.World;

    // ── contact output ───────────────────────────────────────────────

    /** global contact stream, pairs un-normalized (A→B), with added/persisted/removed lifecycle. */
    contacts: PhysicsContacts;
    /** pool of rigid-body-side observer Contact instances, drawn by fan-out into ContactsTrait. */
    rigidBodyContactPool: RigidBodyContactPool;
    /** pool of aabb-body-side observer Contact instances, drawn by fan-out into ContactsTrait. */
    aabbBodyContactPool: AabbBodyContactPool;
    /** pool of voxel-side observer Contact instances, drawn by fan-out into ContactsTrait. */
    voxelContactPool: VoxelContactPool;
    /** pool of ContactPair instances backing `contacts.*` lists. */
    contactPairPool: ContactPairPool;
    /** cached query for fan-out, built once at init so we don't pay hash+lookup each tick. */
    contactsQuery: ReturnType<typeof query<[typeof ContactsTrait]>>;

    /** sink passed into `AabbPhysics.tick`. drains pairs into `contacts`. */
    aabbPairSink: AabbPhysics.PairSink;

    /** body contacts gathered by character VCCs during `runOnTick` (which runs
     *  before the rigid solver). a VCC depenetrates its character off the bodies
     *  it touches and teleport-follows its kinematic inner body, so by the time
     *  the solver steps there's no overlap and no manifold, a fast projectile
     *  would pass straight through with no contact event. these are replayed into
     *  `contacts` each tick (see {@link ingestVccRigidContacts}) so they reach both
     *  bodies' `ContactsTrait` like any solver contact. staged here (coordinator
     *  level, not on the rigid world) since the producer is the character
     *  controller and the replay writes the shared stream. `vccRigidContactCount` is
     *  the live length; records are reused (no per-frame allocation). */
    vccRigidContacts: VccRigidContact[];
    vccRigidContactCount: number;

    /** same staging as {@link vccRigidContacts}, for the VCC's *voxel* (terrain)
     *  contacts. the VCC sweeps voxels itself rather than through the solver,
     *  so its terrain contacts never form a manifold; replayed each tick (see
     *  {@link ingestVccVoxelContacts}) so they fan out to the character node's
     *  `ContactsTrait` as VoxelContacts. `vccVoxelContactCount` is the live
     *  length; records are reused. */
    vccVoxelContacts: VccVoxelContact[];
    vccVoxelContactCount: number;

    /** set of nodes currently enrolled in interpolation because at least one
     *  subsystem has a body for them. diffed each preStep against the union of
     *  `rigid.nodeToBody ∪ aabb.nodeToBody`. (Contacts is not membership-driven:
     *  a node's ContactsTrait is created lazily on its first contact, in fan-out.) */
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
 *  bit for each. bit assignment is positional (first name → first free bit
 *  above the reserved range), so it's identical on every side, groups aren't
 *  synced, so a game MUST declare them the same way everywhere (call this once
 *  at module load with a fixed list, don't build the list conditionally).
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

#### `BoxShapeDef`

```ts
export const BoxShapeDef;
```

#### `SphereShapeDef`

```ts
export const SphereShapeDef;
```

#### `TransformedShapeDef`

```ts
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
/**
 * declarative body recipe. when the trait carries a `def`, the installer
 * builds + owns the body from it. matches the optional fields on crashcat's
 * `RigidBodySettings` so the editor / serialized scenes can drive the full
 * surface without ceremony.
 */
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
 * per-step contact lifecycle for a node.
 *
 * populated by the physics fan-out phase (after the world step, before
 * `runOnPostPhysicsStep`). normals point AWAY from this node. owner-local,
 * whichever side runs the physics step populates locally; events from a
 * predicted body show up on the predicting client.
 *
 * lifetime contract: Contact references in these arrays are valid until
 * the start of the next physics step. fields are *not* preserved across
 * steps, the underlying Contact instance is released to the pool. if a
 * script needs to retain data across steps, copy the fields it cares about.
 *
 * a Contact appearing in `added` last step appears in `persisted` this step
 * with *different* object identity but identical-meaning fields. don't hash
 * by reference; key by `nodeId`+`subShapeId` or `(voxelX, voxelY, voxelZ)`.
 */
export const ContactsTrait;
```

## Controllers

The player, fly, and orbit controller traits.

#### `PlayerTrait`

```ts
/**
 * player trait. marks a node as the in-scene body of a specific Player,
 * one (client, room, mode) view. persist: false, player nodes are
 * ephemeral, created at Player join time.
 *
 * playerId/client/userId/username are server-set runtime state. they're
 * replicated as explicit-dirty syncs (no editor exposure, no auto byte-diff).
 * server code that mutates them must call <field>Sync.dirty(t).
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
/**
 * Input + HUD wiring for the player controller. One master switch plus
 * grouped sub-knobs for desktop and touch behaviours. Fields are mutated
 * live, flip `enabled` for pause menus, dialog modals, cutscenes; flip
 * individual sub-flags for settings UIs.
 */
export type ControlsConfig = {
    /** master switch. false → trait wires no input and mounts no HUD. */
    enabled: boolean;

    desktop: {
        /** double-tap W activates sprint until W releases. off for games
         *  where sprint is RMB-held or always-on. */
        doubleTapSprint: boolean;
        /** double-tap Space toggles noclip (free-fly). off by default; the
         *  editor flips it on for its character mode, and games that want a
         *  fly cheat can enable it too. the noclip movement itself lives on
         *  the CC and is independent of this gesture. */
        doubleTapNoclip: boolean;
    };

    touch: {
        /** auto-mount the default 'move' joystick on mobile. the joystick
         *  id is read into cc.move regardless, set false to suppress only
         *  the default mount (e.g. you're mounting your own at a custom
         *  position). */
        joystick: boolean;
        /** auto-mount default 'jump' button on mobile. */
        jumpButton: boolean;
        /** auto-mount 'sprint' button on mobile (off by default, joystick
         *  magnitude drives sprint instead). always-read regardless. */
        sprintButton: boolean;
        /** auto-mount 'crouch' button on mobile (off by default). */
        crouchButton: boolean;
        /** while noclip (free-fly) is active, mount a vertical up/down joystick
         *  in place of the jump button so the flyer can ascend AND descend with
         *  analog control. on by default. */
        noclipVerticalJoystick: boolean;
        /** mount a fly/walk toggle button that flips noclip on tap. off by
         *  default; opt in where free-fly is allowed (the editor turns it on,
         *  same as `desktop.doubleTapNoclip`). the touch counterpart to the
         *  double-tap-Space toggle, which a finger can't do. */
        flyToggleButton: boolean;
        /** right-half canvas drag → cc.look on touch devices. */
        canvasLook: boolean;
    };
};
```

#### `PlayerControllerTouchIds`

```ts
/**
 * Touch control ids that PlayerControllerTrait reads from `TouchInput`
 * when `controls.enabled` is true. Register a joystick / button at these
 * ids and the controller picks them up automatically. Unregistered ids
 * no-op (the touch input layer returns zero stubs), so reads are free
 * when nothing's mounted.
 */
export const PlayerControllerTouchIds;
```

#### `PlayerControllerTrait`

```ts
export const PlayerControllerTrait;
```
#### `FlyControllerTrait`

```ts
/**
 * fly controller tunables.
 *
 * `speed` is the live move speed; updated by the wheel-adjust path while
 * pointer-locked. the rest are caps and rates configurable via inspector.
 */
export const FlyControllerTrait;
```
#### `OrbitControllerTrait`

```ts
/**
 * orbit controller. attaching it wires up the orbit camera script
 * (left-drag rotate, right-drag pan, wheel dolly).
 *
 * `target` is the world-space focal point the camera orbits / pans around.
 * mutable, pan writes back into it and the editor reconcile loop seeds it
 * on takeover.
 *
 * `eye` is the initial world-space camera position. consumed once on
 * attach to seed the camera transform + spherical state. leave the
 * default (null) to use whatever pose the camera transform already
 * carries (set externally before attach, or the room default).
 */
export const OrbitControllerTrait;
```

## Pathfinding

Grid pathfinding over the voxel world.

#### `nav.Walkable`

```ts
/** strategy: can the agent stand/be at this cell? scalar args so the A* inner
 *  loop allocates nothing. slot a different impl in for fly / swim / wall. */
export type Walkable = (voxels: Voxels, x: number, y: number, z: number) => boolean;
```

#### `nav.groundWalkable`

```ts
/** ground agent, needs solid support below. default body is 1×2×1 (2 blocks high).
 *  feed it to `gridActions`/`groundShortcut`, or wrap it, for "only walk on X" rules. */
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
/** the sink a successor calls once per reachable neighbour cell, its coords plus
 *  the move cost. the search supplies it, so a successor never builds a list. */
export type StepFn = (x: number, y: number, z: number, cost: number) => void;
```

#### `nav.Actions`

```ts
/** the pluggable successor function `findPath`/`floodFill` search over: expand a
 *  cell by calling `step(nx, ny, nz, cost)` for each reachable neighbour. the
 *  candidate moves AND per-cell walkability both live here, so movement can be
 *  context-dependent (ladders, liquids, variable cost). emitting rather than
 *  returning a list means a hot search allocates nothing per expansion. */
export type Actions = (voxels: Voxels, x: number, y: number, z: number, step: StepFn) => void;
```

#### `nav.Heuristic`

```ts
/** admissible-ish distance estimate between two cells. */
export type Heuristic = (fromX: number, fromY: number, fromZ: number, toX: number, toY: number, toZ: number) => number;
```

#### `nav.Shortcut`

```ts
/** line-of-sight test used by `smoothPath`: can the agent travel `from`→`to`
 *  directly (skipping intermediate waypoints)? */
export type Shortcut = (voxels: Voxels, from: Vec3, to: Vec3) => boolean;
```

#### `nav.gridActions`

```ts
/** build an `Actions` from a fixed candidate offset set + a walkability test, the
 *  composer for the common (fixed-offset) case. each offset landing on a walkable
 *  cell becomes a reachable step. compose `groundMoves`/`groundWalkable` here, or
 *  swap in your own moves/walkability, for custom movement. */
export function gridActions(moves: readonly Move[], walkable: Walkable): Actions;
```

#### `nav.groundMoves`

```ts
/** the default ground move set, spread + extend it (e.g. add gap-jumps) and feed
 *  `gridActions` for a custom successor. */
export const groundMoves: readonly Move[];
```

#### `nav.groundActions`

```ts
/** the ready-made ground successor (default 1×2×1 agent). pass it straight to
 *  `findPath`/`floodFill`; wrap it `(v,x,y,z) => groundActions(v,x,y,z).filter(...)`
 *  to add/restrict steps, or rebuild via `gridActions(groundMoves, groundWalkable(...))`
 *  for a different agent. */
export const groundActions: Actions;
```

#### `nav.groundDropActions`

```ts
/** ground successor that ALSO lets the agent walk off a ledge and drop straight down to
 *  the first landing below, to any depth up to `maxDrop`. the fixed ground moves (flat,
 *  ±1 step) come from the standard ground actions; this adds, per cardinal, the one cell
 *  the agent falls to after stepping off the edge. the fall column must stay clear the
 *  whole way (no overhang clips the 2-high body) and the landing needs solid support
 *  below. `maxDrop` MUST be finite: out-of-world reads are air, so a void column has no
 *  floor and the scan would never terminate, the cap doubles as the "don't path off into
 *  the abyss" guard. `dropCost` is the extra cost per block fallen on top of the unit move
 *  (keep it small so drops are taken when they shortcut, but stairs win when costs tie). */
export function groundDropActions(opts?: {
    size?: Vec3;
    maxDrop?: number;
    dropCost?: number;
}): Actions;
```

#### `nav.SearchType`

```ts
/** how the frontier is scored. 'shortest' = classic A* (g + h); 'greedy' =
 *  best-first (h only), faster, not optimal. */
export type SearchType = 'shortest' | 'greedy';
```

#### `nav.FindPathOptions`

```ts
export type FindPathOptions = {
    /** cap on A* iterations (nodes expanded); returns null once exceeded. the
     *  guard against an unreachable/disconnected goal blowing up the search. */
    maxIterations?: number;
    /** frontier scoring. default 'shortest'. */
    searchType?: SearchType;
    /** distance estimate for A* (default euclidean). */
    heuristic?: Heuristic;
};
```

#### `nav.Path`

```ts
/**
 * A route, caller-owned and poolable: cells plus how many of them are live.
 *
 * `count` rather than `cells.length` for the reason `Flood` has one — the cells past it are
 * retained storage from a longer path, and truncating to drop them is what would stop a warmed
 * up `Path` from ever being allocation-free. Never read past `count`; never truncate.
 *
 * This is why every producer takes `out: Path` and not `out: Vec3[]`. An array cannot be
 * genuinely reused: resetting it means `length = 0`, which throws the pooled cells away, so the
 * callee ends up allocating a fresh `[x, y, z]` per cell anyway — an out-param that saves one
 * allocation and churns N. A `Path` owns both halves, so cells are rewritten in place and only
 * a path longer than any before it allocates at all.
 */
export type Path = {
    cells: Vec3[];
    count: number;
};
```

#### `nav.createPath`

```ts
/** an empty `Path`. Grows to its high-water mark, then stops allocating. */
export function createPath(): Path;
```

#### `nav.findPath`

```ts
/**
 * Find a path of cells from `start` to `goal` under the successor function `actions`, into
 * `out`. Returns whether the goal was reached; `out.count` is 0 when it was not.
 *
 * Every cell, never smoothed — smooth explicitly with `smoothPath` if you want steering
 * waypoints. Pass `actions` directly (e.g. `groundActions`), wrap one, or build via
 * `gridActions`. Heuristic defaults to euclidean (override via `options.heuristic`).
 *
 * Uses lazy deletion: a cheaper route to an open cell pushes a fresh node and stale duplicates
 * are skipped on pop (closed check), correct without decrease-key bookkeeping.
 */
export function findPath(out: Path, voxels: Voxels, start: Vec3, goal: Vec3, actions: Actions, options?: FindPathOptions): boolean;
```

#### `nav.smoothPath`

```ts
/** drop redundant waypoints: keep a cell only when the agent can't travel
 *  directly (per `shortcut`) from the last kept cell to the one after it.
 *  never shortcuts across an upward hop, a waypoint whose predecessor is
 *  lower (a +Y step) is preserved so the agent still jumps it. */
export function smoothPath(out: Path, voxels: Voxels, path: Path, shortcut: Shortcut): Path;
```

#### `nav.groundShortcut`

```ts
/** swept-box line-of-sight with gravity descent over a precomputed diagonal trace,
 *  the standard ground smoother for `smoothPath`. won't shortcut uphill. defaults to
 *  the standard ground agent; pass the same `walkable` the path was found with if you
 *  customized it. */
export function groundShortcut(walkable: Walkable = groundWalkable()): Shortcut;
```

#### `nav.FloodMap`

```ts
/**
 * A `Flood`'s own coord → cell-index map: the "have I seen this cell" set, which doubles as the
 * lookup behind `floodIndexOf`.
 *
 * The flood used to borrow the A* table, and that is what made a completed flood unqueryable:
 * one module-level table, reset per search, so it only ever described the MOST RECENT one. Ask
 * a retained flood "did you reach here?" after anything else had run and it answered from
 * somebody else's search.
 *
 * Owning one per flood is also SMALLER, not bigger. A flood needs "first touch?" and nothing
 * else — it never reads a g-score or a closed flag — so this is four Int32Arrays where the A*
 * table carries a Float64 g and a closed byte on top. And because the shapes differ, A* keeps
 * its own table and its own probe loop untouched: nothing hot pays for this.
 *
 * Exported only because `Flood` names it. Treat it as internal.
 */
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
/**
 * A completed flood: the cells reached, the BFS tree that reached them, and the map to look a
 * cell up by coordinate.
 *
 * The tree is the point. A breadth-first expansion necessarily discovers HOW it got to every
 * cell, and throwing that away meant a caller who picked a destination out of the result had to
 * run `findPath` to rediscover a route the flood had already proved exists — two searches for
 * one answer, and the A* could still fail on its own budget.
 *
 * CALLER-OWNED, so it is also safe to keep. `floodFill` refills one of these in place, which
 * means two agents can hold their own without clobbering each other, and one agent can flood
 * once and query it across frames.
 *
 * Only `[0, count)` of `cells`/`parent` is live. Entries beyond it are retained pool storage
 * from a previous, larger fill — never read them, and never truncate them either, since keeping
 * them is what makes a warmed-up `Flood` allocation-free.
 */
export type Flood = {
    /** cells reached, start first, roughly nearest-first. */
    cells: Vec3[];
    /** for each cell, the index it was discovered FROM. `-1` at the start. */
    parent: number[];
    /** how many entries of `cells`/`parent` this fill wrote. */
    count: number;
    /** coord → cell index. internal; go through `floodIndexOf`. */
    map: FloodMap;
};
```

#### `nav.createFlood`

```ts
/** an empty `Flood`, ready to be filled. Grows to its high-water mark, then stops allocating. */
export function createFlood(): Flood;
```

#### `nav.floodFill`

```ts
/**
 * Breadth-first expansion of every cell reachable from `start` under the successor `actions`,
 * written into `out`. `start` is included, first; order is roughly nearest-first.
 *
 * Flood-fill is otherwise unbounded, so `maxIterations` caps cells EXPANDED (the same work
 * budget `findPath` takes); the result includes the frontier discovered up to that bound.
 *
 * Touches no shared state — a fill neither disturbs nor is disturbed by A* or another `Flood`.
 * Returns `out`, so a call reads as an assignment.
 */
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
/**
 * The route from the fill's start to `cells[index]`, start-first — the same cell list
 * `findPath` returns, and smoothable the same way.
 *
 * FREE, in the sense that matters: the flood already found this route, so this only walks the
 * parent chain back. No search, no budget, and no way for it to fail on a cell the flood
 * reached — which is what makes "pick a destination out of a flood" a reachable-by-construction
 * move rather than a hopeful one.
 *
 * `out`'s cells are its own, rewritten in place, so the result survives the next fill — unlike
 * `flood.cells`, which the next fill overwrites.
 */
export function floodPath(out: Path, flood: Flood, index: number): Path;
```

## Players & input

Reading mouse, keyboard, and touch input.

#### `CanvasTouch`

```ts
/**
 * Single canvas touch (one finger). Mirrors Unity's EnhancedTouch.Touch
 * for raw position/start/delta state, and adds latched gesture edge
 * flags (`tapped`/`longPressed`/`swiped`) so scripts can read intent
 * with a single per-touch iteration, same model as the mouse gestures
 * above.
 */
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

    /** first frame this pointerId is observed. */
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

#### `Input`

```ts
export type Input = {
    mouseKeyboard: MouseKeyboardInput;
    touch: TouchInput;
    /** does this room want the pointer locked (desktop mouse-look)? Persistent
     *  room intent, set via `setPointerLock`. Lives here (not on a controller
     *  trait) so it survives a controller being removed and re-added — e.g. the
     *  death→respawn churn — with no relock dance. Default false; the player
     *  controller sets it true in `onInit`, fly/orbit set it false. */
    _lockWanted: boolean;
    /** has this room's controller declared its lock intent at least once (any
     *  `setPointerLock` call)? Distinguishes a freshly-mounted room whose
     *  `_lockWanted=false` is merely the un-run default (intent still pending)
     *  from a live room whose `false` is authoritative. `reconcilePointerLock`
     *  holds a lock through a room swap only while intent is still pending. */
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
    /** currently held keys by KeyboardEvent.code */
    _keyState: Map<string, boolean>;
    /** key state from the previous frame (for just-up; just-down uses _keyJustPressed) */
    _prevKeyState: Map<string, boolean>;
    /**
     * codes that received a non-repeat keydown since last reset. drives
     * isKeyJustDown directly so macOS doesn't drop subsequent presses when
     * Cmd is held (Cmd+letter swallows the letter's keyup on macOS, leaving
     * _keyState stuck true so the prev/current diff fails on the next press).
     */
    _keyJustPressed: Set<string>;
    /**
     * current modifier state. `mod` is cmd-on-mac / ctrl-on-win (e.metaKey
     * || e.ctrlKey), matching the convention used elsewhere in the editor.
     */
    _mods: ModifierState;
    /** modifier state from previous frame */
    _prevMods: ModifierState;
    /** accumulated mouse movement since last reset() */
    _dx: number;
    _dy: number;
    /** current mouse button state */
    _buttons: { left: boolean; right: boolean; middle: boolean };
    /** button state from previous frame */
    _prevButtons: { left: boolean; right: boolean; middle: boolean };
    /** accumulated scroll wheel delta since last reset() */
    _wheelDeltaY: number;
    /** per-button drag-vs-tap discrimination, see MouseButtonGesture */
    _gestures: { left: MouseButtonGesture; middle: MouseButtonGesture; right: MouseButtonGesture };
    /** pointer-lock state, snapshotted once per frame so `is/was/just` agree
     *  within a frame (raw `document.pointerLockElement` can flip mid-frame). */
    _locked: boolean;
    _prevLocked: boolean;
    /** mirrors InputManager._lockReleases: true while a UI surface (library,
     *  dialog, ad, host overlay) is holding pointer input via useReleasePointer,
     *  so the viewport does not own the cursor/wheel. viewport wheel gestures
     *  (orbit dolly, hotbar cycle) read this to ignore scrolls aimed at a panel
     *  instead of sniffing the event target for "is this the game". */
    _pointerCapturedByUi: boolean;
};
```

#### `TouchButtonState`

```ts
export type TouchButtonState = {
    down: boolean;
    /** previous-frame `down`, mirrors the _prevButtons trick above. */
    _prevDown: boolean;
    /** `look:true` buttons also drive the camera while held (a fire button you
     *  can aim with). their drag is forwarded into the same look pipeline as a
     *  right-half canvas drag, see `consumeTouchButtonLookDrag`. */
    look: boolean;
    /** CSS-px drag accumulated since the last consume; meaningful only when `look`. */
    _dragX: number;
    _dragY: number;
};
```

#### `TouchInput`

```ts
export type TouchInput = {
    /** live touches keyed by pointerId. */
    _canvasTouches: Map<number, CanvasTouch>;
    /** touches that ended this frame; cleared by reset. */
    _canvasTouchesEnded: Map<number, CanvasTouch>;
    /** inter-touch distance last frame (for pinch). 0 when !=2 touches. */
    _pinchPrevDist: number;
    /** registered virtual joysticks. id chosen by the script. */
    _joysticks: Map<string, JoystickState>;
    /** registered virtual buttons. */
    _buttons: Map<string, TouchButtonState>;
};
```

#### `consumeTouchButtonLookDrag`

```ts
/** Sum the drag accumulated by every `look:true` button since the last call,
 *  zeroing it. CSS px, same units as a canvas touch's `dx/dy`, so the caller
 *  applies it with the touch look sensitivity. Lets a fire button double as an
 *  aim surface: hold to act, slide to look. Returns `{dx:0, dy:0}` when none. */
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
/**
 * fires for one frame the moment a held button crosses the drag
 * threshold. use in place of `isMouseJustDown` for actions that should
 * commit to a drag gesture (e.g. fly-look pointer-lock), so a quick
 * click doesn't trigger them.
 */
export function isMouseDragStart(mouseKeyboard: MouseKeyboardInput, button: MouseButton): boolean;
```

#### `isMouseJustDown`

```ts
export function isMouseJustDown(mouseKeyboard: MouseKeyboardInput, button: MouseButton): boolean;
```

#### `isMouseJustLocked`

```ts
/** Fires for one frame the moment the pointer becomes locked (unlocked → locked). */
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
/**
 * fires for one frame on button-up when the press never crossed the
 * drag threshold. use for click commit actions (e.g. block placement)
 * so a drag release doesn't double as a tap.
 */
export function isMouseTap(mouseKeyboard: MouseKeyboardInput, button: MouseButton): boolean;
```

#### `isPointerCapturedByUi`

```ts
/** True while a UI overlay is holding pointer input (see _pointerCapturedByUi).
 *  Viewport wheel gestures check this so a scroll over an open panel drives the
 *  panel, not the game. */
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
/** Device is touch-CAPABLE (touch-only or hybrid). true on touchscreen laptops
 *  too — use `isTouchPrimary` to decide whether touch is actually being used. */
export function isTouchDevice(ctx: ScriptContext): boolean;
```

#### `isTouchPrimary`

```ts
/**
 * Touch is the input being used RIGHT NOW ("last input wins", from real pointer
 * events). Unlike `isMobile` this is viewport-INDEPENDENT, so it stays true on a
 * tablet or a phone held in landscape; unlike `isTouchDevice` it's false on a
 * touchscreen laptop driven by its trackpad, and it flips live when a hybrid user
 * switches devices. This is the "should I show on-screen touch controls (joystick,
 * action buttons)" check — gate per-tick so it tracks the current modality.
 */
export function isTouchPrimary(ctx: ScriptContext): boolean;
```

#### `isMobileViewport`

```ts
/** viewport width below the 768px breakpoint. FRAGILE on its own — a phone whose
 *  host page renders desktop-style reports ~980px here — so `isMobile` only uses it
 *  as an extra catch on top of the robust device signal, never as the sole check. */
export function isMobileViewport(): boolean;
```

#### `isMobile`

```ts
/** A phone-class device — the "use a compact/phone HUD LAYOUT" check. Reads the
 *  robust, viewport-independent device probe (Client Hints / UA), so it holds on a
 *  real phone even when the host page (e.g. the editor) renders desktop-width; the
 *  narrow-viewport check is only an extra catch (small window / split-screen). For
 *  gating touch CONTROLS (joystick, action buttons) use `isTouchPrimary`, which is
 *  also true on tablets. */
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
 * room intent (unlike the web's one-shot `element.requestPointerLock()`). Setting
 * `true` attempts to lock right away *if* called during a user gesture (e.g. a
 * held mouse button); otherwise the lock is acquired on the next desktop click.
 * Locking never happens on touch. The player controller sets this `true` in
 * `onInit`; fly/orbit set it `false`; a top-down game opts out with `false`.
 */
export function setPointerLock(ctx: ScriptContext, wanted: boolean): void;
```

#### `isPointerLocked`

```ts
/**
 * Is the pointer locked right now? Use to gate custom look/aim code AND gameplay
 * actions (fire, interact): because acquisition is async, the click that grabs
 * the lock still reads `false` here, so it's naturally swallowed and the next
 * click acts. Always `false` on touch and while any UI is holding the cursor free.
 */
export function isPointerLocked(_ctx: ScriptContext): boolean;
```

#### `releasePointer`

```ts
/**
 * Free the cursor while an in-game panel is open (shop, settings, inventory).
 * Stacks, so nested panels are fine. Does NOT freeze gameplay input — pair with
 * `controls.enabled = false` if you also want movement to stop.
 *
 * `restore()` re-locks *synchronously*, so call it from the panel's close handler
 * (a real user gesture) for a seamless re-lock; closing without a gesture (timer,
 * network) falls back to re-locking on the next canvas click. Returns a no-op
 * handle on the server.
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
 * Client-only override hook for the room's audio listener pose source.
 *
 * By default the audio runtime (`client/audio/audio.ts`) reads listener
 * position + orientation from the client's `pov` node's TransformTrait, the
 * same node the renderer derives the active camera from. That's the
 * right pick for first-person and most third-person cameras, where the
 * "ears" and the "eyes" sit at the same node.
 *
 * Attach this trait to a different node when you want to decouple them,
 * e.g. a third-person camera that orbits the player but should hear
 * the world from the player's head, not from the camera's pose. The
 * first node carrying an active `AudioListenerTrait` wins; the POV
 * node is only consulted as a fallback.
 *
 * `persist: false` because this is a runtime camera/audio routing
 * concern, not part of the saved scene. Disable temporarily by flipping
 * `active: false` rather than removing + re-adding the trait.
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
/** Stable wrapper around a `CommandDef`. Identity plus the live def; the schema
 *  and codec are read through `.def` rather than copied out (see `declare`). */
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
/**
 * define a command. commands are typed network messages.
 *
 * direction determines where send() can be called and where listen() receives:
 * - CLIENT_TO_SERVER: client sends to server (routed via room), server listens per-room
 * - SERVER_TO_CLIENT: server sends/broadcasts to client, client listens
 *
 * handlers are NOT in the definition, they are registered in scripts via listen().
 *
 * ```ts
 * const placeBlock = command('place_block', CLIENT_TO_SERVER, p.object({
 *   x: p.int32(),
 *   y: p.int32(),
 *   z: p.int32(),
 *   blockId: p.string(),
 * }))
 *
 * // in client script:
 * send(ctx, placeBlock, { x: 0, y: 0, z: 0, blockId: 'stone' })
 *
 * // in server script:
 * listen(ctx, placeBlock, (args, from) => { ... })
 * ```
 */
export function command<S extends pack.Schema, D extends RpcDirection>(id: string, direction: D, schema: S): CommandHandle<S, D>;
```
<!-- RenderModule: module not found: api/matchmaking -->
#### `rooms.create`

```ts
/**
 * Create a new room.
 *
 * With `o.sceneId`: boots from that scene's content. Without it: boots EMPTY —
 * just the root node + empty voxels, no content file — for the caller to author
 * itself, e.g. a procedurally generated world written via `setBlock`.
 *
 * Server: allocates a server room in the caller's namespace. Returns the new
 * roomId. Client: creates a local-only ClientRoom.
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
 * Stop a room.
 *
 * Server: destroys the server room. Forbidden across namespaces.
 *
 * Client: disposes a local ClientRoom; throws on server-mirrored rooms
 * (those are membership-driven, not script-controlled).
 */
export function stop(ctx: ScriptContext, roomId: string): void;
```

#### `rooms.recreate`

```ts
/**
 * Recreate the caller's room: boot a fresh room from the same on-disk scene,
 * move every client into it, then destroy the old room. Server-only.
 *
 * The fresh room loads pristine voxels from disk and re-runs every script
 * onInit (fresh authored/spawned entities), and each client re-joins via the
 * normal onJoin path (reset to spawn), i.e. a whole-map reset for a new round.
 * The successor runs the same scripts, so a round timer driving this restarts
 * on its own.
 *
 * Runs inline (no deferral): the old room is torn down with destroyRoom, the
 * direct, non-cascading teardown, which is safe mid-tick because every
 * downstream tick stage iterates queries, and destroyNode removes dying nodes
 * from every query as it goes, so those stages simply see nothing this frame.
 */
export function recreate(ctx: ScriptContext): void;
```

#### `rooms.activate`

```ts
/**
 * Activate a room, make it the focused view.
 *
 * Server form (4 args): instructs `client` to activate (roomId, mode).
 * Sends an `activate_room` message over the per-client outbox.
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
 * List rooms visible to the caller, all roomIds in the caller's
 * namespace (server) or all roomIds the client observes (client).
 */
export function list(ctx: ScriptContext): string[];
```

#### `rooms.view`

```ts
/**
 * Return a ScriptContext pointing at another room. Returns null if the
 * target is unknown (or in a different namespace, server) or not
 * observed (client). Mutation through the returned context is allowed,
 * advanced; it bypasses the calling room's tick boundaries.
 */
export function view(ctx: ScriptContext, roomId: string, o?: {
    mode?: PlayerMode;
}): ScriptContext | null;
```

#### `rooms.join`

```ts
/**
 * Add `client` as a Player in `roomId`. Does NOT activate; pair with
 * rooms.activate when the new view should become focused.
 */
export function join(ctx: ScriptContext, client: Client, roomId: string, o?: {
    mode?: PlayerMode;
}): void;
```

#### `rooms.leave`

```ts
/**
 * Remove `client`'s Player from `roomId`. Does NOT auto-destroy the
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
 * with `chat.listen(ctx, handle, fn)`. spec lives in the room's chat as
 * long as the script instance is alive, auto-removed on dispose.
 */
export function command(ctx: ScriptContext, spec: CommandSpec): CommandHandle;
```

#### `chat.listen`

```ts
/**
 * attach a handler for `handle`'s command, scoped to ctx. when the input
 * pipeline finds a command match with a local listener, the listener runs
 * and the command is "consumed" (not forwarded onward).
 *
 * call on whichever side should execute the command. shared scripts gate
 * with `env.server` / `env.client`.
 */
export function listen(ctx: ScriptContext, handle: CommandHandle, fn: CommandHandler): () => void;
```

#### `chat.onMessage`

```ts
/**
 * listen for plain chat messages broadcast to this room. fires on every
 * non-command message (server-broadcast ChatBroadcast). client-only,
 * server scripts that want to inspect inbound chat should register a
 * `chat.command` of their own.
 */
export function onMessage(ctx: ScriptContext, fn: MessageHandler): () => void;
```

#### `chat.message`

```ts
/**
 * emit a chat message. on the server, broadcasts to every client in the
 * room (appears as a system message). on the client, forwards the text to
 * the server as if the user typed it, useful for programmatic /me, etc.
 *
 * the text may carry inline `[…]` formatting tags, applied by the chat panel
 * as it renders:
 *
 * - `[#rrggbb]`, set the colour to any 24-bit hex (e.g. `[#ff8800]`),
 *   case-insensitive.
 * - `[b]` `[i]` `[u]` `[s]`, turn bold / italic / underline / strike ON.
 * - `[/]`, reset colour and every style back to the default.
 *
 * formatting is cumulative: a colour tag swaps only the colour and leaves any
 * active styles intact (`[b][#ff8800]bold orange`), so colours and styles
 * layer freely, only `[/]` clears them. any bracketed run that isn't a known
 * tag (`[lol]`, `[1]`, an emote) renders verbatim, so ordinary text using
 * brackets is never eaten. tags ride inside the plain string, there's no
 * structured payload, so they degrade gracefully to readable text anywhere
 * the panel isn't doing the rendering.
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
 * enable or disable chat for the calling script's room. state lives on the
 * room's chat (per-room, not global), so call it from a script with ctx. on the
 * client it hides the chat UI; on the server it stops chat propagation (inbound
 * lines and outbound broadcasts are dropped). a shared script hits both sides.
 * default is enabled; apps that embed the engine as a pure display surface
 * call `chat.setEnabled(ctx, false)`.
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
/**
 * Where this client is playing. One verb covers both moves, because they differ
 * only in the destination: a new server of the project they are in, or another
 * project entirely.
 *
 * The transport lives on the `ClientDriver` supplied at engine init — the engine
 * knows a project slug and nothing else. Whether to ask, what the card says, and
 * whether "going" is a navigation or a new tab are all the host's, since routes
 * and navigation are platform knowledge this layer deliberately does not hold.
 */
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
