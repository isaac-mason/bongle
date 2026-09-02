import { frustum, PerspectiveCamera } from 'gpucat';
import { mat4 } from 'math';
import { type Box3, box3 } from 'math/shapes';
import { describe, expect, it } from 'vitest';
import * as dbvt from '../../../src/render/visibility/dbvt';

/** deterministic PRNG, so a failure is reproducible. */
function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function boxAt(x: number, y: number, z: number, half = 0.5): Box3 {
    return box3.set(box3.create(), x - half, y - half, z - half, x + half, y + half, z + half);
}

function checkInvariants(tree: dbvt.Dbvt): { leaves: number; maxDepth: number } {
    if (tree.root === -1) return { leaves: 0, maxDepth: 0 };

    let leaves = 0;
    let maxDepth = 0;
    const stack: Array<[index: number, parent: number, depth: number]> = [[tree.root, -1, 0]];

    while (stack.length > 0) {
        const [index, parent, depth] = stack.pop()!;
        const node = tree.nodes[index]!;
        expect(node.parent).toBe(parent);
        if (depth > maxDepth) maxDepth = depth;

        if (node.left === -1) {
            expect(node.right).toBe(-1);
            expect(node.height).toBe(0);
            leaves++;
            continue;
        }

        const left = tree.nodes[node.left]!;
        const right = tree.nodes[node.right]!;
        expect(node.height).toBe(1 + Math.max(left.height, right.height));
        expect(Math.abs(left.height - right.height)).toBeLessThanOrEqual(1);
        expect(box3.containsBox3(node.aabb, left.aabb)).toBe(true);
        expect(box3.containsBox3(node.aabb, right.aabb)).toBe(true);

        stack.push([node.left, index, depth + 1]);
        stack.push([node.right, index, depth + 1]);
    }

    return { leaves, maxDepth };
}

/** every leaf currently in the tree, as (data, aabb) pairs. */
function allLeaves(tree: dbvt.Dbvt): Array<{ data: number; aabb: Box3 }> {
    const out: Array<{ data: number; aabb: Box3 }> = [];
    if (tree.root === -1) return out;
    const stack = [tree.root];
    while (stack.length > 0) {
        const node = tree.nodes[stack.pop()!]!;
        if (node.left === -1) out.push({ data: node.data, aabb: node.aabb });
        else {
            stack.push(node.left);
            stack.push(node.right);
        }
    }
    return out;
}

function makeFrustum(eye: [number, number, number], target: [number, number, number]) {
    const camera = new PerspectiveCamera(Math.PI / 3, 1, 0.1, 500);
    mat4.lookAt(camera.matrixWorldInverse, eye, target, [0, 1, 0]);
    const f = frustum.create();
    frustum.setFromViewProjectionMatrix(f, camera.projectionMatrix, camera.matrixWorldInverse, camera.coordinateSystem);
    return f;
}

describe('dbvt', () => {
    it('keeps its invariants through inserts, updates and removes', () => {
        const tree = dbvt.create();
        const random = rng(0x1234567);
        const leaves: number[] = [];

        for (let i = 0; i < 400; i++) {
            leaves.push(dbvt.add(tree, boxAt(random() * 200 - 100, random() * 40, random() * 200 - 100), i));
        }
        expect(checkInvariants(tree).leaves).toBe(400);

        for (let i = 0; i < leaves.length; i++) {
            dbvt.update(tree, leaves[i]!, boxAt(random() * 200 - 100, random() * 40, random() * 200 - 100));
        }
        expect(checkInvariants(tree).leaves).toBe(400);

        for (let i = 0; i < leaves.length; i += 2) dbvt.remove(tree, leaves[i]!);
        expect(checkInvariants(tree).leaves).toBe(200);
    });

    it('stays near log2(leaves) deep rather than drifting with insertion order', () => {
        const tree = dbvt.create();
        for (let i = 0; i < 1024; i++) dbvt.add(tree, boxAt(i * 2, 0, 0), i);

        const { maxDepth } = checkInvariants(tree);
        expect(maxDepth).toBeLessThanOrEqual(16);
        expect(dbvt.height(tree)).toBe(maxDepth);
    });

    it('visits exactly the leaves a brute-force frustum test finds', () => {
        const tree = dbvt.create();
        const random = rng(0xabcdef);
        for (let i = 0; i < 500; i++) {
            dbvt.add(tree, boxAt(random() * 300 - 150, random() * 30, random() * 300 - 150), i);
        }

        const f = makeFrustum([0, 20, 200], [0, 0, 0]);
        const expected = new Set(
            allLeaves(tree)
                .filter((l) => frustum.intersectsBox3(f, l.aabb))
                .map((l) => l.data),
        );

        const got = new Set<number>();
        dbvt.frustumCull(tree, f, 0, 20, 200, Number.POSITIVE_INFINITY, (data) => {
            got.add(data);
        });

        expect([...got].sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));
    });

    it('drops leaves outside the view sphere without dropping any inside it', () => {
        const tree = dbvt.create();
        const random = rng(0x5eed);
        for (let i = 0; i < 500; i++) {
            dbvt.add(tree, boxAt(random() * 300 - 150, random() * 30, random() * 300 - 150), i);
        }

        const eye: [number, number, number] = [0, 20, 200];
        const f = makeFrustum(eye, [0, 0, 0]);
        const radius = 120;
        const radiusSq = radius * radius;

        const expected = new Set(
            allLeaves(tree)
                .filter((l) => {
                    if (!frustum.intersectsBox3(f, l.aabb)) return false;
                    const dx = eye[0] < l.aabb[0] ? l.aabb[0] - eye[0] : eye[0] > l.aabb[3] ? eye[0] - l.aabb[3] : 0;
                    const dy = eye[1] < l.aabb[1] ? l.aabb[1] - eye[1] : eye[1] > l.aabb[4] ? eye[1] - l.aabb[4] : 0;
                    const dz = eye[2] < l.aabb[2] ? l.aabb[2] - eye[2] : eye[2] > l.aabb[5] ? eye[2] - l.aabb[5] : 0;
                    return dx * dx + dy * dy + dz * dz <= radiusSq;
                })
                .map((l) => l.data),
        );
        expect(expected.size).toBeGreaterThan(0);

        const got = new Set<number>();
        dbvt.frustumCull(tree, f, eye[0], eye[1], eye[2], radiusSq, (data) => {
            got.add(data);
        });

        expect([...got].sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));
    });

    it('survives emptying and refilling', () => {
        const tree = dbvt.create();
        const leaves: number[] = [];
        for (let i = 0; i < 32; i++) leaves.push(dbvt.add(tree, boxAt(i, 0, 0), i));
        for (const leaf of leaves) dbvt.remove(tree, leaf);
        expect(tree.root).toBe(-1);

        leaves.length = 0;
        for (let i = 0; i < 32; i++) leaves.push(dbvt.add(tree, boxAt(0, i, 0), i));
        expect(checkInvariants(tree).leaves).toBe(32);
    });
});
