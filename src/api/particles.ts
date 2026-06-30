/**
 * Script-facing particle API.
 *
 * Three surfaces from one barrel:
 *   - `particle(id, options)`, module-scope declaration primitive
 *     (parallel to `sprite()` / `sound()` / `block()`).
 *   - `spawnParticle(ctx, type, pos, opts?)`, runtime spawn into the
 *     per-room pool. server-safe (returns `null` when there's no client
 *     room), per `feedback_no_callbacks_on_primitives` semantics.
 *   - `particleUpdate.*`, curated motion vocabulary used inside a
 *     particle's `update` fn (see `core/particles/particle-update.ts`).
 *
 * Type re-exports cover everything a script needs to type a handle or
 * spawn opt without reaching into engine internals.
 */

import type { Vec3 } from 'mathcat';
import type { ParticleHandle } from '../core/particles/particles';
import type { ScriptContext } from '../core/scene/scripts';
import { allocateSlot, type SpawnOpts } from '../render/particles/particles';

export { particleUpdate } from '../core/particles/particle-update';
export type {
    ParticleHandle,
    ParticleOptions,
    ParticlePlayback,
    ParticlePool,
    UpdateFn,
} from '../core/particles/particles';
export { particle } from '../core/particles/particles';
export type { SpawnOpts } from '../render/particles/particles';

/**
 * spawn a particle of the given type at world `pos` into the active
 * room's pool. returns the slot index, or `null` when there's no
 * client room (server-side, pre-join) or the pool is full.
 *
 * `pos` is splatted into `posX/posY/posZ`; `opts` overrides the
 * universal default-init fields (velocity, lifetime, size, seed,
 * spawnTime, see `SpawnOpts`). type-specific knobs live inside the
 * particle's `update` fn, not on this call.
 */
export function spawnParticle(ctx: ScriptContext, type: ParticleHandle, pos: Vec3, opts?: SpawnOpts): number | null {
    const pool = ctx.client?.room?.particles;
    if (!pool) return null;
    const slot = allocateSlot(pool, type, pos[0]!, pos[1]!, pos[2]!, performance.now() / 1000, opts);
    return slot === -1 ? null : slot;
}
