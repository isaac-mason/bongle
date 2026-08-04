import {
    checkAvatarHeight,
    RIG_6BONE_LOCOMOTION_CLIPS,
    RIG_6BONE_MAX_HEIGHT_M,
    RIG_6BONE_MIN_HEIGHT_M,
    RIG_6BONE_REQUIRED_NODES,
    RIG_TYPE_6BONE,
    type RigNodeView,
    type RigSceneView,
    validateRig6Bone,
} from '../../../../avatar/rig';
import { describe, expect, it } from 'vitest';

// Small builder so each test reads as a tree literal rather than an
// imperative chain of pushes.
const n = (name: string, children: RigNodeView[] = []): RigNodeView => ({ name, children });

const conformingRig = (): RigSceneView => ({
    roots: [n('waist', [n('body', [n('head'), n('arm_left'), n('arm_right')])]), n('leg_left'), n('leg_right')],
});

describe('rig contract — tags & constants', () => {
    it('tags are frozen at the documented values', () => {
        expect(RIG_TYPE_6BONE).toBe('6bone');
        expect(RIG_6BONE_REQUIRED_NODES).toEqual(['waist', 'body', 'head', 'arm_left', 'arm_right', 'leg_left', 'leg_right']);
        expect(RIG_6BONE_LOCOMOTION_CLIPS).toEqual(['idle', 'walk']);
    });
});

describe('validateRig6Bone', () => {
    it('accepts a Blockbench-style rig with legs as separate scene roots', () => {
        expect(validateRig6Bone(conformingRig())).toEqual({ ok: true });
    });

    it('accepts a fully nested rig under a single root', () => {
        const scene: RigSceneView = {
            roots: [n('waist', [n('body', [n('head'), n('arm_left'), n('arm_right')]), n('leg_left'), n('leg_right')])],
        };
        expect(validateRig6Bone(scene)).toEqual({ ok: true });
    });

    it('accepts attach-point empties anywhere in the tree', () => {
        const scene: RigSceneView = {
            roots: [
                n('waist', [
                    n('body', [n('head'), n('arm_left', [n('hand_left')]), n('arm_right', [n('hand_right')]), n('back')]),
                ]),
                n('leg_left'),
                n('leg_right'),
            ],
        };
        expect(validateRig6Bone(scene)).toEqual({ ok: true });
    });

    it('accepts avatar-specific (non-canonical) bones alongside required ones', () => {
        const scene: RigSceneView = {
            roots: [
                n('waist', [n('body', [n('head'), n('arm_left'), n('arm_right'), n('tail')])]),
                n('leg_left', [n('fin_left')]),
                n('leg_right', [n('fin_right')]),
            ],
        };
        expect(validateRig6Bone(scene)).toEqual({ ok: true });
    });

    it('flags every individually missing required node', () => {
        const scene: RigSceneView = {
            roots: [n('waist', [n('body', [n('arm_left')]), n('leg_left')])],
        };
        const result = validateRig6Bone(scene);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors).toContain(`missing required node 'head'`);
            expect(result.errors).toContain(`missing required node 'arm_right'`);
            expect(result.errors).toContain(`missing required node 'leg_right'`);
        }
    });

    it('skips the height bound when no height is supplied', () => {
        expect(validateRig6Bone({ ...conformingRig(), heightMeters: undefined })).toEqual({ ok: true });
    });

    it('accepts a conforming rig with an in-bounds height', () => {
        expect(validateRig6Bone({ ...conformingRig(), heightMeters: 1.8 })).toEqual({ ok: true });
    });

    it('rejects a conforming rig that is too tall', () => {
        const result = validateRig6Bone({ ...conformingRig(), heightMeters: RIG_6BONE_MAX_HEIGHT_M + 0.5 });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors.some((e) => e.includes('tall'))).toBe(true);
    });

    it('rejects a conforming rig that is too short', () => {
        const result = validateRig6Bone({ ...conformingRig(), heightMeters: RIG_6BONE_MIN_HEIGHT_M - 0.1 });
        expect(result.ok).toBe(false);
    });

    it('reports both a missing node and a bad height together', () => {
        const scene: RigSceneView = {
            roots: [n('waist', [n('body', [n('head'), n('arm_left'), n('arm_right')]), n('leg_left')])],
            heightMeters: 10,
        };
        const result = validateRig6Bone(scene);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors).toContain(`missing required node 'leg_right'`);
            expect(result.errors.some((e) => e.includes('tall'))).toBe(true);
        }
    });
});

describe('checkAvatarHeight', () => {
    it('passes heights inside the bounds', () => {
        expect(checkAvatarHeight(RIG_6BONE_MIN_HEIGHT_M)).toBeNull();
        expect(checkAvatarHeight(RIG_6BONE_MAX_HEIGHT_M)).toBeNull();
        expect(checkAvatarHeight(1.8)).toBeNull();
    });

    it('fails heights outside the bounds with a descriptive message', () => {
        expect(checkAvatarHeight(RIG_6BONE_MAX_HEIGHT_M + 0.01)).toContain('tall');
        expect(checkAvatarHeight(RIG_6BONE_MIN_HEIGHT_M - 0.01)).toContain('tall');
    });
});
