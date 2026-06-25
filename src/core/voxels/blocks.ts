import { createMulberry32Generator, type Vec2, type Vec3 } from 'mathcat';
import { recordBlock, recordBlockTexture } from '../capture/module-scope';
import { particleUpdate } from '../particles/particle-update';
import { type ParticleHandle, particle } from '../particles/particles';
import { registry, upsert } from '../registry';
import type { SoundHandle } from '../sounds/sounds';
import { draw, type ImageSource, type NormalizedImageSource, normalizeImageSource } from '../sprites/draw';
import { sprite } from '../sprites/sprites';
import type { BlockShape } from './block-collider';
import { formatKey } from './block-registry';
import type { BlockStateDef, PropsDef, PropsValues } from './block-state';
import * as bs from './block-state';

export type BlockTextureOptions = {
    /**
     * source image(s). single entry for static, array for animated. each
     * entry may be a string path (project-root-relative), a URL
     * (typically `new URL('./texture.png', import.meta.url)`), or a
     * `draw()` bake-time descriptor for procedural / composed textures.
     *
     * the URL form lets 3rd-party packs ship textures bundled alongside
     * their modules — vite rewrites the `new URL(...)` call in client
     * bundles, and the asset pipeline resolves the `file://` URL via
     * fileURLToPath to a real disk path sharp can read. URLs are
     * normalized to `.href` strings at registration; nested DrawSources
     * pass through untouched.
     */
    src: ImageSource | ImageSource[];
    /** animation speed in frames per second. default 1. ignored if single frame. */
    fps?: number;
    /** interpolate between frames (smooth water). default false. */
    interpolate?: boolean;
};

export type BlockTextureDef = {
    /** texture string id (e.g. 'lava') */
    id: string;
    /** DepGraph dependency — see SceneHandle.dependency. */
    dependency: { registry: 'blockTextures'; id: string };
    /** source declarations, post-URL-normalization. each entry is either
     *  a path string or a `DrawSource` descriptor; the asset-pipeline
     *  `draw-textures` pass (step 10) bakes any DrawSource entries to
     *  in-memory canvases before the block atlas builder runs. */
    frames: NormalizedImageSource[];
    /** animation speed in frames per second. */
    fps: number;
    /** interpolate between frames. */
    interpolate: boolean;
};

/**
 * declare a block texture. called at module scope.
 *
 * pass a single src for static textures, or an array for animated
 * textures (one entry per frame). each entry may be a string path,
 * a URL, or a `draw()` descriptor; flipbook frames mix freely.
 *
 * returns a handle that can be passed to block model definitions.
 */
export function blockTexture(id: string, options: BlockTextureOptions): BlockTextureDef {
    const src = options.src;
    const rawFrames = Array.isArray(src) ? src : [src];
    const frames = rawFrames.map(normalizeImageSource);
    const def: BlockTextureDef = {
        id,
        dependency: { registry: 'blockTextures', id },
        frames,
        fps: options.fps ?? 1,
        interpolate: options.interpolate ?? false,
    };
    upsert(registry.blockTextures, id, def);
    recordBlockTexture(id);
    return def;
}

export type TextureRef = BlockTextureDef | string;

/** resolve a TextureRef to its string id. */
export function resolveTextureRef(ref: TextureRef): string {
    return typeof ref === 'string' ? ref : ref.id;
}

/** UV rotation for a cube face — 0/90/180/270 ccw. default 0. */
export type CubeFaceRotation = 0 | 90 | 180 | 270;

/** per-face slot for a cube model. rotation defaults to 0 if omitted. */
export type CubeFaceSpec = { texture: TextureRef; rotation?: CubeFaceRotation };

/** per-face texture assignment for a cube model. */
export type CubeTextures =
    | { all: CubeFaceSpec }
    | { top: CubeFaceSpec; bottom: CubeFaceSpec; sides: CubeFaceSpec }
    | {
          top: CubeFaceSpec;
          bottom: CubeFaceSpec;
          north: CubeFaceSpec;
          south: CubeFaceSpec;
          east: CubeFaceSpec;
          west: CubeFaceSpec;
      };

/** cube model — standard solid block. */
export type CubeModel = {
    type: 'cube';
    textures: CubeTextures;
};

/** custom model — quad list for arbitrary block shapes. */
export type CustomModel = {
    type: 'custom';
    /** list of quads. the mesher emits these directly.
     *  quad-only authoring (Minecraft + Sodium convention); the
     *  registry build rejects non-quad input. */
    quads: BlockQuad[];
};

/**
 * a single quad in a custom block model.
 *
 * coordinates are in block-local space [0, 1]. the mesher offsets
 * them by the block's world position.
 *
 * use bm.quad() for raw quads, bm.box() for axis-aligned boxes
 * (6 quads), bm.cross() for vegetation cross-quads (4 quads).
 */
