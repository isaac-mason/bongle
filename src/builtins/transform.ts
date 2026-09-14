import type { Mat4, Quat, Vec3 } from 'math';
import { mat4, quat, vec3 } from 'math';
import { TRANSFORM_SEND_HZ } from '../core/clock';
import { control, sync, trait } from '../core/registry';
import { pack } from '../core/scene/pack';
import { prop } from '../core/scene/prop';
import type { Node, SceneTree } from '../core/scene/scene-tree';
import { getTrait } from '../core/scene/scene-tree';
import { dirty, rate } from '../core/scene/sync/sync-rate';
import type { TraitType } from '../core/scene/traits';
import {
    markTransformChanged,
    markWorldDirty,
    parentTransform,
    TRANSFORM_DIRTY_ALL,
    updateWorldTransform,
    worldToLocalPosition,
    worldToLocalQuaternion,
} from '../core/scene/transform';
import { traverse } from '../core/scene/traverse';

// runtime lives in core so the scene tree can use it without importing this module's trait().
export * from '../core/scene/transform';

// _dirty is a bitmask on TransformTrait, one bit per derived cache (see TRANSFORM_DIRTY_* in core/scene/transform).

export const TransformTrait = trait(
    'transform',
    {
        position: vec3.create(),
        quaternion: quat.create(),
        scale: vec3.fromValues(1, 1, 1),

        /** sync-only teleport counter. when it changes, client snaps instead of interpolating */
        teleport: 0,

        worldPosition: vec3.create(),
        worldQuaternion: quat.create(),
        worldScale: vec3.fromValues(1, 1, 1),
        worldMatrix: mat4.create(),

        // chunk coord of worldPosition (cx,cy,cz), lazily recomputed by getWorldChunk.
        worldChunk: null as Vec3 | null,

        // parallel chain to worldMatrix for rendering, composed from parent.interpolatedWorldMatrix * local.
        interpolatedWorldPosition: null as Vec3 | null,
        interpolatedWorldQuaternion: null as Quat | null,
        interpolatedWorldScale: null as Vec3 | null,
        interpolatedWorldMatrix: null as Mat4 | null,

        lastTeleport: 0,

        // starts at TRANSFORM_DIRTY_ALL so first read computes everything.
        _dirty: TRANSFORM_DIRTY_ALL,

        // sticky bit: 1 once interpolatedWorld* has been touched; when 0, visual getters use the world chain.
        _interpolated: 0 as 0 | 1,

        /** sticky flag toggled by `setInterpolation(node, on)`; enrolls this transform in the per-frame `interpolating` set. */
        interpolate: 0 as 0 | 1,
        /** local pose at the start of the current fixed tick; remote-driven transforms chase-latest instead. */
        prevPosition: null as Vec3 | null,
        prevQuaternion: null as Quat | null,

        /** remote chase-latest translator (client-only), lazily allocated on the first remote pose. */
        _remoteInterpolation: null as RemoteInterpolation | null,

        /** frames remaining in an active correction blend; 0 when idle */
        _correctionFrames: 0,
        _correctionTarget: null as Vec3 | null,
        _correctionTargetQuat: null as Quat | null,

        _version: 0,

        /** local TRS moved since the last `Interpolation.snapshot` drain; only meaningful while `interpolate` is set. */
        _movedSinceSnapshot: 0 as 0 | 1,

        /** nearest transform-bearing ancestor, or null at a transform root; typed `any`, narrowed on the exported type. */
        _parent: null as any,

        /** the transforms directly below this one, passthrough nodes already skipped. */
        _children: [] as any[],

        /** this transform's slot in `_parent._children`, or -1 when it has no parent; avoids an O(n^2) removal scan. */
        _childIndex: -1,
    },
    { icon: 'kit:icon:transform' },
);

export type TransformTrait = Omit<TraitType<typeof TransformTrait>, '_parent' | '_children'> & {
    _parent: TransformTrait | null;
    _children: TransformTrait[];
};

// non-owner poses chase-latest: unpack writes into t.position/t.quaternion and render/interpolation.ts eases toward it.

export type RemoteInterpolation = {
    positionOld: Vec3;
    positionCurrent: Vec3;
    quaternionOld: Quat;
    quaternionCurrent: Quat;
    /** ease duration (seconds), an EWMA of the observed send interval, per channel. */
    positionEaseDuration: number;
    quaternionEaseDuration: number;
    /** seconds elapsed into the current ease segment, per channel. */
    positionElapsed: number;
    quaternionElapsed: number;
    /** server stamp of the target the current segment eases toward; the gap to `*PendingStamp` is the learned cadence. */
    positionStamp: number;
    quaternionStamp: number;
    positionPendingStamp: number;
    quaternionPendingStamp: number;
    /** unpack-bumped sequence; a mismatch vs the last retargeted value means a fresh pose landed. */
    positionSequence: number;
    positionSeen: number;
    quaternionSequence: number;
    quaternionSeen: number;
    /** 0 until `current` has been seeded from a real pose (first frame / teleport). */
    initialized: 0 | 1;
};

