import { describe, expect, it } from 'vitest';
import { addChild, addTrait, createNode, createSceneTree, getTrait } from '../../../../src/core/scene/scene-tree';
import { Self, trait } from '../../../../src/core/scene/traits';

describe('Self marker', () => {
    it('types a self-referential field as the trait instance, no cast', () => {
        const Link = trait('self-marker/link', {
            label: 'x',
            next: null as Self | null,
        });

        const sceneTree = createSceneTree();
        const head = createNode({ name: 'head' });
        const tail = createNode({ name: 'tail' });
        addChild(sceneTree.root, head);
        addChild(head, tail);
        const h = addTrait(head, Link);
        const t = addTrait(tail, Link);

        // the compile-time half: reading Link-only members straight off `next`
        // only typechecks if `Self` resolved to the real instance type.
        h.next = t;
        const resolved = h.next;
        if (resolved === null) throw new Error('expected a link');
        expect(resolved).toBe(t);
        expect(resolved.label).toBe('x');
        expect(resolved.next).toBe(null);
        expect(getTrait(tail, Link)).toBe(resolved);
    });
});
