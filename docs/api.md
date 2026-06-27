# bongle API reference

Curated reference for the public `bongle` surface. For a guided,
read-top-to-bottom introduction see [the guide](./guide.md).

## Transforms & scene graph

Read and write node positions in local and world space.

### Setters

Write local-space values; each marks the node dirty so descendants recompute.

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

### World-space getters

Read resolved world-space values, recomputing lazily if anything upstream moved.

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
