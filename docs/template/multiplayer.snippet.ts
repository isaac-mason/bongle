// Typechecked snippets for Multiplayer, in depth.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { CLIENT_TO_SERVER, client, command, debug, env, listen, onInit, pack, send, system } from 'bongle';

/* SNIPPET_START: rpc */
// a typed client-to-server command
const FireWeaponCommand = command('fire-weapon', CLIENT_TO_SERVER, pack.object({ charge: pack.float32() }));

system('weapon-rpc', (ctx) => {
    // the server is the only side that handles an incoming client command
    if (env.server) {
        listen(ctx, FireWeaponCommand, (data, from) => {
            debug.log(ctx, 'fire', data.charge, 'from', from);
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
system('switch-mode', (ctx) => {
    onInit(ctx, () => {
        if (ctx.client) void client.transfer(ctx, { options: { mode: 'ffa' } });
    });
});
/* SNIPPET_END: rematch */

/* SNIPPET_START: transfer-project */
// send this player to a DIFFERENT project. the platform asks them first, so
// resolve tells you whether they actually went.
system('portal-pad', (ctx) => {
    onInit(ctx, async () => {
        if (!ctx.client) return;
        const went = await client.transfer(ctx, { project: 'neon-drift', joinData: { from: 'lobby' } });
        if (!went) console.log('they stayed');
    });
});
/* SNIPPET_END: transfer-project */
