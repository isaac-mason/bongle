import { mat4, type Mat4, quat, type Quat, vec3, type Vec3 } from 'mathcat';
import { describe, expect, it } from 'vitest';
import { TransformTrait } from '../../builtins/transform';
import {
    addChild,
    addTrait,
    createNode,
    createSceneGraph,
    deserializeNode,
    getTrait,
    removeTrait,
    reparent,
    serializeNode,
} from './nodes';
import {
    computeWorldTransforms,
    getVisualWorldPosition,
    getVisualWorldQuaternion,
    getVisualWorldScale,
    getWorldMatrix,
    TRANSFORM_DIRTY_ALL,
    TRANSFORM_DIRTY_WORLD_MATRIX,
    TRANSFORM_DIRTY_WORLD_TRS,
    getWorldPosition,
    getWorldQuaternion,
    getWorldScale,
    hasTransformedParent,
    markTransformDirty,
    resetInterpolation,
    setInterpolation,
    setPosition,
    setQuaternion,
    setScale,
    setWorldPosition,
    setWorldQuaternion,
    worldToLocalPosition,
    worldToLocalQuaternion,
} from '../../builtins/transform';
import { init as initInterpolation, interpolate, snapshot } from '../../client/interpolation';

/* ── helpers ── */

function setup() {
    return createSceneGraph();
}

/** approximate equality for vec3 */
function expectVec3Near(actual: Vec3, expected: Vec3, epsilon = 1e-5) {
    expect(actual[0]).toBeCloseTo(expected[0], -Math.log10(epsilon));
    expect(actual[1]).toBeCloseTo(expected[1], -Math.log10(epsilon));
    expect(actual[2]).toBeCloseTo(expected[2], -Math.log10(epsilon));
}

/** approximate equality for quat */
function expectQuatNear(actual: Quat, expected: Quat, epsilon = 1e-5) {
    // quaternions q and -q represent the same rotation — normalize sign
    const dot = actual[0] * expected[0] + actual[1] * expected[1] + actual[2] * expected[2] + actual[3] * expected[3];
    const sign = dot < 0 ? -1 : 1;
    const prec = -Math.log10(epsilon);
    expect(actual[0] * sign).toBeCloseTo(expected[0], prec);
    expect(actual[1] * sign).toBeCloseTo(expected[1], prec);
    expect(actual[2] * sign).toBeCloseTo(expected[2], prec);
    expect(actual[3] * sign).toBeCloseTo(expected[3], prec);
}

/** approximate equality for mat4 */
function expectMat4Near(actual: Mat4, expected: Mat4, epsilon = 1e-4) {
    const prec = -Math.log10(epsilon);
    for (let i = 0; i < 16; i++) {
        expect(actual[i]).toBeCloseTo(expected[i], prec);
    }
}

/** build a 90-degree rotation around Y axis */
function rotY90(): Quat {
    const q: Quat = quat.create();
    quat.setAxisAngle(q, vec3.fromValues(0, 1, 0), Math.PI / 2);
    return q;
}

// ═══════════════════════════════════════════════════════════════════════
// computeWorldTransforms
// ═══════════════════════════════════════════════════════════════════════

