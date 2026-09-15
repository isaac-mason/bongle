import type { SpriteHandle } from '../sprites/sprites';
import type { Voxels } from '../voxels/voxels';

/** how a particle's sprite frame timeline maps onto its lifetime. */
export type ParticlePlayback = 'stretch' | 'loop' | 'once';

/** `ParticlePlayback` as the `pool.playback` column's scalar encoding. */
export const PLAYBACK_STRETCH = 0;
export const PLAYBACK_LOOP = 1;
export const PLAYBACK_ONCE = 2;

export function encodePlayback(playback: ParticlePlayback): number {
    return playback === 'loop' ? PLAYBACK_LOOP : playback === 'once' ? PLAYBACK_ONCE : PLAYBACK_STRETCH;
}

/** Per-room SoA pool (impl lives in render/particles/particles.ts). Alive
 *  prefix is `[0, count)`; dead slots are compacted by `update` (client). The
 *  type is declared here so `ParticleUpdateFn` (also here) can name its first
 *  param without forcing a core->client import. */
export type ParticlePool = {
    /** max slots. */
    capacity: number;
    /** live slots, alive prefix is `[0, count)`. */
    count: number;
    /** round-robin victim for `allocateSlot` once `count === capacity`; a
     *  spawn evicts a live particle rather than failing. */
    evictCursor: number;

    /** sprite per slot, the renderer resolves its atlas frames. null on free slots. */
    sprite: Array<SpriteHandle | null>;
    /** per-particle update fn, resolved at spawn. null on free slots. */
    updateFn: Array<ParticleUpdateFn | null>;
    /** `PLAYBACK_*`, how `sprite[i]`'s frames map onto this particle's life. */
    playback: Uint8Array;
    /** frame rate for `PLAYBACK_LOOP` / `PLAYBACK_ONCE`; ignored by stretch. */
    fps: Float32Array;

    posX: Float32Array;
    posY: Float32Array;
    posZ: Float32Array;
    prevX: Float32Array;
    prevY: Float32Array;
    prevZ: Float32Array;
    velX: Float32Array;
    velY: Float32Array;
    velZ: Float32Array;

    /** room-clock (`clock.wall`) anchor for `age = now - spawnTime[i]`. */
    spawnTime: Float32Array;
    /** absolute deadline. death = `expiresAt[i] <= now`. default
     *  `Infinity`. motion fns kill by writing `0`. */
    expiresAt: Float32Array;
    /** per-particle render size (multiplies sprite world dims). */
    size: Float32Array;
    /** per-particle glow (self-illumination) in [0,1]. raises the
     *  lighting floor so the particle lights up in its own colour,
     *  0 = lit by world voxel light, 1 = fully lit / shadow-free,
     *  matching mesh/sprite `glow`. mutate from the update fn to
     *  animate (e.g. fire embers fade 1 -> 0 over lifetime). */
    glow: Float32Array;
    /** per-particle RGBA tint multiplier. RGB multiplies the shaded
     *  color (so [0,0,0] fades to black), A multiplies the sprite alpha
     *  (so 0 fades to transparent). default [1,1,1,1] = no tint. */
    tintR: Float32Array;
    tintG: Float32Array;
    tintB: Float32Array;
    tintA: Float32Array;
    /** deterministic per-particle jitter seed. */
    seed: Uint32Array;
};

/** per-particle update fn, owns motion, collision, and death.
 *  invoked once per tick per alive slot. write `pool.expiresAt[i] = 0`
 *  to kill from inside the fn. `now` is the same clock `spawnTime` /
 *  `expiresAt` are anchored to, so lifetime fraction is
 *  `(now - spawnTime[i]) / (expiresAt[i] - spawnTime[i])`. `voxels` is the
 *  room's voxel world, threaded so `collide*` primitives can query
 *  `BLOCK_FLAG_COLLISION` without the pool carrying a back-ref. */
export type ParticleUpdateFn = (pool: ParticlePool, i: number, dt: number, now: number, voxels: Voxels) => void;
