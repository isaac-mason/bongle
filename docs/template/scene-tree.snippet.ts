// Typechecked snippets for The programming model — nodes & scene graph.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { addChild, addTrait, createNode, destroyNode, findByName, TransformTrait } from 'bongle';

/* SNIPPET_START: hierarchy */
// build a small subtree: a turret with a barrel child
const turret = createNode({ name: 'turret' });
addTrait(turret, TransformTrait);

const barrel = createNode({ name: 'barrel' });
addTrait(barrel, TransformTrait);
addChild(turret, barrel); // barrel is now a live child of turret

// find a descendant by name, then detach the whole subtree from the scene
const found = findByName(turret, 'barrel');
if (found) destroyNode(found);
/* SNIPPET_END: hierarchy */
