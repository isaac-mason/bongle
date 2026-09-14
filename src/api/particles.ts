import type { Vec3 } from 'math';
import type { ParticleHandle } from '../core/particles/particles';
import type { ScriptContext } from '../core/scene/scripts';
import { allocateSlot, type SpawnOpts } from '../render/particles/particles';

export { particleUpdate } from '../core/particles/particle-update';
export type {
    ParticleHandle,
    ParticleOptions,
    ParticlePlayback,
    ParticlePool,
    ParticleUpdateFn,
} from '../core/particles/particles';
export { particle } from '../core/registry';
export type { SpawnOpts } from '../render/particles/particles';

/**
 * spawn a particle of the given type at world `pos` into the active room's
 * pool. returns the slot index, or `null` when there's no client room or
 * the pool is full. `opts` overrides default-init fields (see `SpawnOpts`);
 * type-specific knobs live inside the particle's `update` fn.
 */
export function spawnParticle(ctx: ScriptContext, type: ParticleHandle, pos: Vec3, opts?: SpawnOpts): number | null {
    const pool = ctx.client?.room?.particles;
    if (!pool) return null;
    const slot = allocateSlot(pool, type, pos[0]!, pos[1]!, pos[2]!, performance.now() / 1000, opts);
    return slot === -1 ? null : slot;
}