export type BlockQuad = {
    /** 4 vertices in CCW order as [x, y, z] in block-local space [0,1]. */
    verts: [Vec3, Vec3, Vec3, Vec3];
    /** face normal as [nx, ny, nz]. */
    normal: Vec3;
    /** texture ref for this quad (BlockTextureDef handle or string id). */
    texture: TextureRef;
    /** uv coordinates for each vertex. defaults to full-texture [[0,1],[1,1],[1,0],[0,0]]. */
    uvs?: [Vec2, Vec2, Vec2, Vec2];
    /**
     * cull face direction. if the neighbor in this direction is a full
     * opaque cube, this quad is hidden. undefined = never culled.
     *
     * only applies to quads flush with the block boundary.
     * e.g. a slab's bottom face has cullFace: 'down', but its
     * top face (at y=0.5) has no cullFace because it's never
     * occluded by a neighbor.
     */
    cullFace?: 'north' | 'south' | 'east' | 'west' | 'up' | 'down';
    /**
     * render pass for this quad. defaults to the block's material.
     * set explicitly for mixed-material custom models (e.g. cauldron
     * with opaque shell + translucent water quad).
     */
    material?: MaterialType;
    /**
     * receives smooth-light + AO sampling. defaults to true. set false
     * for quads that should stay flat-lit (emissive sub-quads like a
     * torch flame, or flat per-cell light for cheap fallback).
     */
    ao?: boolean;
};

export type BlockModel = CubeModel | CustomModel;

/**
 * Collect the BlockTexture ids referenced by a model into `out`. Used by
 * the block-registry freeze pass to seed the atlas and by the blocks
 * registry's `extractDeps` to wire DepGraph edges from textures to the
 * blocks that close over them in their model factories.
 */
export function collectModelTextureIds(model: BlockModel, out: Set<string>): void {
    switch (model.type) {
        case 'cube': {
            const tex = model.textures;
            if ('all' in tex) {
                out.add(resolveTextureRef(tex.all.texture));
            } else if ('sides' in tex) {
                out.add(resolveTextureRef(tex.top.texture));
                out.add(resolveTextureRef(tex.bottom.texture));
                out.add(resolveTextureRef(tex.sides.texture));
            } else {
                out.add(resolveTextureRef(tex.top.texture));
                out.add(resolveTextureRef(tex.bottom.texture));
                out.add(resolveTextureRef(tex.north.texture));
                out.add(resolveTextureRef(tex.south.texture));
                out.add(resolveTextureRef(tex.east.texture));
                out.add(resolveTextureRef(tex.west.texture));
            }
            break;
        }
        case 'custom':
            for (const q of model.quads) {
                out.add(resolveTextureRef(q.texture));
            }
            break;
    }
}

// ── cull type ───────────────────────────────────────────────────────
//
// controls **only** face culling between adjacent blocks. no render
// routing — that's handled by MaterialType.
//
//   SOLID   — full block. culls all neighbors. self-culls. (stone, dirt)
//   SELF    — culled by solid. self-culls with **same block id only**.
//             (leaves, water, glass — leaves don't cull water)
//   PARTIAL — culled by solid. never culls neighbors. no self-cull.
//             (stairs, slabs, stained glass that shouldn't self-cull)
//   NONE    — invisible / no geometry (air). never culls anything.

export enum CullType {
    NONE,
    SOLID,
    SELF,
    PARTIAL,
}

// ── material type ───────────────────────────────────────────────────
//
// controls which render pass geometry goes to. completely independent
// of CullType.
//
//   OPAQUE      — no discard, no blend; early-Z survives (stone, dirt, ores)
//   TRANSPARENT — alpha cutout via Discard() at alpha<0.5; depth-write on
//                 (leaves, glass-pane, plant cross-quads)
//   TRANSLUCENT — alpha blending; depth-write off; cullMode none (water)

export enum MaterialType {
    OPAQUE = 0,
    TRANSPARENT = 1,
    TRANSLUCENT = 2,
}

// ── vertex animation ────────────────────────────────────────────────
//
// opt-in vertex displacement in the shader. the mesher outputs an
// animation type attribute per vertex so the shader knows what to do.
//
//   NONE             — no vertex animation (default)
//   WAVE             — gentle wind sway, full-block (leaves, vines)
//   SWAY             — heavier movement, full-block (banners, hanging signs)
//   PLANT_WIND_SWAY  — bottom-anchored bend; tip moves, base stays planted
//                      (tall grass, wheat, saplings, flowers)

export enum VertexAnimation {
    NONE,
    WAVE,
    SWAY,
    PLANT_WIND_SWAY,
}

// ── hook context + signatures ───────────────────────────────────────
//
// hooks are called by the engine when block changes are processed.
// see plan-block-hooks.md for the split between intrinsic (def) and
// observer (additive, module scope) hooks.

export type BlockChangeCtx = {
    voxels: import('./voxels').Voxels;
    worldX: number;
    worldY: number;
    worldZ: number;
    /** current global state id at (worldX, worldY, worldZ). */
    stateId: number;
};

export type BlockStateChangeCtx = BlockChangeCtx & {
    /** global state id before the state change. */
    oldStateId: number;
};

/** pure: recompute self stateId from current world state. return same id = no change. */
export type OnNeighbourUpdateFn = (ctx: BlockChangeCtx) => number;
/** imperative: a neighbour changed, do side effects. */
export type OnNeighbourChangedFn = (ctx: BlockChangeCtx) => void;

