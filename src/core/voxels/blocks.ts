import type { Vec2, Vec3 } from 'math';
import { mulberry32 } from 'math/random';
import type { AssetMeta } from '../asset-meta';
import type { DepKey } from '../capture/dep-graph';
import { particleUpdate } from '../particles/particle-update';
import type { ParticleHandle } from '../particles/particles';
import { particle, sprite, texture, textureStore } from '../registry';
import type { SoundHandle } from '../sounds/sounds';
import type { ImageSource } from '../sprites/sprites';
import type { TextureHandle } from '../textures/textures';
import type { BlockShape } from './block-collider';
import type { BlockStateDef, PropsDef, PropsValues } from './block-state';
import * as blockState from './block-state';
import type { Voxels } from './voxels';

export type TileOptions = {
    /**
     * source image(s). single entry for static, array for animated. each
     * entry may be a string path (project-root-relative) or a module-relative
     * `asset('./texture.png', import.meta.url)` ref.
     *
     * the `asset()` form lets 3rd-party packs ship textures alongside their
     * modules — it resolves relative to the calling module wherever it's
     * installed, and the pipeline reads the resolved path.
     */
    src?: ImageSource | ImageSource[];

    /** the textures this tile's frames come from. The direct form; `src`
     *  is sugar that declares textures for you. */
    frames?: TextureHandle[];

    /** animation speed in frames per second. default 1. ignored if single frame. */
    fps?: number;

    /** interpolate between frames (smooth water). default false. */
    interpolate?: boolean;
};

/** The declared data for one tile. Pure: hashed wholesale, swapped
 *  wholesale on re-declaration (see `declare`). */
export type TileDef = {
    /** tile string id (e.g. 'lava') */
    id: string;

    /** the textures this tile's frames sample, in order. one entry for a
     *  static tile, N for a flipbook. every frame is a multiple of 16 per side
     *  (see `BLOCK_TILE_SIZE`), and every frame of one tile is the same size. */
    frames: DepKey[];

    /** animation speed in frames per second. */
    fps: number;

    /** interpolate between frames. */
    interpolate: boolean;
};

/**
 * Stable wrapper around a `TileDef`; identity plus the live def.
 *
 * A tile is referenced by its HANDLE, never by id string. The handle carries
 * its own def, so resolving a reference needs no registry lookup and cannot
 * depend on declaration order — which is what lets a block derive its dust at
 * declaration time rather than deferring to the registry build. A string id
 * would reintroduce both: the lookup could miss simply because the tile was
 * declared later in the file.
 */
export type TileHandle = {
    /** the declared id (identity, never changes). */
    readonly id: string;
    /** DepGraph dependency + the brand `isHandle` tests. */
    dependency: { registry: 'tiles'; id: string };
    /** the declared data. re-pointed on every re-declaration. */
    def: TileDef;
};

/** UV rotation for a cube face, 0/90/180/270 ccw. default 0. */
export type CubeFaceRotation = 0 | 90 | 180 | 270;

/**
 * per-face slot for a cube model. A bare handle is the common case; the object
 * form exists only to carry a rotation.
 */
export type CubeFaceSpec = TileHandle | { tile: TileHandle; rotation?: CubeFaceRotation };

/** the tile a face spec names, in either form. */
export function faceTile(spec: CubeFaceSpec): TileHandle {
    return 'tile' in spec ? spec.tile : spec;
}

/** the rotation a face spec carries, 0 when it is a bare handle. */
export function faceRotation(spec: CubeFaceSpec): CubeFaceRotation {
    return 'tile' in spec ? (spec.rotation ?? 0) : 0;
}

/** per-face tile assignment for a cube model. */
export type CubeTiles =
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

/** cube model, standard solid block. */
export type CubeModel = {
    type: 'cube';
    tiles: CubeTiles;
};

/** custom model, quad list for arbitrary block shapes. */
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

    /** the tile this quad samples. */
    tile: TileHandle;

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
     * `false` draws the quad without the per-face directional shade (top 1.0,
     * sides 0.6 / 0.8, bottom 0.5); AO still applies. Minecraft's element
     * `shade: false`. Foliage planes use it so a clump reads as one soft mass
     * rather than as lit cards. Default true.
     */
    shade?: boolean;

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
 * Collect the tile ids referenced by a model into `out`. Used by
 * the block-registry freeze pass to seed the atlas and by the blocks
 * registry's `extractDeps` to wire DepGraph edges from tiles to the
 * blocks that close over them in their model factories.
 */
