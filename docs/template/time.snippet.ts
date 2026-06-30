// Typechecked snippets for The programming model — time.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { onTick, script, trait } from 'bongle';

const WeaponTrait = trait('weapon', { cooldown: 1.5 });

/* SNIPPET_START: cooldown */
script(WeaponTrait, 'fire-cooldown', (ctx) => {
    let nextFireAt = 0; // a moment on the room clock, in seconds

    onTick(ctx, () => {
        // ctx.clock.time is local tick-aligned time, ideal for cooldowns and
        // durations. for a deadline every client must agree on, use ctx.clock.server.
        if (ctx.clock.time < nextFireAt) return; // still cooling down
        nextFireAt = ctx.clock.time + ctx.trait.cooldown;
        // ... fire the weapon ...
    });
});
/* SNIPPET_END: cooldown */