describe('computeWorldTransforms', () => {
    it('top-level node: local === world', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait, {
            position: vec3.fromValues(10, 20, 30),
        });

        computeWorldTransforms(sg);

        const t = getTrait(node, TransformTrait)!;
        expectVec3Near(getWorldPosition(t), vec3.fromValues(10, 20, 30));
        expectQuatNear(getWorldQuaternion(t), quat.create()); // identity
        expectVec3Near(getWorldScale(t), vec3.fromValues(1, 1, 1));
    });

    it('top-level node: worldMatrix matches TRS', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        const pos = vec3.fromValues(1, 2, 3);
        const rot = rotY90();
        const scl = vec3.fromValues(2, 2, 2);
        addTrait(node, TransformTrait, {
            position: pos,
            quaternion: rot,
            scale: scl,
        });

        computeWorldTransforms(sg);

        const t = getTrait(node, TransformTrait)!;
        const expected: Mat4 = mat4.create();
        mat4.fromRotationTranslationScale(expected, rot, pos, scl);
        expectMat4Near(getWorldMatrix(t), expected);
    });

    it('nested 2-level: child world = parent world * child local', () => {
        const sg = setup();

        // parent at (10, 0, 0)
        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait, {
            position: vec3.fromValues(10, 0, 0),
        });

        // child at local (5, 0, 0) → world should be (15, 0, 0)
        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait, {
            position: vec3.fromValues(5, 0, 0),
        });

        computeWorldTransforms(sg);

        const ct = getTrait(child, TransformTrait)!;
        expectVec3Near(getWorldPosition(ct), vec3.fromValues(15, 0, 0));
    });

    it('nested 2-level with rotation: child position rotated by parent', () => {
        const sg = setup();

        // parent rotated 90° around Y → local +X becomes world +Z
        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait, {
            quaternion: rotY90(),
        });

        // child at local (5, 0, 0) → should be at world (0, 0, -5)
        // (90° Y rotation: x→-z in right-hand system... let's just check)
        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait, {
            position: vec3.fromValues(5, 0, 0),
        });

        computeWorldTransforms(sg);

        // build expected manually
        const parentMat: Mat4 = mat4.create();
        mat4.fromRotationTranslationScale(parentMat, rotY90(), vec3.create(), vec3.fromValues(1, 1, 1));
        const childLocalMat: Mat4 = mat4.create();
        mat4.fromRotationTranslationScale(childLocalMat, quat.create(), vec3.fromValues(5, 0, 0), vec3.fromValues(1, 1, 1));
        const expectedWorld: Mat4 = mat4.create();
        mat4.multiply(expectedWorld, parentMat, childLocalMat);

        const expectedPos: Vec3 = vec3.create();
        mat4.getTranslation(expectedPos, expectedWorld);

        const ct = getTrait(child, TransformTrait)!;
        expectVec3Near(getWorldPosition(ct), expectedPos);
    });

    it('nested 2-level with scale: child world scale is product', () => {
        const sg = setup();

        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait, {
            scale: vec3.fromValues(2, 2, 2),
        });

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait, {
            position: vec3.fromValues(5, 0, 0),
            scale: vec3.fromValues(3, 3, 3),
        });

        computeWorldTransforms(sg);

        const ct = getTrait(child, TransformTrait)!;
        // world position: parent scale 2 * child local pos 5 = 10
        expectVec3Near(getWorldPosition(ct), vec3.fromValues(10, 0, 0));
        // world scale: 2 * 3 = 6
        expectVec3Near(getWorldScale(ct), vec3.fromValues(6, 6, 6));
    });

    it('nested 3-level: grandchild accumulates all ancestors', () => {
        const sg = setup();

        const gp = createNode({ name: 'GP' });
        addChild(sg.root, gp);
        addTrait(gp, TransformTrait, {
            position: vec3.fromValues(100, 0, 0),
        });

        const parent = createNode({ name: 'Parent' });
        addChild(gp, parent);
        addTrait(parent, TransformTrait, {
            position: vec3.fromValues(10, 0, 0),
        });

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait, {
            position: vec3.fromValues(1, 0, 0),
        });

        computeWorldTransforms(sg);

        const ct = getTrait(child, TransformTrait)!;
        expectVec3Near(getWorldPosition(ct), vec3.fromValues(111, 0, 0));

        const pt = getTrait(parent, TransformTrait)!;
        expectVec3Near(getWorldPosition(pt), vec3.fromValues(110, 0, 0));
    });

    it('intermediate node without transform: child skips to grandparent', () => {
        const sg = setup();

        // grandparent has transform
        const gp = createNode({ name: 'GP' });
        addChild(sg.root, gp);
        addTrait(gp, TransformTrait, {
            position: vec3.fromValues(50, 0, 0),
        });

        // parent has NO transform — just a grouping node
        const parent = createNode({ name: 'NoTransform' });
        addChild(gp, parent);

        // child has transform — should inherit from grandparent
        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait, {
            position: vec3.fromValues(5, 0, 0),
        });

        computeWorldTransforms(sg);

        const ct = getTrait(child, TransformTrait)!;
        expectVec3Near(getWorldPosition(ct), vec3.fromValues(55, 0, 0));
    });

    it('multiple children at the same level get correct world positions', () => {
        const sg = setup();

        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait, {
            position: vec3.fromValues(100, 0, 0),
        });

        const a = createNode({ name: 'A' });
        addChild(parent, a);
        addTrait(a, TransformTrait, { position: vec3.fromValues(1, 0, 0) });

        const b = createNode({ name: 'B' });
        addChild(parent, b);
        addTrait(b, TransformTrait, { position: vec3.fromValues(0, 2, 0) });

        const c = createNode({ name: 'C' });
        addChild(parent, c);
        addTrait(c, TransformTrait, { position: vec3.fromValues(0, 0, 3) });

        computeWorldTransforms(sg);

        expectVec3Near(getWorldPosition(getTrait(a, TransformTrait)!), vec3.fromValues(101, 0, 0));
        expectVec3Near(getWorldPosition(getTrait(b, TransformTrait)!), vec3.fromValues(100, 2, 0));
        expectVec3Near(getWorldPosition(getTrait(c, TransformTrait)!), vec3.fromValues(100, 0, 3));
    });

    it('repeated calls produce consistent results', () => {
        const sg = setup();

        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait, {
            position: vec3.fromValues(10, 0, 0),
        });

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait, {
            position: vec3.fromValues(5, 0, 0),
        });

        computeWorldTransforms(sg);
        computeWorldTransforms(sg);
        computeWorldTransforms(sg);

        const ct = getTrait(child, TransformTrait)!;
        expectVec3Near(getWorldPosition(ct), vec3.fromValues(15, 0, 0));
    });
});

// ═══════════════════════════════════════════════════════════════════════
// parent transform bookkeeping
// ═══════════════════════════════════════════════════════════════════════