/**
 * placement ctx. fed to a block's `place` hook by the build tool when the
 * user right-clicks. carries everything a directional block needs to pick
 * its initial state: target cell, hit-face normal, hit point in the
 * clicked block's [0..1]³ local space (lets slab/stair pick top/bottom
 * half from where on the face the player clicked), and the placer's
 * camera orientation as yaw/pitch.
 *
 * facing (cardinal) and look vector are both derivable from yaw/pitch —
 * use `snapCardinal(yaw)` from editor/camera for the 90% case, or
 * trig on yaw/pitch when richer pitch-aware logic is needed.
 */
export type BlockPlaceCtx = {
    /** target cell (where the block will land — adjacent to the clicked one). */
    worldX: number;
    worldY: number;
    worldZ: number;
    /** hit-face normal — points away from the clicked block. */
    normalX: number;
    normalY: number;
    normalZ: number;
    /** hit point in the clicked block's [0..1]³ local space. */
    hitX: number;
    hitY: number;
    hitZ: number;
    /** placer camera yaw (radians). */
    yaw: number;
    /** placer camera pitch (radians). */
    pitch: number;
};

/** read/write seam handed to a `place` hook. the caller binds it: the editor
 *  records each `set` as an undoable edit op; gameplay writes authoritative
 *  voxels; tests mock it. `place` never touches voxels directly — same string
 *  block-key currency as `getBlock`/`setBlock`, so a hook decodes a neighbour
 *  via `parseKey` with no registry. `get` reflects this place-action's own
 *  pending writes ('air' for an empty cell). */
export type PlaceIO = {
    get(x: number, y: number, z: number): string;
    set(x: number, y: number, z: number, key: string): void;
};

/** imperative placement (= Luanti `on_place`). validate via `io.get`, then
 *  `io.set` the cell(s) — multiple sets for a footprint (door = 2). return
 *  early to abort (no writes). optional on the def; when absent the build tool
 *  writes the block's default/selected state at the target cell. */
export type PlaceFn = (ctx: BlockPlaceCtx, io: PlaceIO) => void;

/** rotate a stateId 90° around an axis. cw = looking down the +axis. when
 *  undefined, engine falls back to the prop-name convention. */
export type RotateFn = (stateId: number, axis: 'x' | 'y' | 'z', cw: boolean) => number;

/** mirror a stateId across the plane perpendicular to axis through origin.
 *  when undefined, engine falls back to the prop-name convention. */
export type FlipFn = (stateId: number, axis: 'x' | 'y' | 'z') => number;

/** observer fired when a block of this type is built (air → non-air). */
export type OnBuildFn = (ctx: BlockChangeCtx) => void;
/** observer fired when a block of this type is broken (non-air → air). */
export type OnBreakFn = (ctx: BlockChangeCtx) => void;
/** observer fired when state changes within the same block-type. */
export type OnStateChangeFn = (ctx: BlockStateChangeCtx) => void;

/**
 * fullscreen tint applied while the camera is inside a block. used for
 * underwater blue, lava orange, smoke fog, etc. resolved per-state at
 * registry freeze and read each frame by the renderer.
 */
export type ScreenTintSpec = {
    /** linear RGB color, each channel 0..1. */
    color: readonly [number, number, number];
    /** mix weight 0..1. 0 = no tint, 1 = full replacement. */
    opacity: number;
};

/**
 * Block-level sound config — one handle array per category. Multiple
 * handles per slot let the driving system round-robin or random-cycle
 * across clips for variation; an empty array silences the category.
 *
 * Compose preset bundles from `blockSoundPresets.*` in
 * `bongle/starter` or build a fully custom config. All slots
 * optional; omit a category to leave it silent.
 *
 * NOTE: the systems that actually drive playback off these handles
 * (character-controller footstep tick, voxel break/place hooks) are
 * not yet wired — for now this is stored on the def for future use.
 */
export type BlockSoundConfig = {
    /** played while the character walks on top of this block — and, for
     *  liquid blocks, on the feet-enter edge (entry splash) and once
     *  per swim stroke while submerged. one slot covers all three; the
     *  controller swaps which block is sampled and the character trait
     *  varies volume between cadence and entry. */
    footstep?: readonly SoundHandle[];
    /** looped while the block is being mined (before the final break). */
    dig?: readonly SoundHandle[];
    /** one-shot on the final break (mining completes / block is destroyed). */
    break?: readonly SoundHandle[];
    /** one-shot when a block of this type is placed by a player. */
    place?: readonly SoundHandle[];
};

/**
 * named particle slots on a block. slot names describe the particle's
 * visual *type*, not the event that emits it — the same `dust` handle
 * is reused across footstep / landing / mining-in-progress, while
 * `build` and `break` are distinct because their physics differ.
 *
 * each slot is an array because `block()` auto-derives 3 dust variants
 * per block; downstream spawn code picks one at random for visual variety.
 */
