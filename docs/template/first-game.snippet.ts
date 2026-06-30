// Typechecked walkthrough of the new-bongle starter (its src/index.ts).
//
// Imports compile against `bongle` exactly as a game would, so if the public
// API drifts this stops compiling and `pnpm -C lib docs` fails. Regions
// between SNIPPET markers are pulled into guide.md by build.js.

import {
    CharacterControllerTrait,
    setCharacterLookAt,
    ENVIRONMENT_OVERWORLD,
    env,
    getTrait,
    matchmaking,
    onInit,
    onJoin,
    script,
    setEnvironment,
    setEnvironmentTime,
    setPosition,
    TransformTrait,
    use,
    WorldTrait,
} from 'bongle';
import { blocks } from 'bongle/starter';

/* SNIPPET_START: setup */
// register the starter block set so those blocks exist and show up in the editor
use(blocks);

// cap how many players matchmaking puts in one room
matchmaking({ maxPlayers: 32 });
/* SNIPPET_END: setup */

/* SNIPPET_START: environment */
// sky + a late-morning sun. { editor: true } runs this in the editor too, so
// the world is lit while you build it, not only at play time.
script(
    WorldTrait,
    'environment',
    (ctx) => {
        onInit(ctx, () => {
            setEnvironment(ctx, ENVIRONMENT_OVERWORLD);
            setEnvironmentTime(ctx, 9);
        });
    },
    { editor: true },
);
/* SNIPPET_END: environment */

/* SNIPPET_START: spawn */
// place each joining player. server-authoritative, so it only runs there.
script(WorldTrait, 'spawn', (ctx) => {
    if (!env.server) return;

    onJoin(ctx, ({ playerNode }) => {
        const transform = getTrait(playerNode, TransformTrait)!;
        setPosition(transform, [0, 5, 0]);

        // face the new player at a point of interest. setCharacterLookAt aims through
        // the character's eyes, setting its look yaw and pitch; the player controller
        // reads them, so the client's camera starts pointed that way.
        const controller = getTrait(playerNode, CharacterControllerTrait)!;
        setCharacterLookAt(controller, transform, [10, 5, 0]);
    });
});
/* SNIPPET_END: spawn */