export function collectModelTileIds(model: BlockModel, out: Set<string>): void {
    switch (model.type) {
        case 'cube': {
            const t = model.tiles;
            if ('all' in t) {
                out.add(faceTile(t.all).id);
            } else if ('sides' in t) {
                out.add(faceTile(t.top).id);
                out.add(faceTile(t.bottom).id);
                out.add(faceTile(t.sides).id);
            } else {
                out.add(faceTile(t.top).id);
                out.add(faceTile(t.bottom).id);
                out.add(faceTile(t.north).id);
                out.add(faceTile(t.south).id);
                out.add(faceTile(t.east).id);
                out.add(faceTile(t.west).id);
            }
            break;
        }
        case 'custom':
            for (const q of model.quads) {
                out.add(q.tile.id);
            }
            break;
    }
}

// ── cull type ───────────────────────────────────────────────────────
//
// controls **only** face culling between adjacent blocks. no render
// routing, that's handled by MaterialType.
//
//   SOLID, full block. culls all neighbors. self-culls. (stone, dirt)
//   SELF, culled by solid. self-culls with **same block id only**.
//             (leaves, water, glass, leaves don't cull water)
//   PARTIAL, culled by solid. never culls neighbors. no self-cull.
//             (stairs, slabs, stained glass that shouldn't self-cull)
//   NONE, invisible / no geometry (air). never culls anything.

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
//   OPAQUE, no discard, no blend; early-Z survives (stone, dirt, ores)
//   TRANSPARENT, alpha cutout via Discard() at alpha<0.5; depth-write on
//                 (leaves, glass-pane, plant cross-quads)
//   TRANSLUCENT, alpha blending; depth-write off; cullMode none (water)

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
//   NONE, no vertex animation (default)
//   WAVE, gentle wind sway, full-block (leaves, vines)
//   SWAY, heavier movement, full-block (banners, hanging signs)
//   PLANT_WIND_SWAY, bottom-anchored bend; tip moves, base stays planted
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
    voxels: Voxels;
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
 * facing (cardinal) and look vector are both derivable from yaw/pitch,
 * use `snapCardinal(yaw)` from editor/camera for the 90% case, or
 * trig on yaw/pitch when richer pitch-aware logic is needed.
 */