export type BlockParticleConfig = {
    /** small surface puffs. emitted on sprint footstep cadence + landing
     *  edge + liquid-entry splash. mining-in-progress + other surface
     *  impacts will share the same handle when those systems land. */
    dust?: readonly ParticleHandle[];
    /** future: emitted when a block of this type is placed by a player. */
    build?: readonly ParticleHandle[];
    /** future: chunky debris on full break. */
    break?: readonly ParticleHandle[];
};

// ── block definition (user input) ───────────────────────────────────

export type BlockOptions<P extends PropsDef = PropsDef> = {
    /** human-readable display name for editor UIs (inventory, hotbar,
     *  inspectors). falls back to the string id when omitted. */
    name?: string;

    /** block state schema. omit for stateless blocks. */
    states?: BlockStateDef<P>;

    /**
     * authoritative default state — drives `defaultId()`/`defaultKey()`, the
     * inventory icon, and any caller that places this block without specifying
     * props. when omitted, the default is the first encoded state (local index
     * 0), which can look broken for neighbour-driven shapes (standalone
     * fence/pane post renders invisible) or for level-encoded blocks (water at
     * level=1 is a sliver). neighbour-aware blocks correct themselves via
     * `onNeighbourUpdate` after placement regardless of the default.
     */
    defaultState?: PropsValues<P>;

    /**
     * model function. receives decoded props, returns geometry description.
     * called once per state at freeze time, cached for zero-cost meshing.
     *
     * omit for invisible blocks (air).
     */
    model?: (props: PropsValues<P>) => BlockModel;

    /**
     * cull type — controls face culling between adjacent blocks.
     * defaults to CullType.SOLID. can be a static value or a function
     * of props for per-state cull behavior (called once per state at
     * freeze time).
     */
    cull?: CullType | ((props: PropsValues<P>) => CullType);

    /**
     * material type — controls which render pass geometry goes to.
     * defaults to MaterialType.OPAQUE. can be a static value or a
     * function of props for per-state material (called once per state
     * at freeze time). for per-tri material on custom models, set
     * material on individual BlockQuad instead.
     */
    material?: MaterialType | ((props: PropsValues<P>) => MaterialType);

    /**
     * vertex animation type. the shader applies displacement based on
     * this. can be a static value or a function of props.
     * @default VertexAnimation.NONE
     */
    vertexAnimation?: VertexAnimation | ((props: PropsValues<P>) => VertexAnimation);

    /**
     * rgb light emission, each channel 0-15. blocks with this set act
     * as light sources for flood fill lighting. can be state-dependent
     * (e.g. torch on/off). omit for non-emitters.
     */
    lightEmission?: [number, number, number] | ((props: PropsValues<P>) => [number, number, number]);

    /**
     * light opacity: how much light is absorbed per step through this
     * block (0-15). 0 = fully transparent to light (air, glass).
     * 15 = fully opaque (stone). can be state-dependent.
     * default is based on cull type:
     *   SOLID=15, SELF=1, PARTIAL=0, NONE=0.
     */
    lightOpacity?: number | ((props: PropsValues<P>) => number);

    /**
     * emissive: renders at full brightness regardless of surrounding
     * light. useful for lamp blocks whose surfaces should glow.
     * can be state-dependent.
     * @default false
     */
    emissive?: boolean | ((props: PropsValues<P>) => boolean);

    /**
     * collision: does this block participate in physics collision?
     * when false, dynamic bodies (players, projectiles) pass through.
     * can be state-dependent.
     * @default true
     */
    collision?: boolean | ((props: PropsValues<P>) => boolean);

    /**
     * selection: can this block be targeted by raycasts for interaction?
     * (mining, placing, editor picking). when false, selection rays
     * pass through. can be state-dependent.
     * @default true
     */
    selection?: boolean | ((props: PropsValues<P>) => boolean);

    /**
     * physics/selection shape for this block.
     *
     * omit → unit box collider (the default for all blocks, fast path).
     * BlockShape → use this shape for collision and selection.
     *
     * the shape is in block-local [0,1] space. at runtime, translated to
     * the voxel's world position. use blockShape.rotateY() for rotation
     * data at define time.
     *
     * can be state-dependent: (props) => BlockShape
     */
    shape?: BlockShape | ((props: PropsValues<P>) => BlockShape);

    /**
     * climbable: when true, the character controller treats this block as a
     * ladder — gravity is bypassed inside it, jump ascends, crouch descends.
     * climbable blocks usually want `collision: false` so the character can
     * actually enter them. defaults to false.
     * @default false
     */
    climbable?: boolean | ((props: PropsValues<P>) => boolean);

    /**
     * liquid: when set, the character swims while submerged in this block —
     * gravity is replaced by a small downward sink, drag scales with
     * `viscosity` (0..1), and jump/crouch swim up/down. liquids should usually
     * have `collision: false`.
     * @default undefined (not a liquid)
     */
    liquid?: { viscosity: number } | null | ((props: PropsValues<P>) => { viscosity: number } | null);

    /**
     * pathfindable: may a navigating agent (see core/nav voxel pathfinding)
     * occupy/pass through this cell? defaults to the inverse of `collision`, so
     * normal blocks need no annotation. override to mark colliding-but-passable
     * cells (open doors) or passable-but-avoided cells (hazards). can be
     * state-dependent.
     * @default !collision
     */
    pathfindable?: boolean | ((props: PropsValues<P>) => boolean);

    /**
     * friction coefficient. multiplied with the body's per-rigid-body /
     * per-aabb-body friction to produce the effective contact friction
     * (and with the vcc character controller's `groundDragRate` when the
     * character stands on this block). 0 = perfect ice regardless of
     * body; ~0.1 = slippery; ~2.0 = sticky.
     * @default 1.0
     */
    friction?: number | ((props: PropsValues<P>) => number);

    /**
     * restitution (bounciness) coefficient. multiplied with the body's
     * per-rigid-body / per-aabb-body restitution to produce the effective
     * contact restitution. 0 = no bounce regardless of body; 1 = elastic.
     * @default 0
     */
    restitution?: number | ((props: PropsValues<P>) => number);

    /**
     * sneak-guard: when crouched, the character anchors to this block and
     * cannot walk off its edges. defaults to true for any collidable block.
     * set false for blocks the player should be able to slide off even while
     * crouched (ice, conveyor belts).
     * defaults to true for collidable blocks, false otherwise
     */
    sneakGuard?: boolean | ((props: PropsValues<P>) => boolean);

    /**
     * extra bits OR'd into the block's flags bitmask. used to mark
     * connection groups (BLOCK_FLAG_FENCE, BLOCK_FLAG_WALL, BLOCK_FLAG_PANE)
     * so neighbour-aware blocks can check membership without string compares.
     */
    flags?: number;

    /**
     * surface height (0..1) — opts this block into MODEL_LIQUID. the mesher
     * emits a cube with the top quad lowered to this height and the side
     * quads height-clipped. omit for normal full-cube blocks. can be
     * state-dependent so a single block can register multiple heights.
     */
    surfaceHeight?: number | ((props: PropsValues<P>) => number);

    /**
     * fluid group id (e.g. 'water'). all states sharing a group string cull
     * faces between each other when surface heights line up. used only by
     * MODEL_LIQUID blocks; future flow/sim work keys off the same identity.
     */
    fluidGroup?: string;

    /**
     * screen tint applied as a fullscreen overlay when the camera sits
     * inside this block. color is linear RGB (0..1), opacity is 0..1.
     * for MODEL_LIQUID blocks the tint only applies while the camera Y is
     * below the cell's surfaceHeight band. omit (or return undefined from
     * the function form) for no tint.
     */
    screenTint?: ScreenTintSpec | ((props: PropsValues<P>) => ScreenTintSpec | undefined);

    /**
     * sounds played for footstep / dig / break / place events on this
     * block. compose via `blockSoundPresets.*` bundles or build fully
     * custom. omit to leave the block silent across all four slots.
     *
     * static config applies to every state of the block. for blocks
     * whose sounds vary per state (e.g. waterlogged → water footsteps,
     * lit/unlit redstone → different break clip), pass a function of
     * decoded props instead — called once per state at registry freeze
     * time, baked into a per-state lookup table for hot-path reads.
     */
    sounds?: BlockSoundConfig | ((props: PropsValues<P>) => BlockSoundConfig);

    /**
     * pure neighbour-driven state recompute. called after any neighbour of
     * a block of this type changes (and once when the block itself is placed).
     * read neighbours via ctx.voxels; return a new global state id, or the
     * same id for "no change". the engine fast-paths the unchanged case.
     *
     * runs in both editor and server runtime — must be pure (no world
     * mutation beyond returning a new stateId).
     */
    onNeighbourUpdate?: OnNeighbourUpdateFn;

    /**
     * imperative side-effect hook fired after any neighbour changes. drop
     * items, schedule ticks, ignite, etc. server-only — never runs in editor.
     */
    onNeighbourChanged?: OnNeighbourChangedFn;

    /**
     * pick the placed stateId from hit context (camera + face + click point).
     * called once when the build tool places a block of this type. when
     * undefined, the engine falls back to the prop-name convention
     * (`axis` / `facing` enum props auto-mutated from hit normal + yaw).
     */
    place?: PlaceFn;

    /**
     * rotate a stateId 90° around `axis` (cw = looking down the +axis).
     * called per-voxel by blueprint rotate and voxel-rotate. when undefined,
     * the engine falls back to the prop-name convention (`axis` / `facing`
     * remap tables).
     */
    rotate?: RotateFn;

    /**
     * mirror a stateId across the plane perpendicular to `axis`. called
     * per-voxel by blueprint flip. when undefined, the engine falls back
     * to the prop-name convention.
     */
    flip?: FlipFn;

    /**
     * named particle slots for this block. when omitted (or any slot
     * within is omitted), missing slots default to 3 auto-derived
     * `<id>:particle{0,1,2}` dust variants baked from the top-face
     * texture of the default state (cube models only; cost is 3 sprite
     * + 3 particle registrations per block at module-scope eval — free
     * at runtime).
     *
     * static config applies to every state. pass a function of decoded
     * props for per-state slots — called once per state at registry
     * freeze, baked into a per-state lookup. authors who want per-state
     * particles should hoist `particle()` declarations to module scope
     * (free dedup by id) and just reference them per state.
     *
     * default dust is derived **once from the default state's model**
     * and shared across every state — this is the dedup escape hatch
     * for blocks with many states (the registry never multiplies the
     * auto-dust set by state count).
     *
     * pass `false` to opt out entirely for all states — no dust
     * derivation, no slot defaults. invisible blocks (no model) never
     * derive regardless.
     *
     * defaulting all three slots to the same dust handles today is a
     * placeholder; when block-place + block-break systems land, `build`
     * and `break` will re-default to dedicated presets whose particles
     * have different physics (e.g. `build` won't collide; `break` will
     * be larger debris).
     */
    particles?: BlockParticleConfig | ((props: PropsValues<P>) => BlockParticleConfig) | false;
};

