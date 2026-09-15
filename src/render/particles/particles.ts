import type { Vec3 } from 'math';
import type { ParticlePlayback, ParticlePool, ParticleUpdateFn } from '../../core/particles/particles';
import { encodePlayback, PLAYBACK_STRETCH } from '../../core/particles/particles';
import type { SpriteHandle } from '../../core/sprites/sprites';
import type { Voxels } from '../../core/voxels/voxels';

export type { ParticlePool } from '../../core/particles/particles';

/** Per-room pool size, fixed at room creation. The GPU instance buffers size off this too. */
export const POOL_CAPACITY = 8192;

/** create a fresh pool with all slots zeroed and `count = 0`. */
export function init(): ParticlePool {
    const capacity = POOL_CAPACITY;
    return {
        capacity,
        count: 0,
        evictCursor: 0,
        sprite: new Array<SpriteHandle | null>(capacity).fill(null),
        updateFn: new Array<ParticleUpdateFn | null>(capacity).fill(null),
        playback: new Uint8Array(capacity),
        fps: new Float32Array(capacity),
        posX: new Float32Array(capacity),
        posY: new Float32Array(capacity),
        posZ: new Float32Array(capacity),
        prevX: new Float32Array(capacity),
        prevY: new Float32Array(capacity),
        prevZ: new Float32Array(capacity),
        velX: new Float32Array(capacity),
        velY: new Float32Array(capacity),
        velZ: new Float32Array(capacity),
        spawnTime: new Float32Array(capacity),
        expiresAt: new Float32Array(capacity),
        size: new Float32Array(capacity),
        glow: new Float32Array(capacity),
        tintR: new Float32Array(capacity),
        tintG: new Float32Array(capacity),
        tintB: new Float32Array(capacity),
        tintA: new Float32Array(capacity),
        seed: new Uint32Array(capacity),
    };
}

/** Everything describing one particle. `sprite`, `update` and `position` are
 *  required; the rest fall back to engine defaults. Every field is copied eagerly
 *  into the pool, so a reused scratch object (and reused `position` / `velocity`
 *  vectors) are safe, and nothing here is retained after the call. */
export type ParticleOptions = {
    /** the sprite to draw; its frames drive `playback`. */
    sprite: SpriteHandle;
    /** per-tick motion, collision and death. compose `particleUpdate.*`
     *  primitives or pass a whole preset. */
    update: ParticleUpdateFn;
    /** world position to spawn at. */
    position: Vec3;
    /** initial velocity. default stationary. */
    velocity?: Vec3;
    /** duration in seconds, engine writes `expiresAt[i] = now + lifetime`. */
    lifetime?: number;
    /** multiplies the sprite's world dims. default 1. */
    size?: number;
    /** how the sprite's frames map onto the particle's life. default `'stretch'`,
     *  which needs `lifetime`; `'loop'` / `'once'` need `fps`. single-frame
     *  sprites degenerate to "show frame 0" in all modes. */
    playback?: ParticlePlayback;
    /** frame rate for `'loop'` / `'once'`. default 0. */
    fps?: number;
    /** start mid-animation by passing `now - offset`. default = now. */
    spawnTime?: number;
    /** explicit seed. default = random u32. */
    seed?: number;
    /** self-illumination in [0,1]. 1 = fully lit / shadow-free, 0 = sample
     *  world light. default 0. */
    glow?: number;
    /** RGBA tint multiplier. RGB multiplies the shaded color, A the sprite
     *  alpha. default [1,1,1,1]. */
    tint?: [r: number, g: number, b: number, a: number];
};

const DEFAULT_TINT: [number, number, number, number] = [1, 1, 1, 1];

/**
 * Takes a slot and writes the spawn into it. Never fails: once the pool is full it evicts a
 * live particle round-robin, so a fresh burst always shows rather than being silently
 * dropped. Every column is written here, so reusing an occupied slot needs no clearing pass
 * and `options` (with anything nested in it) is never retained.
 */
