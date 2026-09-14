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
    src?: ImageSource | ImageSource[]; // source image(s): single entry for static, array for animated; a path or an asset() ref
    frames?: TextureHandle[]; // the textures this tile's frames come from, the direct form; `src` is sugar for this
    fps?: number; // animation speed in frames per second, default 1; ignored if single frame
    interpolate?: boolean; // interpolate between frames (smooth water). default false
};

/** The declared data for one tile; hashed and swapped wholesale on re-declaration. */
export type TileDef = {
    id: string; // tile string id (e.g. 'lava')
    frames: DepKey[]; // textures this tile's frames sample, in order: one entry for a static tile, N for a flipbook
    fps: number; // animation speed in frames per second
    interpolate: boolean;
};

/** Stable wrapper around a `TileDef`: identity plus the live def, referenced by handle rather than id string so resolving needs no registry lookup. */
export type TileHandle = {
    readonly id: string; // the declared id (identity, never changes)
    dependency: { registry: 'tiles'; id: string }; // DepGraph dependency + the brand `isHandle` tests
    def: TileDef; // the declared data, re-pointed on every re-declaration
};

/** UV rotation for a cube face, 0/90/180/270 ccw. default 0. */
export type CubeFaceRotation = 0 | 90 | 180 | 270;

// per-face slot for a cube model; a bare handle is the common case, the object form exists only to carry a rotation.
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

export type CustomModel = {
    type: 'custom';
    quads: BlockQuad[]; // the mesher emits these directly; the registry build rejects non-quad input
};

// a single quad in a custom block model, in block-local space [0,1] (the mesher offsets by world position); use bm.quad() for raw quads, bm.box() for axis-aligned boxes, bm.cross() for vegetation cross-quads.
export type BlockQuad = {
    verts: [Vec3, Vec3, Vec3, Vec3]; // 4 vertices in CCW order as [x, y, z] in block-local space [0,1]
    normal: Vec3;
    tile: TileHandle;
    uvs?: [Vec2, Vec2, Vec2, Vec2]; // defaults to full-texture [[0,1],[1,1],[1,0],[0,0]]

    // hidden when the neighbor in this direction is a full opaque cube; undefined = never culled; only for quads flush with the block boundary.
    cullFace?: 'north' | 'south' | 'east' | 'west' | 'up' | 'down';

    shade?: boolean; // `false` skips per-face directional shade (AO still applies); foliage uses it to read as one soft mass. default true
    material?: MaterialType; // render pass for this quad; defaults to the block's material
    ao?: boolean; // receives smooth-light + AO sampling; set false for quads that should stay flat-lit. default true
};

export type BlockModel = CubeModel | CustomModel;

/** Collect the tile ids referenced by a model into `out`, for seeding the atlas and wiring DepGraph edges from tiles to blocks. */
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

// controls only face culling between adjacent blocks; render routing is handled by MaterialType.
export enum CullType {
    NONE, // invisible / no geometry (air); never culls anything
    SOLID, // full block; culls all neighbors, self-culls
    SELF, // culled by solid; self-culls with same block id only (leaves, water, glass)
    PARTIAL, // culled by solid; never culls neighbors, no self-cull (stairs, slabs)
}

// controls which render pass geometry goes to; independent of CullType.
export enum MaterialType {
    OPAQUE = 0, // no discard, no blend; early-Z survives
    TRANSPARENT = 1, // alpha cutout via discard at alpha<0.5; depth-write on
    TRANSLUCENT = 2, // alpha blending; depth-write off; cullMode none
}

// opt-in vertex displacement; the mesher outputs an animation type attribute per vertex so the shader knows what to do.
export enum VertexAnimation {
    NONE, // no vertex animation (default)
    WAVE, // gentle wind sway, full-block (leaves, vines)
    SWAY, // heavier movement, full-block (banners, hanging signs)
    PLANT_WIND_SWAY, // bottom-anchored bend; tip moves, base stays planted
}

// hooks are called by the engine when block changes are processed: intrinsic (def) hooks vs. observer (additive, module scope) hooks.
export type BlockChangeCtx = {
    voxels: Voxels;
    worldX: number;
    worldY: number;
    worldZ: number;
    stateId: number; // current global state id at (worldX, worldY, worldZ)
};

export type BlockStateChangeCtx = BlockChangeCtx & {
    oldStateId: number; // global state id before the state change
};

