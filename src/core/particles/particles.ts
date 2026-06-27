// particle() declaration primitive + pure-data type surface.
//
// Lives in core/ for the same reason sprite() does: the declaration is a
// pure registry write with no client-runtime dependency. The pool, tick,
// and spawn op are client-only and live next door under
// `render/particles/particles.ts` — that file imports the types from
// here and supplies the implementations.
//
// The split mirrors sprites: declaration + handle shape in core,
// runtime (atlas/pool/visuals/spawn) in client. The original step 11/12
// arrangement collapsed both halves into client/ per KISS; step 15
// (block() auto-deriving break particles in core/voxels/blocks.ts)
// forced the split — block() needs to call `particle(...)` at module
// scope, and core can't take a runtime dep on client.
//
// ── particle() declaration ──
//
// Shape mirrors sprite() / blockTexture(): a typed registry entry whose
// payload is fully authored content (sprite ref + playback knobs + update
// fn). No codegen barrel — the runtime resolves particle types by id at
// spawn time via `particlesRegistry.byId.get(typeId)`, parallel to how
// sprites get resolved by `SpriteTrait`.
//
// Four fields per the plan: `sprite`, `playback`, `fps` (required for
// `'loop'` / `'once'` on multi-frame sprites), and `update`. Everything
// else — gravity, drag, collision, lifetime range, etc. — lives inside
// the `update` fn. Curated update fns live next door in
// `./particle-update.ts` — they're pure pool mutations + voxel queries,
// no client deps, so they sit in the declaration layer alongside
// `particle()` itself (and let `block()` reference `particleUpdate.dust`
// for auto-derived block-dust without inverting core → client).

import { recordParticle } from '../capture/module-scope';
import { registry, upsert } from '../registry';
import type { SpriteHandle } from '../sprites/sprites';
import type { Voxels } from '../voxels/voxels';

/* ── pool shape (impl lives in render/particles/particles.ts) ── */

/** Per-room SoA pool. Alive prefix is `[0, count)`; dead slots are
 *  compacted by `Particles.update` (client). The type is declared here
 *  so `UpdateFn` (also here) can name its first param without forcing a
 *  core→client import; the runtime that allocates / mutates it lives in
 *  client. Both halves agree on the layout via this single declaration. */
export type ParticlePool = {
    /** max slots. */
    capacity: number;
    /** live slots — alive prefix is `[0, count)`. */
    count: number;

    /** particle handle per slot — renderer reads `.sprite` / `.playback`
     *  / `.fps` to drive frame selection + atlas lookup. null on free slots. */
    handle: Array<ParticleHandle | null>;
    /** per-particle update fn resolved at spawn time. dispatch target —
     *  redundant with `handle[i].update` but kept as a direct pointer so
     *  the tick loop's inner indirect-call doesn't chase through the
     *  handle struct. null on free slots. */
    updateFn: Array<UpdateFn | null>;

    posX: Float32Array;
    posY: Float32Array;
    posZ: Float32Array;
    prevX: Float32Array;
    prevY: Float32Array;
    prevZ: Float32Array;
    velX: Float32Array;
    velY: Float32Array;
    velZ: Float32Array;

    /** absolute clock anchor for `age = now - spawnTime[i]`. */
    spawnTime: Float32Array;
    /** absolute deadline. death = `expiresAt[i] <= now`. default
     *  `Infinity`. motion fns kill by writing `0`. */
    expiresAt: Float32Array;
    /** per-particle render size (multiplies sprite world dims). */
    size: Float32Array;
    /** per-particle glow (self-illumination) in [0,1]. raises the
     *  lighting floor so the particle lights up in its own colour —
     *  0 = lit by world voxel light, 1 = fully lit / shadow-free —
     *  matching mesh/sprite `glow`. mutate from the update fn to
     *  animate (e.g. fire embers fade 1 → 0 over lifetime). */
    glow: Float32Array;
    /** per-particle RGBA tint multiplier. RGB multiplies the shaded
     *  color (so [0,0,0] fades to black), A multiplies the sprite alpha
     *  (so 0 fades to transparent). default [1,1,1,1] = no tint. mutate
     *  from the update fn to animate (e.g. fade RGB or A over lifetime).
     *  decomposed per-channel to match the posX/Y/Z SoA convention. */
    tintR: Float32Array;
    tintG: Float32Array;
    tintB: Float32Array;
    tintA: Float32Array;
    /** deterministic per-particle jitter seed. */
    seed: Uint32Array;
};

