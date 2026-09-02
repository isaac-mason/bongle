// Tuple-slot maintenance for terms that do NOT gate membership.
//
// `Optional(Up/Ancestor)` slots are maintained by resolveChildren (they are
// traversals with an `apply`). A Self-sourced Optional is not a traversal, and
// `reindex` only handles enter/exit, so nothing updates its slot while the node
// stays a member.
import { Ancestor, Optional, Up } from '../src/core/scene/conditions';
import { addChild, addTrait, createNode, createSceneTree, query, removeTrait } from '../src/core/scene/scene-tree';
import { trait } from '../src/core/scene/traits';

const A = trait('opt/a', { x: 0 });
const B = trait('opt/b', { y: 0 });
const C = trait('opt/c', { z: 0 });

function check(label: string, actual: unknown, expected: unknown) {
    console.log(`${actual === expected ? '  ok  ' : ' FAIL '} ${label}`);
}

// ── Optional(Self), gained after membership ──
{
    const st = createSceneTree();
    const q = query(st, [A, Optional(B)]);
    const n = createNode({ name: 'n' });
    addTrait(n, A);
    addChild(st.root, n);
    const b = addTrait(n, B);
    check('Optional(Self): slot updates when the trait is ADDED later', q.matches[0]![1], b);
}

// ── Optional(Self), present at join then removed ──
{
    const st = createSceneTree();
    const q = query(st, [A, Optional(B)]);
    const n = createNode({ name: 'n' });
    addTrait(n, A);
    addTrait(n, B);
    addChild(st.root, n);
    check('Optional(Self): slot is set when present at join', q.matches[0]![1] !== null, true);
    removeTrait(n, B);
    check('Optional(Self): slot clears when the trait is REMOVED', q.matches[0]![1], null);
}

// ── Optional(Up), the traversal path, for contrast ──
{
    const st = createSceneTree();
    const q = query(st, [A, Optional(Up(C))]);
    const host = createNode({ name: 'host' });
    addChild(st.root, host);
    const n = createNode({ name: 'n' });
    addTrait(n, A);
    addChild(host, n);
    const c = addTrait(host, C);
    check('Optional(Up): slot updates when an ancestor gains the trait', q.matches[0]![1], c);
    removeTrait(host, C);
    check('Optional(Up): slot clears when the ancestor loses it', q.matches[0]![1], null);
}

// ── Optional(Ancestor) ──
{
    const st = createSceneTree();
    const q = query(st, [A, Optional(Ancestor(C))]);
    const host = createNode({ name: 'host' });
    addChild(st.root, host);
    const n = createNode({ name: 'n' });
    addTrait(n, A);
    addChild(host, n);
    const c = addTrait(host, C);
    check('Optional(Ancestor): slot updates when an ancestor gains it', q.matches[0]![1], c);
}
