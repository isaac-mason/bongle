// Typechecked snippets for Multiplayer — chat.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { chat, log, onInit, system } from 'bongle';

/* SNIPPET_START: message */
system('announcer', (ctx) => {
    onInit(ctx, () => {
        // a system message broadcast to everyone in the room. inline tags style
        // the text: [#rrggbb] colour, [b]/[i]/[u]/[s] for bold/italic/underline/
        // strike, and [/] to reset back to the default.
        if (ctx.server) chat.message(ctx, `[#ffcc00][b]Round starting![/]`);
    });

    // react to the plain chat players type (client-only). msg is { from, text, kind }.
    chat.onMessage(ctx, (msg) => {
        log(ctx, `${msg.from}: ${msg.text}`);
    });
});
/* SNIPPET_END: message */

/* SNIPPET_START: command */
// a typed slash command: `/tp <x> <z>`
system('commands', (ctx) => {
    // register the spec on both sides (this is a shared script), so the client
    // gets autocomplete and argument validation as the player types.
    const teleport = chat.command(ctx, {
        name: '/tp',
        description: 'teleport to coordinates',
        args: [
            { name: 'x', type: 'number' },
            { name: 'z', type: 'number' },
        ],
    });

    // execute it on the server, where it has authority. a matched command is
    // consumed (not shown as a normal chat line); `from` is the client that ran it.
    if (ctx.server) {
        chat.listen(ctx, teleport, ({ args, from }) => {
            log(ctx, 'teleport', from, args.x, args.z);
        });
    }
});
/* SNIPPET_END: command */
