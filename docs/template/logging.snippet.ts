// Typechecked snippets for The programming model — logging.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { error, log, onInit, onTick, script, trait, warn } from 'bongle';

const HealthTrait = trait('health', { hp: 100, max: 100 });

/* SNIPPET_START: logging */
script(HealthTrait, 'health-log', (ctx) => {
    onInit(ctx, () => {
        // log/warn/error tag the message with this script's trait and node, so the
        // editor and console show what logged it.
        log(ctx, 'spawned with', ctx.trait.hp, 'hp'); // routine info
        if (ctx.trait.max <= 0) warn(ctx, 'max hp is not positive'); // a smell
    });

    onTick(ctx, () => {
        if (ctx.trait.hp < 0) error(ctx, 'hp went negative:', ctx.trait.hp); // a bug
    });
});
/* SNIPPET_END: logging */