export type OnNeighbourUpdateFn = (ctx: BlockChangeCtx) => number; // pure: recompute self stateId; return same id = no change
export type OnNeighbourChangedFn = (ctx: BlockChangeCtx) => void; // imperative: a neighbour changed, do side effects

// placement ctx fed to a block's `place` hook.
export type BlockPlaceCtx = {
    worldX: number; // target cell (where the block will land, adjacent to the clicked one)
    worldY: number;
    worldZ: number;
    normalX: number; // hit-face normal, points away from the clicked block
    normalY: number;
    normalZ: number;
    hitX: number; // hit point in the clicked block's [0,1]^3 local space
    hitY: number;
    hitZ: number;
    yaw: number; // placer camera yaw (radians)
    pitch: number; // placer camera pitch (radians)
};

/** Read/write seam handed to a `place` hook, bound by the caller (editor records undoable ops, gameplay writes authoritative voxels, tests mock it). */
export type PlaceIO = {
    get(x: number, y: number, z: number): string;
    set(x: number, y: number, z: number, key: string): void;
};

/** Imperative placement: validate via `io.get`, then `io.set` the cell(s) (multiple for a footprint like a door); return early to abort. */
export type PlaceFn = (ctx: BlockPlaceCtx, io: PlaceIO) => void;

/** Rotate a stateId 90 degrees around an axis (cw = looking down the +axis); falls back to the prop-name convention when undefined. */
export type RotateFn = (stateId: number, axis: 'x' | 'y' | 'z', cw: boolean) => number;

/** Mirror a stateId across the plane perpendicular to axis through origin; falls back to the prop-name convention when undefined. */
export type FlipFn = (stateId: number, axis: 'x' | 'y' | 'z') => number;

export type OnBuildFn = (ctx: BlockChangeCtx) => void; // observer fired when a block of this type is built (air -> non-air)
export type OnBreakFn = (ctx: BlockChangeCtx) => void; // observer fired when a block of this type is broken (non-air -> air)
export type OnStateChangeFn = (ctx: BlockStateChangeCtx) => void; // observer fired when state changes within the same block-type

// fullscreen tint applied while the camera is inside a block (underwater blue, lava orange); resolved per-state at registry freeze.
export type ScreenTintSpec = {
    color: readonly [number, number, number]; // linear RGB, each channel 0..1
    opacity: number; // mix weight 0..1; 0 = no tint, 1 = full replacement
};

// block-level sound config, one handle array per category (round-robin variation); not yet wired to a driving system.
export type BlockSoundConfig = {
    footstep?: readonly SoundHandle[]; // walking on this block, and, for liquid blocks, entry splash and each swim stroke
    dig?: readonly SoundHandle[]; // looped while the block is being mined (before the final break)
    break?: readonly SoundHandle[]; // one-shot on the final break
    place?: readonly SoundHandle[]; // one-shot when a block of this type is placed by a player
};

/** Named particle slots on a block; slot names describe the particle's visual type, not the event that emits it. */
export type BlockParticleConfig = {
    dust?: readonly ParticleHandle[]; // small surface puffs: sprint footstep cadence, landing edge, liquid-entry splash
    build?: readonly ParticleHandle[]; // future: emitted when a block of this type is placed by a player
    break?: readonly ParticleHandle[]; // future: chunky debris on full break
};

