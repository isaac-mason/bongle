import { describe, expect, it } from 'vitest';
import { TransformTrait } from '../../../../src/builtins/transform';
import { addChild, addTrait, createNode, createSceneTree } from '../../../../src/core/scene/scene-tree';

describe('Self marker', () => {
    it('types a self-referential field as the trait instance, no cast', () => {
        const sceneTree = createSceneTree();
        const parent = createNode({ name: 'parent' });
        const child = createNode({ name: 'child' });
        addChild(sceneTree.root, parent);
        addChild(parent, child);
        const pt = addTrait(parent, TransformTrait);
        const ct = addTrait(child, TransformTrait);

        // the compile-time half: reading TransformTrait-only members straight
        // off `_parent` only typechecks if `Self` resolved to the real type.
        const resolved = ct._parent;
        expect(resolved).toBe(pt);
        if (resolved === null) throw new Error('expected a parent transform');
        expect(resolved.worldMatrix.length).toBe(16);
        expect(resolved.position.length).toBe(3);
        expect(resolved._parent).toBe(null);
    });
});
