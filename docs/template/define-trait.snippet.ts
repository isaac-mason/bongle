// Typechecked snippets for The programming model — defining a trait.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { my, onTick, script, trait, Up } from 'bongle';

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

/* SNIPPET_START: my */
const VehicleTrait = trait('vehicle', { fuel: 100, speed: 0 });

// riders are reparented into a seat node under the vehicle when they board, and
// back out into the world when they leave.
const RiderTrait = trait('rider', {
    // the vehicle this node is riding, or null when on foot. the engine
    // re-resolves it on every board and exit, and every rider aboard resolves to
    // the same instance, so the vehicle is the group they share.
    vehicle: my(Up(VehicleTrait)),
});

script(RiderTrait, 'fuel-warning', (ctx) => {
    onTick(ctx, () => {
        const vehicle = ctx.trait.vehicle;
        if (vehicle === null) return; // on foot
        if (vehicle.fuel < 10) console.log('low fuel');
    });
});
/* SNIPPET_END: my */
