// Typechecked snippets for The programming model — defining a trait.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { my, onTick, script, trait, type TraitType, Up } from 'bongle';

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

// riders are reparented into a seat under the vehicle when they board.
const RiderTrait = trait('rider', {
    // the vehicle this node is riding, or null when on foot. re-resolved on
    // every board and exit, so any call site can just read it.
    vehicle: my(Up(VehicleTrait)),
});
type RiderTrait = TraitType<typeof RiderTrait>;

// called from input handling, UI, a physics callback: nowhere to iterate.
export function canRefuel(rider: RiderTrait): boolean {
    return rider.vehicle !== null && rider.vehicle.fuel < 100;
}
/* SNIPPET_END: my */
