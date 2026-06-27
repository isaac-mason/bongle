// Typechecked documentation snippets for the Transforms section.
//
// This file is a workspace package that imports `bongle` exactly as a game
// would, so if the public API drifts these snippets stop compiling and
// `pnpm -C lib docs` fails loudly. Regions between SNIPPET markers are pulled
// into guide.md / api.md by build.js — keep them runnable.

import { addTrait, createNode, getWorldPosition, setPosition, TransformTrait } from 'bongle';

/* SNIPPET_START: place-node */
// give a node a transform, then position it in local space
const crate = createNode({ name: 'crate' });
const transform = addTrait(crate, TransformTrait);
setPosition(transform, [4, 1, -2]);

// read where it ended up in world space (after any parent transforms apply)
const worldPos = getWorldPosition(transform);
console.log(worldPos);
/* SNIPPET_END: place-node */
