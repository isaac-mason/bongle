// Typechecked snippets for Scenes & prefabs.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { addChild, cloneNode, createPrefab, onInit, prefab, scene, system } from 'bongle';

// a scene authored in the editor, referenced here by id
const PenguinScene = scene('penguin');

/* SNIPPET_START: define-prefab */
// a prefab clones a scene's node children under each instance's root
const PenguinPrefab = prefab('penguin', {
    type: 'nodes',
    deps: [PenguinScene],
    fn: (ctx) => {
        for (const child of PenguinScene.node.children) {
            addChild(ctx.root, cloneNode(child));
        }
    },
});
/* SNIPPET_END: define-prefab */

/* SNIPPET_START: spawn-prefab */
// instantiate inside a script: createPrefab returns a detached node, attach
// it to make it live
system('spawn-penguins', (ctx) => {
    onInit(ctx, () => {
        const penguin = createPrefab(ctx, PenguinPrefab);
        addChild(ctx.node, penguin);
    });
});
/* SNIPPET_END: spawn-prefab */
