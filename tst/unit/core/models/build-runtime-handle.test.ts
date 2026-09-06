import { describe, expect, it } from 'vitest';
import { MeshTrait } from '../../../../src/builtins/mesh';
import { TransformTrait } from '../../../../src/builtins/transform';
import { createEmptyDef, hydrateRuntimeHandle } from '../../../../src/core/models/build-runtime-handle';
import type { Model, ModelNode } from '../../../../src/core/models/model';
import { getTrait } from '../../../../src/core/scene/scene-tree';

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
        const def = createEmptyDef('avatar');
        const v0 = def.version;
        const model = makeMinimalModel();

        hydrateRuntimeHandle(def, model);

        expect(def.version).toBe(v0 + 1);
        expect(def.aabb).toEqual([0, 0, 0, 1, 2, 1]);
        expect(Object.keys(def.nodes).sort()).toEqual(['arm', 'avatar_root', 'head']);
        expect(def.scene).toBe(def.nodes.avatar_root);
        expect(def.meshes.HeadMesh!.id).toEqual({ modelId: 'avatar', meshName: 'HeadMesh' });
    });

    it('stamps TransformTrait + MeshTrait on mesh-bearing nodes', () => {
        const def = createEmptyDef('avatar');
        hydrateRuntimeHandle(def, makeMinimalModel());

        const head = def.nodes.head!;
        const transform = getTrait(head, TransformTrait);
        expect(transform).toBeDefined();
        expect(transform!.position).toEqual([0, 1, 0]);

        const mesh = getTrait(head, MeshTrait);
        expect(mesh).toBeDefined();
        expect(mesh!.meshId).toEqual({ modelId: 'avatar', meshName: 'HeadMesh' });
    });

    it('skips TransformTrait on identity-TRS non-mesh non-animated nodes', () => {
        const def = createEmptyDef('avatar');
        hydrateRuntimeHandle(def, makeMinimalModel());

        const arm = def.nodes.arm!;
        expect(getTrait(arm, TransformTrait)).toBeUndefined();
    });
});
