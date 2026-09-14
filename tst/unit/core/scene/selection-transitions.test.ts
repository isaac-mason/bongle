import { describe, expect, it } from 'vitest';
import * as Selection from '../../../../src/core/scene/selection';

describe('Selection transitions', () => {
    it('node transitions share the voxel chunks and keep the active id in the nodes', () => {
        const base = Selection.ofVoxel(1, 2, 3);
        const one = Selection.withNode(base, 7);
        expect(one.chunks).toBe(base.chunks);
        expect(one.active).toBe(7);
        const two = Selection.withNode(one, 9);
        expect([...two.nodes]).toEqual([7, 9]);
        expect(two.active).toBe(9);
        const back = Selection.withoutNode(two, 9);
        expect(back.active).toBeNull();
        expect(Selection.activeNode(back)).toBe(7);
        expect(Selection.has(back, 1, 2, 3)).toBe(true);
    });

    it('ofNode and nodesOnly drop the voxels, voxelsOnly drops the nodes', () => {
        const mixed = Selection.withNode(Selection.ofVoxel(0, 0, 0), 3);
        expect(Selection.countVoxels(Selection.ofNode(3))).toBe(0);
        expect(Selection.countVoxels(Selection.nodesOnly(mixed))).toBe(0);
        expect(Selection.nodesOnly(mixed).nodes.has(3)).toBe(true);
        expect(Selection.voxelsOnly(mixed).nodes.size).toBe(0);
        expect(Selection.has(Selection.voxelsOnly(mixed), 0, 0, 0)).toBe(true);
    });

    it('withVoxelToggled never mutates the source', () => {
        const base = Selection.ofVoxel(0, 0, 0);
        const toggled = Selection.withVoxelToggled(base, 0, 0, 0);
        expect(Selection.has(base, 0, 0, 0)).toBe(true);
        expect(Selection.has(toggled, 0, 0, 0)).toBe(false);
        const added = Selection.withVoxelToggled(base, 5, 5, 5);
        expect(Selection.countVoxels(added)).toBe(2);
        expect(Selection.countVoxels(base)).toBe(1);
    });
});