/* ── declaration types ── */

/** how a particle's sprite frame timeline maps onto its lifetime.
 *  see plan §"Playback mode" for the full table. */
export type ParticlePlayback = 'stretch' | 'loop' | 'once';

/** per-particle update fn — owns motion, collision, and death.
 *  invoked once per tick per alive slot. write `pool.expiresAt[i] = 0`
 *  to kill from inside the fn. `voxels` is the room's voxel world,
 *  threaded so `collide*` primitives can query `BLOCK_FLAG_COLLISION`
 *  without the pool carrying a back-ref. pure-motion fns ignore it. */
export type UpdateFn = (pool: ParticlePool, i: number, dt: number, voxels: Voxels) => void;

export type ParticleOptions = {
    /** human-readable display name for editor UIs. falls back to the
     *  string id when omitted. purely cosmetic — IDs remain the lookup
     *  key everywhere else. */
    name?: string;
    /** the sprite handle whose frames drive the particle's visuals. */
    sprite: SpriteHandle;
    /** how `age / total` (or `age * fps`) maps to the sprite's frame
     *  timeline. `'stretch'` requires spawn opts to pass `lifetime`. */
    playback: ParticlePlayback;
    /** required for `'loop'` / `'once'` on multi-frame sprites; ignored
     *  for `'stretch'`. single-frame sprites degenerate to "show frame
     *  0" in all modes. */
    fps?: number;
    /** per-particle update fn. one indirect call per alive slot per
     *  tick. compose primitives from `particleUpdate.*` or write your
     *  own. */
    update: UpdateFn;
    /** spawn-time default for the per-particle glow (self-illumination)
     *  level [0,1]. 0 = fully sample world light (lit like models /
     *  voxel-meshes), 1 = fully lit / shadow-free — matching mesh/sprite
     *  `glow`. the update fn can mutate `pool.glow[i]` per-frame for
     *  fades. default 0. */
    glow?: number;
    /** spawn-time default RGBA tint multiplier. RGB multiplies the
     *  shaded color, A the sprite alpha. the update fn can mutate
     *  `pool.tintR/G/B/A[i]` per-frame for fades. default [1,1,1,1]. */
    tint?: [r: number, g: number, b: number, a: number];
};

export type ParticleHandle = {
    /** particle type string id (e.g. 'smoke', '_block-dust/grass'). */
    typeId: string;
    /** human-readable display name for editor UIs. always set —
     *  defaults to `typeId` when the author didn't supply one. */
    name: string;
    /** DepGraph dependency — see SceneHandle.dependency. */
    dependency: { registry: 'particles'; id: string };
    /** sprite ref (frame timeline source). */
    sprite: SpriteHandle;
    /** playback mode. */
    playback: ParticlePlayback;
    /** fps for `'loop'` / `'once'`. defaults to 0 (degenerate frame-0)
     *  for `'stretch'` and single-frame sprites. */
    fps: number;
    /** per-particle update fn. */
    update: UpdateFn;
    /** resolved spawn-time default for glow [0,1]. */
    glow: number;
    /** resolved spawn-time default RGBA tint multiplier. [1,1,1,1] = none. */
    tint: [r: number, g: number, b: number, a: number];
};

/* ── registration ── */

/**
 * declare a particle type. called at module scope.
 *
 * returns a pure-data handle. the runtime resolves particle types by id
 * at spawn time via `particlesRegistry`; no codegen barrel.
 *
 * @example
 * ```ts
 * const Smoke = particle('smoke', {
 *     sprite: SmokeSprite,
 *     playback: 'stretch',
 *     update: particleUpdate.smoke,
 * });
 * ```
 */
export function particle(id: string, options: ParticleOptions): ParticleHandle {
    const handle: ParticleHandle = {
        typeId: id,
        name: options.name ?? id,
        dependency: { registry: 'particles', id },
        sprite: options.sprite,
        playback: options.playback,
        fps: options.fps ?? 0,
        update: options.update,
        glow: options.glow ?? 0,
        tint: options.tint ?? [1, 1, 1, 1],
    };
    upsert(registry.particles, id, handle);
    recordParticle(id);
    return handle;
}
