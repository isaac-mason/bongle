// Typechecked snippets for The programming model — defining a trait.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { onTick, script, trait } from 'bongle';

/* SNIPPET_START: define */
// a trait is named state. fields are literals or factories (use a factory for
// any mutable default, such as a vector or array).
const HealthTrait = trait('health', {
    current: 100,
    max: 100,
});

// attach behaviour with script(). ctx.trait is typed as the HealthTrait instance.
script(HealthTrait, 'regen', (ctx) => {
    onTick(ctx, ({ delta }) => {
        ctx.trait.current = Math.min(ctx.trait.max, ctx.trait.current + 5 * delta);
    });
});
/* SNIPPET_END: define */