// ── block def (internal, stored in blocksRegistry via the handle's _def) ────

export type BlockDef<P extends PropsDef = PropsDef> = {
    /** string id (e.g. 'oak_log') */
    id: string;
    /** human-readable display name for editor UIs. always set —
     *  defaults to `id` when the author didn't supply one. */
    name: string;
    /** block state schema (empty schema if stateless) */
    states: BlockStateDef<P>;
    /** local state index for the block's default state. omitted (or 0)
     *  when no `defaultState` was supplied — default is the first encoded
     *  state. drives `defaultId()`/`defaultKey()` on the handle. */
    defaultLocalIdx?: number;
    /** model function (undefined for invisible blocks like air) */
    model?: (props: PropsValues<P>) => BlockModel;
    /** cull type setting */
    cull: CullType | ((props: PropsValues<P>) => CullType);
    /** material type setting */
    material: MaterialType | ((props: PropsValues<P>) => MaterialType);
    /** vertex animation setting */
    vertexAnimation?: VertexAnimation | ((props: PropsValues<P>) => VertexAnimation);
    /** light emission setting */
    lightEmission?: [number, number, number] | ((props: PropsValues<P>) => [number, number, number]);
    /** light opacity setting */
    lightOpacity?: number | ((props: PropsValues<P>) => number);
    /** emissive setting */
    emissive?: boolean | ((props: PropsValues<P>) => boolean);
    /** collision setting */
    collision?: boolean | ((props: PropsValues<P>) => boolean);
    /** selection setting */
    selection?: boolean | ((props: PropsValues<P>) => boolean);
    /** shape setting */
    shape?: BlockShape | ((props: PropsValues<P>) => BlockShape);
    /** climbable setting */
    climbable?: boolean | ((props: PropsValues<P>) => boolean);
    /** liquid setting */
    liquid?: { viscosity: number } | null | ((props: PropsValues<P>) => { viscosity: number } | null);
    /** pathfindable setting (defaults to !collision) */
    pathfindable?: boolean | ((props: PropsValues<P>) => boolean);
    /** friction setting */
    friction?: number | ((props: PropsValues<P>) => number);
    /** restitution setting */
    restitution?: number | ((props: PropsValues<P>) => number);
    /** sneak-guard setting */
    sneakGuard?: boolean | ((props: PropsValues<P>) => boolean);
    /** extra bits OR'd into flags (e.g. BLOCK_FLAG_FENCE for fence presets). */
    flags?: number;
    /** surface height (0..1) — opts into MODEL_LIQUID rendering. */
    surfaceHeight?: number | ((props: PropsValues<P>) => number);
    /** fluid group string — shared id for same-fluid face culling. */
    fluidGroup?: string;
    /** screen tint applied while camera is inside this block. */
    screenTint?: ScreenTintSpec | ((props: PropsValues<P>) => ScreenTintSpec | undefined);
    /** raw author option for sounds. resolved per-state into
     *  `BlockRegistry.sounds[]` at freeze. */
    sounds?: BlockSoundConfig | ((props: PropsValues<P>) => BlockSoundConfig);
    /** raw author option for particles. resolved per-state into
     *  `BlockRegistry.particles[]` at freeze: user-supplied slots win,
     *  missing slots fall back to the once-per-block auto-derived dust
     *  handles. `false` opts out entirely. */
    particles?: BlockParticleConfig | ((props: PropsValues<P>) => BlockParticleConfig) | false;
    /** pure neighbour-driven state recompute (editor + server). */
    onNeighbourUpdate?: OnNeighbourUpdateFn;
    /** imperative neighbour-changed side effect (server only). */
    onNeighbourChanged?: OnNeighbourChangedFn;
    /** pick placed stateId from hit context (build tool). */
    place?: PlaceFn;
    /** rotate a stateId 90° around an axis. */
    rotate?: RotateFn;
    /** mirror a stateId across the plane perpendicular to an axis. */
    flip?: FlipFn;
};

