// per-room SoA pool + tick stepper for the particle system.
//
// Lives in client/ because the pool is a client-only runtime concern,
// it never ticks on the server and never enters replication. The
// declaration primitive (`particle()`) and the pure-data type surface
// (`ParticleHandle`, `ParticlePool`, `UpdateFn`, etc.) live in
// `core/particles/particles.ts` so module-scope authoring (incl.
// auto-derived block-dust from `block()`) can call `particle(...)`
// without core taking a runtime dep on client.
//
// ── pool ──
//
// per-room SoA, fixed capacity, free-list via swap-with-last compaction.
// spawned slots are appended to the alive prefix `[0, count)`; dead
// slots (`expiresAt[i] <= now`) are detected at tick time and compacted
// in the postlude.
//
// no per-particle JS allocations during tick (UpdateFn args are direct
// pool + index + dt + voxels, no per-call object construction).
// renderer reads `subarray(0, count)` for GPU writeback (see
// `particle-visuals.ts`).
//
// engine prelude is empty: no per-frame age increment, no per-frame
// lifetime decrement. spawn writes `spawnTime[i] = now` and (if a
// `lifetime` opt is supplied) `expiresAt[i] = now + lifetime` exactly
// once; the per-particle update fn does the rest. universal per-tick
// cost is the compaction scan (one read + at-most-one swap per slot) and
// GPU writeback.
//
// slot defaults match the plan §"Pool design" table, unset slots aren't
// traps:
//   pos*       = spawn pos
//   prev*      = pos at spawn (writes-through for render interpolation)
//   vel*       = [0, 0, 0]
//   spawnTime  = now
//   expiresAt  = Infinity                (motion fns kill via `= 0`)
//   size       = 1
//   seed       = random u32
//
// per-particle dispatch (one indirect call per alive slot per tick) is
// the v1 choice, closest to MC's model and trivially within budget at
// 8k particles × 60Hz (≈ 0.1ms/frame indirect-call overhead). swappable
// to sort-by-fn or per-bucket sub-pools later without touching update
// fns (signature is `(pool, i, dt, voxels)`, pool identity is invariant).
//
// `voxels` is threaded into the per-particle update fn (rather than
// stamped on the pool) so collision primitives can query the world
// without the pool carrying a back-ref. pure-motion fns ignore the arg.

import type { ParticleHandle, ParticlePool, UpdateFn } from '../../core/particles/particles';
import type { Voxels } from '../../core/voxels/voxels';

export type { ParticlePool } from '../../core/particles/particles';

/** per-room pool size. fixed at room creation; spawn returns `-1` when
 *  full (caller decides whether to silently drop or warn). 8k is well
 *  above MC's per-frame budget and ≈ 0.5 MiB of TypedArrays. */
const POOL_CAPACITY = 8192;

/** create a fresh pool with all slots zeroed and `count = 0`. */
export function init(): ParticlePool {
    const capacity = POOL_CAPACITY;
    return {
        capacity,
        count: 0,
        handle: new Array<ParticleHandle | null>(capacity).fill(null),
        updateFn: new Array<UpdateFn | null>(capacity).fill(null),
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

/** spawn-time opt overrides. universal fields the engine exposes for
 *  per-spawn customization. matches the plan §"Spawning" surface. unset
 *  → engine default. */
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

/**
 * allocate a slot, default-init universal fields, and apply any spawn
 * opts. returns the slot index or `-1` if the pool is full.
 *
 * the script-facing `spawnParticle(ctx, type, pos, opts)` (api/) is a
 * thin wrapper: it grabs the per-room pool off `ctx.client.room`, splats
 * `pos` into x/y/z, samples the current clock, and forwards here.
 */
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
    pool.updateFn[i] = handle.update;

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
    pool.glow[i] = opts?.glow ?? handle.glow;
    const tint = opts?.tint ?? handle.tint;
    pool.tintR[i] = tint[0];
    pool.tintG[i] = tint[1];
    pool.tintB[i] = tint[2];
    pool.tintA[i] = tint[3];
    pool.seed[i] = opts?.seed ?? (Math.random() * 0x1_0000_0000) >>> 0;

    return i;
}

/**
 * step the pool: per-particle dispatch for alive slots, then swap-with-
 * last compaction for slots whose `expiresAt <= now`.
 *
 * dispatch & compact are two separate scans:
 *   1. dispatch in forward order so motion fns see a stable snapshot.
 *      a slot killed by its own update fn (writes `expiresAt = 0`)
 *      doesn't re-process, its `expiresAt <= now` check at compact time
 *      reaps it.
 *   2. compact scans backwards so swap-with-last from `count-1` into the
 *      hole doesn't re-test the swapped-in slot's old position. the
 *      backward scan also means a chain of expired slots at the tail
 *      drops the count without any swaps (`count--` per dead tail slot).
 */
export function update(pool: ParticlePool, dt: number, now: number, voxels: Voxels): void {
    // dispatch
    for (let i = 0; i < pool.count; i++) {
        if (pool.expiresAt[i]! <= now) continue;
        pool.updateFn[i]!(pool, i, dt, voxels);
    }

    // compact, backward scan, swap-with-last on death.
    for (let i = pool.count - 1; i >= 0; i--) {
        if (pool.expiresAt[i]! > now) continue;
        const last = pool.count - 1;
        if (i !== last) swapSlot(pool, i, last);
        pool.count--;
    }
}

/** in-place slot copy. overwrites slot `a` with slot `b`'s data. used
 *  by `update`'s compaction pass to move the alive tail into a dead
 *  slot before decrementing `count`. */
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