export function allocateSlot(pool: ParticlePool, now: number, options: ParticleOptions): number {
    let i: number;
    if (pool.count < pool.capacity) {
        i = pool.count++;
    } else {
        i = pool.evictCursor;
        pool.evictCursor = (i + 1) % pool.capacity;
    }

    pool.sprite[i] = options.sprite;
    pool.updateFn[i] = options.update;
    pool.playback[i] = options.playback ? encodePlayback(options.playback) : PLAYBACK_STRETCH;
    pool.fps[i] = options.fps ?? 0;

    const position = options.position;
    pool.posX[i] = position[0];
    pool.posY[i] = position[1];
    pool.posZ[i] = position[2];
    pool.prevX[i] = position[0];
    pool.prevY[i] = position[1];
    pool.prevZ[i] = position[2];
    const velocity = options.velocity;
    pool.velX[i] = velocity ? velocity[0] : 0;
    pool.velY[i] = velocity ? velocity[1] : 0;
    pool.velZ[i] = velocity ? velocity[2] : 0;

    pool.spawnTime[i] = options.spawnTime ?? now;
    pool.expiresAt[i] = options.lifetime !== undefined ? now + options.lifetime : Number.POSITIVE_INFINITY;
    pool.size[i] = options.size ?? 1;
    pool.glow[i] = options.glow ?? 0;
    const tint = options.tint ?? DEFAULT_TINT;
    pool.tintR[i] = tint[0];
    pool.tintG[i] = tint[1];
    pool.tintB[i] = tint[2];
    pool.tintA[i] = tint[3];
    pool.seed[i] = options.seed ?? (Math.random() * 0x1_0000_0000) >>> 0;

    return i;
}

/**
 * Steps the pool: per-particle dispatch for alive slots, then swap-with-last compaction for
 * slots whose `expiresAt <= now`. Dispatch runs forward so a slot killed by its own update
 * fn is reaped by the next pass rather than reprocessed. Compaction scans backward so
 * swap-with-last from `count-1` never re-tests the slot it just swapped in.
 */
export function update(pool: ParticlePool, dt: number, now: number, voxels: Voxels): void {
    for (let i = 0; i < pool.count; i++) {
        if (pool.expiresAt[i]! <= now) continue;
        pool.updateFn[i]!(pool, i, dt, now, voxels);
    }

    for (let i = pool.count - 1; i >= 0; i--) {
        if (pool.expiresAt[i]! > now) continue;
        const last = pool.count - 1;
        if (i !== last) swapSlot(pool, i, last);
        pool.count--;
    }
}

/** Overwrites slot `a` with slot `b`'s data, used by `update`'s compaction pass. */
function swapSlot(pool: ParticlePool, a: number, b: number): void {
    pool.sprite[a] = pool.sprite[b]!;
    pool.updateFn[a] = pool.updateFn[b]!;
    pool.playback[a] = pool.playback[b]!;
    pool.fps[a] = pool.fps[b]!;

    pool.posX[a] = pool.posX[b]!;
    pool.posY[a] = pool.posY[b]!;
    pool.posZ[a] = pool.posZ[b]!;
    pool.prevX[a] = pool.prevX[b]!;
    pool.prevY[a] = pool.prevY[b]!;
    pool.prevZ[a] = pool.prevZ[b]!;
    pool.velX[a] = pool.velX[b]!;
    pool.velY[a] = pool.velY[b]!;
    pool.velZ[a] = pool.velZ[b]!;

    pool.spawnTime[a] = pool.spawnTime[b]!;
    pool.expiresAt[a] = pool.expiresAt[b]!;
    pool.size[a] = pool.size[b]!;
    pool.glow[a] = pool.glow[b]!;
    pool.tintR[a] = pool.tintR[b]!;
    pool.tintG[a] = pool.tintG[b]!;
    pool.tintB[a] = pool.tintB[b]!;
    pool.tintA[a] = pool.tintA[b]!;
    pool.seed[a] = pool.seed[b]!;
}
