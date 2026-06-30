// Typechecked snippets for The programming model — where and when code runs.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import type { Node } from 'bongle';
import {
    addChild,
    addTrait,
    CanvasTrait,
    createNode,
    env,
    findChildByName,
    getTrait,
    isKeyDown,
    log,
    onFrame,
    onJoin,
    query,
    script,
    setPosition,
    trait,
    TransformTrait,
    WorldTrait,
} from 'bongle';

/* SNIPPET_START: sides */
script(WorldTrait, 'sides', (ctx) => {
    // server-only: authoritative logic, compiled out of the client bundle
    if (env.server) {
        onJoin(ctx, ({ playerNode }) => {
            log(ctx, 'player joined', playerNode.id);
        });
    }

    // client-only: visuals, input, and UI, compiled out of the server bundle
    if (env.client) {
        onFrame(ctx, () => {
            // inside `env.client`, ctx.client is guaranteed, so `!` is fine
            const mouseKeyboard = ctx.client!.input.mouseKeyboard;
            if (isKeyDown(mouseKeyboard, 'KeyE')) {
                // ... interact ...
            }
        });
    }
});
/* SNIPPET_END: sides */

const SpawnTrait = trait('spawn', {});

/* SNIPPET_START: editor-marker */
// an authoring aid: a label floating over each spawn point while you build the
// level. `{ editor: true }` lets the script run in edit mode at all; the guard
// limits it to an editor build (env.editor) in edit mode (ctx.mode), so it never
// appears in play or in a shipped bundle.
script(
    WorldTrait,
    'spawn-markers',
    (ctx) => {
        if (!env.editor || ctx.mode !== 'edit') return;

        const spawns = query(ctx, [SpawnTrait, TransformTrait]);
        const painted = new Set<Node>();

        onFrame(ctx, () => {
            for (const [, transform] of spawns) {
                const point = transform._node;

                let marker = findChildByName(point, 'marker');
                if (!marker) {
                    // a client-only canvas billboard. paint it next frame, once the
                    // visuals layer has installed (and one-time cleared) its canvas.
                    marker = createNode({ realm: 'client', name: 'marker' });
                    setPosition(addTrait(marker, TransformTrait), [0, 1.5, 0]);
                    addTrait(marker, CanvasTrait, { mode: 'y-billboard', worldScale: 1 / 128 });
                    addChild(point, marker);
                    continue;
                }
                if (painted.has(marker)) continue; // a static label: paint it just once

                const canvas = getTrait(marker, CanvasTrait);
                const g = canvas?.canvas?.getContext('2d');
                if (!canvas || !g) continue;
                g.fillStyle = '#000';
                g.fillRect(0, 0, canvas.width, canvas.height);
                g.fillStyle = '#fff';
                g.font = 'bold 48px sans-serif';
                g.textAlign = 'center';
                g.textBaseline = 'middle';
                g.fillText('SPAWN', canvas.width / 2, canvas.height / 2);
                canvas.needsUpdate = true;
                painted.add(marker);
            }
        });
    },
    { editor: true },
);
/* SNIPPET_END: editor-marker */