export type BlockOptions<P extends PropsDef = PropsDef> = AssetMeta & {
    states?: BlockStateDef<P>; // block state schema. omit for stateless blocks
    defaultState?: PropsValues<P>; // authoritative default state, drives defaultId()/defaultKey() and the inventory icon
    model?: (props: PropsValues<P>) => BlockModel | BlockModel[]; // geometry per state; an array return declares per-position variants
    cull?: CullType | ((props: PropsValues<P>) => CullType); // face culling between adjacent blocks. default CullType.SOLID
    material?: MaterialType | ((props: PropsValues<P>) => MaterialType); // which render pass geometry goes to. default MaterialType.OPAQUE
    vertexAnimation?: VertexAnimation | ((props: PropsValues<P>) => VertexAnimation); // @default VertexAnimation.NONE
    jitter?: { xz?: number; y?: number }; // small render-only world-position-derived offset so a field of blocks isn't on a grid
    lightEmission?: [number, number, number] | ((props: PropsValues<P>) => [number, number, number]); // rgb, each channel 0-15
    lightOpacity?: number | ((props: PropsValues<P>) => number); // 0-15, 0 = transparent, 15 = opaque; default by cull type
    emissive?: boolean | ((props: PropsValues<P>) => boolean); // renders at full brightness regardless of surrounding light. @default false
    collision?: boolean | ((props: PropsValues<P>) => boolean); // participates in physics collision. @default true
    selection?: boolean | ((props: PropsValues<P>) => boolean); // targetable by raycasts for mining/placing/picking. @default true
    shape?: BlockShape | ((props: PropsValues<P>) => BlockShape); // physics/selection shape in block-local [0,1] space; omit for the unit box fast path
    climbable?: boolean | ((props: PropsValues<P>) => boolean); // treated as a ladder (gravity bypassed). @default false
    liquid?: { viscosity: number } | null | ((props: PropsValues<P>) => { viscosity: number } | null); // character swims while submerged, drag scales with viscosity
    pathfindable?: boolean | ((props: PropsValues<P>) => boolean); // may a navigating agent occupy/pass through this cell? @default !collision
    friction?: number | ((props: PropsValues<P>) => number); // 0 = perfect ice, ~0.1 = slippery, ~2.0 = sticky. @default 1.0
    restitution?: number | ((props: PropsValues<P>) => number); // bounciness. 0 = no bounce, 1 = elastic. @default 0
    sneakGuard?: boolean | ((props: PropsValues<P>) => boolean); // crouched character anchors and can't walk off edges. default true for collidable blocks
    flags?: number; // extra bits OR'd into the block's flags bitmask (BLOCK_FLAG_FENCE, BLOCK_FLAG_WALL, ...)
    surfaceHeight?: number | ((props: PropsValues<P>) => number); // (0..1), opts this block into MODEL_LIQUID
    fluidGroup?: string; // states sharing a group string cull faces between each other when surface heights line up
    screenTint?: ScreenTintSpec | ((props: PropsValues<P>) => ScreenTintSpec | undefined); // fullscreen overlay while camera is inside this block
    sounds?: BlockSoundConfig | ((props: PropsValues<P>) => BlockSoundConfig); // footstep/dig/break/place sounds; omit to leave silent
    onNeighbourUpdate?: OnNeighbourUpdateFn; // pure state recompute after any neighbour changes; must be pure
    onNeighbourChanged?: OnNeighbourChangedFn; // imperative side-effect hook after any neighbour changes; server-only
    place?: PlaceFn; // pick the placed stateId from hit context; falls back to the prop-name convention when undefined
    rotate?: RotateFn; // rotate a stateId 90 degrees around `axis`; falls back to the prop-name convention
    flip?: FlipFn; // mirror a stateId across the plane perpendicular to `axis`; falls back to the prop-name convention
    particles?: BlockParticleConfig | ((props: PropsValues<P>) => BlockParticleConfig) | false; // missing slots auto-derive from the top-face texture
};

// internal, stored in blocksRegistry via the handle's _def.
export type BlockDef<P extends PropsDef = PropsDef> = {
    id: string; // string id (e.g. 'oak_log')
    name: string; // display name for editor UIs; defaults to `id`
    tags: readonly string[]; // search words for editor UIs, normalised (see `AssetMeta`)
    states: BlockStateDef<P>; // block state schema (empty schema if stateless)
    defaultLocalIdx?: number; // local state index for the default state; omitted (or 0) means the first encoded state
    model?: (props: PropsValues<P>) => BlockModel | BlockModel[];
    cull: CullType | ((props: PropsValues<P>) => CullType);
    material: MaterialType | ((props: PropsValues<P>) => MaterialType);
    vertexAnimation?: VertexAnimation | ((props: PropsValues<P>) => VertexAnimation);
    jitter?: { xz?: number; y?: number };
    lightEmission?: [number, number, number] | ((props: PropsValues<P>) => [number, number, number]);
    lightOpacity?: number | ((props: PropsValues<P>) => number);
    emissive?: boolean | ((props: PropsValues<P>) => boolean);
    collision?: boolean | ((props: PropsValues<P>) => boolean);
    selection?: boolean | ((props: PropsValues<P>) => boolean);
    shape?: BlockShape | ((props: PropsValues<P>) => BlockShape);
    climbable?: boolean | ((props: PropsValues<P>) => boolean);
    liquid?: { viscosity: number } | null | ((props: PropsValues<P>) => { viscosity: number } | null);
    pathfindable?: boolean | ((props: PropsValues<P>) => boolean); // defaults to !collision
    friction?: number | ((props: PropsValues<P>) => number);
    restitution?: number | ((props: PropsValues<P>) => number);
    sneakGuard?: boolean | ((props: PropsValues<P>) => boolean);
    flags?: number;
    surfaceHeight?: number | ((props: PropsValues<P>) => number);
    fluidGroup?: string;
    screenTint?: ScreenTintSpec | ((props: PropsValues<P>) => ScreenTintSpec | undefined);
    sounds?: BlockSoundConfig | ((props: PropsValues<P>) => BlockSoundConfig); // resolved per-state into `BlockRegistry.sounds[]` at freeze
    particles?: BlockParticleConfig | ((props: PropsValues<P>) => BlockParticleConfig) | false; // user slots win, missing fall back to auto-derived dust
    onNeighbourUpdate?: OnNeighbourUpdateFn;
    onNeighbourChanged?: OnNeighbourChangedFn;
    place?: PlaceFn;
    rotate?: RotateFn;
    flip?: FlipFn;
};