describe('parent transform bookkeeping', () => {
    it('top-level node has null parent transform', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait);

        const t = getTrait(node, TransformTrait)!;
        expect(t._parent).toBeNull();
    });

    it('child under transform parent gets parent transform set', () => {
        const sg = setup();

        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait);

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait);

        const pt = getTrait(parent, TransformTrait)!;
        const ct = getTrait(child, TransformTrait)!;
        expect(ct._parent).toBe(pt);
    });

    it('child under non-transform parent has null parent transform', () => {
        const sg = setup();

        const parent = createNode({ name: 'NoTransform' });
        addChild(sg.root, parent);
        // no transform on parent

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait);

        const ct = getTrait(child, TransformTrait)!;
        expect(ct._parent).toBeNull();
    });

    it('adding transform to parent updates existing children', () => {
        const sg = setup();

        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait);

        // initially no parent transform
        const ct = getTrait(child, TransformTrait)!;
        expect(ct._parent).toBeNull();

        // now add transform to parent — child should update
        addTrait(parent, TransformTrait);
        const pt = getTrait(parent, TransformTrait)!;
        expect(ct._parent).toBe(pt);
    });

    it('removing transform from parent updates children to inherit grandparent', () => {
        const sg = setup();

        const gp = createNode({ name: 'GP' });
        addChild(sg.root, gp);
        addTrait(gp, TransformTrait);

        const parent = createNode({ name: 'Parent' });
        addChild(gp, parent);
        addTrait(parent, TransformTrait);

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait);

        const gpt = getTrait(gp, TransformTrait)!;
        const pt = getTrait(parent, TransformTrait)!;
        const ct = getTrait(child, TransformTrait)!;

        // initially child → parent
        expect(ct._parent).toBe(pt);

        // remove parent's transform — child should now point to grandparent
        removeTrait(parent, TransformTrait);
        expect(ct._parent).toBe(gpt);
    });

    it('removing transform from parent with no grandparent sets children to null', () => {
        const sg = setup();

        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait);

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait);

        const pt = getTrait(parent, TransformTrait)!;
        const ct = getTrait(child, TransformTrait)!;
        expect(ct._parent).toBe(pt);

        removeTrait(parent, TransformTrait);
        expect(ct._parent).toBeNull();
    });

    it('addChild updates parent transform for moved subtree', () => {
        const sg = setup();

        const oldParent = createNode({ name: 'OldParent' });
        addChild(sg.root, oldParent);
        addTrait(oldParent, TransformTrait);

        const newParent = createNode({ name: 'NewParent' });
        addChild(sg.root, newParent);
        addTrait(newParent, TransformTrait, {
            position: vec3.fromValues(100, 0, 0),
        });

        const child = createNode({ name: 'Child' });
        addChild(oldParent, child);
        addTrait(child, TransformTrait);

        const opt = getTrait(oldParent, TransformTrait)!;
        const npt = getTrait(newParent, TransformTrait)!;
        const ct = getTrait(child, TransformTrait)!;

        expect(ct._parent).toBe(opt);

        // move child to new parent
        addChild(newParent, child);
        expect(ct._parent).toBe(npt);
    });

    it('reparent updates parent transform for moved subtree', () => {
        const sg = setup();

        const parentA = createNode({ name: 'ParentA' });
        addChild(sg.root, parentA);
        addTrait(parentA, TransformTrait);

        const parentB = createNode({ name: 'ParentB' });
        addChild(sg.root, parentB);
        addTrait(parentB, TransformTrait);

        const child = createNode({ name: 'Child' });
        addChild(parentA, child);
        addTrait(child, TransformTrait);

        const at = getTrait(parentA, TransformTrait)!;
        const bt = getTrait(parentB, TransformTrait)!;
        const ct = getTrait(child, TransformTrait)!;

        expect(ct._parent).toBe(at);

        reparent(child, parentB);
        expect(ct._parent).toBe(bt);
    });

    it('reparent updates deep subtree pointers', () => {
        const sg = setup();

        const parentA = createNode({ name: 'ParentA' });
        addChild(sg.root, parentA);
        addTrait(parentA, TransformTrait);

        const parentB = createNode({ name: 'ParentB' });
        addChild(sg.root, parentB);
        addTrait(parentB, TransformTrait);

        // subtree: container → child → grandchild
        const container = createNode({ name: 'Container' });
        addChild(parentA, container);
        addTrait(container, TransformTrait);

        const child = createNode({ name: 'Child' });
        addChild(container, child);
        addTrait(child, TransformTrait);

        const at = getTrait(parentA, TransformTrait)!;
        const bt = getTrait(parentB, TransformTrait)!;
        const contT = getTrait(container, TransformTrait)!;
        const childT = getTrait(child, TransformTrait)!;

        // container points to parentA, child points to container
        expect(contT._parent).toBe(at);
        expect(childT._parent).toBe(contT);

        // reparent container to parentB
        reparent(container, parentB);

        // container now points to parentB, child still points to container
        expect(contT._parent).toBe(bt);
        expect(childT._parent).toBe(contT);
    });

    it('intermediate node without transform: grandchild points to grandparent', () => {
        const sg = setup();

        const gp = createNode({ name: 'GP' });
        addChild(sg.root, gp);
        addTrait(gp, TransformTrait);

        // middle node has no transform
        const middle = createNode({ name: 'Middle' });
        addChild(gp, middle);

        const child = createNode({ name: 'Child' });
        addChild(middle, child);
        addTrait(child, TransformTrait);

        const gpt = getTrait(gp, TransformTrait)!;
        const ct = getTrait(child, TransformTrait)!;
        expect(ct._parent).toBe(gpt);
    });

    it('deserializeNode sets parent transform correctly', () => {
        const sg = setup();

        // create a parent with transform, then a child with transform
        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait, {
            position: vec3.fromValues(10, 20, 30),
        });

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait, {
            position: vec3.fromValues(1, 2, 3),
        });

        // serialize the parent (includes child)
        const data = serializeNode(parent);

        // deserialize into a fresh scene graph
        const sg2 = createSceneGraph();
        const restored = deserializeNode(data);
        addChild(sg2.root, restored);

        const restoredChild = restored.children[0];
        const rpt = getTrait(restored, TransformTrait)!;
        const rct = getTrait(restoredChild, TransformTrait)!;

        // child's parent transform should point to parent's transform
        expect(rct._parent).toBe(rpt);
        // parent is top-level (under root) — no transform ancestor
        expect(rpt._parent).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════════