// ── block handle (returned to user) ─────────────────────────────────
//
// returned by block() at module scope. the registry builder patches
// _baseStateId and _index at freeze time. user code only calls
// stateId()/defaultId() inside script callbacks, which run after freeze.

export type BlockHandle<P extends PropsDef = PropsDef> = {
    /** block string id (e.g. 'oak_log') */
    readonly id: string;
    /** human-readable display name for editor UIs. always set —
     *  defaults to `id` when the author didn't supply one. */
    readonly name: string;
    /** DepGraph dependency — see SceneHandle.dependency. */
    dependency: { registry: 'blocks'; id: string };
    /** the block's state schema */
    readonly states: BlockStateDef<P>;
    /** the block def (internal) */
    readonly _def: BlockDef<P>;

    /** dense block type index. set by registry builder at freeze time. */
    _index: number;
    /** first global state id. set by registry builder at freeze time. */
    _baseStateId: number;
    /** total number of states for this block. */
    readonly totalStates: number;
    /**
     * bitmask of hooks this block has (intrinsic + any observer handlers
     * registered at module scope). populated by the registry builder at
     * freeze time. drives the fast-path filter in the hook dispatcher.
     * see BlockHooks enum in block-hooks.ts.
     */
    _hooks: number;

    /** get the global state id for specific property values. */
    stateId(props: PropsValues<P>): number;

    /**
     * lift a pre-computed local state index (0..totalStates-1) into a
     * global state id by adding `_baseStateId`. lets a hot path encode
     * the local index inline (e.g. with `states.stride()`) and skip the
     * props-object allocation that `stateId()` requires.
     */
    stateIdLocal(localIdx: number): number;

    /** get the default global state id. driven by the `defaultState`
     *  option (falls back to local index 0). */
    defaultId(): number;

    /** get the stable string key for specific property values (e.g. "oak_log[axis=y]"). */
    stateKey(props: PropsValues<P>): string;

    /** get the stable string key for the default state. driven by the
     *  `defaultState` option (falls back to local index 0). */
    defaultKey(): string;
};

