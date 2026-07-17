# bongle API reference

The exhaustive signature list for the public `bongle` surface, generated from the
package's exports. For a guided, read-top-to-bottom introduction with runnable
examples, see [the guide](./docs.md).

## Scene graph & nodes

Create nodes, compose them with traits, and walk the tree.

<!-- RenderModule: module not found: api/scene-graph -->
#### `TRANSFORM_DIRTY_WORLD_MATRIX`

```ts
export const TRANSFORM_DIRTY_WORLD_MATRIX;
```

#### `TRANSFORM_DIRTY_WORLD_TRS`

```ts
export const TRANSFORM_DIRTY_WORLD_TRS;
```

#### `TRANSFORM_DIRTY_INTERPOLATED_TRS`

```ts
export const TRANSFORM_DIRTY_INTERPOLATED_TRS;
```

#### `TRANSFORM_DIRTY_INTERPOLATED_MATRIX`

```ts
export const TRANSFORM_DIRTY_INTERPOLATED_MATRIX;
```

#### `TRANSFORM_DIRTY_ALL`

```ts
export const TRANSFORM_DIRTY_ALL;
```

#### `TransformTrait`

```ts
/**
 * spatial transform for a node. persisted to scene files, replicated
 * over the network.
 *
 * position/quaternion/scale are **local-space** (relative to parent).
 * they are what the user edits in the inspector, what gets persisted,
 * and what gets synced over the network. write via setPosition/
 * setQuaternion/setScale to trigger dirty-flag propagation.
 *
 * external writes (net sync, scene unpack, editor inspector) bypass the
 * setters and instead route through control.set / sync.unpack callbacks,
 * copy in-place, then markDirty. keeps the Vec3/Quat reference stable
 * for code that caches it.
 *
 * world-space values (worldPosition, worldQuaternion, worldScale,
 * worldMatrix) are computed lazily, read via getWorldPosition/
 * getWorldMatrix/etc which recompute on demand if dirty.
 *
 * visual values (interpolatedWorldPosition, interpolatedWorldQuaternion,
 * interpolatedWorldScale, interpolatedWorldMatrix) are world-space, computed
 * lazily for rendering. they parallel the world chain but compose
 * from `parent.interpolatedWorldMatrix` instead of `parent.worldMatrix`,
 * so interpolation writes upstream automatically flow down through
 * descendants. renderers read via getVisualWorld*, see below.
 */
export const TransformTrait;
```

#### `NetSnapshots`

```ts
export type NetSnapshots = {
    posTime: Float64Array;
    pos: Float32Array;
    posHead: number;
    posCount: number;
    rotTime: Float64Array;
    rot: Float32Array;
    rotHead: number;
    rotCount: number;
};
```

#### `ensureNetSnapshots`

```ts
/** lazily allocate the ring on the first remote pose. owner/local/static nodes
 *  never call this, so they carry a null field and pay nothing. */
export function ensureNetSnapshots(t: TransformTrait): NetSnapshots;
```

#### `pushPositionSnapshot`

```ts
/** append a position keyframe stamped at server-clock `time`. */
export function pushPositionSnapshot(t: TransformTrait, time: number, p: Vec3): void;
```

#### `pushRotationSnapshot`

```ts
/** append a rotation keyframe stamped at server-clock `time`. */
export function pushRotationSnapshot(t: TransformTrait, time: number, q: Quat): void;
```

#### `resetNetSnapshots`

```ts
/** collapse both rings to a single keyframe at `(pos, quat, time)`. used on a
 *  teleport edge (and local→remote ownership handoff) so the sampler holds on the
 *  new pose instead of interpolating across the discontinuity. */
export function resetNetSnapshots(t: TransformTrait, pos: Vec3, rotation: Quat, time: number): void;
```

#### `samplePositionSnapshot`

```ts
/** sample the interpolated local position at `renderTime` into `out`. `frac > 1`
 *  (dry buffer) extrapolates the last-known velocity, the lerp form handles it as-is. */
export function samplePositionSnapshot(snaps: NetSnapshots, renderTime: number, out: Vec3): void;
```

#### `sampleRotationSnapshot`

```ts
/** sample the interpolated local rotation at `renderTime` into `out`. */
export function sampleRotationSnapshot(snaps: NetSnapshots, renderTime: number, out: Quat): void;
```

#### `markTransformDirty`

```ts
export function markTransformDirty(t: TransformTrait): void;
```

#### `markWorldDirty`

```ts
/**
 * mark world transform caches dirty without triggering the snapshot
 * enqueue or replication-dirty flags. used by the buffered (remote-
 * driven) pose unpack: `position`/`quaternion` changed so any consumer
 * of world values (physics queries, audio, GPU upload, descendant
 * compose) needs the same invalidation `markTransformDirty` does, but
 * NOT the `_transformDirty` enqueue (which would copy position→prev on
 * the next snapshot and stomp the buffered path's irrelevant prev) and
 * NOT the pose/scale dirty bits (we're not the owner; we don't re-emit).
 */
export function markWorldDirty(t: TransformTrait): void;
```

#### `markAncestryChanged`

```ts
/**
 * mark a subtree dirty because its *ancestry* changed (reparent, or an
 * ancestor's TransformTrait was added/removed), `parent transform`
 * pointers shifted but local TRS values didn't.
 *
 * unlike `markDirty`, this:
 *   - has no "already maximally dirty" early-out, `_version` must bump
 *     unconditionally so consumers gated on `_version` (e.g. editor
 *     body-sync) catch the world-matrix change even when the node was
 *     already dirty from a prior local write this frame.
 *   - does NOT flag pose/scaleSync dirty, local TRS is unchanged, so
 *     replication doesn't need to retransmit. structural reparenting is
 *     replicated separately by the scene-graph layer.
 */
export function markAncestryChanged(node: Node): void;
```

#### `composeWorldMatrix`

```ts
/**
 * compose one node's worldMatrix from its current local TRS and the
 * (assumed-fresh) parent.worldMatrix. clears TRANSFORM_DIRTY_WORLD_MATRIX;
 * the root branch also clears TRANSFORM_DIRTY_WORLD_TRS since worldP/Q/S
 * are seeded directly. caller must ensure parent.worldMatrix is fresh.
 *
 * the per-node compose is hand-inlined: quat→matrix expansion and
 * parent*local multiply are written directly here rather than calling
 * mat4.fromRotationTranslationScale + mat4.multiply, which:
 *   - eliminates the intermediate `_localMat` scratch
 *   - exploits the affine invariant (bottom row [0 0 0 1]) so the multiply
 *     touches 12 of 16 result cells with 36 mults instead of 64
 *   - is a hot path during skeleton compose and per-frame model rendering
 *
 * called by both `updateWorldTransform`'s lazy walk-up-then-down loop and
 * the animator's eager forward-DFS compose at the end of `tickAnimator`.
 */
export function composeWorldMatrix(n: TransformTrait): void;
```

#### `composeInterpolatedWorldMatrix`

```ts
/**
 * compose one node's interpolatedWorldMatrix from its current local TRS and the
 * (assumed-fresh) parent.interpolatedWorldMatrix. clears
 * TRANSFORM_DIRTY_INTERPOLATED_MATRIX; the root branch also clears
 * TRANSFORM_DIRTY_INTERPOLATED_TRS since interpolatedWorld P/Q/S are seeded directly.
 * caller must ensure parent.interpolatedWorldMatrix is fresh.
 */
export function composeInterpolatedWorldMatrix(n: TransformTrait): void;
```

#### `updateInterpolatedWorldTransform`

```ts
/**
 * ensure interpolatedWorld values are up to date, mirror of
 * `updateWorldTransform`, using the visual dirty bit and visual chain.
 *
 * walks up only through interpolated ancestors; stops at the first clean
 * interpolated ancestor OR the first non-interpolated ancestor. when the
 * boundary parent is non-interpolated, refreshes its worldMatrix so the
 * compose-down loop can source from it (see `composeInterpolatedWorldMatrix`
 * nested branch).
 *
 * caller (the getters) guarantees `t._interpolated === 1`, so the topmost
 * stacked node is always an Interp participant.
 */
export function updateInterpolatedWorldTransform(t: TransformTrait): void;
```

#### `markInterpolatedDescendantsDirty`

```ts
/**
 * mark `node`'s descendant TransformTraits visual-dirty and flag them as
 * participating in interpolation. used by `interpolate()`: when an Interp
 * ancestor's interpolatedWorldMatrix is written, descendants need to recompose
 * visually on next read AND need their `_interpolated` bit set so reader
 * short-circuits flip to the visual chain.
 *
 * does NOT touch the world dirty bits, sim-side worldMatrix chain is
 * independent and stays valid.
 *
 * unlike `markDescendants`, this walk has no "already dirty" early-out:
 * newly-attached subtrees may already be dirty (from creation) but their
 * `_interpolated` bit hasn't been set yet, so we must keep recursing.
 * descendant counts under Interp roots are small (player rigs, attached
 * props), the unconditional walk is fine.
 */
export function markInterpolatedDescendantsDirty(node: Node): void;
```

