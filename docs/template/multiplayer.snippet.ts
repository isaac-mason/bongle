// Typechecked snippets for Multiplayer, in depth.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { CLIENT_TO_SERVER, client, command, env, listen, log, onInit, pack, script, send, WorldTrait } from 'bongle';

/* SNIPPET_START: rpc */
// a typed client-to-server command
const FireWeaponCommand = command('fire-weapon', CLIENT_TO_SERVER, pack.object({ charge: pack.float32() }));

script(WorldTrait, 'weapon-rpc', (ctx) => {
    // the server is the only side that handles an incoming client command
    if (env.server) {
        listen(ctx, FireWeaponCommand, (data, from) => {
            log(ctx, 'fire', data.charge, 'from', from);
        });
    }

    // the client is the only side that sends it
    if (env.client) {
        onInit(ctx, () => {
            send(ctx, FireWeaponCommand, { charge: 1 });
        });
    }
});
/* SNIPPET_END: rpc */

/* SNIPPET_START: rematch */
// move this client into another gamemode by re-entering matchmaking
script(WorldTrait, 'switch-mode', (ctx) => {
    onInit(ctx, () => {
        if (ctx.client) client.matchmake(ctx, { gameOptions: { mode: 'ffa' } });
    });
});
/* SNIPPET_END: rematch */