// hasTransformedParent
// ═══════════════════════════════════════════════════════════════════════

describe('hasTransformedParent', () => {
    it('returns false for top-level transform', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait);

        const t = getTrait(node, TransformTrait)!;
        expect(hasTransformedParent(t)).toBe(false);
    });

    it('returns true for nested transform', () => {
        const sg = setup();
        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait);

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait);

        const ct = getTrait(child, TransformTrait)!;
        expect(hasTransformedParent(ct)).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// world↔local helpers
// ═══════════════════════════════════════════════════════════════════════

describe('worldToLocalPosition', () => {
    it('top-level: world === local (fast path)', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait);

        computeWorldTransforms(sg);

        const t = getTrait(node, TransformTrait)!;
        const out: Vec3 = vec3.create();
        worldToLocalPosition(t, vec3.fromValues(10, 20, 30), out);
        expectVec3Near(out, vec3.fromValues(10, 20, 30));
    });

    it('nested with translation: subtracts parent offset', () => {
        const sg = setup();
        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait, {
            position: vec3.fromValues(100, 0, 0),
        });

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait);

        computeWorldTransforms(sg);

        const ct = getTrait(child, TransformTrait)!;
        const out: Vec3 = vec3.create();
        worldToLocalPosition(ct, vec3.fromValues(110, 0, 0), out);
        expectVec3Near(out, vec3.fromValues(10, 0, 0));
    });

    it('nested with rotation: inverse rotates correctly', () => {
        const sg = setup();
        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait, {
            quaternion: rotY90(),
        });

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait);

        computeWorldTransforms(sg);

        // get child's world position from a known local position
        // first compute what world position local (5,0,0) maps to
        const ct = getTrait(child, TransformTrait)!;
        setPosition(ct, vec3.fromValues(5, 0, 0));

        // now convert that world position back to local
        const worldPos = vec3.clone(getWorldPosition(ct));
        const out: Vec3 = vec3.create();
        worldToLocalPosition(ct, worldPos, out);
        expectVec3Near(out, vec3.fromValues(5, 0, 0));
    });

    it('nested with scale: inverse scales correctly', () => {
        const sg = setup();
        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait, {
            scale: vec3.fromValues(2, 2, 2),
        });

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait);

        computeWorldTransforms(sg);

        const ct = getTrait(child, TransformTrait)!;
        const out: Vec3 = vec3.create();
        // world pos (10, 0, 0) with parent scale 2 → local (5, 0, 0)
        worldToLocalPosition(ct, vec3.fromValues(10, 0, 0), out);
        expectVec3Near(out, vec3.fromValues(5, 0, 0));
    });
});

describe('worldToLocalQuaternion', () => {
    it('top-level: world === local (fast path)', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait);

        computeWorldTransforms(sg);

        const t = getTrait(node, TransformTrait)!;
        const worldQ = rotY90();
        const out: Quat = quat.create();
        worldToLocalQuaternion(t, worldQ, out);
        expectQuatNear(out, worldQ);
    });

    it('nested: strips parent rotation', () => {
        const sg = setup();
        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        const parentRot = rotY90();
        addTrait(parent, TransformTrait, {
            quaternion: parentRot,
        });

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait);

        computeWorldTransforms(sg);

        const ct = getTrait(child, TransformTrait)!;
        // if world rotation equals parent rotation, local should be identity
        const out: Quat = quat.create();
        worldToLocalQuaternion(ct, parentRot, out);
        expectQuatNear(out, quat.create());
    });
});

describe('setWorldPosition', () => {
    it('top-level: sets position directly', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait);

        computeWorldTransforms(sg);

        const t = getTrait(node, TransformTrait)!;
        setWorldPosition(t, vec3.fromValues(42, 0, 0));
        expectVec3Near(t.position, vec3.fromValues(42, 0, 0));
    });

    it('nested: converts world to local correctly', () => {
        const sg = setup();
        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait, {
            position: vec3.fromValues(100, 0, 0),
        });

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait);

        computeWorldTransforms(sg);

        const ct = getTrait(child, TransformTrait)!;
        // set world pos to (110, 0, 0) → local should be (10, 0, 0)
        setWorldPosition(ct, vec3.fromValues(110, 0, 0));
        expectVec3Near(ct.position, vec3.fromValues(10, 0, 0));
    });
});

describe('setWorldQuaternion', () => {
    it('top-level: sets quaternion directly', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait);

        computeWorldTransforms(sg);

        const t = getTrait(node, TransformTrait)!;
        const worldQ = rotY90();
        setWorldQuaternion(t, worldQ);
        expectQuatNear(t.quaternion, worldQ);
    });

    it('nested: strips parent rotation', () => {
        const sg = setup();
        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait, {
            quaternion: rotY90(),
        });

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait);

        computeWorldTransforms(sg);

        const ct = getTrait(child, TransformTrait)!;
        // set world rotation to same as parent → local should be identity
        setWorldQuaternion(ct, rotY90());
        expectQuatNear(ct.quaternion, quat.create());
    });
});

// ═══════════════════════════════════════════════════════════════════════
// dirty-flag lazy recompute
// ═══════════════════════════════════════════════════════════════════════