#### `setInterpolation`

```ts
/**
 * enroll/unenroll a node in the per-frame interpolation pass. mirrors
 * godot's `set_physics_interpolated`.
 *
 * on enable: flips `interpolate` flag, seeds prev pose from the current
 * local pose, and adds the transform to the per-room `_interpolating` set,
 * which the per-frame `interpolate()` loop in `render/interpolation.ts`
 * iterates.
 *
 * on disable: flips the flag off, clears `_interpolated` (so visual getters
 * fall back to the world chain), and removes from the set.
 *
 * idempotent: re-enabling a node that is already on is a no-op; same for
 * disabling. nodes without TransformTrait are silently ignored.
 *
 * server-safe: `_interpolating` exists on both sides but is never iterated
 * server-side. calling this from shared script code (onInit/onDispose) is
 * fine.
 */
export function setInterpolation(node: Node, on: boolean): void;
```

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

#### `setPosition`

```ts
/** set local position and mark dirty. only the position slice replicates. */
export function setPosition(t: TransformTrait, v: Vec3): void;
```

#### `setQuaternion`

```ts
/** set local quaternion and mark dirty. only the quaternion slice replicates. */
export function setQuaternion(t: TransformTrait, q: Quat): void;
```

#### `setScale`

```ts
/** set local scale and mark dirty. only the scale slice replicates. */
export function setScale(t: TransformTrait, v: Vec3): void;
```

#### `setTransform`

```ts
/** set all local transform fields and mark dirty (single dirty pass). */
export function setTransform(t: TransformTrait, pos: Vec3, rot: Quat, scale: Vec3): void;
```

#### `getWorldPosition`

```ts
/** get world-space position, decomposing from worldMatrix if needed. */
export function getWorldPosition(t: TransformTrait): Vec3;
```

#### `getWorldQuaternion`

```ts
/** get world-space quaternion, decomposing from worldMatrix if needed. */
export function getWorldQuaternion(t: TransformTrait): Quat;
```

#### `getWorldScale`

```ts
/** get world-space scale, decomposing from worldMatrix if needed. */
export function getWorldScale(t: TransformTrait): Vec3;
```

#### `getWorldMatrix`

```ts
/** get world matrix, recomputing if dirty. */
export function getWorldMatrix(t: TransformTrait): Mat4;
```

#### `getVisualWorldMatrix`

```ts
/** get the world matrix to render with, visual chain if interpolated, world otherwise. */
export function getVisualWorldMatrix(t: TransformTrait): Mat4;
```

#### `getVisualWorldPosition`

```ts
/** get visual world-space position, lazy-decomposing if deferred. */
export function getVisualWorldPosition(t: TransformTrait): Vec3;
```

#### `getVisualWorldQuaternion`

```ts
/** get visual world-space quaternion, lazy-decomposing if deferred. */
export function getVisualWorldQuaternion(t: TransformTrait): Quat;
```

#### `getVisualWorldScale`

```ts
/** get visual world-space scale, lazy-decomposing if deferred. */
export function getVisualWorldScale(t: TransformTrait): Vec3;
```

#### `computeWorldTransforms`

```ts
/**
 * walk the scene graph parent-first and clear all dirty flags by
 * recomputing world-space transforms. useful as a safety-net at
 * tick boundaries to guarantee everything is clean before interpolation.
 *
 * with lazy recompute in place, most world values will already be clean
 * (read during the tick). this just catches anything that was dirtied
 * but never read.
 */
export function computeWorldTransforms(nodes: SceneTree): void;
```

#### `worldToLocalPosition`

```ts
/**
 * convert a world-space position to local-space for a node.
 * fast path: if no transformed parent, world === local, just copies.
 */
export function worldToLocalPosition(t: TransformTrait, worldPos: Vec3, out: Vec3): Vec3;
```

#### `worldToLocalQuaternion`

```ts
/**
 * convert a world-space quaternion to local-space for a node.
 * fast path: if no transformed parent, world === local, just copies.
 */
export function worldToLocalQuaternion(t: TransformTrait, worldQuat: Quat, out: Quat): Quat;
```

#### `setWorldPosition`

```ts
/**
 * set a node's local position such that its world position matches worldPos.
 * fast path when no transformed parent, just copies into t.position.
 * marks dirty after writing.
 */
export function setWorldPosition(t: TransformTrait, worldPos: Vec3): void;
```

#### `setWorldQuaternion`

```ts
/**
 * set a node's local quaternion such that its world rotation matches worldQuat.
 * fast path when no transformed parent, just copies into t.quaternion.
 * marks dirty after writing.
 */
export function setWorldQuaternion(t: TransformTrait, worldQuat: Quat): void;
```

#### `hasTransformedParent`

```ts
/**
 * returns true if this node has a transformed parent (parent transform pointer is set).
 * used as a fast path check, if false, local === world and no conversion is needed.
 */
export function hasTransformedParent(t: TransformTrait): boolean;
```

#### `collapseTransformIntoChildren`

```ts
/**
 * compose `anchor.local` into each direct-child subtree's first-encountered
 * TransformTrait. used by the play-mode prefab bake to drop the anchor's
 * transform: after this call, each affected descendant's world pose is
 * unchanged, and the anchor's TransformTrait can be safely removed.
 *
 * for each direct child of `anchor`, DFS until a TransformTrait is found
 * and compose:
 *   newLocal = anchor.local ∘ childLocal
 *
 * subtrees with no TransformTrait are left untouched, they inherit the
 * anchor's parent transform once the anchor's transform is removed.
 *
 * callers are responsible for `removeTrait(anchor, TransformTrait)` and
 * any downstream sync (markAncestryChanged on descendants happens
 * automatically via removeTrait's child-pointer update).
 */
export function collapseTransformIntoChildren(anchor: Node): void;
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

#### `getVisualWorldMatrix`

```ts
/** get the world matrix to render with, visual chain if interpolated, world otherwise. */
export function getVisualWorldMatrix(t: TransformTrait): Mat4;
```

#### `getVisualWorldPosition`

```ts
/** get visual world-space position, lazy-decomposing if deferred. */
export function getVisualWorldPosition(t: TransformTrait): Vec3;
```

#### `getVisualWorldQuaternion`

```ts
/** get visual world-space quaternion, lazy-decomposing if deferred. */
export function getVisualWorldQuaternion(t: TransformTrait): Quat;
```

#### `getVisualWorldScale`

```ts
/** get visual world-space scale, lazy-decomposing if deferred. */
export function getVisualWorldScale(t: TransformTrait): Vec3;
```

#### `getWorldMatrix`

```ts
/** get world matrix, recomputing if dirty. */
export function getWorldMatrix(t: TransformTrait): Mat4;
```

#### `getWorldPosition`

```ts
/** get world-space position, decomposing from worldMatrix if needed. */
export function getWorldPosition(t: TransformTrait): Vec3;
```

#### `getWorldQuaternion`

```ts
/** get world-space quaternion, decomposing from worldMatrix if needed. */
export function getWorldQuaternion(t: TransformTrait): Quat;
```

#### `getWorldScale`

```ts
/** get world-space scale, decomposing from worldMatrix if needed. */
export function getWorldScale(t: TransformTrait): Vec3;
```

#### `markDirty`

```ts
export function markDirty(t: TransformTrait): void;
```

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
 * local pose, and adds the transform to the per-room `_interpolating` set,
 * which the per-frame `interpolate()` loop in `render/interpolation.ts`
 * iterates.
 *
 * on disable: flips the flag off, clears `_interpolated` (so visual getters
 * fall back to the world chain), and removes from the set.
 *
 * idempotent: re-enabling a node that is already on is a no-op; same for
 * disabling. nodes without TransformTrait are silently ignored.
 *
 * server-safe: `_interpolating` exists on both sides but is never iterated
 * server-side. calling this from shared script code (onInit/onDispose) is
 * fine.
 */
export function setInterpolation(node: Node, on: boolean): void;
```

#### `setPosition`

```ts
/** set local position and mark dirty. only the position slice replicates. */
export function setPosition(t: TransformTrait, v: Vec3): void;
```

#### `setQuaternion`

```ts
/** set local quaternion and mark dirty. only the quaternion slice replicates. */
export function setQuaternion(t: TransformTrait, q: Quat): void;
```

#### `setScale`

```ts
/** set local scale and mark dirty. only the scale slice replicates. */
export function setScale(t: TransformTrait, v: Vec3): void;
```