function newRemoteInterpolation(): RemoteInterpolation {
    return {
        positionOld: vec3.create(),
        positionCurrent: vec3.create(),
        quaternionOld: quat.create(),
        quaternionCurrent: quat.create(),
        positionEaseDuration: 0,
        quaternionEaseDuration: 0,
        positionElapsed: 0,
        quaternionElapsed: 0,
        positionStamp: 0,
        quaternionStamp: 0,
        positionPendingStamp: 0,
        quaternionPendingStamp: 0,
        positionSequence: 0,
        positionSeen: 0,
        quaternionSequence: 0,
        quaternionSeen: 0,
        initialized: 0,
    };
}

/** lazily allocate the translator on the first remote pose; owner/local/static nodes pay nothing. */
export function ensureRemoteInterpolation(t: TransformTrait): RemoteInterpolation {
    if (t._remoteInterpolation === null) t._remoteInterpolation = newRemoteInterpolation();
    return t._remoteInterpolation;
}

/** record a freshly-unpacked remote position, restarting the render-side ease toward it. */
export function noteRemotePosition(t: TransformTrait, time: number): void {
    const remote = ensureRemoteInterpolation(t);
    remote.positionPendingStamp = time;
    remote.positionSequence++;
}

export function noteRemoteQuaternion(t: TransformTrait, time: number): void {
    const remote = ensureRemoteInterpolation(t);
    remote.quaternionPendingStamp = time;
    remote.quaternionSequence++;
}

// the transform hierarchy is the node hierarchy with non-bearers contracted out, derived on demand rather than materialised.

control(TransformTrait, 'position', {
    label: 'Position',
    schema: prop.vec3(),
    get: (t) => t.position,
    set: (t, v) => {
        vec3.copy(t.position, v);
        markTransformDirty(t);
    },
});

control(TransformTrait, 'quaternion', {
    label: 'Rotation',
    schema: prop.quaternion(),
    get: (t) => t.quaternion,
    set: (t, v) => {
        quat.copy(t.quaternion, v);
        markTransformDirty(t);
    },
});

control(TransformTrait, 'scale', {
    label: 'Scale',
    schema: prop.vec3(),
    get: (t) => t.scale,
    set: (t, v) => {
        vec3.copy(t.scale, v);
        markTransformDirty(t);
    },
});

sync(TransformTrait, 'teleport', {
    schema: pack.uint32(),
    pack: (t) => t.teleport,
    unpack: (v, t) => {
        t.teleport = v;
    },
});

// position and quaternion sync as independent owner-authority slices so a static rotation doesn't re-emit with a moving position.
const transformPositionSync = sync(TransformTrait, 'position', {
    schema: pack.position(),
    pack: (t) => t.position,
    unpack: (p, t) => {
        vec3.copy(t.position, p);
        markWorldDirty(t);
        const runtime = t._node?.scene?.context;
        if (runtime?.client) noteRemotePosition(t, runtime.clock.serverLatest);
    },
    authority: 'owner',
    dirty: dirty.diff(),
    rate: rate.hz(TRANSFORM_SEND_HZ),
});

const transformQuaternionSync = sync(TransformTrait, 'quaternion', {
    schema: pack.quaternion(),
    pack: (t) => t.quaternion,
    unpack: (q, t) => {
        quat.copy(t.quaternion, q);
        markWorldDirty(t);
        const runtime = t._node?.scene?.context;
        if (runtime?.client) noteRemoteQuaternion(t, runtime.clock.serverLatest);
    },
    authority: 'owner',
    dirty: dirty.diff(),
    rate: rate.hz(TRANSFORM_SEND_HZ),
});

const transformScaleSync = sync(TransformTrait, 'scale', {
    schema: pack.scale(),
    pack: (t) => t.scale,
    unpack: (s, t) => {
        vec3.copy(t.scale, s);
        markTransformDirty(t);
    },
});

export function markTransformDirty(transform: TransformTrait): void {
    markTransformChanged(transform);
    // unconditional, else a freshly-created trait's first write would be swallowed by markTransformChanged's early-out.
    transformPositionSync.dirty(transform);
    transformQuaternionSync.dirty(transform);
    transformScaleSync.dirty(transform);
}

/** enroll/unenroll a node in the per-frame interpolation pass; idempotent and safe on nodes without TransformTrait. */
export function setInterpolation(node: Node, on: boolean): void {
    const transform = getTrait(node, TransformTrait);
    if (!transform) return;
    if (on) {
        if (transform.interpolate) return;
        transform.interpolate = 1;
        transform.prevPosition = vec3.clone(transform.position);
        transform.prevQuaternion = quat.clone(transform.quaternion);
        // force the first interpolate() frame to snap interpolatedWorld* to the current pose instead of lerping from zero.
        transform.lastTeleport = transform.teleport - 1;
        if (node.scene) node.scene.interpolating.add(transform);
    } else {
        if (!transform.interpolate) return;
        transform.interpolate = 0;
        transform._interpolated = 0;
        transform._correctionFrames = 0;
        if (node.scene) node.scene.interpolating.delete(transform);
    }
}

