import type { ScriptContext } from '../core/scene/scripts';
import { allocateSlot, type ParticleOptions } from '../render/particles/particles';

export { particleUpdate } from '../core/particles/particle-update';
export type { ParticlePlayback, ParticlePool, ParticleUpdateFn } from '../core/particles/particles';
export type { ParticleOptions } from '../render/particles/particles';

/**
 * spawn one particle into the active room's pool. `options` carries everything about it:
 * the `sprite` it draws, the `update` that steps it, where it starts, and how long, big
 * and bright it is. no-ops when there's no client room.
 *
 * the pool never refuses a spawn: once full it evicts a live particle, so a fresh burst
 * always shows. `options` is read in full before returning, the `position` and `velocity`
 * vectors included, and nothing in it is retained, so one reused object can drive a whole
 * burst: overwrite what varies, call again.
 */
export function spawnParticle(ctx: ScriptContext, options: ParticleOptions): void {
    const room = ctx.client?.room;
    if (!room) return;
    allocateSlot(room.particles, room.clock.wall, options);
}