#### `setTransform`

```ts
/** set all local transform fields and mark dirty (single dirty pass). */
export function setTransform(t: TransformTrait, pos: Vec3, rot: Quat, scale: Vec3): void;
```

#### `setWorldPosition`

```ts
/**
 * set a node's local position such that its world position matches worldPos.
 * fast path when no transformed parent, just copies into t.position.
 * marks dirty after writing.
 */
export function setWorldPosition(t: TransformTrait, worldPos: Vec3): void;
```

#### `setWorldQuaternion`

```ts
/**
 * set a node's local quaternion such that its world rotation matches worldQuat.
 * fast path when no transformed parent, just copies into t.quaternion.
 * marks dirty after writing.
 */
export function setWorldQuaternion(t: TransformTrait, worldQuat: Quat): void;
```

## Traits & schemas

Define traits and the schemas behind editor controls (`prop`) and network packing (`pack`).

#### `dirty`

```ts
/**
 * `dirty` policy constructors — what counts as a change worth sending. the metric
 * variants bake their metric so it can't be mismatched with the value, and read as
 * English at the call site: `dirty: dirty.distance(0.05)`.
 */
export const dirty: {
    distance: (threshold: number) => DirtyThreshold;
    angle: (threshold: number) => DirtyThreshold;
    scalar: (threshold: number) => DirtyThreshold;
    onChange: () => "onChange";
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

#### `syncMetric`

```ts
/**
 * change metrics for `DirtyThreshold`. each receives the previously-emitted value
 * and the current one (the field's own value, not bytes), returning a magnitude
 * the diff compares against the rate's `threshold`. body-agnostic: a node moved by
 * a rigid body, an AABB body, a script, or an animation all measure the same way.
 */
