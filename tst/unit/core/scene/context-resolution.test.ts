import { describe, expect, it } from 'vitest';
import { Ancestor, Up } from '../../../../src/core/scene/conditions';
import { addChild, addTrait, cloneNode, createNode, createSceneTree, getTrait } from '../../../../src/core/scene/scene-tree';
import { context, Self, trait } from '../../../../src/core/scene/traits';

describe('directives on detached subtrees', () => {
    // A resolution must be correct BEFORE attachment: scene-pack hydrates whole trees
    // detached, and `cloneNode` assembles one bottom-up. Nothing here is in a
    // scene tree, so none of it is in a query.
    it('addTrait resolves the field on a detached node', () => {
        const Chain = trait('detached/chain', { parent: null as any });
        context(Chain, 'parent', { condition: Ancestor(Self) });
        const top = createNode({ name: 'top' });
        const mid = createNode({ name: 'mid' });
        addChild(top, mid);
        const t = addTrait(top, Chain);
        const m = addTrait(mid, Chain);
        expect(m.parent).toBe(t);
        expect(t.parent).toBe(null);
    });

    it('addChild re-resolves a detached subtree under a detached parent', () => {
        const Chain = trait('detached/chain2', { parent: null as any });
        context(Chain, 'parent', { condition: Ancestor(Self) });
        const top = createNode({ name: 'top' });
        const t = addTrait(top, Chain);

        // built separately, attached afterwards — the hydration shape
        const sub = createNode({ name: 'sub' });
        const leaf = createNode({ name: 'leaf' });
        addChild(sub, leaf);
        const s = addTrait(sub, Chain);
        const l = addTrait(leaf, Chain);
        expect(s.parent).toBe(null);
        expect(l.parent).toBe(s);

        addChild(top, sub);
        expect(s.parent).toBe(t);
        // the walk prunes at `sub` (it bears the trait), which is only correct
        // because leaf already pointed at sub and that didn't change.
        expect(l.parent).toBe(s);
    });

    it('a clone carries fresh resolutions, not pointers into the source tree', () => {
        const Chain = trait('detached/chain3', { parent: null as any });
        context(Chain, 'parent', { condition: Ancestor(Self) });
        const sceneTree = createSceneTree();
        const host = createNode({ name: 'host' });
        addChild(sceneTree.root, host);
        const hostChain = addTrait(host, Chain);

        const src = createNode({ name: 'src' });
        const gap = createNode({ name: 'gap' }); // no trait: descendants resolve past it
        const leaf = createNode({ name: 'leaf' });
        addChild(src, gap);
        addChild(gap, leaf);
        const srcChain = addTrait(src, Chain);
        const leafChain = addTrait(leaf, Chain);
        addChild(host, src);
        expect(srcChain.parent).toBe(hostChain);
        expect(leafChain.parent).toBe(srcChain);

        const clone = cloneNode(src);
        const cloneChain = getTrait(clone, Chain)!;
        const cloneLeaf = getTrait(clone.children[0]!.children[0]!, Chain)!;
        // detached clone: nothing above it yet, and the inner edge resolves
        // within the clone rather than at the original.
        expect(cloneChain.parent).toBe(null);
        expect(cloneLeaf.parent).toBe(cloneChain);
        expect(cloneLeaf.parent).not.toBe(srcChain);

        addChild(host, clone);
        expect(cloneChain.parent).toBe(hostChain);
        expect(cloneLeaf.parent).toBe(cloneChain);
    });
});

describe('directives in a trait body', () => {
    it('a resolution to a real trait handle does not blow up at definition time', () => {
        // the directive holds the condition's handle, and a handle points back at
        // its def which points back at the handle. Hashing the body for HMR walked
        // that cycle and overflowed the stack; only `Self` (which has no def)
        // happened to avoid it.
        const Group = trait('hash/group', { n: 0 });
        expect(() => {
            const T = trait('hash/mesh', { group: null as any });
            context(T, 'group', { condition: Up(Group) });
        }).not.toThrow();
    });

    it('a directive field cannot be set through addTrait props', () => {
        const Group = trait('hash/group2', { n: 0 });
        const Mesh = trait('hash/mesh2', { group: null as any });
        context(Mesh, 'group', { condition: Up(Group) });

        const sceneTree = createSceneTree();
        const host = createNode({ name: 'host' });
        addChild(sceneTree.root, host);
        const real = addTrait(host, Group);

        const child = createNode({ name: 'child' });
        addChild(host, child);
        // an override would be silently overwritten by the next resolve, so it is
        // ignored outright rather than briefly appearing to work.
        const decoy = { n: 99 } as any;
        const mesh = addTrait(child, Mesh, { group: decoy });
        expect(mesh.group).toBe(real);
    });

    it('a self-referential directive resolves to the enclosing trait', () => {
        const Chain = trait('hash/chain', { parent: null as any });
        context(Chain, 'parent', { condition: Ancestor(Self) });
        const sceneTree = createSceneTree();
        const top = createNode({ name: 'top' });
        const mid = createNode({ name: 'mid' });
        addChild(sceneTree.root, top);
        addChild(top, mid);
        const t = addTrait(top, Chain);
        const m = addTrait(mid, Chain);
        expect(m.parent).toBe(t);
        expect(getTrait(top, Chain)!.parent).toBe(null);
    });
});
