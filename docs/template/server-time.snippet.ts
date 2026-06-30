// Typechecked snippets for Multiplayer — server time.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { onFrame, onInit, pack, script, sync, trait } from 'bongle';

/* SNIPPET_START: server-clock */
const ProjectileTrait = trait('projectile', { spawnTime: 0 });

// spawnTime is stamped by the server and replicated (server-authoritative)
sync(ProjectileTrait, 'spawnTime', {
    schema: pack.float32(),
    pack: (t) => t.spawnTime,
    unpack: (value, t) => {
        t.spawnTime = value;
    },
});

script(ProjectileTrait, 'projectile', (ctx) => {
    // stamp the spawn instant in the shared server clock, on the server
    if (ctx.server) {
        onInit(ctx, () => {
            ctx.trait.spawnTime = ctx.clock.server;
        });
    }

    onFrame(ctx, () => {
        // age in that same shared timeline. the client's clock.server is held about
        // one-way latency behind, so a server-stamped event lines up: the projectile
        // appears at the muzzle as clock.server crosses spawnTime, not already downrange.
        const age = Math.max(0, ctx.clock.server - ctx.trait.spawnTime);
        if (age > 5) return; // past its 5s lifetime
        // ... advance the projectile and its trail by `age` ...
    });
});
/* SNIPPET_END: server-clock */