export const syncMetric: {
    distance(a: ArrayLike<number>, b: ArrayLike<number>): number;
    angle(a: ArrayLike<number>, b: ArrayLike<number>): number;
    scalar(a: number, b: number): number;
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
 * - 'onChange' (default), dirty whenever the packed bytes differ.
 * - 'explicit', never auto-dirty; only `SyncHandle.dirty()` marks it (set-once
 *   fields whose value the byte-diff can't be trusted to catch cheaply).
 * - DirtyThreshold, dirty only on a significant value change (movement/rotation/…).
 */
export type DirtyConfig = 'onChange' | 'explicit' | DirtyThreshold;
```

#### `DirtyThreshold`

```ts
/** threshold dirtiness: the value counts as changed only once `metric(previous,
 *  current)` reaches `threshold` since the last emit. sub-threshold changes
 *  accumulate against the last emitted value, so slow drift still reconciles.
 *  body-agnostic, it reads the field's own value, so it works for any field and any
 *  driver (rigid body, AABB body, script, animation). */
export type DirtyThreshold = {
    threshold: number;
    metric: SyncMetric;
};
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

#### `SyncMetric`

```ts
/** measures how much a sync value changed, receives the previously-emitted value
 *  and the current one, returns a magnitude compared against a `DirtyThreshold`'s
 *  `threshold`. `dirty.{distance,angle,scalar}` cover the common shapes. */
export type SyncMetric = (previous: any, current: any) => number;
```

#### `TraitBase`

```ts
/** base shape of every trait instance, has `_node` back-ref + def back-ref. */
export type TraitBase = {
    _node: Node;
    _def: TraitDef;
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
export type TraitDef = {
    id: string;
    name: string;
    slot: number;
    body: Record<string, unknown>;
    persist: boolean;
    controls: ControlDef[];
    controlsById: Map<string, {
        reg: ControlDef;
        index: number;
    }>;
    sync: SyncDef[];
    syncById: Map<string, {
        reg: SyncDef;
        index: number;
    }>;
    scripts: ScriptDef[];
    scriptsById: Map<string, {
        reg: ScriptDef;
        index: number;
    }>;
    handle: TraitHandle;
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
    readonly _id: string;
    readonly _slot: number;
    readonly _def: TraitDef;
    dependency: {
        registry: 'traits';
        id: string;
    };
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
    [K in keyof S as K extends ReservedTraitKey ? never : K]: S[K] extends Factory<infer R> ? R : S[K];
};
```

#### `TraitOptions`

```ts
/** trait-level options, passed as the third arg to `trait()`. */
export type TraitOptions = {
    name?: string;
    persist?: boolean;
};
```

#### `TraitType`

```ts
/** extract the instance type from a trait handle. */
export type TraitType<H extends TraitHandle> = H['__type'];
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
    scene: Scene;
    subject: SceneTree.Node | null;
    player: SceneTree.Node;
    camera: SceneTree.Node;
    defaultSubject: SceneTree.Node | null;
    defaultCamera: SceneTree.Node;
    domElement: HTMLCanvasElement;
    viewport: HTMLDivElement;
    touchOverlay: HTMLDivElement;
    clientId: ClientId | undefined;
    input: Input;
    state?: EngineClient;
    room?: ClientRoom;
};
```

#### `EditorPlayData`

```ts
/** editor viewpoint pose passed under `EDITOR_JOIN_KEY` in join data. */
export type EditorPlayData = {
    position: [
        number,
        number,
        number
    ];
    quaternion: [
        number,
        number,
        number,
        number
    ];
};
```

#### `EditRoomState`

```ts
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
    id: string;
    subject: SceneTree.Node;
    camera: SceneTree.Node;
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
    characterModelId: string;
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
    mode: 'edit' | 'play';
    trait: T;
    node: SceneTree.Node;
    nodes: SceneTree.SceneTree;
    voxels: Voxels;
    physics: Physics;
    clock: Clock;
    blocks: BlockRegistry;
    client?: ClientContext;
    server?: ServerContext;
    _instance?: ScriptInstance;
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
    dependency: {
        registry: 'scripts';
        id: string;
    };
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
export function broadcast(ctx: ScriptContext, handle: CommandHandle<Scripts.Schema, 'server_to_client'>, data: Scripts.SchemaType<Scripts.Schema>): void;
```

#### `filter`

```ts
export function filter<const Args extends SceneTree.ConditionArgs[]>(ctx: ScriptContext, conditions: Args): SceneTree.Node[];
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
export function listen(ctx: ScriptContext, handle: CommandHandle<Scripts.Schema, 'client_to_server'>, fn: (data: Scripts.SchemaType<Scripts.Schema>, from: Client) => void): Unsubscribe;
```

#### `onBlockBreak`

```ts
/**
 * register a callback that fires when a block of `block`'s type is broken
 * (replaced with air or a different block). server-only.
 */
export function onBlockBreak(ctx: ScriptContext, block: import('../voxels/blocks').BlockHandle, fn: (ev: import('../voxels/blocks').BlockChangeCtx) => void): Unsubscribe;
```

#### `onBlockBuild`

```ts
/**
 * register a callback that fires when a block of `block`'s type is built
 * (placed where air or a different block was). server-only, no-op on the
 * client. handler receives the world coords + new state id; close over
 * `ctx` for scene/room access (e.g. spawn an item, play a sound).
 */
export function onBlockBuild(ctx: ScriptContext, block: import('../voxels/blocks').BlockHandle, fn: (ev: import('../voxels/blocks').BlockChangeCtx) => void): Unsubscribe;
```

#### `onBlockStateChange`

```ts
/**
 * register a callback that fires when a block of `block`'s type changes
 * state in place (same block-type, different stateId). server-only.
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
 * server-only, no-op on the client.
 */
export function onJoin(ctx: ScriptContext, fn: (args: JoinArgs) => void): Unsubscribe;
```

#### `onLeave`

```ts
/**
 * register a callback that fires when a client leaves the room.
 * server-only, no-op on the client.
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
export function query<const Args extends SceneTree.ConditionArgs[]>(ctx: ScriptContext, conditions: Args): SceneTree.Query<SceneTree.ConditionArgsToConditions<Args>>;
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
export function script<T extends TraitBase>(handle: TraitHandle<T>, scriptId: string, factory: ScriptFactory<T>, opts?: ScriptOptions): ScriptDef;
```

#### `send`

```ts
export function send<S extends Scripts.Schema, Direction extends Rpc.RpcDirection>(ctx: ScriptContext, handle: CommandHandle<S, Direction>, data: Scripts.SchemaType<S>, client?: Direction extends typeof Rpc.SERVER_TO_CLIENT ? Client : never): void;
```

## Logging & environment

Tagged logging and the build-time `env` / `platform` flags.

#### `log`

```ts
/** log an info-level message tagged with the script's trait + node. */
export function log(ctx: ScriptContext, ...args: unknown[]): void;
```

#### `warn`

```ts
/** log a warning tagged with the script's trait + node. */
export function warn(ctx: ScriptContext, ...args: unknown[]): void;
```

#### `error`

```ts
/** log an error tagged with the script's trait + node. */
export function error(ctx: ScriptContext, ...args: unknown[]): void;
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
 * (`EngineAssetPipeline`), not a headless variant of the client.
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
 * Game-facing bridge to the active host portal (CrazyGames / Poki / none).
 * Client-only. The transport lives on the ClientDriver supplied at engine init,
 * this just hands off to it. Standalone / bongle-dev hosts wire these to an
 * inert impl, so a game can call them unconditionally regardless of where it's
 * running.
 *
 * Loading/gameplay lifecycle is NOT here, the host infers that from the
 * connection. These are the ad moments only the game knows the timing of
 * (between rounds, on death, etc.).
 *
 * Audio is muted for the duration of every ad automatically: we set
 * `state.adActive` while the ad runs, and the client update loop reconciles the
 * engine's audio output mute against it each frame. Games don't think about it.
 */
export const platform: {
    commercialBreak(ctx: ScriptContext): Promise<void>;
    rewardedBreak(ctx: ScriptContext): Promise<boolean>;
};
```

## Assets

Declare models, sounds, and sprites, and keep data-only handles alive.

#### `asset`

```ts
export function asset(rel: string, base: string): string;
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
export function getModel(ctx: ScriptContext, id: string): ModelHandle | null;
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
    url: string | {
        client: string;
        server: string;
    };
    hash?: string;
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
export function loadModel(ctx: ScriptContext, id: string, options: LoadModelOptions): Promise<ModelHandle>;
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
#### `SoundHandle`

```ts
export type SoundHandle = {
    readonly soundId: string;
    readonly name: string;
    dependency: {
        registry: 'sounds';
        id: string;
    };
    readonly src: string;
    readonly long: boolean;
    readonly duration: number;
    version: number;
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
export type SoundOptions = {
    name?: string;
    src: string;
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
#### `SpriteHandle`

```ts
export type SpriteHandle = {
    spriteId: string;
    name: string;
    dependency: {
        registry: 'sprites';
        id: string;
    };
    src: NormalizedImageSource | NormalizedImageSource[];
    padding: number;
    mipmap: boolean;
};
```

#### `SpriteOptions`

```ts
export type SpriteOptions = {
    name?: string;
    src: ImageSource | ImageSource[];
    padding?: number;
    mipmap?: boolean;
};
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

#### `spriteAtlasTexture`

```ts
/**
 * Resolve the engine-global sprite atlas `Texture`, escape hatch for
 * advanced scripts that want to write a custom material sampling the
 * atlas directly. Returns `null` server-side or before the client has
 * finished `load()`. Prefer `sampleSprite()` (step 7) over raw atlas
 * access where possible, atlas-layout shifts on every registry change,
 * but `sampleSprite()`'s LUT indirection absorbs them.
 */
export function spriteAtlasTexture(ctx: ScriptContext): Texture | null;
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

Also exported: `DrawFn`, `DrawInputs`, `DrawParams`, `DrawSource`, `ImageSource`, `NormalizedImageSource`, `draw`.
#### `use`

```ts
/**
 * Keep a handle alive through bundler tree-shaking.
 *
 * `block()` / `model()` / `sound()` / `blockTexture()` register into the
 * engine's registries when their declaration is evaluated. If a game
 * never references a handle in code (e.g. blocks listed only in a
 * scene's voxel palette, models referenced only by prefab id), prod
 * bundlers may drop the declaration as dead code, the registration
 * then never happens and the scene fails to load.
 *
 * `use()` is a non-pure call that takes the handles you depend on:
 *
 *   import { use } from 'bongle';
 *   import { blocks } from 'bongle/starter';
 *
 *   // scene data references `starter:stone`, keep its declaration alive.
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

#### `_registerScenePayload`

```ts
/**
 * called at module-eval by the per-project codegen barrel
 * `src/generated/scenes.ts` (one call per discovered scene file).
 *
 *   - existing handle → mutate `_payload` in place so user-held refs stay
 *     valid.
 *   - no handle yet → register one under `PLACEHOLDER_OWNER` so it's
 *     visible through `registry.scenes` (icon renderer, editor inventory).
 *     If the user later declares the id via `scene()`, `claimOwnership`
 *     promotes the placeholder to the user module. Edit mode's filesystem
 *     walk surfaces every `.scene.json` (including blueprints), so many
 *     ids never get a user-side `scene()` and stay as placeholders, fine.
 *
 * Exposed via `bongle/internal`.
 */
export function _registerScenePayload(id: string, payload: ScenePayload): void;
```

Also exported: `SceneHandle`, `SceneOptions`.
#### `PrefabType`

```ts
/**
 * what a prefab produces when instantiated.
 *   - 'voxels', voxel content only (`fn` populates the empty `ctx.voxels` canvas)
 *   - 'nodes', node children only (`fn` attaches children under `ctx.root`)
 *   - 'composite', both voxels and nodes
 */
export type PrefabType = 'voxels' | 'nodes' | 'composite';
```

#### `PrefabDef`

```ts
export type PrefabDef<Args = unknown> = {
    id: string;
    name: string;
    type: PrefabType;
    deps: ReadonlyArray<DepHandle>;
    argsSchema: Schema;
    defaultArgs: Args;
    node?: {
        realm?: Realm;
    };
    apply: (ctx: PrefabApplyContext, args: Args) => void;
};
```

#### `PrefabHandle`

```ts
export type PrefabHandle<Args = unknown> = {
    readonly id: string;
    readonly name: string;
    dependency: {
        registry: 'prefabs';
        id: string;
    };
    readonly type: PrefabType;
    readonly argsSchema: Schema;
    readonly defaultArgs: Args;
    readonly node: {
        realm?: Realm;
    } | undefined;
    readonly __args: Args;
};
```

#### `PrefabOptions`

```ts
export type PrefabOptions<T extends PrefabType, S extends Schema> = {
    name?: string;
    type: T;
    deps?: ReadonlyArray<DepHandle>;
    args?: {
        schema: S;
        default: SchemaType<S>;
    };
    fn?: (ctx: PrefabApplyContext<T>, args: SchemaType<S>) => void;
    node?: {
        realm?: Realm;
    };
};
```

#### `prefab`

```ts
/**
 * declare a prefab def at module scope.
 */
export function prefab<T extends PrefabType>(id: string, options: {
    type: T;
    deps?: ReadonlyArray<DepHandle>;
    node?: {
        realm?: Realm;
    };
    fn?: (ctx: PrefabApplyContext<T>, args: Record<string, never>) => void;
}): PrefabHandle<Record<string, never>>;
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
    nodeName: string;
    property: ClipChannelProperty;
    interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
    times: Float32Array;
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

#### `ModelHandle`

```ts
/**
 * Static handle for a single model. Codegen'd into `<basename>.glb.generated.ts`,
 * never constructed at runtime.
 *
 * Fully typed against the source gltf:
 *   - NodeNames: union of all named gltf nodes (mesh-bearing or not)
 *   - MeshNames: union of all mesh names
 *   - ClipNames: union of all animation clip names
 */
export type ModelHandle<NodeNames extends string = string, MeshNames extends string = string, ClipNames extends string = string> = {
    readonly modelId: string;
    readonly name: string;
    dependency: {
        registry: 'models';
        id: string;
    };
    readonly src: string;
    readonly bin: {
        readonly client: string;
        readonly server: string;
    };
    readonly scene: Node;
    readonly aabb: Box3;
    readonly nodes: {
        readonly [K in NodeNames]: Node;
    };
    readonly meshes: {
        readonly [K in MeshNames]: {
            readonly id: MeshId;
            readonly aabb: Box3;
        };
    };
    readonly animations: {
        readonly [K in ClipNames]: ClipDef;
    };
    version: number;
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
export type ModelOptions = {
    name?: string;
    src: string;
};
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

#### `AABB`

```ts
/** [minX, minY, minZ, maxX, maxY, maxZ] in block-local [0,1]³. */
export type AABB = readonly [
    number,
    number,
    number,
    number,
    number,
    number
];
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
export type AABB = readonly [
    number,
    number,
    number,
    number,
    number,
    number
];
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
 * @param texture - texture ref (BlockTextureDef handle or string id)
 * @param options - optional uvs, cullFace, material
 */
export function quad(verts: [
    Vec3,
    Vec3,
    Vec3,
    Vec3
], normal: Vec3, texture: TextureRef, options?: {
    uvs?: [
        Vec2,
        Vec2,
        Vec2,
        Vec2
    ];
    cullFace?: CullFace;
    material?: MaterialType;
}): BlockQuad;
```

#### `blockModel.box`

```ts
/**
 * generate 6 quads (one per face) from an axis-aligned box.
 *
 * @param from - min corner [x, y, z] in block-local space [0, 1]
 * @param to - max corner [x, y, z] in block-local space [0, 1]
 * @param textures - texture assignment, same format as CubeTextures
 * @param options - optionally exclude faces or override cull behavior
 */
export function box(from: Vec3, to: Vec3, textures: CubeTextures, options?: {
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

#### `blockModel.cross`

```ts
/**
 * create two intersecting diagonal planes (4 quads, front + back per plane).
 * used for vegetation: flowers, tall grass, saplings, mushrooms, etc.
 */
export function cross(texture: TextureRef, options?: {
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

#### `blockPreset.cube`

```ts
export function cube(id: string, textures: CubeTextures, options?: PresetOptions);
```

#### `blockPreset.column`

```ts
export function column(id: string, textures: {
    end: TextureRef;
    side: TextureRef;
}, options?: PresetOptions);
```

#### `blockPreset.stairs`

```ts
export function stairs(id: string, textures: CubeTextures, options?: PresetOptions);
```

#### `blockPreset.slab`

```ts
export function slab(id: string, textures: CubeTextures, options?: PresetOptions);
```

#### `blockPreset.plant`

```ts
export function plant(id: string, texture: TextureRef, options?: PresetOptions);
```

#### `blockPreset.leaves`

```ts
export function leaves(id: string, textures: CubeTextures, options?: PresetOptions);
```

#### `blockPreset.ladder`

```ts
export function ladder(id: string, texture: TextureRef, options?: PresetOptions);
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
    level(n: number): string;
    max(): string;
};
```

#### `blockPreset.liquid`

```ts
export function liquid(id: string, textures: CubeTextures, options?: PresetOptions & {
    viscosity?: number;
    translucent?: boolean;
    levels?: number;
    fluidGroup?: string;
    tint?: ScreenTintSpec;
    maxHeight?: number;
    lightEmission?: [
        number,
        number,
        number
    ];
    emissive?: boolean;
}): LiquidHandle;
```

#### `blockPreset.fence`

```ts
export function fence(id: string, textures: CubeTextures, options?: PresetOptions);
```

#### `blockPreset.pane`

```ts
export function pane(id: string, textures: CubeTextures, options?: PresetOptions);
```

#### `blockPreset.carpet`

```ts
export function carpet(id: string, textures: CubeTextures, options?: PresetOptions);
```

#### `blockPreset.trapdoor`

```ts
export function trapdoor(id: string, textures: CubeTextures, options?: PresetOptions);
```

#### `blockPreset.plate`

```ts
export function plate(id: string, texture: TextureRef, options?: PresetOptions);
```

#### `blockPreset.wall`

```ts
export function wall(id: string, textures: CubeTextures, options?: PresetOptions);
```

#### `blockPreset.torch`

```ts
export function torch(id: string, texture: TextureRef, options?: PresetOptions & {
    lightEmission?: [
        number,
        number,
        number
    ];
});
```

#### `blockPreset.door`

```ts
export function door(id: string, textures: {
    top: TextureRef;
    bottom: TextureRef;
}, options?: PresetOptions);
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
    totalStates: number;
    blockCount: number;
    defs: BlockDef[];
    idToDef: Map<string, BlockDef>;
    handles: BlockHandle[];
    idToHandle: Map<string, BlockHandle>;
    stateToBlockIndex: Uint16Array;
    stateToLocalIndex: Uint16Array;
    modelType: Uint8Array;
    cubeTexIndices: Uint16Array;
    cubeFaceUVs: Uint8Array;
    meshId: Uint16Array;
    meshQuads: BlockQuad[][];
    meshTexIndices: Uint16Array[];
    meshQuadMaterials: Uint8Array[];
    meshQuadShape: Uint8Array[];
    meshQuadFaceDir: Uint8Array[];
    meshQuadCullFaceDir: Uint8Array[];
    meshQuadDepth: Float32Array[];
    meshQuadVertDepth: Float32Array[];
    meshQuadVertNormal: Float32Array[];
    meshQuadCornerUV: Float32Array[];
    meshQuadCornerPos: Float32Array[];
    meshQuadCornerNormSq: Float32Array[];
    meshQuadNormal: Float32Array[];
    meshQuadUVs: Float32Array[];
    meshQuadVerts: Float32Array[];
    colliderId: Uint16Array;
    colliderShapes: Shape[];
    shapeKind: Uint8Array;
    shapeAabbs: AABB[][];
    cull: Uint8Array;
    blockTypeId: Uint16Array;
    material: Uint8Array;
    vertexAnimation: Uint8Array;
    lightEmission: Uint16Array;
    lightOpacity: Uint8Array;
    emissive: Uint8Array;
    flags: Uint32Array;
    friction: Float32Array;
    restitution: Float32Array;
    liquidViscosity: Float32Array;
    surfaceHeight: Float32Array;
    fluidGroup: Uint16Array;
    screenTint: Float32Array;
    sounds: (BlockSoundConfig | undefined)[];
    particles: (BlockParticleConfig | undefined)[];
    stateToKey: string[];
    keyToState: Map<string, number>;
    textures: string[];
    textureIndex: Map<string, number>;
    texAnimData: Float32Array;
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

#### `MISSING`

```ts
/** global state id for missing/unresolved blocks. always 1. */
export const MISSING;
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
export type PropValue<P extends PropDef> = P extends BoolPropDef ? boolean : P extends EnumPropDef<infer V> ? V[number] : P extends IntPropDef ? number : never;
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
    readonly props: P;
    readonly totalStates: number;
    encode(values: PropsValues<P>): number;
    decode(index: number): PropsValues<P>;
    get<K extends string & keyof P>(index: number, prop: K): PropValue<P[K]>;
    with<K extends string & keyof P>(index: number, prop: K, value: PropValue<P[K]>): number;
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
export type BlockHandle<P extends PropsDef = PropsDef> = {
    readonly id: string;
    readonly name: string;
    dependency: {
        registry: 'blocks';
        id: string;
    };
    readonly states: BlockStateDef<P>;
    readonly _def: BlockDef<P>;
    _index: number;
    _baseStateId: number;
    readonly totalStates: number;
    _hooks: number;
    stateId(props: PropsValues<P>): number;
    stateIdLocal(localIdx: number): number;
    defaultId(): number;
    stateKey(props: PropsValues<P>): string;
    defaultKey(): string;
};
```

#### `BlockModel`

```ts
export type BlockModel = CubeModel | CustomModel;
```

#### `BlockOptions`

```ts
export type BlockOptions<P extends PropsDef = PropsDef> = {
    name?: string;
    states?: BlockStateDef<P>;
    defaultState?: PropsValues<P>;
    model?: (props: PropsValues<P>) => BlockModel;
    cull?: CullType | ((props: PropsValues<P>) => CullType);
    material?: MaterialType | ((props: PropsValues<P>) => MaterialType);
    vertexAnimation?: VertexAnimation | ((props: PropsValues<P>) => VertexAnimation);
    lightEmission?: [
        number,
        number,
        number
    ] | ((props: PropsValues<P>) => [
        number,
        number,
        number
    ]);
    lightOpacity?: number | ((props: PropsValues<P>) => number);
    emissive?: boolean | ((props: PropsValues<P>) => boolean);
    collision?: boolean | ((props: PropsValues<P>) => boolean);
    selection?: boolean | ((props: PropsValues<P>) => boolean);
    shape?: BlockShape | ((props: PropsValues<P>) => BlockShape);
    climbable?: boolean | ((props: PropsValues<P>) => boolean);
    liquid?: {
        viscosity: number;
    } | null | ((props: PropsValues<P>) => {
        viscosity: number;
    } | null);
    pathfindable?: boolean | ((props: PropsValues<P>) => boolean);
    friction?: number | ((props: PropsValues<P>) => number);
    restitution?: number | ((props: PropsValues<P>) => number);
    sneakGuard?: boolean | ((props: PropsValues<P>) => boolean);
    flags?: number;
    surfaceHeight?: number | ((props: PropsValues<P>) => number);
    fluidGroup?: string;
    screenTint?: ScreenTintSpec | ((props: PropsValues<P>) => ScreenTintSpec | undefined);
    sounds?: BlockSoundConfig | ((props: PropsValues<P>) => BlockSoundConfig);
    onNeighbourUpdate?: OnNeighbourUpdateFn;
    onNeighbourChanged?: OnNeighbourChangedFn;
    place?: PlaceFn;
    rotate?: RotateFn;
    flip?: FlipFn;
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
    verts: [
        Vec3,
        Vec3,
        Vec3,
        Vec3
    ];
    normal: Vec3;
    texture: TextureRef;
    uvs?: [
        Vec2,
        Vec2,
        Vec2,
        Vec2
    ];
    cullFace?: 'north' | 'south' | 'east' | 'west' | 'up' | 'down';
    material?: MaterialType;
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
 * `bongle/starter` or build a fully custom config. All slots
 * optional; omit a category to leave it silent.
 *
 * NOTE: the systems that actually drive playback off these handles
 * (character-controller footstep tick, voxel break/place hooks) are
 * not yet wired, for now this is stored on the def for future use.
 */
export type BlockSoundConfig = {
    footstep?: readonly SoundHandle[];
    dig?: readonly SoundHandle[];
    break?: readonly SoundHandle[];
    place?: readonly SoundHandle[];
};
```

#### `BlockTextureDef`

```ts
export type BlockTextureDef = {
    id: string;
    dependency: {
        registry: 'blockTextures';
        id: string;
    };
    frames: NormalizedImageSource[];
    fps: number;
    interpolate: boolean;
};
```

#### `BlockTextureOptions`

```ts
export type BlockTextureOptions = {
    src: ImageSource | ImageSource[];
    fps?: number;
    interpolate?: boolean;
};
```

#### `CubeModel`

```ts
/** cube model, standard solid block. */
export type CubeModel = {
    type: 'cube';
    textures: CubeTextures;
};
```

#### `CubeTextures`

```ts
/** per-face texture assignment for a cube model. */
export type CubeTextures = {
    all: CubeFaceSpec;
} | {
    top: CubeFaceSpec;
    bottom: CubeFaceSpec;
    sides: CubeFaceSpec;
} | {
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
    quads: BlockQuad[];
};
```

#### `TextureRef`

```ts
export type TextureRef = BlockTextureDef | string;
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

#### `blockTexture`

```ts
/**
 * declare a block texture. called at module scope.
 *
 * pass a single src for static textures, or an array for animated
 * textures (one entry per frame). each entry may be a string path,
 * a URL, or a `draw()` descriptor; flipbook frames mix freely.
 *
 * returns a handle that can be passed to block model definitions.
 */
export function blockTexture(id: string, options: BlockTextureOptions): BlockTextureDef;
```

#### `resolveTextureRef`

```ts
/** resolve a TextureRef to its string id. */
export function resolveTextureRef(ref: TextureRef): string;
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
    toi: number;
    axis: number;
    sign: number;
    normalX: number;
    normalY: number;
    normalZ: number;
    vx: number;
    vy: number;
    vz: number;
    stateId: number;
    subAabbIndex: number;
    boxMinX: number;
    boxMinY: number;
    boxMinZ: number;
    boxMaxX: number;
    boxMaxY: number;
    boxMaxZ: number;
    overlapDepth: number;
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
 * `out` is reset internally; on return, `out.axis === -1` iff no hit.
 */
export function sweepAabbVsVoxels(voxels: Voxels, mcX: number, mcY: number, mcZ: number, mhX: number, mhY: number, mhZ: number, dx: number, dy: number, dz: number, out: VoxelSweepHit): boolean;
```

#### `VoxelRaycastResult`

```ts
export type VoxelRaycastResult = {
    hit: boolean;
    px: number;
    py: number;
    pz: number;
    nx: number;
    ny: number;
    nz: number;
    distance: number;
    voxelX: number;
    voxelY: number;
    voxelZ: number;
    stateId: number;
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
export function raycastVoxels(out: VoxelRaycastResult, voxels: Voxels, registry: BlockRegistry, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDistance: number, requiredFlags: number): VoxelRaycastResult;
```

#### `Chunk`

```ts
/** chunk data structure */
export type Chunk = {
    cx: number;
    cy: number;
    cz: number;
    wx: number;
    wy: number;
    wz: number;
    nonAirCount: number;
    solidCount: number;
    paletteKeys: string[];
    palette: number[];
    paletteMap: Map<string, number>;
    data: Uint16Array;
    light: Uint16Array;
    dirty: boolean;
    meshGen: number;
    version: number;
    lightDirty: boolean;
    lightDirtyMask: Uint8Array;
    lightDirtyCount: number;
    compressedSnapshot: Uint8Array | null;
    snapshotPalette: string[] | null;
    compressedLight: {
        sky: Uint8Array;
        rgb: Uint8Array;
    } | null;
    neighbors: (Chunk | null)[];
    knownNeighbourCount: number;
};
```

#### `Voxels`

```ts
export type Voxels = {
    chunks: Map<string, Chunk>;
    dirty: {
        blocks: Set<Chunk>;
        light: Set<Chunk>;
    };
    columns: Map<string, Chunk[]>;
    registry: BlockRegistry;
    authority: VoxelsAuthority | null;
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
    changes: VoxelChanges;
    observers: Map<number, BlockObserverEntry> | null;
    floodFillLighting: FloodFillLightingState;
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

#### `toChunkCoord`

```ts
/** world position → chunk coordinate (floored division). */
export function toChunkCoord(worldCoord: number): number;
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
 *  feet land if standing on top of block `(x, y, z)`. block N occupies
 *  `[N, N+1)`, so the top-center is `(x + 0.5, y + 1, z + 0.5)`. */
export function blockTopCenter(out: Vec3, x: number, y: number, z: number): Vec3;
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
/** remove a chunk from `voxels.chunks`, unlinking it from the neighbour graph. */
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
export function ensureChunkPaletteSlot(chunk: Chunk, key: string, registry: BlockRegistry): number;
```

#### `chunkData`

```ts
/** the chunk's writable voxel-data array, COWing out of the shared EMPTY_DATA
 *  stub first so a direct write can't corrupt the singleton. for tier-1 raw
 *  fills: grab this, write/`.fill()` slots into it, then call invalidateChunk. */
export function chunkData(chunk: Chunk): Uint16Array;
```

#### `setChunkBlock`

```ts
/**
 * set a block at a chunk-local position — the meat of a voxel write. resolves
 * the palette slot, writes the cell, maintains nonAir/solid counts + mesh gen,
 * registers the chunk mesh-dirty, and (when `voxels` is authoritative) records
 * the op and routes lighting by flag:
 *   DEFAULT → per-block incremental (pendingLight) + inline hook drain
 *   BULK    → whole-chunk relight (staleLightChunks) + skip inline hooks
 * All authority-side work no-ops when `voxels.authority` is null (client mirror,
 * bare test fixtures) — those get just the data + palette + counts.
 *
 * `setBlock` is a thin wrapper over this that resolves world coords → chunk.
 * no bounds checking, caller ensures 0 <= x,y,z < CHUNK_SIZE.
 */
export function setChunkBlock(voxels: Voxels, chunk: Chunk, x: number, y: number, z: number, key: string, flags: number = SetBlockFlags.DEFAULT): void;
```

#### `invalidateChunk`

```ts
/**
 * reconcile a chunk after tier-1 raw writes into `chunkData(chunk)`: rescans
 * nonAir/solid counts from the data + palette, marks the chunk mesh-dirty and
 * schedules its light (a tick-end whole-chunk relight, or an inline flat seed
 * when flood-fill is disabled). No ops, no hooks — the raw-write path trades
 * those away for speed. no-op past the rescan when `voxels.authority` is null.
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
export function resolveChunk(chunk: Chunk, registry: BlockRegistry): void;
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
    data: number;
    wx: number;
    wy: number;
    wz: number;
    oldStateId: number;
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
 *   - `light`       → flushPendingLight (relight)
 */
export type VoxelChanges = {
    ops: VoxelOp[];
    addedChunks: Set<Chunk>;
    light: {
        blocks: Array<{
            wx: number;
            wy: number;
            wz: number;
            oldStateId: number;
        }>;
        chunks: Set<Chunk>;
        newChunks: Chunk[];
        epoch: number;
    };
};
```

#### `createVoxelChanges`

```ts
export function createVoxelChanges(): VoxelChanges;
```

#### `clearVoxelChanges`

```ts
/**
 * clear the network per-tick state after end-of-tick dispatch. the `light`
 * queues are cleared by their own consumer (flushPendingLight, which runs
 * earlier in the tick); `light.epoch` is monotonic and never cleared.
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
 * lives inside `VoxelsAuthority`, only meaningful when this Voxels owns
 * the truth and drives light propagation.
 */
export type FloodFillLightingState = {
    enabled: boolean;
    minLevel: number;
};
```

#### `createVoxelsAuthority`

```ts
export function createVoxelsAuthority(): VoxelsAuthority;
```

#### `clearVoxelsAuthority`

```ts
/** clear per-tick state inside the authority bundle. observer registry
 *  and lighting config are NOT cleared, they outlive a tick. */
export function clearVoxelsAuthority(authority: VoxelsAuthority): void;
```

#### `createVoxels`

```ts
export function createVoxels(registry: BlockRegistry): Voxels;
```

#### `markChunkDirty`

```ts
/** mark `chunk` as needing a remesh. routes through here (instead of
 *  setting `chunk.dirty = true` directly) so the renderer's per-frame
 *  scan can iterate `voxels.dirty.blocks` instead of the whole Map. */
export function markChunkDirty(voxels: Voxels, chunk: Chunk): void;
```

#### `markChunkLightDirty`

```ts
/** mark `chunk` as needing a relight. adds to BOTH `dirty.blocks` (so the
 *  client renderer remeshes, meshChunk emits geometry+light in one pass)
 *  AND `dirty.light` (so the server's chunk_light streaming path can find
 *  light-only changes without filtering a growing blocks set). */
export function markChunkLightDirty(voxels: Voxels, chunk: Chunk): void;
```

#### `rebuildColumns`

```ts
/** rebuild `voxels.columns` from `voxels.chunks`. used by deserialize and as
 *  a defensive reconcile when callers bypass `ensureChunk` (tests/benches). */
export function rebuildColumns(voxels: Voxels): void;
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
 * (camera node Transform + this trait), see `Renderer.syncRenderCamera`.
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
    sky?: {
        preset?: SkyPreset;
        stops?: SkyStop[];
    };
    sun?: {
        enabled?: boolean;
        intensity?: number;
    };
    moon?: {
        enabled?: boolean;
    };
    stars?: {
        enabled?: boolean;
        density?: number;
    };
    clouds?: {
        enabled?: boolean;
        density?: number;
        wind?: Vec2;
        altitude?: number;
        thickness?: number;
    };
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
 * merge a partial config into the room's environment. slow path, writes
 * the config storage buffer. call from script init or in response to game
 * events, not every frame.
 *
 * `sky.preset` and `sky.stops` are mutually exclusive at merge time: if
 * both are set, `stops` wins. presets compile to a `stops` array here.
 */
export function setEnvironment(ctx: ScriptContext, config: EnvironmentConfig): void;
```
#### `MeshTrait`

```ts
export const MeshTrait;
```

#### `setMeshTint`

```ts
/** set per-instance tint (rgb target, a intensity) and flag the renderer
 *  to re-upload params. */
export function setMeshTint(t: MeshTrait, v: Vec4): void;
```

#### `setMeshFlash`

```ts
/** set the transient flash overlay [r,g,b,a] (rgb colour, a strength) and
 *  flag the renderer to re-upload params. */
export function setMeshFlash(t: MeshTrait, v: Vec4): void;
```

#### `setMeshLight`

```ts
/** set per-instance voxel light contribution and flag the renderer. */
export function setMeshLight(t: MeshTrait, v: Vec4): void;
```

#### `setMeshGlow`

```ts
/** set per-instance self-illumination (0-1; lights the mesh in its own colour,
 *  no white wash) and flag the renderer. */
export function setMeshGlow(t: MeshTrait, v: number): void;
```

#### `setMeshUnlit`

```ts
/** opt out of voxel + sun lighting; render the texture flat. */
export function setMeshUnlit(t: MeshTrait, v: boolean): void;
```

#### `setMeshLitMin`

```ts
/** set the voxel-light floor (0-1). 0 = no floor; 1 = effectively self-lit. */
export function setMeshLitMin(t: MeshTrait, v: number): void;
```

#### `setMeshDither`

```ts
/** set the screen-door fade (0-1). 0 = solid; 1 = fully invisible. */
export function setMeshDither(t: MeshTrait, v: number): void;
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
    dust: UpdateFn;
    smoke: UpdateFn;
    spark: UpdateFn;
    snow: UpdateFn;
    rain: UpdateFn;
};
```

#### `ParticleHandle`

```ts
export type ParticleHandle = {
    typeId: string;
    name: string;
    dependency: {
        registry: 'particles';
        id: string;
    };
    sprite: SpriteHandle;
    playback: ParticlePlayback;
    fps: number;
    update: UpdateFn;
    glow: number;
    tint: [
        r: number,
        g: number,
        b: number,
        a: number
    ];
};
```

#### `ParticleOptions`

```ts
export type ParticleOptions = {
    name?: string;
    sprite: SpriteHandle;
    playback: ParticlePlayback;
    fps?: number;
    update: UpdateFn;
    glow?: number;
    tint?: [
        r: number,
        g: number,
        b: number,
        a: number
    ];
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
 *  compacted by `Particles.update` (client). The type is declared here
 *  so `UpdateFn` (also here) can name its first param without forcing a
 *  core→client import; the runtime that allocates / mutates it lives in
 *  client. Both halves agree on the layout via this single declaration. */
export type ParticlePool = {
    capacity: number;
    count: number;
    handle: Array<ParticleHandle | null>;
    updateFn: Array<UpdateFn | null>;
    posX: Float32Array;
    posY: Float32Array;
    posZ: Float32Array;
    prevX: Float32Array;
    prevY: Float32Array;
    prevZ: Float32Array;
    velX: Float32Array;
    velY: Float32Array;
    velZ: Float32Array;
    spawnTime: Float32Array;
    expiresAt: Float32Array;
    size: Float32Array;
    glow: Float32Array;
    tintR: Float32Array;
    tintG: Float32Array;
    tintB: Float32Array;
    tintA: Float32Array;
    seed: Uint32Array;
};
```

#### `UpdateFn`

```ts
/** per-particle update fn, owns motion, collision, and death.
 *  invoked once per tick per alive slot. write `pool.expiresAt[i] = 0`
 *  to kill from inside the fn. `voxels` is the room's voxel world,
 *  threaded so `collide*` primitives can query `BLOCK_FLAG_COLLISION`
 *  without the pool carrying a back-ref. pure-motion fns ignore it. */
export type UpdateFn = (pool: ParticlePool, i: number, dt: number, voxels: Voxels) => void;
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
    lifetime?: number;
    size?: number;
    spawnTime?: number;
    seed?: number;
    glow?: number;
    tint?: [
        r: number,
        g: number,
        b: number,
        a: number
    ];
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
 * Synchronously mount the placeholder (baseAvatar) rig on `node` if it has no
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
    weight: number;
    targetWeight: number;
    fadeRate: number;
    time: number;
    speed: number;
    loopMode: 'once' | 'repeat';
    enabled: boolean;
    layer: number;
    mask: ReadonlySet<string> | null;
    blendMode: BlendMode;
    _channels: ClipChannels | null;
    _boneIndices: Int32Array | null;
    _boneIndicesEpoch: number;
    _boneIndicesChannelsRef: ClipChannels | null;
    _boneIndicesMaskRef: ReadonlySet<string> | null;
    _lastKeyIdx: Int32Array | null;
    _idxTranslation: Int32Array | null;
    _idxRotation: Int32Array | null;
    _idxScale: Int32Array | null;
};
```

#### `AnimatorState`

```ts
export type AnimatorState = {
    actions: Map<ClipDef, AnimationAction>;
    actionsList: AnimationAction[];
    boneOrder: TransformTrait[];
    bonePos: Vec3[];
    boneQuat: Quat[];
    boneScale: Vec3[];
    boneIndex: Map<string, number>;
    boneOrderEpoch: number;
    layerAccum: Float32Array;
    subtreeEnd: Int32Array;
    subtreeDirty: Uint8Array;
    accumCapacity: number;
    _cullMeshes: MeshTrait[];
    _lodStride: number;
    _lodPhase: number;
    _lodClassifiedAtFrame: number;
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
    weight: number;
    targetWeight: number;
    fadeRate: number;
    time: number;
    speed: number;
    loopMode: 'once' | 'repeat';
    enabled: boolean;
    layer: number;
    mask: ReadonlySet<string> | null;
    blendMode: BlendMode;
    _channels: ClipChannels | null;
    _boneIndices: Int32Array | null;
    _boneIndicesEpoch: number;
    _boneIndicesChannelsRef: ClipChannels | null;
    _boneIndicesMaskRef: ReadonlySet<string> | null;
    _lastKeyIdx: Int32Array | null;
    _idxTranslation: Int32Array | null;
    _idxRotation: Int32Array | null;
    _idxScale: Int32Array | null;
};
```

#### `Animation.AnimatorState`

```ts
export type AnimatorState = {
    actions: Map<ClipDef, AnimationAction>;
    actionsList: AnimationAction[];
    boneOrder: TransformTrait[];
    bonePos: Vec3[];
    boneQuat: Quat[];
    boneScale: Vec3[];
    boneIndex: Map<string, number>;
    boneOrderEpoch: number;
    layerAccum: Float32Array;
    subtreeEnd: Int32Array;
    subtreeDirty: Uint8Array;
    accumCapacity: number;
    _cullMeshes: MeshTrait[];
    _lodStride: number;
    _lodPhase: number;
    _lodClassifiedAtFrame: number;
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
    _query: ReturnType<typeof query<[
        typeof AnimatorTrait
    ]>>;
    _frameCount: number;
    _nextLodPhase: number;
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
/** A plausible display name for an ambient NPC, drawn from a small bundled pool. */
export function randomDisplayName(): string;
```
#### `Avatar`

```ts
export type Avatar = {
    modelId: string;
    rigType: string;
};
```

## Physics

Rigid bodies, AABB bodies, contacts, and the physics layers and groups.

#### `Physics`

```ts
export type Physics = {
    rigid: RigidPhysics.World;
    aabb: AabbPhysics.World;
    contacts: PhysicsContacts;
    rigidBodyContactPool: RigidBodyContactPool;
    aabbBodyContactPool: AabbBodyContactPool;
    voxelContactPool: VoxelContactPool;
    contactPairPool: ContactPairPool;
    contactsQuery: ReturnType<typeof query<[
        typeof ContactsTrait
    ]>>;
    aabbPairSink: AabbPhysics.PairSink;
    vccContacts: VccBodyContact[];
    vccContactCount: number;
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
    enabled: boolean;
    desktop: {
        doubleTapSprint: boolean;
        doubleTapNoclip: boolean;
    };
    touch: {
        joystick: boolean;
        jumpButton: boolean;
        sprintButton: boolean;
        crouchButton: boolean;
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
    maxIterations?: number;
    searchType?: SearchType;
    heuristic?: Heuristic;
};
```

#### `nav.findPath`

```ts
/**
 * find a path of cells from `start` to `goal` under the successor function
 * `actions`, or null. returns every cell, never smoothed (smooth explicitly with
 * `smoothPath` if you want steering waypoints). pass `actions` directly (e.g.
 * `groundActions`), wrap one, or build via `gridActions`. heuristic defaults to
 * euclidean (override via `options.heuristic`).
 *
 * uses lazy deletion: a cheaper route to an open cell pushes a fresh node and
 * stale duplicates are skipped on pop (closed check), correct without
 * decrease-key bookkeeping.
 */
export function findPath(voxels: Voxels, start: Vec3, goal: Vec3, actions: Actions, options?: FindPathOptions): Vec3[] | null;
```

#### `nav.smoothPath`

```ts
/** drop redundant waypoints: keep a cell only when the agent can't travel
 *  directly (per `shortcut`) from the last kept cell to the one after it.
 *  never shortcuts across an upward hop, a waypoint whose predecessor is
 *  lower (a +Y step) is preserved so the agent still jumps it. */
export function smoothPath(voxels: Voxels, path: Vec3[], shortcut: Shortcut): Vec3[];
```

#### `nav.groundShortcut`

```ts
/** swept-box line-of-sight with gravity descent over a precomputed diagonal trace,
 *  the standard ground smoother for `smoothPath`. won't shortcut uphill. defaults to
 *  the standard ground agent; pass the same `walkable` the path was found with if you
 *  customized it. */
export function groundShortcut(walkable: Walkable = groundWalkable()): Shortcut;
```

#### `nav.floodFill`

```ts
/** breadth-first expansion of every cell reachable from `start` under the successor
 *  `actions`. `start` is included; order is roughly nearest-first. flood-fill is
 *  otherwise unbounded, so `maxIterations` caps cells expanded (the same work budget
 *  `findPath` takes); the result includes the frontier discovered up to that bound.
 *
 *  the returned array ALIASES a reused pool — it (and its cells) are valid only until
 *  the next `floodFill` call. read or copy what you need out before then; clone any
 *  cell you intend to retain (`[c[0], c[1], c[2]]`). */
export function floodFill(voxels: Voxels, start: Vec3, actions: Actions, maxIterations: number): Vec3[];
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
    x: number;
    y: number;
    dx: number;
    dy: number;
    startX: number;
    startY: number;
    downAt: number;
    justStarted: boolean;
    justEnded: boolean;
    tapped: boolean;
    longPressed: boolean;
    swiped: boolean;
    swipeDx: number;
    swipeDy: number;
    _maxDriftSq: number;
    _longPressLatched: boolean;
    _recentSamples: {
        t: number;
        x: number;
        y: number;
    }[];
};
```

#### `Input`

```ts
export type Input = {
    mouseKeyboard: MouseKeyboardInput;
    touch: TouchInput;
    _lockWanted: boolean;
    _lockDeclared: boolean;
};
```

#### `JoystickState`

```ts
export type JoystickState = {
    x: number;
    y: number;
    active: boolean;
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
    _prevKeyState: Map<string, boolean>;
    _keyJustPressed: Set<string>;
    _mods: ModifierState;
    _prevMods: ModifierState;
    _dx: number;
    _dy: number;
    _buttons: {
        left: boolean;
        right: boolean;
        middle: boolean;
    };
    _prevButtons: {
        left: boolean;
        right: boolean;
        middle: boolean;
    };
    _wheelDeltaY: number;
    _gestures: {
        left: MouseButtonGesture;
        middle: MouseButtonGesture;
        right: MouseButtonGesture;
    };
    _locked: boolean;
    _prevLocked: boolean;
};
```

#### `TouchButtonState`

```ts
export type TouchButtonState = {
    down: boolean;
    _prevDown: boolean;
    look: boolean;
    _dragX: number;
    _dragY: number;
};
```

#### `TouchInput`

```ts
export type TouchInput = {
    _canvasTouches: Map<number, CanvasTouch>;
    _canvasTouchesEnded: Map<number, CanvasTouch>;
    _pinchPrevDist: number;
    _joysticks: Map<string, JoystickState>;
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
/** matchMedia('(pointer: coarse)') OR navigator.maxTouchPoints > 0. true on
 *  touchscreen laptops too, use `isTouchPrimary` to gate touch controls. */
export function isTouchDevice(ctx: ScriptContext): boolean;
```

#### `isTouchPrimary`

```ts
/**
 * Touch is the PRIMARY pointer (matchMedia('(pointer: coarse)')). Unlike
 * `isMobile` this is viewport-INDEPENDENT, so it stays true on a tablet or a
 * phone held in landscape; unlike `isTouchDevice` it's false on a touchscreen
 * laptop driven by its trackpad. This is the "should I show on-screen touch
 * controls (joystick, action buttons)" check. Resolved once at client boot.
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

Also exported: `CreateTouchJoystickOpts`, `CreateTouchButtonOpts`.
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
#### `UILayer`

```ts
export const UILayer;
```

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
/** a command handle returned by command(). */
export type CommandHandle<S extends pack.Schema, D extends RpcDirection> = {
    readonly id: string;
    dependency: {
        registry: 'commands';
        id: string;
    };
    readonly direction: D;
    readonly schema: S;
    readonly serdes: ReturnType<typeof pack.build>;
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

#### `SERVER_TO_CLIENT`

```ts
export const SERVER_TO_CLIENT;
```
#### `MatchmakingConfig`

```ts
export type MatchmakingConfig = {
    dependency: {
        registry: 'matchmaking';
        id: string;
    };
    maxPlayers: number;
};
```

#### `MatchmakingOptions`

```ts
export type MatchmakingOptions = {
    maxPlayers?: number;
};
```

#### `DEFAULT_MATCHMAKING_CONFIG`

```ts
/** Applied when the user didn't call matchmaking(), preserves the
 *  pre-existing platform behavior (rooms cap at 10). */
export const DEFAULT_MATCHMAKING_CONFIG: MatchmakingConfig;
```

#### `HARD_MAX_PLAYERS_PER_ROOM`

```ts
/** Hard ceiling enforced both at the platform (manifest validation) and
 *  here (matchmaking() call). Bumping this is a coordinated change with
 *  apps/service/src/matchmaking. */
export const HARD_MAX_PLAYERS_PER_ROOM;
```

#### `matchmaking`

```ts
/**
 * declare per-game matchmaking config. call once at module scope, before
 * scripts/traits/etc. only the first call wins, a second call throws so
 * conflicts don't sit hidden.
 */
export function matchmaking(opts: MatchmakingOptions = {

}): MatchmakingConfig;
```
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
 * Drop this client from the current allocation and re-enter the matchmaker
 * with new gameOptions / joinData. Client-only. The transport (engine
 * `play` message in dev, iframe-bridge re-enqueue in deployed) lives on the
 * ClientDriver supplied at engine init, this just hands off to it.
 *
 * Use cases: gamemode switches, team splits, lobby→game transitions.
 */
export const client: {
    matchmake(ctx: ScriptContext, opts: {
        gameOptions: Record<string, string | number | boolean>;
        joinData?: Record<string, JsonValue>;
    }): void;
};
```
#### `clientToUser`

```ts
export function clientToUser(ctx: ScriptContext, client: Client): User;
```