describe('dirty-flag lazy recompute', () => {
    it('getWorldPosition triggers lazy recompute after setPosition', () => {
        const sg = setup();
        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait, {
            position: vec3.fromValues(10, 0, 0),
        });

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait, {
            position: vec3.fromValues(5, 0, 0),
        });

        // initial read triggers compute
        const ct = getTrait(child, TransformTrait)!;
        expectVec3Near(getWorldPosition(ct), vec3.fromValues(15, 0, 0));

        // mutate child local position via setter
        setPosition(ct, vec3.fromValues(20, 0, 0));

        // reading world position should trigger lazy recompute
        expectVec3Near(getWorldPosition(ct), vec3.fromValues(30, 0, 0));
    });

    it('setPosition on parent marks children dirty', () => {
        const sg = setup();
        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait, {
            position: vec3.fromValues(10, 0, 0),
        });

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait, {
            position: vec3.fromValues(5, 0, 0),
        });

        // initial reads
        const pt = getTrait(parent, TransformTrait)!;
        const ct = getTrait(child, TransformTrait)!;
        expectVec3Near(getWorldPosition(ct), vec3.fromValues(15, 0, 0));

        // move parent
        setPosition(pt, vec3.fromValues(50, 0, 0));

        // child world should update lazily
        expectVec3Near(getWorldPosition(ct), vec3.fromValues(55, 0, 0));
        expectVec3Near(getWorldPosition(pt), vec3.fromValues(50, 0, 0));
    });

    it('markDirty cascades through 3-level hierarchy', () => {
        const sg = setup();

        const gp = createNode({ name: 'GP' });
        addChild(sg.root, gp);
        addTrait(gp, TransformTrait, {
            position: vec3.fromValues(100, 0, 0),
        });

        const parent = createNode({ name: 'Parent' });
        addChild(gp, parent);
        addTrait(parent, TransformTrait, {
            position: vec3.fromValues(10, 0, 0),
        });

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait, {
            position: vec3.fromValues(1, 0, 0),
        });

        // initial reads
        expectVec3Near(getWorldPosition(getTrait(child, TransformTrait)!), vec3.fromValues(111, 0, 0));

        // move grandparent
        setPosition(getTrait(gp, TransformTrait)!, vec3.fromValues(200, 0, 0));

        // all descendants should reflect the change
        expectVec3Near(getWorldPosition(getTrait(gp, TransformTrait)!), vec3.fromValues(200, 0, 0));
        expectVec3Near(getWorldPosition(getTrait(parent, TransformTrait)!), vec3.fromValues(210, 0, 0));
        expectVec3Near(getWorldPosition(getTrait(child, TransformTrait)!), vec3.fromValues(211, 0, 0));
    });

    it('setQuaternion marks dirty and getWorldQuaternion recomputes', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait);

        const t = getTrait(node, TransformTrait)!;
        setQuaternion(t, rotY90());
        expectQuatNear(getWorldQuaternion(t), rotY90());
    });

    it('setScale marks dirty and getWorldScale recomputes', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait);

        const t = getTrait(node, TransformTrait)!;
        setScale(t, vec3.fromValues(3, 4, 5));
        expectVec3Near(getWorldScale(t), vec3.fromValues(3, 4, 5));
    });

    it('getVisualWorld* returns world values for non-Interp nodes', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait, {
            position: vec3.fromValues(7, 8, 9),
        });

        const t = getTrait(node, TransformTrait)!;
        expectVec3Near(getVisualWorldPosition(t), vec3.fromValues(7, 8, 9));
        expectQuatNear(getVisualWorldQuaternion(t), quat.create());
        expectVec3Near(getVisualWorldScale(t), vec3.fromValues(1, 1, 1));
    });

    it('getVisualWorldPosition reflects ancestor composition', () => {
        const sg = setup();
        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait, {
            position: vec3.fromValues(10, 0, 0),
        });

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait, {
            position: vec3.fromValues(5, 0, 0),
        });

        const grandchild = createNode({ name: 'GC' });
        addChild(child, grandchild);
        addTrait(grandchild, TransformTrait, {
            position: vec3.fromValues(1, 0, 0),
        });

        const pt = getTrait(parent, TransformTrait)!;
        const ct = getTrait(child, TransformTrait)!;
        const gt = getTrait(grandchild, TransformTrait)!;
        expectVec3Near(getVisualWorldPosition(pt), vec3.fromValues(10, 0, 0));
        expectVec3Near(getVisualWorldPosition(ct), vec3.fromValues(15, 0, 0));
        expectVec3Near(getVisualWorldPosition(gt), vec3.fromValues(16, 0, 0));
    });

    it('_dirty starts TRANSFORM_DIRTY_ALL so first read triggers compute', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait, {
            position: vec3.fromValues(42, 0, 0),
        });

        const t = getTrait(node, TransformTrait)!;
        // should be fully dirty initially
        expect(t._dirty).toBe(TRANSFORM_DIRTY_ALL);

        // reading clears the world-chain bits only; interpolated/parent-matrix
        // bits stay deferred until their own getters fire.
        expectVec3Near(getWorldPosition(t), vec3.fromValues(42, 0, 0));
        expect(t._dirty & (TRANSFORM_DIRTY_WORLD_MATRIX | TRANSFORM_DIRTY_WORLD_TRS)).toBe(0);
    });

    it('markDirty early-outs if already dirty', () => {
        const sg = setup();
        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait);

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait);

        const pt = getTrait(parent, TransformTrait)!;
        const ct = getTrait(child, TransformTrait)!;

        // clean the world chain on both
        getWorldPosition(pt);
        getWorldPosition(ct);
        const WORLD_MASK = TRANSFORM_DIRTY_WORLD_MATRIX | TRANSFORM_DIRTY_WORLD_TRS;
        expect(pt._dirty & WORLD_MASK).toBe(0);
        expect(ct._dirty & WORLD_MASK).toBe(0);

        // mark parent dirty
        markTransformDirty(pt);
        expect(pt._dirty).toBe(TRANSFORM_DIRTY_ALL);
        expect(ct._dirty).toBe(TRANSFORM_DIRTY_ALL);

        // marking again should be a no-op (no crash, no infinite recursion)
        markTransformDirty(pt);
        expect(pt._dirty).toBe(TRANSFORM_DIRTY_ALL);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// snapshot
