// Typechecked snippets for Rooms: opening rooms and moving clients between them.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { CLIENT_TO_SERVER, command, env, listen, pack, rooms, scene, system } from 'bongle';

/* SNIPPET_START: rooms */
// a second scene the game opens rooms from on demand
const Arena = scene('arena');

// a client asks to be sent to the arena
const EnterArena = command('enter-arena', CLIENT_TO_SERVER, pack.object({}));

// open a dedicated arena room and move the requesting client into it. rooms.create
// returns the new room's id; rooms.view hands back a ScriptContext for another room
// so ordinary script APIs read through it; rooms.swap moves a client between rooms.
system('arena-portal', (ctx) => {
    if (!env.server) return;

    listen(ctx, EnterArena, (_data, from) => {
        // reuse a running arena room, or open a fresh one from the scene
        let arenaId = rooms.list(ctx).find((id) => rooms.view(ctx, id)?.server?.room.sceneId === Arena.id);
        if (!arenaId) arenaId = rooms.create(ctx, { sceneId: Arena.id });
        rooms.swap(ctx, from, arenaId);
    });
});
/* SNIPPET_END: rooms */