/** re-seed prev pose from the node's current local TRS after a hard snap/teleport; no-op if not enrolled. */
export function resetInterpolation(node: Node): void {
    const transform = getTrait(node, TransformTrait);
    if (!transform?.interpolate) return;
    vec3.copy(transform.prevPosition!, transform.position);
    quat.copy(transform.prevQuaternion!, transform.quaternion);
    // also force a teleport-edge snap on the next interpolate() to avoid smearing across the discontinuity.
    transform.lastTeleport = transform.teleport - 1;
}

/** set local position and mark dirty. only the position slice replicates. */
export function setPosition(transform: TransformTrait, position: Vec3): void {
    transform.position[0] = position[0];
    transform.position[1] = position[1];
    transform.position[2] = position[2];
    markTransformChanged(transform);
    transformPositionSync.dirty(transform);
}

/** set local quaternion and mark dirty. only the quaternion slice replicates. */
export function setQuaternion(transform: TransformTrait, quaternion: Quat): void {
    transform.quaternion[0] = quaternion[0];
    transform.quaternion[1] = quaternion[1];
    transform.quaternion[2] = quaternion[2];
    transform.quaternion[3] = quaternion[3];
    markTransformChanged(transform);
    transformQuaternionSync.dirty(transform);
}

/** set local scale and mark dirty. only the scale slice replicates. */
export function setScale(transform: TransformTrait, scale: Vec3): void {
    transform.scale[0] = scale[0];
    transform.scale[1] = scale[1];
    transform.scale[2] = scale[2];
    markTransformChanged(transform);
    transformScaleSync.dirty(transform);
}

/** set all local transform fields and mark dirty (single dirty pass). */
export function setTransform(transform: TransformTrait, position: Vec3, quaternion: Quat, scale: Vec3): void {
    transform.position[0] = position[0];
    transform.position[1] = position[1];
    transform.position[2] = position[2];
    transform.quaternion[0] = quaternion[0];
    transform.quaternion[1] = quaternion[1];
    transform.quaternion[2] = quaternion[2];
    transform.quaternion[3] = quaternion[3];
    transform.scale[0] = scale[0];
    transform.scale[1] = scale[1];
    transform.scale[2] = scale[2];
    markTransformDirty(transform);
}

/** walk the scene graph parent-first, recomputing world-space transforms; safety net at tick boundaries. */
export function computeWorldTransforms(nodes: SceneTree): void {
    traverse(nodes.root, (node: Node) => {
        const transform = getTrait(node, TransformTrait);
        if (!transform) return;
        updateWorldTransform(transform);
    });
}

export function setWorldPosition(transform: TransformTrait, worldPosition: Vec3): void {
    worldToLocalPosition(transform, worldPosition, transform.position);
    markTransformDirty(transform);
}

export function setWorldQuaternion(transform: TransformTrait, worldQuaternion: Quat): void {
    worldToLocalQuaternion(transform, worldQuaternion, transform.quaternion);
    markTransformDirty(transform);
}

/** true if this node has a transformed parent; if false, local === world and no conversion is needed. */
export function hasTransformedParent(transform: TransformTrait): boolean {
    return parentTransform(transform) !== null;
}

const _collapseRotated: Vec3 = vec3.create();
const _collapseQuat: Quat = quat.create();

/** compose anchor.local into each direct-child subtree's first-encountered TransformTrait, so removing the anchor's transform leaves world poses unchanged. */
export function collapseTransformIntoChildren(anchor: Node): void {
    const at = getTrait(anchor, TransformTrait);
    if (!at) return;
    for (const child of anchor.children) {
        collapseFirstTransformBelow(child, at);
    }
}

function collapseFirstTransformBelow(node: Node, anchor: TransformTrait): void {
    const t = getTrait(node, TransformTrait);
    if (t) {
        composeLocalIntoChild(anchor, t);
        markTransformDirty(t);
        return;
    }
    for (const child of node.children) {
        collapseFirstTransformBelow(child, anchor);
    }
}

// child.local := anchor.local composed with child.local (TRS compose).
function composeLocalIntoChild(anchor: TransformTrait, child: TransformTrait): void {
    const ap = anchor.position;
    const aq = anchor.quaternion;
    const as = anchor.scale;

    _collapseRotated[0] = child.position[0] * as[0];
    _collapseRotated[1] = child.position[1] * as[1];
    _collapseRotated[2] = child.position[2] * as[2];
    vec3.transformQuat(_collapseRotated, _collapseRotated, aq);
    child.position[0] = ap[0] + _collapseRotated[0];
    child.position[1] = ap[1] + _collapseRotated[1];
    child.position[2] = ap[2] + _collapseRotated[2];

    quat.multiply(_collapseQuat, aq, child.quaternion);
    quat.copy(child.quaternion, _collapseQuat);

    child.scale[0] *= as[0];
    child.scale[1] *= as[1];
    child.scale[2] *= as[2];
}