// ═══════════════════════════════════════════════════════════════════════

describe('snapshot', () => {
    it('refreshes prev fields from current pose for dirty transforms', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait, {
            position: vec3.fromValues(0, 0, 0),
        });
        setInterpolation(node, true); // seeds prev = (0,0,0)

        // mutate via setPosition — marks dirty and enqueues for snapshot
        const t = getTrait(node, TransformTrait)!;
        setPosition(t, vec3.fromValues(1, 2, 3));
        setQuaternion(t, rotY90());

        snapshot(initInterpolation(sg));

        // snapshot drain copied the post-mutation pose into prev
        expectVec3Near(t.prevPosition, vec3.fromValues(1, 2, 3));
        expectQuatNear(t.prevQuaternion, rotY90());
    });

    it('prev values remain stable after position mutation without re-snapshot', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait, {
            position: vec3.fromValues(1, 2, 3),
        });
        setInterpolation(node, true);
        // setInterpolation already seeded prev = (1,2,3)

        // mutate current position
        const t = getTrait(node, TransformTrait)!;
        vec3.set(t.position, 99, 99, 99);

        // prev should still be old values
        expectVec3Near(t.prevPosition, vec3.fromValues(1, 2, 3));
    });
});

// ═══════════════════════════════════════════════════════════════════════
// interpolate
// ═══════════════════════════════════════════════════════════════════════

