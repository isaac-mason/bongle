import { describe, expect, it } from 'vitest';
import { MeshTrait } from '../../builtins/mesh';
import { getTrait } from '../scene/nodes';
import { TransformTrait } from '../../builtins/transform';
import { createEmptyHandle, hydrateRuntimeHandle } from './build-runtime-handle';
import type { Model, ModelNode } from './model';

function makeMinimalModel(): Model {
    // root → head (mesh) + arm (transform only, identity-TRS)
    const headMesh = {
        name: 'HeadMesh',
        positions: new Float32Array([0, 0, 0]),
        normals: new Float32Array([0, 1, 0]),
        uvs: new Float32Array([0, 0]),
        indices: new Uint32Array([0]),
        aabb: [0, 0, 0, 1, 1, 1] as [number, number, number, number, number, number],
        image: null,
    };

    const root: ModelNode = {
        name: 'avatar_root',
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
        parent: null,
        children: [],
        mesh: null,
    };
    const head: ModelNode = {
        name: 'head',
        position: [0, 1, 0],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
        parent: root,
        children: [],
        mesh: headMesh,
    };
    const arm: ModelNode = {
        name: 'arm',
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
        parent: root,
        children: [],
        mesh: null,
    };
    root.children = [head, arm];

    const nodesByName = new Map<string, ModelNode>([
        ['avatar_root', root],
        ['head', head],
        ['arm', arm],
    ]);
    const meshesByName = new Map([['HeadMesh', headMesh]]);

    return {
        root,
        nodesByName,
        meshesByName,
        clipsByName: new Map(),
        images: [],
        aabb: [0, 0, 0, 1, 2, 1],
    };
}

describe('hydrateRuntimeHandle', () => {
    it('populates scene/nodes/meshes/animations and bumps version', () => {
        const handle = createEmptyHandle('avatar');
        const v0 = handle.version;
        const model = makeMinimalModel();

        hydrateRuntimeHandle(handle, model);

        expect(handle.version).toBe(v0 + 1);
        expect(handle.aabb).toEqual([0, 0, 0, 1, 2, 1]);
        expect(Object.keys(handle.nodes).sort()).toEqual(['arm', 'avatar_root', 'head']);
        expect(handle.scene).toBe(handle.nodes.avatar_root);
        expect(handle.meshes.HeadMesh!.id).toEqual({ modelId: 'avatar', meshName: 'HeadMesh' });
    });

    it('stamps TransformTrait + MeshTrait on mesh-bearing nodes', () => {
        const handle = createEmptyHandle('avatar');
        hydrateRuntimeHandle(handle, makeMinimalModel());

        const head = handle.nodes.head!;
        const transform = getTrait(head, TransformTrait);
        expect(transform).toBeDefined();
        expect(transform!.position).toEqual([0, 1, 0]);

        const mesh = getTrait(head, MeshTrait);
        expect(mesh).toBeDefined();
        expect(mesh!.meshId).toEqual({ modelId: 'avatar', meshName: 'HeadMesh' });
    });

    it('skips TransformTrait on identity-TRS non-mesh non-animated nodes', () => {
        const handle = createEmptyHandle('avatar');
        hydrateRuntimeHandle(handle, makeMinimalModel());

        const arm = handle.nodes.arm!;
        expect(getTrait(arm, TransformTrait)).toBeUndefined();
    });
});
