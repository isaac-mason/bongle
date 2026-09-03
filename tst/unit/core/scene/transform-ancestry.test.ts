import { describe, expect, it } from 'vitest';
import { parentTransform, TransformTrait } from '../../../../src/builtins/transform';
import { addChild, addTrait, cloneNode, createNode, createSceneTree, getTrait } from '../../../../src/core/scene/scene-tree';

describe('transform ancestry on detached subtrees', () => {
    // ancestry must read correctly BEFORE attachment: scene-pack hydrates whole trees
    // detached, and `cloneNode` assembles one bottom-up. Nothing here is in a scene tree.
    it('resolves on a detached node', () => {
        const top = createNode({ name: 'top' });
        const mid = createNode({ name: 'mid' });
        addChild(top, mid);
        const t = addTrait(top, TransformTrait);
        const m = addTrait(mid, TransformTrait);
        expect(parentTransform(m)).toBe(t);
        expect(parentTransform(t)).toBe(null);
    });

    it('a detached subtree reads through to a detached parent after addChild', () => {
        const top = createNode({ name: 'top' });
        const t = addTrait(top, TransformTrait);

        // built separately, attached afterwards, the hydration shape
        const sub = createNode({ name: 'sub' });
        const leaf = createNode({ name: 'leaf' });
        addChild(sub, leaf);
        const s = addTrait(sub, TransformTrait);
        const l = addTrait(leaf, TransformTrait);
        expect(parentTransform(s)).toBe(null);
        expect(parentTransform(l)).toBe(s);

        addChild(top, sub);
        expect(parentTransform(s)).toBe(t);
        expect(parentTransform(l)).toBe(s);
    });

    it('a clone reads its own ancestry, not the source tree', () => {
        const sceneTree = createSceneTree();
        const host = createNode({ name: 'host' });
        addChild(sceneTree.root, host);
        const hostXf = addTrait(host, TransformTrait);

        const src = createNode({ name: 'src' });
        const gap = createNode({ name: 'gap' }); // no transform: descendants read past it
        const leaf = createNode({ name: 'leaf' });
        addChild(src, gap);
        addChild(gap, leaf);
        const srcXf = addTrait(src, TransformTrait);
        const leafXf = addTrait(leaf, TransformTrait);
        addChild(host, src);
        expect(parentTransform(srcXf)).toBe(hostXf);
        expect(parentTransform(leafXf)).toBe(srcXf);

        const clone = cloneNode(src);
        const cloneXf = getTrait(clone, TransformTrait)!;
        const cloneLeaf = getTrait(clone.children[0]!.children[0]!, TransformTrait)!;
        // detached clone: nothing above it yet, and the inner edge reads
        // within the clone rather than at the original.
        expect(parentTransform(cloneXf)).toBe(null);
        expect(parentTransform(cloneLeaf)).toBe(cloneXf);
        expect(parentTransform(cloneLeaf)).not.toBe(srcXf);

        addChild(host, clone);
        expect(parentTransform(cloneXf)).toBe(hostXf);
        expect(parentTransform(cloneLeaf)).toBe(cloneXf);
    });
});

describe('transform ancestry contracts passthrough nodes', () => {
    it('reads past any number of plain nodes', () => {
        const sceneTree = createSceneTree();
        const top = createNode({ name: 'top' });
        addChild(sceneTree.root, top);
        const t = addTrait(top, TransformTrait);

        let cursor = top;
        for (let i = 0; i < 4; i++) {
            const gap = createNode({ name: `gap${i}` });
            addChild(cursor, gap);
            cursor = gap;
        }
        const leaf = createNode({ name: 'leaf' });
        addChild(cursor, leaf);
        const l = addTrait(leaf, TransformTrait);

        expect(parentTransform(l)).toBe(t);
        // the scene root bears no transform, so `top` is a transform root
        expect(parentTransform(t)).toBe(null);
    });

    it('follows a transform appearing on an intervening node', () => {
        const sceneTree = createSceneTree();
        const top = createNode({ name: 'top' });
        const mid = createNode({ name: 'mid' });
        const leaf = createNode({ name: 'leaf' });
        addChild(sceneTree.root, top);
        addChild(top, mid);
        addChild(mid, leaf);
        const t = addTrait(top, TransformTrait);
        const l = addTrait(leaf, TransformTrait);
        expect(parentTransform(l)).toBe(t);

        const m = addTrait(mid, TransformTrait);
        expect(parentTransform(l)).toBe(m);
        expect(parentTransform(m)).toBe(t);
    });
});