describe('interpolate', () => {
    it('top-level non-owned: copies position directly', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait, {
            position: vec3.fromValues(10, 20, 30),
            scale: vec3.fromValues(2, 2, 2),
        });

        computeWorldTransforms(sg);
        interpolate(initInterpolation(sg), 0.5, null);

        const t = getTrait(node, TransformTrait)!;
        expectVec3Near(getVisualWorldPosition(t), vec3.fromValues(10, 20, 30));
        expectVec3Near(getVisualWorldScale(t), vec3.fromValues(2, 2, 2));
    });

    it('top-level owned: lerps between prev and current', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        node.owner = 1;
        addTrait(node, TransformTrait, {
            position: vec3.fromValues(0, 0, 0),
        });
        setInterpolation(node, true); // seeds prev = (0,0,0)

        // prime: consume the setInterpolation cold-start teleport snap so
        // the next interpolate() actually exercises the lerp path.
        interpolate(initInterpolation(sg, 1), 0, 1);

        // move to (10, 0, 0)
        const t = getTrait(node, TransformTrait)!;
        vec3.set(t.position, 10, 0, 0);

        computeWorldTransforms(sg);
        interpolate(initInterpolation(sg, 1), 0.5, 1);

        // at alpha=0.5, should be halfway: (5, 0, 0)
        expectVec3Near(getVisualWorldPosition(t), vec3.fromValues(5, 0, 0));
    });

    it('top-level owned at alpha=0: equals prev position', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        node.owner = 1;
        addTrait(node, TransformTrait, {
            position: vec3.fromValues(0, 0, 0),
        });
        setInterpolation(node, true);

        // prime: consume the cold-start teleport snap.
        interpolate(initInterpolation(sg, 1), 0, 1);

        const t = getTrait(node, TransformTrait)!;
        vec3.set(t.position, 10, 0, 0);

        computeWorldTransforms(sg);
        interpolate(initInterpolation(sg, 1), 0, 1);

        expectVec3Near(getVisualWorldPosition(t), vec3.fromValues(0, 0, 0));
    });

    it('top-level owned at alpha=1: equals current position', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        node.owner = 1;
        addTrait(node, TransformTrait, {
            position: vec3.fromValues(0, 0, 0),
        });

        snapshot(initInterpolation(sg));
        const t = getTrait(node, TransformTrait)!;
        vec3.set(t.position, 10, 0, 0);

        computeWorldTransforms(sg);
        interpolate(initInterpolation(sg), 1, 1);

        expectVec3Near(getVisualWorldPosition(t), vec3.fromValues(10, 0, 0));
    });

    it('builds interpolatedWorldMatrix from interpolated TRS', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait, {
            position: vec3.fromValues(5, 10, 15),
            scale: vec3.fromValues(2, 2, 2),
        });
        setInterpolation(node, true);

        computeWorldTransforms(sg);
        interpolate(initInterpolation(sg), 0.5, null);

        const t = getTrait(node, TransformTrait)!;
        const expected: Mat4 = mat4.create();
        mat4.fromRotationTranslationScale(expected, t.interpolatedWorldQuaternion, t.interpolatedWorldPosition, t.interpolatedWorldScale);
        expectMat4Near(t.interpolatedWorldMatrix, expected);
    });

    it('child of interpolated ancestor composes visual chain against interpolated parent', () => {
        const sg = setup();

        // parent is interpolated; child is not. child reads through
        // getVisualWorldMatrix and should see the interpolated parent matrix.
        // parent is owned so interpolate() lerps prev→current (non-owned
        // top-level nodes snap to current and would defeat the assertion).
        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        parent.owner = 1;
        addTrait(parent, TransformTrait, { position: vec3.fromValues(0, 0, 0) });
        setInterpolation(parent, true); // seeds prev = (0,0,0)

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait, { position: vec3.fromValues(1, 0, 0) });

        computeWorldTransforms(sg);

        // prime: consume the cold-start teleport snap on parent so the
        // next interpolate() exercises the lerp path.
        interpolate(initInterpolation(sg, 1), 0, 1);

        // now move parent (the "current" pose) — interpolate at alpha=0.5
        // should produce parent.visualPos = (5,0,0), so child world =
        // (5,0,0) + (1,0,0) = (6,0,0).
        const pt = getTrait(parent, TransformTrait)!;
        pt.position[0] = 10;
        markTransformDirty(pt);
        interpolate(initInterpolation(sg, 1), 0.5, 1);

        const ct = getTrait(child, TransformTrait)!;
        expectVec3Near(getVisualWorldPosition(ct), vec3.fromValues(6, 0, 0));
    });

    it('nested non-owned: composes local with parent worldMatrix', () => {
        const sg = setup();

        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait, {
            position: vec3.fromValues(100, 0, 0),
        });

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait, {
            position: vec3.fromValues(10, 0, 0),
        });

        computeWorldTransforms(sg);
        interpolate(initInterpolation(sg), 0.5, null);

        const ct = getTrait(child, TransformTrait)!;
        // nested non-owned uses current local directly, composed with parent world
        expectVec3Near(getVisualWorldPosition(ct), vec3.fromValues(110, 0, 0));
    });

    it('teleport flag causes snap instead of lerp', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        node.owner = 1;
        addTrait(node, TransformTrait, {
            position: vec3.fromValues(0, 0, 0),
        });

        snapshot(initInterpolation(sg));
        const t = getTrait(node, TransformTrait)!;
        vec3.set(t.position, 100, 0, 0);
        t.teleport = 1; // trigger teleport

        computeWorldTransforms(sg);
        interpolate(initInterpolation(sg), 0.5, 1);

        // should snap to current, not lerp
        expectVec3Near(getVisualWorldPosition(t), vec3.fromValues(100, 0, 0));
    });

    it('static node never under Interp: _interpolated stays 0, visual getters return world', () => {
        const sg = setup();
        const node = createNode({ name: 'Static' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait, {
            position: vec3.fromValues(7, 8, 9),
        });

        // run interpolate over a scene with no Interp nodes — should not
        // touch this node's _interpolated bit.
        snapshot(initInterpolation(sg));
        interpolate(initInterpolation(sg), 0.5, null);

        const t = getTrait(node, TransformTrait)!;
        expect(t._interpolated).toBe(0);
        // visual getters short-circuit to the world chain
        expectVec3Near(getVisualWorldPosition(t), vec3.fromValues(7, 8, 9));
        expectVec3Near(getWorldPosition(t), getVisualWorldPosition(t));
    });

    it('interpolated node sets its own _interpolated bit after first interpolate()', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait, { position: vec3.fromValues(0, 0, 0) });
        setInterpolation(node, true);

        const t = getTrait(node, TransformTrait)!;
        expect(t._interpolated).toBe(0);

        interpolate(initInterpolation(sg), 0.5, null);

        expect(t._interpolated).toBe(1);
    });

    it('descendants of interpolated node get _interpolated set by descendant-mark walk', () => {
        const sg = setup();

        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait, { position: vec3.fromValues(0, 0, 0) });
        setInterpolation(parent, true);

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait, { position: vec3.fromValues(1, 0, 0) });

        const grandchild = createNode({ name: 'Grandchild' });
        addChild(child, grandchild);
        addTrait(grandchild, TransformTrait, { position: vec3.fromValues(0, 1, 0) });

        const ct = getTrait(child, TransformTrait)!;
        const gct = getTrait(grandchild, TransformTrait)!;
        expect(ct._interpolated).toBe(0);
        expect(gct._interpolated).toBe(0);

        interpolate(initInterpolation(sg), 0.5, null);

        expect(ct._interpolated).toBe(1);
        expect(gct._interpolated).toBe(1);
    });

    it('interp child of static parent composes against parent.worldMatrix', () => {
        // boundary case at transforms.ts compose: when an Interp child has
        // a non-Interp parent, the parent's interpolatedWorldMatrix is
        // never populated. compose must source parent.worldMatrix instead.
        const sg = setup();

        const parent = createNode({ name: 'StaticParent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait, { position: vec3.fromValues(10, 0, 0) });

        const child = createNode({ name: 'InterpChild' });
        addChild(parent, child);
        addTrait(child, TransformTrait, { position: vec3.fromValues(1, 0, 0) });
        setInterpolation(child, true);

        // refresh parent.worldMatrix — the chain compose() will read against
        computeWorldTransforms(sg);

        const pt = getTrait(parent, TransformTrait)!;
        const ct = getTrait(child, TransformTrait)!;

        // move child locally; non-owned interpolate path copies current
        // directly, which still exercises the parent-matrix boundary.
        setPosition(ct, vec3.fromValues(3, 0, 0));

        interpolate(initInterpolation(sg), 0.5, null);

        // parent never participated — bit stays 0, boundary takes the
        // parent.worldMatrix branch.
        expect(pt._interpolated).toBe(0);
        expect(ct._interpolated).toBe(1);

        // child's visual world = parent.worldMatrix * child.local
        // = [10,0,0] + [3,0,0] = [13,0,0]
        expectVec3Near(getVisualWorldPosition(ct), vec3.fromValues(13, 0, 0));
    });

    it('setInterpolation(true) seeds prev = current immediately', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait, {
            position: vec3.fromValues(7, 8, 9),
            quaternion: rotY90(),
        });

        const t = getTrait(node, TransformTrait)!;
        // before opt-in, prev is default (0,0,0) / identity
        expectVec3Near(t.prevPosition, vec3.fromValues(0, 0, 0));

        setInterpolation(node, true);

        // prev now mirrors current — first interpolate frame won't lerp from origin
        expectVec3Near(t.prevPosition, vec3.fromValues(7, 8, 9));
        expectQuatNear(t.prevQuaternion, rotY90());
        expect(t.interpolate).toBe(1);
        expect(sg._interpolating.has(t)).toBe(true);
    });

    it('setInterpolation(false) clears _interpolated and removes from set', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait, { position: vec3.fromValues(1, 0, 0) });
        setInterpolation(node, true);
        interpolate(initInterpolation(sg), 0.5, null);

        const t = getTrait(node, TransformTrait)!;
        expect(t._interpolated).toBe(1);
        expect(sg._interpolating.has(t)).toBe(true);

        setInterpolation(node, false);

        expect(t.interpolate).toBe(0);
        expect(t._interpolated).toBe(0);
        expect(sg._interpolating.has(t)).toBe(false);
    });

    it('setInterpolation is idempotent on repeated calls', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait, { position: vec3.fromValues(1, 2, 3) });

        setInterpolation(node, true);
        const t = getTrait(node, TransformTrait)!;
        // mutate prev so we can detect whether a second enable resets it
        vec3.set(t.prevPosition, 99, 99, 99);
        setInterpolation(node, true);
        // idempotent: prev was NOT re-seeded
        expectVec3Near(t.prevPosition, vec3.fromValues(99, 99, 99));

        setInterpolation(node, false);
        setInterpolation(node, false);
        expect(t.interpolate).toBe(0);
    });

    it('resetInterpolation re-seeds prev from current pose', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait, { position: vec3.fromValues(0, 0, 0) });
        setInterpolation(node, true);

        const t = getTrait(node, TransformTrait)!;
        // teleport the node and reset interpolation to suppress rubber-band
        vec3.set(t.position, 50, 0, 0);
        resetInterpolation(node);

        expectVec3Near(t.prevPosition, vec3.fromValues(50, 0, 0));
    });

    it('resetInterpolation is a no-op for non-interpolated nodes', () => {
        const sg = setup();
        const node = createNode({ name: 'A' });
        addChild(sg.root, node);
        addTrait(node, TransformTrait, { position: vec3.fromValues(1, 2, 3) });

        const t = getTrait(node, TransformTrait)!;
        resetInterpolation(node);
        // prev stays at default
        expectVec3Near(t.prevPosition, vec3.fromValues(0, 0, 0));
    });
});