// empty states singleton for stateless blocks
const EMPTY_STATES = bs.create({});

/**
 * declare a block type. called at module scope — the definition is
 * captured and frozen into a registry when the module is loaded.
 *
 * returns a handle used for getting global state ids in gameplay code.
 */
export function block<const P extends PropsDef = {}>(id: string, options: BlockOptions<P> = {}): BlockHandle<P> {
    const states = (options.states ?? EMPTY_STATES) as BlockStateDef<P>;
    const cull = options.cull ?? CullType.SOLID;
    const material = options.material ?? MaterialType.OPAQUE;
    const defaultLocalIdx = options.defaultState ? states.encode(options.defaultState) : 0;

    const def: BlockDef<P> = {
        id,
        name: options.name ?? id,
        states,
        defaultLocalIdx,
        model: options.model,
        cull,
        material,
        vertexAnimation: options.vertexAnimation,
        lightEmission: options.lightEmission,
        lightOpacity: options.lightOpacity,
        emissive: options.emissive,
        collision: options.collision,
        selection: options.selection,
        shape: options.shape,
        climbable: options.climbable,
        liquid: options.liquid,
        pathfindable: options.pathfindable,
        friction: options.friction,
        restitution: options.restitution,
        sneakGuard: options.sneakGuard,
        flags: options.flags,
        surfaceHeight: options.surfaceHeight,
        fluidGroup: options.fluidGroup,
        screenTint: options.screenTint,
        sounds: options.sounds,
        particles: options.particles,
        onNeighbourUpdate: options.onNeighbourUpdate,
        onNeighbourChanged: options.onNeighbourChanged,
        place: options.place,
        rotate: options.rotate,
        flip: options.flip,
    };

    const handle: BlockHandle<P> = {
        id,
        name: options.name ?? id,
        dependency: { registry: 'blocks', id },
        states,
        _def: def,
        _baseStateId: 0,
        _index: 0,
        _hooks: 0,
        totalStates: states.totalStates,

        stateId(props: PropsValues<P>): number {
            return this._baseStateId + states.encode(props);
        },

        stateIdLocal(localIdx: number): number {
            return this._baseStateId + localIdx;
        },

        defaultId(): number {
            return this._baseStateId + defaultLocalIdx;
        },

        stateKey(props: PropsValues<P>): string {
            return formatKey(id, states, states.encode(props));
        },

        defaultKey(): string {
            return formatKey(id, states, defaultLocalIdx);
        },
    };

    const stored = upsert(registry.blocks, id, handle as BlockHandle);
    // presence-only snapshot record. block content changes propagate via
    // the flush path — `applyRegistryChanges` rebuilds BlockRegistry,
    // refreshes the atlas, repoints per-room `voxels.registry`, and
    // `resolveAllChunks` triggers a remesh on the next tick. when upsert
    // returns the existing wrapper (content unchanged), we keep the
    // already-patched handle from the previous build instead of leaking
    // the freshly-constructed unpatched one.
    recordBlock(id);

    return stored.payload as BlockHandle<P>;
}