// returned by block() at module scope; the registry builder patches _baseStateId and _index at freeze time.

/** Stable wrapper around a `BlockDef`: identity, the live def, and the state-id helpers gameplay code calls. */
export type BlockHandle<P extends PropsDef = PropsDef> = {
    readonly id: string; // the declared id (identity, never changes)
    dependency: { registry: 'blocks'; id: string }; // DepGraph dependency + the brand `isHandle` tests
    def: BlockDef<P>; // the declared data, re-pointed on every re-declaration

    _index: number; // dense block type index, set by the registry builder at freeze time
    _baseStateId: number; // first global state id, set by the registry builder at freeze time
    _hooks: number; // bitmask of hooks this block has (intrinsic + observer)

    // per-block dust particles, derived from the default state's model, shared as the fallback for any unset particle slot.
    _defaultDust: readonly ParticleHandle[] | null;

    stateId(props: PropsValues<P>): number; // get the global state id for specific property values

    // lift a pre-computed local state index into a global state id, skipping the props-object allocation stateId() needs.
    stateIdLocal(localIdx: number): number;

    defaultId(): number; // get the default global state id, driven by `defaultState`
    stateKey(props: PropsValues<P>): string; // get the stable string key for specific property values (e.g. "oak_log[axis=y]")
    defaultKey(): string; // get the stable string key for the default state
};

export const EMPTY_STATES = blockState.create({});

// `block()` registers 3 deterministic `<id>:particle{0,1,2}` dust variants (sprite + particle) per block with a cube model, sliced via one mulberry32 PRNG seeded by FNV-1a of the block id; source dims are hardcoded to 16x16.

const DUST_SIZE = 4;
const DUST_SOURCE_SIZE = 16;
const DUST_VARIANT_COUNT = 3;

/** FNV-1a 32-bit string hash, used as the per-block dust slice seed. */
function hashStringFnv1a(s: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    }
    return h >>> 0;
}

/** The texture backing one of a tile's frames, resolved through the texture store; null when the tile has no such frame. */
export function tileFrame(tile: TileHandle, index = 0): TextureHandle | null {
    const frame = tile.def.frames[index];
    return frame ? (textureStore.handles.get(frame.id) ?? null) : null;
}

/** pick the tile to slice dust sprites out of: cubes use their top face, custom models the first upward-facing quad (else quads[0]). */
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

/** Declare `<id>:particle{0..N-1}` sprite + particle entries from the block's top-face texture; null when no source tile resolves. */
export function deriveBlockDust(id: string, model: BlockModel): readonly ParticleHandle[] | null {
    const topTile = pickDustSourceTile(model);
    if (!topTile) return null;
    const source = tileFrame(topTile); // frame 0: dust wants one static image out of an animated tile
    if (!source) return null;

    const baseSeed = hashStringFnv1a(id);
    const handles: ParticleHandle[] = [];

    for (let i = 0; i < DUST_VARIANT_COUNT; i++) {
        const variantId = `${id}:particle${i}`;
        const seed = (baseSeed + i) >>> 0;

        // computed texture drawn from the block's top face, then a sprite referencing it.
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