// ═══════════════════════════════════════════════════════════════════════
// round-trip: mutation → compute → verify
// ═══════════════════════════════════════════════════════════════════════

describe('round-trip: mutation → compute → verify', () => {
    it('moving parent updates child world position on next compute', () => {
        const sg = setup();

        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait, {
            position: vec3.fromValues(10, 0, 0),
        });

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait, {
            position: vec3.fromValues(5, 0, 0),
        });

        computeWorldTransforms(sg);
        expectVec3Near(getWorldPosition(getTrait(child, TransformTrait)!), vec3.fromValues(15, 0, 0));

        // move parent via setter (marks dirty)
        setPosition(getTrait(parent, TransformTrait)!, vec3.fromValues(50, 0, 0));
        computeWorldTransforms(sg);
        expectVec3Near(getWorldPosition(getTrait(child, TransformTrait)!), vec3.fromValues(55, 0, 0));
    });

    it('reparenting then computing gives correct world position', () => {
        const sg = setup();

        const parentA = createNode({ name: 'A' });
        addChild(sg.root, parentA);
        addTrait(parentA, TransformTrait, {
            position: vec3.fromValues(10, 0, 0),
        });

        const parentB = createNode({ name: 'B' });
        addChild(sg.root, parentB);
        addTrait(parentB, TransformTrait, {
            position: vec3.fromValues(200, 0, 0),
        });

        const child = createNode({ name: 'Child' });
        addChild(parentA, child);
        addTrait(child, TransformTrait, {
            position: vec3.fromValues(5, 0, 0),
        });

        computeWorldTransforms(sg);
        expectVec3Near(getWorldPosition(getTrait(child, TransformTrait)!), vec3.fromValues(15, 0, 0));

        // reparent child to B
        reparent(child, parentB);
        computeWorldTransforms(sg);
        expectVec3Near(getWorldPosition(getTrait(child, TransformTrait)!), vec3.fromValues(205, 0, 0));
    });

    it('setWorldPosition + compute round-trip preserves world position', () => {
        const sg = setup();

        const parent = createNode({ name: 'Parent' });
        addChild(sg.root, parent);
        addTrait(parent, TransformTrait, {
            position: vec3.fromValues(100, 0, 0),
            scale: vec3.fromValues(2, 2, 2),
        });

        const child = createNode({ name: 'Child' });
        addChild(parent, child);
        addTrait(child, TransformTrait);

        computeWorldTransforms(sg);

        const ct = getTrait(child, TransformTrait)!;
        const desiredWorldPos = vec3.fromValues(120, 0, 0);
        setWorldPosition(ct, desiredWorldPos);

        // recompute — child world position should match desired
        computeWorldTransforms(sg);
        expectVec3Near(getWorldPosition(ct), desiredWorldPos);
    });
});