// ── auto-derived block-dust ─────────────────────────────────────────
//
// Asset-pipeline-as-call-graph: `block()` makes 6 extra module-scope
// declaration calls (3× `sprite()` + 3× `particle()`) per block-with-a-
// cube-model, registering `<id>:particle{0,1,2}` against the same
// registries user-authored sprites + particles land in. No engine-special
// ownership path — the derived entries are attributed to the same module
// that called `block()`, so deletion is automatic.
//
// Three variants because Minecraft picks a random 4×4 slice of the face
// per spawned particle (~64 per break, 169 possible slices per face) for
// visual richness. We can't do per-spawn picking against a baked atlas,
// so we bake 3 deterministic slices per block. Spawn-side code picks one
// of the 3 per particle for similar visual variance at a fraction of the
// atlas cost.
//
// Slices are drawn from one mulberry32 PRNG seeded by FNV-1a of the
// block id — sequential calls produce uncorrelated (sx, sy) pairs, so
// the 3 variants tend to cover different regions of the face. Hardcoded
// 16×16 source dims to match the engine's default block texture size —
// non-default sizes will read out of bounds; widen when a real case
// forces it.
//
// The draw fn is hashed via `Function.prototype.toString()` for asset-
// pipeline invalidation, so the seed rides through `params` (which DOES
// participate in the structural hash). `createMulberry32Generator` is a
// stable published algorithm — the closure-capture-not-hashed gap is a
// theoretical concern only.

const DUST_SIZE = 4;
const DUST_SOURCE_SIZE = 16;
const DUST_VARIANT_COUNT = 3;

/** FNV-1a 32-bit string hash. used as the per-block dust slice seed.
 *  inlined here rather than imported from a util so the dust deriver
 *  stays self-contained — sole consumer, no other hash needs. */
function hashStringFnv1a(s: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    }
    return h >>> 0;
}

/** resolve a TextureRef (string id or BlockTextureDef handle) to the
 *  first-frame `NormalizedImageSource`. returns `null` if a string ref
 *  doesn't resolve — the deriver silently skips in that case (block
 *  authoring order would have to be wrong for this to fire). */
function resolveTextureFrame(ref: TextureRef): NormalizedImageSource | null {
    const def = typeof ref === 'string' ? registry.blockTextures.byId.get(ref)?.payload : ref;
    return def?.frames[0] ?? null;
}

/** pick the texture ref to slice dust sprites out of. cubes have an
 *  unambiguous top face; custom models pick the first upward-facing
 *  quad and fall back to quads[0] if none face up. */
function pickDustSourceTexture(model: BlockModel): TextureRef | null {
    if (model.type === 'cube') {
        const tex = model.textures;
        return 'all' in tex ? tex.all.texture : tex.top.texture;
    }
    const quads = model.quads;
    if (quads.length === 0) return null;
    for (const q of quads) {
        if (q.normal[1] > 0.5) return q.texture;
    }
    return quads[0]!.texture;
}

/** declare `<id>:particle{0..N-1}` sprite + particle entries from the
 *  block's top-face texture. caller evaluates the block's model fn at
 *  default props and hands the snapshot in; invisible blocks (no model)
 *  never reach here (caller guards).
 *
 *  source-texture pick:
 *    - cube: `all` / `top`, depending on which the texture map exposes.
 *    - custom: the first quad with an upward-facing normal (ny > 0.5);
 *      falls back to the first quad if no upward face exists (rare —
 *      e.g. hanging vines). stairs/slabs land on their top slab face,
 *      which is what we'd hand-pick anyway.
 *
 *  the seed passed into `draw()`'s `params` is `hash(id) + idx` rather
 *  than per-variant PRNG draws so each variant's structural hash is
 *  stable independent of the others — adding a 4th variant later won't
 *  bust the cache for variants 0..2.
 *
 *  returns the derived `ParticleHandle`s (one per variant) so the caller
 *  can stash them on the block def for direct lookup; `null` when the
 *  source texture can't be resolved or a custom model has no quads. */
export function deriveBlockDust(id: string, model: BlockModel): readonly ParticleHandle[] | null {
    const topRef = pickDustSourceTexture(model);
    if (!topRef) return null;
    const frame = resolveTextureFrame(topRef);
    if (!frame) return null;

    const baseSeed = hashStringFnv1a(id);
    const handles: ParticleHandle[] = [];

    for (let i = 0; i < DUST_VARIANT_COUNT; i++) {
        const variantId = `${id}:particle${i}`;
        const seed = (baseSeed + i) >>> 0;

        const variantSprite = sprite(variantId, {
            src: draw(
                (ctx, inputs, params) => {
                    const r = createMulberry32Generator(params.seed as number);
                    const max = (params.src as number) - (params.size as number);
                    const sx = Math.floor(r() * max);
                    const sy = Math.floor(r() * max);
                    ctx.drawImage(
                        inputs.tex,
                        sx,
                        sy,
                        params.size as number,
                        params.size as number,
                        0,
                        0,
                        params.size as number,
                        params.size as number,
                    );
                },
                {
                    size: [DUST_SIZE, DUST_SIZE],
                    inputs: { tex: frame },
                    params: { seed, src: DUST_SOURCE_SIZE, size: DUST_SIZE },
                },
            ),
            mipmap: false,
        });
        handles.push(
            particle(variantId, {
                sprite: variantSprite,
                playback: 'stretch',
                update: particleUpdate.dust,
            }),
        );
    }
    return handles;
}
