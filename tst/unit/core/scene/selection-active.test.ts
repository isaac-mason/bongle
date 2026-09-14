import { describe, expect, it } from 'vitest';
import * as Selection from '../../../../src/core/scene/selection';

describe('Selection.activeNode', () => {
    it('an empty selection has no active node', () => {
        expect(Selection.activeNode(Selection.create())).toBeNull();
    });

    it('the explicit active id wins while it is still selected', () => {
        const sel = Selection.create();
        sel.nodes.add(3);
        sel.nodes.add(7);
        sel.active = 3;
        expect(Selection.activeNode(sel)).toBe(3);
    });

    it('falls back to the last node added when the active id left the selection', () => {
        const sel = Selection.create();
        sel.nodes.add(3);
        sel.nodes.add(7);
        sel.active = 9;
        expect(Selection.activeNode(sel)).toBe(7);
    });

    it('clone keeps the active id', () => {
        const sel = Selection.create();
        sel.nodes.add(4);
        sel.active = 4;
        expect(Selection.clone(sel).active).toBe(4);
    });
});

describe('ownership boundary', () => {
    it('a plain node is not a boundary; a prefab anchor and a character root are', async () => {
        const { isOwnershipBoundary } = await import('../../../../src/editor/node-bodies');
        const { createNode, addTrait } = await import('../../../../src/core/scene/scene-tree');
        const { CharacterTrait } = await import('../../../../src/builtins/character');
        const plain = createNode({ name: 'plain' });
        expect(isOwnershipBoundary(plain)).toBe(false);
        const anchor = createNode({ name: 'anchor' });
        anchor.prefab = { prefabId: 'x', args: undefined };
        expect(isOwnershipBoundary(anchor)).toBe(true);
        const character = createNode({ name: 'character' });
        addTrait(character, CharacterTrait);
        expect(isOwnershipBoundary(character)).toBe(true);
    });
});
