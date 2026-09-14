import type { ParticleHandle, ParticlePool, ParticleUpdateFn } from '../../core/particles/particles';
import type { Voxels } from '../../core/voxels/voxels';

export type { ParticlePool } from '../../core/particles/particles';

/** Per-room pool size, fixed at room creation. Spawn returns `-1` when full. */
const POOL_CAPACITY = 8192;

/** create a fresh pool with all slots zeroed and `count = 0`. */
export function init(): ParticlePool {
    const capacity = POOL_CAPACITY;
    return {
        capacity,
        count: 0,
        handle: new Array<ParticleHandle | null>(capacity).fill(null),
        updateFn: new Array<ParticleUpdateFn | null>(capacity).fill(null),
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

/** Spawn-time opt overrides. Unset fields fall back to the engine default. */
export type SpawnOpts = {
    velX?: number;
    velY?: number;
    velZ?: number;
    /** duration in seconds, engine writes `expiresAt[i] = now + lifetime`. */
    lifetime?: number;
    size?: number;
    /** start mid-animation by passing `now - offset`. default = now. */
    spawnTime?: number;
    /** explicit seed. default = random u32. */
    seed?: number;
    /** override the handle's spawn-default glow (0..1). 1 = fully lit /
     *  shadow-free, 0 = sample world light. */
    glow?: number;
    /** override the handle's spawn-default RGBA tint multiplier. RGB
     *  multiplies the shaded color, A the sprite alpha. [1,1,1,1] = none. */
    tint?: [r: number, g: number, b: number, a: number];
};

/** Allocates a slot, default-inits fields, and applies any spawn opts. Returns the slot
 *  index or `-1` if the pool is full. The script-facing `spawnParticle(ctx, type, pos, opts)`
 *  is a thin wrapper over this. */
export function allocateSlot(
    pool: ParticlePool,
    handle: ParticleHandle,
    x: number,
    y: number,
    z: number,
    now: number,
    opts?: SpawnOpts,
): number {
    if (pool.count >= pool.capacity) return -1;
    const i = pool.count++;

    pool.handle[i] = handle;
    pool.updateFn[i] = handle.def.update;

    pool.posX[i] = x;
    pool.posY[i] = y;
    pool.posZ[i] = z;
    pool.prevX[i] = x;
    pool.prevY[i] = y;
    pool.prevZ[i] = z;
    pool.velX[i] = opts?.velX ?? 0;
    pool.velY[i] = opts?.velY ?? 0;
    pool.velZ[i] = opts?.velZ ?? 0;

    pool.spawnTime[i] = opts?.spawnTime ?? now;
    pool.expiresAt[i] = opts?.lifetime !== undefined ? now + opts.lifetime : Number.POSITIVE_INFINITY;
    pool.size[i] = opts?.size ?? 1;
    pool.glow[i] = opts?.glow ?? handle.def.glow;
    const tint = opts?.tint ?? handle.def.tint;
    pool.tintR[i] = tint[0];
    pool.tintG[i] = tint[1];
    pool.tintB[i] = tint[2];
    pool.tintA[i] = tint[3];
    pool.seed[i] = opts?.seed ?? (Math.random() * 0x1_0000_0000) >>> 0;

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
        pool.updateFn[i]!(pool, i, dt, voxels);
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
    pool.handle[a] = pool.handle[b]!;
    pool.updateFn[a] = pool.updateFn[b]!;

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