export type BlockPlaceCtx = {
    /** target cell (where the block will land, adjacent to the clicked one). */
    worldX: number;
    worldY: number;
    worldZ: number;
    /** hit-face normal, points away from the clicked block. */
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
 *  voxels; tests mock it. `place` never touches voxels directly, same string
 *  block-key currency as `getBlock`/`setBlock`, so a hook decodes a neighbour
 *  via `parseKey` with no registry. `get` reflects this place-action's own
 *  pending writes ('air' for an empty cell). */
export type PlaceIO = {
    get(x: number, y: number, z: number): string;
    set(x: number, y: number, z: number, key: string): void;
};

/** imperative placement (= Luanti `on_place`). validate via `io.get`, then
 *  `io.set` the cell(s), multiple sets for a footprint (door = 2). return
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
 * Block-level sound config, one handle array per category. Multiple
 * handles per slot let the driving system round-robin or random-cycle
 * across clips for variation; an empty array silences the category.
 *
 * Compose preset bundles from `blockSoundPresets.*` in
 * `bongle/kit` or build a fully custom config. All slots
 * optional; omit a category to leave it silent.
 *
 * NOTE: the systems that actually drive playback off these handles
 * (character-controller footstep tick, voxel break/place hooks) are
 * not yet wired, for now this is stored on the def for future use.
 */
export type BlockSoundConfig = {
    /** played while the character walks on top of this block, and, for
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
 * visual *type*, not the event that emits it, the same `dust` handle
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

export type BlockOptions<P extends PropsDef = PropsDef> = AssetMeta & {
    /** block state schema. omit for stateless blocks. */
    states?: BlockStateDef<P>;

    /**
     * authoritative default state, drives `defaultId()`/`defaultKey()`, the
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
    /**
     * the block's geometry for a given state.
     *
     * returning an ARRAY declares per-position variants: the mesher picks one
     * by hashing the block's world position, so the same block does not look
     * identical everywhere. the array IS the variant set, so the count is
     * derived and cannot drift out of step with what the entries actually are.
     *
     * every entry must share a `type` (a list mixing 'cube' and 'custom' has no
     * single mesher path) and the list must be non-empty. a one-entry array
     * behaves exactly like returning that entry directly.
     *
     * ```ts
     * model: () => [0, 1, 2, 3].map((r) => ({ type: 'custom', quads: rotateY(base, r) }))
     * ```
     */
    model?: (props: PropsValues<P>) => BlockModel | BlockModel[];

    /**
     * cull type, controls face culling between adjacent blocks.
     * defaults to CullType.SOLID. can be a static value or a function
     * of props for per-state cull behavior (called once per state at
     * freeze time).
     */
    cull?: CullType | ((props: PropsValues<P>) => CullType);

    /**
     * material type, controls which render pass geometry goes to.
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
     * offset this block's geometry by a small amount derived from its world
     * position, so a field of them does not sit on a visible grid. rendering
     * only; collision and occupancy stay on the cell.
     *
     * `xz` is the max horizontal offset in blocks, `y` the max downward one
     * (plants sink, never float). the hash deliberately ignores world Y, so a
     * vertical stack of the same block shares one offset and a two-block plant
     * cannot tear apart.
     */
    jitter?: { xz?: number; y?: number };

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
     * ladder, gravity is bypassed inside it, jump ascends, crouch descends.
     * climbable blocks usually want `collision: false` so the character can
     * actually enter them. defaults to false.
     * @default false
     */
    climbable?: boolean | ((props: PropsValues<P>) => boolean);

    /**
     * liquid: when set, the character swims while submerged in this block,
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
     * surface height (0..1), opts this block into MODEL_LIQUID. the mesher
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
     * decoded props instead, called once per state at registry freeze
     * time, baked into a per-state lookup table for hot-path reads.
     */
    sounds?: BlockSoundConfig | ((props: PropsValues<P>) => BlockSoundConfig);

    /**
     * pure neighbour-driven state recompute. called after any neighbour of
     * a block of this type changes (and once when the block itself is placed).
     * read neighbours via ctx.voxels; return a new global state id, or the
     * same id for "no change". the engine fast-paths the unchanged case.
     *
     * runs in both editor and server runtime, must be pure (no world
     * mutation beyond returning a new stateId).
     */
    onNeighbourUpdate?: OnNeighbourUpdateFn;

    /**
     * imperative side-effect hook fired after any neighbour changes. drop
     * items, schedule ticks, ignite, etc. server-only, never runs in editor.
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
     * + 3 particle registrations per block at module-scope eval, free
     * at runtime).
     *
     * static config applies to every state. pass a function of decoded
     * props for per-state slots, called once per state at registry
     * freeze, baked into a per-state lookup. authors who want per-state
     * particles should hoist `particle()` declarations to module scope
     * (free dedup by id) and just reference them per state.
     *
     * default dust is derived **once from the default state's model**
     * and shared across every state, this is the dedup escape hatch
     * for blocks with many states (the registry never multiplies the
     * auto-dust set by state count).
     *
     * pass `false` to opt out entirely for all states, no dust
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
    /** human-readable display name for editor UIs. always set,
     *  defaults to `id` when the author didn't supply one. */
    name: string;
    /** search words for editor UIs, normalised (see `AssetMeta`). */
    tags: readonly string[];
    /** block state schema (empty schema if stateless) */
    states: BlockStateDef<P>;
    /** local state index for the block's default state. omitted (or 0)
     *  when no `defaultState` was supplied, default is the first encoded
     *  state. drives `defaultId()`/`defaultKey()` on the handle. */
    defaultLocalIdx?: number;
    /** model function (undefined for invisible blocks like air) */
    /**
     * the block's geometry for a given state.
     *
     * returning an ARRAY declares per-position variants: the mesher picks one
     * by hashing the block's world position, so the same block does not look
     * identical everywhere. the array IS the variant set, so the count is
     * derived and cannot drift out of step with what the entries actually are.
     *
     * every entry must share a `type` (a list mixing 'cube' and 'custom' has no
     * single mesher path) and the list must be non-empty. a one-entry array
     * behaves exactly like returning that entry directly.
     *
     * ```ts
     * model: () => [0, 1, 2, 3].map((r) => ({ type: 'custom', quads: rotateY(base, r) }))
     * ```
     */
    model?: (props: PropsValues<P>) => BlockModel | BlockModel[];
    /** cull type setting */
    cull: CullType | ((props: PropsValues<P>) => CullType);
    /** material type setting */
    material: MaterialType | ((props: PropsValues<P>) => MaterialType);
    /** vertex animation setting */
    vertexAnimation?: VertexAnimation | ((props: PropsValues<P>) => VertexAnimation);

    /**
     * offset this block's geometry by a small amount derived from its world
     * position, so a field of them does not sit on a visible grid. rendering
     * only; collision and occupancy stay on the cell.
     *
     * `xz` is the max horizontal offset in blocks, `y` the max downward one
     * (plants sink, never float). the hash deliberately ignores world Y, so a
     * vertical stack of the same block shares one offset and a two-block plant
     * cannot tear apart.
     */
    jitter?: { xz?: number; y?: number };
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
    /** surface height (0..1), opts into MODEL_LIQUID rendering. */
    surfaceHeight?: number | ((props: PropsValues<P>) => number);
    /** fluid group string, shared id for same-fluid face culling. */
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

// ── block handle ─────────────────────────────────
//
// returned by block() at module scope. the registry builder patches
// _baseStateId and _index at freeze time. user code only calls
// stateId()/defaultId() inside script callbacks, which run after freeze.

/** Stable wrapper around a `BlockDef`; identity, the live def, and the state-id
 *  helpers gameplay code calls. The `_`-prefixed slots are DERIVED, not declared
 *  data, which is why they live here rather than on the def: `blockHash` walks
 *  the def, and dust derived FROM a block feeding back into that block's own hash
 *  would make every rebuild look like a content change. */
export type BlockHandle<P extends PropsDef = PropsDef> = {
    /** the declared id (identity, never changes). */
    readonly id: string;
    /** DepGraph dependency + the brand `isHandle` tests. */
    dependency: { registry: 'blocks'; id: string };
    /** the declared data. re-pointed on every re-declaration. */
    def: BlockDef<P>;

    /** dense block type index. set by the registry builder at freeze time. */
    _index: number;
    /** first global state id. set by the registry builder at freeze time. */
    _baseStateId: number;
    /**
     * bitmask of hooks this block has (intrinsic + any observer handlers
     * registered at module scope). populated by the registry builder at
     * freeze time. drives the fast-path filter in the hook dispatcher.
     * see BlockHooks enum in block-hooks.ts.
     */
    _hooks: number;
    /**
     * per-block dust particles, derived from the default state's model by
     * `block()` itself and shared across every state as the fallback for any
     * particle slot the author left unset. `null` when the block opted out with
     * `particles: false`, declared no model, or the model names no tile.
     *
     * Derived at DECLARATION time, in the declaring module's own scope, so the
     * ordinary per-module sweep reclaims it when the block is deleted.
     */
    _defaultDust: readonly ParticleHandle[] | null;

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
export const EMPTY_STATES = blockState.create({});

// ── auto-derived block-dust ─────────────────────────────────────────
//
// Asset-pipeline-as-call-graph: `block()` makes 6 extra module-scope
// declaration calls (3× `sprite()` + 3× `particle()`) per block-with-a-
// cube-model, registering `<id>:particle{0,1,2}` against the same
// registries user-authored sprites + particles land in. No engine-special
// ownership path, the derived entries are attributed to the same module
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
// block id, sequential calls produce uncorrelated (sx, sy) pairs, so
// the 3 variants tend to cover different regions of the face. Hardcoded
// 16×16 source dims to match the engine's default block texture size,
// non-default sizes will read out of bounds; widen when a real case
// forces it.
//
// The draw fn is hashed via `Function.prototype.toString()` for asset-
// pipeline invalidation, so the seed rides through `params` (which DOES
// participate in the structural hash). `mulberry32` is a
// stable published algorithm, the closure-capture-not-hashed gap is a
// theoretical concern only.

const DUST_SIZE = 4;
const DUST_SOURCE_SIZE = 16;
const DUST_VARIANT_COUNT = 3;

/** FNV-1a 32-bit string hash. used as the per-block dust slice seed.
 *  inlined here rather than imported from a util so the dust deriver
 *  stays self-contained, sole consumer, no other hash needs. */
function hashStringFnv1a(s: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    }
    return h >>> 0;
}

/**
 * The texture backing one of a tile's frames, resolved through the texture store.
 * `null` when the tile has no such frame.
 *
 * A tile stores frame REFERENCES, so reaching the texture is a lookup rather than a
 * field read. This is the supported way to draw from an existing tile — pass the
 * result as a `texture()` input.
 */
export function tileFrame(tile: TileHandle, index = 0): TextureHandle | null {
    const frame = tile.def.frames[index];
    return frame ? (textureStore.handles.get(frame.id) ?? null) : null;
}

/** pick the tile to slice dust sprites out of. cubes have an
 *  unambiguous top face; custom models pick the first upward-facing
 *  quad and fall back to quads[0] if none face up. */
function pickDustSourceTile(model: BlockModel): TileHandle | null {
    if (model.type === 'cube') {
        const t = model.tiles;
        return faceTile('all' in t ? t.all : t.top);
    }
    const quads = model.quads;
    if (quads.length === 0) return null;
    for (const q of quads) {
        if (q.normal[1] > 0.5) return q.tile;
    }
    return quads[0]!.tile;
}

/** declare `<id>:particle{0..N-1}` sprite + particle entries from the
 *  block's top-face texture. caller evaluates the block's model fn at
 *  default props and hands the snapshot in; invisible blocks (no model)
 *  never reach here (caller guards).
 *
 *  source-tile pick:
 *    - cube: `all` / `top`, depending on which the tile map exposes.
 *    - custom: the first quad with an upward-facing normal (ny > 0.5);
 *      falls back to the first quad if no upward face exists (rare,
 *      e.g. hanging vines). stairs/slabs land on their top slab face,
 *      which is what we'd hand-pick anyway.
 *
 *  the seed passed into the computed texture's `params` is `hash(id) + idx`
 *  rather than per-variant PRNG draws so each variant's structural hash is
 *  stable independent of the others, adding a 4th variant later won't
 *  bust the cache for variants 0..2.
 *
 *  returns the derived `ParticleHandle`s (one per variant) so the caller
 *  can stash them on the block def for direct lookup; `null` when the
 *  source tile can't be resolved or a custom model has no quads. */
export function deriveBlockDust(id: string, model: BlockModel): readonly ParticleHandle[] | null {
    const topTile = pickDustSourceTile(model);
    if (!topTile) return null;
    // frame 0 is the deliberate pick: a tile's `frames` is an animation sequence
    // (water, lava) and dust wants one static image out of it.
    const source = tileFrame(topTile);
    if (!source) return null;

    const baseSeed = hashStringFnv1a(id);
    const handles: ParticleHandle[] = [];

    for (let i = 0; i < DUST_VARIANT_COUNT; i++) {
        const variantId = `${id}:particle${i}`;
        const seed = (baseSeed + i) >>> 0;

        // a computed texture drawn from the block's top face, then a sprite that
        // references it. The source is passed as a HANDLE, so the derived texture holds a
        // real dep edge back to it rather than a copy of its resolved path.
        const variantTexture = texture(variantId, {
            size: [DUST_SIZE, DUST_SIZE],
            inputs: { tex: source },
            params: { seed, src: DUST_SOURCE_SIZE, size: DUST_SIZE },
            fn: (ctx, inputs, params) => {
                const rng = mulberry32.create(params.seed as number);
                const r = () => mulberry32.sample(rng);
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
        });
        const variantSprite = sprite(variantId, { frames: [variantTexture], mipmap: false });
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
