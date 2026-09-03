import { describe, expect, it } from 'vitest';
import { TransformTrait } from '../../../../src/builtins/transform';
import { addChild, addTrait, cloneNode, createNode, createSceneTree, getTrait } from '../../../../src/core/scene/scene-tree';

describe('transform ancestry on detached subtrees', () => {
    // `_parent` must be correct BEFORE attachment: scene-pack hydrates whole trees
    // detached, and `cloneNode` assembles one bottom-up. Nothing here is in a
    // scene tree, so none of it is in a query.
    it('addTrait resolves the field on a detached node', () => {
        const top = createNode({ name: 'top' });
        const mid = createNode({ name: 'mid' });
        addChild(top, mid);
        const t = addTrait(top, TransformTrait);
        const m = addTrait(mid, TransformTrait);
        expect(m._parent).toBe(t);
        expect(t._parent).toBe(null);
    });

    it('addChild re-resolves a detached subtree under a detached parent', () => {
        const top = createNode({ name: 'top' });
        const t = addTrait(top, TransformTrait);

        // built separately, attached afterwards, the hydration shape
        const sub = createNode({ name: 'sub' });
        const leaf = createNode({ name: 'leaf' });
        addChild(sub, leaf);
        const s = addTrait(sub, TransformTrait);
        const l = addTrait(leaf, TransformTrait);
        expect(s._parent).toBe(null);
        expect(l._parent).toBe(s);

        addChild(top, sub);
        expect(s._parent).toBe(t);
        // the walk prunes at `sub` (it bears a transform), which is only correct
        // because leaf already pointed at sub and that didn't change.
        expect(l._parent).toBe(s);
        expect(t._children).toEqual([s]);
        expect(s._children).toEqual([l]);
    });

    it('a clone carries fresh ancestry, not pointers into the source tree', () => {
        const sceneTree = createSceneTree();
        const host = createNode({ name: 'host' });
        addChild(sceneTree.root, host);
        const hostXf = addTrait(host, TransformTrait);

        const src = createNode({ name: 'src' });
        const gap = createNode({ name: 'gap' }); // no transform: descendants resolve past it
        const leaf = createNode({ name: 'leaf' });
        addChild(src, gap);
        addChild(gap, leaf);
        const srcXf = addTrait(src, TransformTrait);
        const leafXf = addTrait(leaf, TransformTrait);
        addChild(host, src);
        expect(srcXf._parent).toBe(hostXf);
        expect(leafXf._parent).toBe(srcXf);

        const clone = cloneNode(src);
        const cloneXf = getTrait(clone, TransformTrait)!;
        const cloneLeaf = getTrait(clone.children[0]!.children[0]!, TransformTrait)!;
        // detached clone: nothing above it yet, and the inner edge resolves
        // within the clone rather than at the original.
        expect(cloneXf._parent).toBe(null);
        expect(cloneLeaf._parent).toBe(cloneXf);
        expect(cloneLeaf._parent).not.toBe(srcXf);
        expect(srcXf._children).toEqual([leafXf]);

        addChild(host, clone);
        expect(cloneXf._parent).toBe(hostXf);
        expect(cloneLeaf._parent).toBe(cloneXf);
        expect(hostXf._children).toEqual([srcXf, cloneXf]);
    });
});

describe('transform ancestry in an attached tree', () => {
    it('_parent cannot be set through addTrait props', () => {
        const sceneTree = createSceneTree();
        const host = createNode({ name: 'host' });
        addChild(sceneTree.root, host);
        const real = addTrait(host, TransformTrait);

        const child = createNode({ name: 'child' });
        addChild(host, child);
        // an override would be silently overwritten by the next resolve, so it is
        // ignored outright rather than briefly appearing to work.
        const decoy = { _children: [] } as any;
        const xf = addTrait(child, TransformTrait, { _parent: decoy });
        expect(xf._parent).toBe(real);
        expect(decoy._children).toEqual([]);
    });

    it('a nested transform points at the nearest transform above it', () => {
        const sceneTree = createSceneTree();
        const top = createNode({ name: 'top' });
        const mid = createNode({ name: 'mid' });
        addChild(sceneTree.root, top);
        addChild(top, mid);
        const t = addTrait(top, TransformTrait);
        const m = addTrait(mid, TransformTrait);
        expect(m._parent).toBe(t);
        // the scene root bears no transform, so `top` is a transform root
        expect(t._parent).toBe(null);
    });
});
