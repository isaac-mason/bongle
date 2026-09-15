import type { Vec2 } from 'math';
import { block } from '../registry';
import * as blockShape from './block-collider';
import * as blockModel from './block-model';
import {
    AIR,
    BLOCK_FLAG_COLLISION,
    BLOCK_FLAG_DOOR,
    BLOCK_FLAG_FENCE,
    BLOCK_FLAG_PANE,
    BLOCK_FLAG_SUPPORTS_HANGING,
    BLOCK_FLAG_WALL,
    parseKey,
} from './block-registry';
import * as blockState from './block-state';
import {
    type BlockHandle,
    type BlockOptions,
    type BlockPlaceCtx,
    type BlockQuad,
    type CubeFaceRotation,
    type CubeFaceSpec,
    type CubeTiles,
    CullType,
    faceTile,
    MaterialType,
    type ScreenTintSpec,
    type TileHandle,
    VertexAnimation,
} from './blocks';

// options shared by every preset: an explicit allowlist of caller-facing material/behaviour knobs. a `Pick`, not an `Omit`, so a field added to `BlockOptions` later stays unexposed until deliberately opted in.
type PresetOptions = Pick<
    BlockOptions,
    | 'name'
    | 'tags'
    | 'sounds'
    | 'material'
    | 'cull'
    | 'vertexAnimation'
    | 'selection'
    | 'collision'
    | 'climbable'
    | 'pathfindable'
    | 'friction'
    | 'restitution'
    | 'sneakGuard'
    | 'lightEmission'
    | 'lightOpacity'
    | 'emissive'
    | 'screenTint'
    | 'particles'
>;

import {
    axisFromPlaceCtx,
    FACING4_FLIP_X,
    FACING4_FLIP_Z,
    FACING4_ORDER,
    FACING4_STEPS,
    type Facing4,
    facing4FromPlaceCtx,
    halfFromPlaceCtx,
    rotateFacing4,
} from './block-place';
import { BLOCK_AIR, getBlockState, setBlock, type Voxels } from './voxels';

// a cube-shaped preset accepts a full per-face `CubeTiles` map or, as shorthand, a bare `TileHandle` for "all faces"; a tile handle never carries an `all`/`top` key, so those keys unambiguously mark a `CubeTiles` map.
type CubeTilesInput = CubeTiles | TileHandle;

/** the four y rotations, in order. */
const QUARTER_TURNS: readonly CubeFaceRotation[] = [0, 90, 180, 270];

function resolveCubeTiles(input: CubeTilesInput): CubeTiles {
    if ('all' in input || 'top' in input) return input as CubeTiles;
    return { all: input as TileHandle };
}

// per-preset option bags, each mirroring block()'s single-config-object shape: the required `tiles` plus the `PresetOptions` knobs the preset leaves caller-settable.
export type CubePresetOptions = PresetOptions & {
    tiles: CubeTilesInput;
    /** draw this cube at one of four y rotations picked from world position (stable across remeshes, identical on
     *  every client) so a large flat expanse doesn't sit on a visible grid. */
    varyRotation?: boolean;
};
export type ColumnPresetOptions = PresetOptions & { tiles: { end: TileHandle; side: TileHandle } };
export type StairsPresetOptions = Omit<PresetOptions, 'cull'> & { tiles: CubeTilesInput };
export type SlabPresetOptions = Omit<PresetOptions, 'cull'> & { tiles: CubeTilesInput };
export type LeavesPresetOptions = Omit<PresetOptions, 'cull' | 'vertexAnimation'> & {
    tiles: CubeTilesInput;
    /** four crossed, overhanging, unshaded, leaning planes so the canopy doesn't end on a hard cube edge; costs 8
     *  extra quads with no culling, so opt-in per leaf type. pass a round masked leaf blob, not a square tile. */
    fluff?: TileHandle;
    /** draw at one of four y rotations picked from world position; odd rotations also mirror the fluff lean. */
    varyRotation?: boolean;
};
export type FencePresetOptions = Omit<PresetOptions, 'cull'> & { tiles: CubeTilesInput };
export type PanePresetOptions = Omit<PresetOptions, 'cull'> & { tiles: CubeTilesInput };
export type CarpetPresetOptions = Omit<PresetOptions, 'cull'> & { tiles: CubeTilesInput };
export type LitterPresetOptions = Omit<PresetOptions, 'cull' | 'collision' | 'lightOpacity' | 'vertexAnimation'> & {
    /** one tile, or several picked per world position (see `cross`). */
    tiles: TileHandle | readonly TileHandle[];
    /** draw at one of four y rotations, picked per world position. default true. */
    varyRotation?: boolean;
};
export type TrapdoorPresetOptions = Omit<PresetOptions, 'cull'> & { tiles: CubeTilesInput };
export type WallPresetOptions = Omit<PresetOptions, 'cull'> & { tiles: CubeTilesInput };
export type CrossPresetOptions = Omit<PresetOptions, 'cull' | 'collision' | 'lightOpacity' | 'vertexAnimation'> & {
    /** one tile, or several: with a list the mesher picks one per world position. */
    tiles: TileHandle | readonly TileHandle[];
    /** per-position offset, `xz` in blocks either way and `y` downward (see `BlockOptions.jitter`). */
    jitter?: BlockOptions['jitter'];
    /** plane height in blocks (default 1); taller planes want a tile `ceil(height)` blocks tall (see `blockModel.cross`). */
    height?: number;
    /** how many blocks tall the tile is, when the plane is shorter than it. */
    tileBlocks?: number;
    /** selection shape, for a plant smaller than the default 12x13x12 box. */
    shape?: BlockOptions['shape'];
};
export type LadderPresetOptions = Omit<PresetOptions, 'cull' | 'collision' | 'climbable'> & { tiles: TileHandle };
export type PlatePresetOptions = Omit<PresetOptions, 'cull' | 'collision'> & { tiles: TileHandle };
export type ChainPresetOptions = Omit<PresetOptions, 'cull' | 'lightOpacity'> & { tiles: TileHandle };
export type LanternPresetOptions = Omit<PresetOptions, 'cull' | 'lightOpacity' | 'emissive'> & {
    tiles: { lit: TileHandle; unlit: TileHandle }; // the lit sheet (animate it for a flicker) and the sheet shown when out
};
export type TorchPresetOptions = Omit<PresetOptions, 'cull' | 'collision' | 'emissive'> & { tiles: TileHandle };
export type DoorPresetOptions = Omit<PresetOptions, 'cull'> & { tiles: { top: TileHandle; bottom: TileHandle } };

// liquids are collision:false and assemble their config by hand, so only the fields they actually forward are exposed.
export type LiquidPresetOptions = Pick<PresetOptions, 'name' | 'tags' | 'sounds' | 'material'> & {
    tiles: CubeTilesInput;
    viscosity?: number;
    translucent?: boolean;
    levels?: number;
    fluidGroup?: string;
    tint?: ScreenTintSpec; // screen tint applied when the camera eye sits inside the filled band
    maxHeight?: number; // scales the surface for every level; 1 = full cube at max level, lower gives a visible meniscus. default 1
    lightEmission?: [number, number, number]; // per-channel light output (0..15), set for lava-style glow
    emissive?: boolean; // mark the texture as self-lit so it stays bright in shadow
};

// the most basic block: a full opaque cube with the given tiles. drop down to block() directly to override cull, friction, or any other field.
/*#__NO_SIDE_EFFECTS__*/
export function cube(id: string, { tiles: tilesInput, varyRotation, ...options }: CubePresetOptions) {
    const tiles = resolveCubeTiles(tilesInput);
    // a y rotation of a cube whose sides match is a rotation of its top and bottom faces; the sides pass through untouched.
    const rotated = (rotation: CubeFaceRotation): CubeTiles => {
        const top = faceTile('all' in tiles ? tiles.all : tiles.top);
        const bottom = faceTile('all' in tiles ? tiles.all : tiles.bottom);
        const side = (face: 'north' | 'south' | 'east' | 'west'): CubeFaceSpec =>
            'all' in tiles ? tiles.all : 'sides' in tiles ? tiles.sides : tiles[face];
        return {
            top: { tile: top, rotation },
            bottom: { tile: bottom, rotation },
            north: side('north'),
            south: side('south'),
            east: side('east'),
            west: side('west'),
        };
    };
    return block(id, {
        ...options,
        model: () =>
            varyRotation
                ? QUARTER_TURNS.map((rotation) => ({ type: 'cube' as const, tiles: rotated(rotation) }))
                : { type: 'cube' as const, tiles },
        material: options?.material ?? MaterialType.OPAQUE,
    });
}

// axis-oriented full cube, end-cap texture on faces perpendicular to the axis, wrap texture on the other four (logs, basalt pillars, hay bales); placement axis is the build tool's dominant hit-normal axis.
const ColumnState = blockState.create({
    axis: blockState.enumeration(['x', 'y', 'z'] as const),
});

// axis-enum rotation: a single 90 degree rotation around `rotAxis` swaps the two axes perpendicular to it. flips are identity.
const AXIS_REMAP: Record<'x' | 'y' | 'z', Record<'x' | 'y' | 'z', 'x' | 'y' | 'z'>> = {
    x: { x: 'x', y: 'z', z: 'y' },
    y: { x: 'z', y: 'y', z: 'x' },
    z: { x: 'y', y: 'x', z: 'z' },
};

/*#__NO_SIDE_EFFECTS__*/
export function column(id: string, { tiles, ...options }: ColumnPresetOptions) {
    const end = tiles.end;
    const side = tiles.side;
    let handle: BlockHandle<typeof ColumnState.props>;
    handle = block(id, {
        ...options,
        material: options?.material ?? MaterialType.OPAQUE,
        states: ColumnState,
        defaultState: { axis: 'y' },
        // axis-aligned cube, geometry never changes; grain follows axis via per-face UV rotation.
        model: ({ axis }) => {
            if (axis === 'y') {
                return {
                    type: 'cube' as const,
                    tiles: { top: end, bottom: end, sides: side },
                };
            }
            if (axis === 'x') {
                return {
                    type: 'cube' as const,
                    tiles: {
                        top: { tile: side, rotation: 90 },
                        bottom: { tile: side, rotation: 90 },
                        north: { tile: side, rotation: 90 },
                        south: { tile: side, rotation: 90 },
                        east: end,
                        west: end,
                    },
                };
            }
            // axis === 'z'
            return {
                type: 'cube' as const,
                tiles: {
                    top: side,
                    bottom: side,
                    north: end,
                    south: end,
                    east: { tile: side, rotation: 90 },
                    west: { tile: side, rotation: 90 },
                },
            };
        },
        place: (ctx, io) => io.set(ctx.worldX, ctx.worldY, ctx.worldZ, handle.stateKey({ axis: axisFromPlaceCtx(ctx) })),
        rotate: (stateId, axis) => {
            const local = stateId - handle._baseStateId;
            const p = handle.def.states.decode(local);
            return handle.stateId({ axis: AXIS_REMAP[axis][p.axis as 'x' | 'y' | 'z'] });
        },
        // axis is directionless, flips are identity.
    });
    return handle;
}

// neighbour-aware staircase; state is (facing, half, shape): facing follows the engine-wide directional convention (base orientation has the high back step at +Z/south, rotated by (4 - FACING4_STEPS[facing]) % 4); half is bottom or top (ceiling-mounted); shape is straight, outer_* (back strip halved) or inner_* (front corner gets a quarter step), l/r naming which side of facing the corner sits on. onNeighbourUpdate derives `shape` from same-block neighbours with matching half whose facing is perpendicular to ours.
const StairState = blockState.create({
    facing: blockState.enumeration(['north', 'east', 'south', 'west'] as const),
    half: blockState.enumeration(['bottom', 'top'] as const),
    shape: blockState.enumeration(['straight', 'inner_left', 'inner_right', 'outer_left', 'outer_right'] as const),
});

type StairShape = 'straight' | 'inner_left' | 'inner_right' | 'outer_left' | 'outer_right';
type StairHalf = 'bottom' | 'top';

// chirality swap for any horizontal mirror: left/right swap, straight unchanged. applied under flip-x and flip-z regardless of facing.
const STAIR_SHAPE_FLIP: Record<StairShape, StairShape> = {
    straight: 'straight',
    inner_left: 'inner_right',
    inner_right: 'inner_left',
    outer_left: 'outer_right',
    outer_right: 'outer_left',
};

// y=0.5..1 boxes for the bottom-half stair facing=north. base + perm.
function stairUpperBoxes(shape: StairShape): [number, number, number, number, number, number][] {
    switch (shape) {
        case 'straight':
            return [[0, 0.5, 0.5, 1, 1, 1]];
        case 'outer_left':
            return [[0, 0.5, 0.5, 0.5, 1, 1]]; // back-west quarter
        case 'outer_right':
            return [[0.5, 0.5, 0.5, 1, 1, 1]]; // back-east quarter
        case 'inner_left':
            return [
                [0, 0.5, 0.5, 1, 1, 1],
                [0, 0.5, 0, 0.5, 1, 0.5], // + front-west quarter
            ];
        case 'inner_right':
            return [
                [0, 0.5, 0.5, 1, 1, 1],
                [0.5, 0.5, 0, 1, 1, 0.5], // + front-east quarter
            ];
    }
}

// exposed top-of-slab regions (y=0.5) for the bottom-half facing=north.
function stairExposedTopRects(shape: StairShape): [number, number, number, number][] {
    switch (shape) {
        case 'straight':
            return [[0, 0, 1, 0.5]];
        case 'outer_left':
            return [
                [0, 0, 1, 0.5],
                [0.5, 0.5, 1, 1],
            ];
        case 'outer_right':
            return [
                [0, 0, 1, 0.5],
                [0, 0.5, 0.5, 1],
            ];
        case 'inner_left':
            return [[0.5, 0, 1, 0.5]];
        case 'inner_right':
            return [[0, 0, 0.5, 0.5]];
    }
}

function reflectAabbY(b: [number, number, number, number, number, number]): [number, number, number, number, number, number] {
    return [b[0], 1 - b[4], b[2], b[3], 1 - b[1], b[5]];
}

function reflectQuadsY(quads: BlockQuad[]): BlockQuad[] {
    return quads.map((q) => {
        // y-reflect each vertex, reverse winding to keep CCW after reflection.
        const rv = (i: number): [number, number, number] => [q.verts[i][0], 1 - q.verts[i][1], q.verts[i][2]];
        const cf = q.cullFace === 'up' ? 'down' : q.cullFace === 'down' ? 'up' : q.cullFace;
        return {
            verts: [rv(3), rv(2), rv(1), rv(0)],
            normal: [q.normal[0], -q.normal[1], q.normal[2]],
            tile: q.tile,
            uvs: q.uvs ? [q.uvs[3], q.uvs[2], q.uvs[1], q.uvs[0]] : undefined,
            cullFace: cf,
            material: q.material,
        };
    });
}

function pickTopTile(tiles: CubeTiles): TileHandle {
    return faceTile('all' in tiles ? tiles.all : tiles.top);
}

function stairBoxes(p: { half: StairHalf; shape: StairShape }) {
    const lower: [number, number, number, number, number, number] = [0, 0, 0, 1, 0.5, 1];
    const boxes = [lower, ...stairUpperBoxes(p.shape)];
    return p.half === 'top' ? boxes.map(reflectAabbY) : boxes;
}

function stairQuads(tiles: CubeTiles, topTex: TileHandle, p: { half: StairHalf; shape: StairShape }): BlockQuad[] {
    const quads: BlockQuad[] = [
        // bottom slab (top face emitted separately as exposed quads); local uvs sample the world-footprint sub-rect at 1:1 texel density.
        ...blockModel.box([0, 0, 0], [1, 0.5, 1], tiles, { exclude: ['up'], uvs: 'local' }),
    ];
    for (const b of stairUpperBoxes(p.shape)) {
        // upper step boxes rest on the slab top, exclude their down face.
        quads.push(...blockModel.box([b[0], b[1], b[2]], [b[3], b[4], b[5]], tiles, { exclude: ['down'], uvs: 'local' }));
    }
    for (const r of stairExposedTopRects(p.shape)) {
        // top quad on the part of the slab that isn't covered by a step box.
        quads.push(
            blockModel.quad(
                [
                    [r[0], 0.5, r[3]],
                    [r[2], 0.5, r[3]],
                    [r[2], 0.5, r[1]],
                    [r[0], 0.5, r[1]],
                ],
                [0, 1, 0],
                topTex,
            ),
        );
    }
    return p.half === 'top' ? reflectQuadsY(quads) : quads;
}

// read same-typed stair neighbour at (wx,wy,wz) with matching half.
function readStairAt(
    voxels: import('./voxels').Voxels,
    handle: BlockHandle<typeof StairState.props>,
    wx: number,
    wy: number,
    wz: number,
    matchHalf: StairHalf,
): Facing4 | null {
    const id = getBlockState(voxels, wx, wy, wz);
    if (id === AIR) return null;
    if (voxels.registry.stateToBlockIndex[id] !== handle._index) return null;
    const local = voxels.registry.stateToLocalIndex[id]!;
    const props = handle.def.states.decode(local);
    if (props.half !== matchHalf) return null;
    return props.facing as Facing4;
}

/*#__NO_SIDE_EFFECTS__*/
export function stairs(id: string, { tiles: tilesInput, ...options }: StairsPresetOptions) {
    const tiles = resolveCubeTiles(tilesInput);
    const topTex = pickTopTile(tiles);
    let handle: BlockHandle<typeof StairState.props>;
    handle = block(id, {
        ...options,
        material: options?.material ?? MaterialType.OPAQUE,
        states: StairState,
        defaultState: { facing: 'south', half: 'bottom', shape: 'straight' },
        shape: (p) => blockShape.rotateY(blockShape.aabbs(stairBoxes(p)), (4 - FACING4_STEPS[p.facing]) % 4),
        model: (p) => ({
            type: 'custom' as const,
            quads: blockModel.rotateY(stairQuads(tiles, topTex, p), (4 - FACING4_STEPS[p.facing]) % 4, { uvlock: true }),
        }),
        cull: CullType.PARTIAL,
        place: (ctx, io) => {
            // shape stays 'straight', onNeighbourUpdate re-derives corners post-placement.
            io.set(
                ctx.worldX,
                ctx.worldY,
                ctx.worldZ,
                handle.stateKey({
                    facing: facing4FromPlaceCtx(ctx),
                    half: halfFromPlaceCtx(ctx),
                    shape: 'straight',
                }),
            );
        },
        onNeighbourUpdate(ctx) {
            const me = handle.def.states.decode(ctx.voxels.registry.stateToLocalIndex[ctx.stateId]!);
            const f = me.facing as Facing4;
            const h = me.half as StairHalf;
            const cw = FACING4_ORDER[(FACING4_STEPS[f] + 1) % 4]!;
            const ccw = FACING4_ORDER[(FACING4_STEPS[f] + 3) % 4]!;

            // world-direction the stair faces, same direction the low/front step points (toward the placer).
            const dir = (
                {
                    north: [0, -1],
                    east: [1, 0],
                    south: [0, 1],
                    west: [-1, 0],
                } as const
            )[f];

            // back neighbour (beyond the high step): a perpendicular stair there continues the raised strip around a convex corner (outer), checked first so outer wins when both back and front neighbours are present.
            const back = readStairAt(ctx.voxels, handle, ctx.worldX - dir[0], ctx.worldY, ctx.worldZ - dir[1], h);
            if (back === cw) return handle.stateId({ facing: f, half: h, shape: 'outer_left' });
            if (back === ccw) return handle.stateId({ facing: f, half: h, shape: 'outer_right' });

            // front neighbour (beyond the low step): a perpendicular stair there sits in the concave nook (inner).
            const front = readStairAt(ctx.voxels, handle, ctx.worldX + dir[0], ctx.worldY, ctx.worldZ + dir[1], h);
            if (front === cw) return handle.stateId({ facing: f, half: h, shape: 'inner_left' });
            if (front === ccw) return handle.stateId({ facing: f, half: h, shape: 'inner_right' });

            return handle.stateId({ facing: f, half: h, shape: 'straight' });
        },
        rotate: (stateId, axis, cw) => {
            // sideways stair has no valid state, only Y rotation maps cleanly.
            if (axis !== 'y') return stateId;
            const p = handle.def.states.decode(stateId - handle._baseStateId);
            return handle.stateId({
                facing: rotateFacing4(p.facing as Facing4, cw),
                half: p.half,
                shape: p.shape,
            });
        },
        flip: (stateId, axis) => {
            const p = handle.def.states.decode(stateId - handle._baseStateId);
            const f = p.facing as Facing4;
            const h = p.half as StairHalf;
            const s = p.shape as StairShape;
            if (axis === 'y') {
                return handle.stateId({ facing: f, half: h === 'top' ? 'bottom' : 'top', shape: s });
            }
            // X/Z mirror: chirality always swaps; facing flips iff it has a component along the mirror axis.
            const table = axis === 'x' ? FACING4_FLIP_X : FACING4_FLIP_Z;
            return handle.stateId({ facing: table[f], half: h, shape: STAIR_SHAPE_FLIP[s] });
        },
    });
    return handle;
}

// `half` picks the slab's vertical placement: bottom, top, or double (full cube, two slabs merged, SOLID so adjacent doubles cull each other; the half slabs are PARTIAL).
const SlabState = blockState.create({
    half: blockState.enumeration(['bottom', 'top', 'double'] as const),
});

const SLAB_BOTTOM_SHAPE = blockShape.aabbs([[0, 0, 0, 1, 0.5, 1]]);
const SLAB_TOP_SHAPE = blockShape.aabbs([[0, 0.5, 0, 1, 1, 1]]);

/*#__NO_SIDE_EFFECTS__*/
export function slab(id: string, { tiles: tilesInput, ...options }: SlabPresetOptions) {
    const tiles = resolveCubeTiles(tilesInput);
    let handle: BlockHandle<typeof SlabState.props>;
    handle = block(id, {
        ...options,
        material: options?.material ?? MaterialType.OPAQUE,
        states: SlabState,
        shape: (p) => {
            if (p.half === 'double') return blockShape.cube();
            return p.half === 'top' ? SLAB_TOP_SHAPE : SLAB_BOTTOM_SHAPE;
        },
        model: (p) => {
            if (p.half === 'double') return { type: 'cube' as const, tiles };
            const from: [number, number, number] = p.half === 'top' ? [0, 0.5, 0] : [0, 0, 0];
            const to: [number, number, number] = p.half === 'top' ? [1, 1, 1] : [1, 0.5, 1];
            return { type: 'custom' as const, quads: blockModel.box(from, to, tiles) };
        },
        cull: (p) => (p.half === 'double' ? CullType.SOLID : CullType.PARTIAL),
        place: (ctx, io) => io.set(ctx.worldX, ctx.worldY, ctx.worldZ, handle.stateKey({ half: halfFromPlaceCtx(ctx) })),
        // rotate is identity (half/double are axis-aligned).
        flip: (stateId, axis) => {
            if (axis !== 'y') return stateId;
            const p = handle.def.states.decode(stateId - handle._baseStateId);
            if (p.half === 'double') return stateId;
            return handle.stateId({ half: p.half === 'top' ? 'bottom' : 'top' });
        },
    });
    return handle;
}

// two diagonal planes, an `x` seen from above (flowers, grass, saplings); several tiles become one custom model each, and the mesher's position hash picks between them for texture variants per position.

// the selection box: a 12x13x12 box centred in the cell, so a ray past the plant's edge reaches the ground it stands on; height caps at the cell whatever the planes do.
const CROSS_SHAPE = blockShape.aabbs([[2 / 16, 0, 2 / 16, 14 / 16, 13 / 16, 14 / 16]]);

/*#__NO_SIDE_EFFECTS__*/
export function cross(id: string, { tiles, height, tileBlocks, shape, ...options }: CrossPresetOptions) {
    const variants = Array.isArray(tiles) ? (tiles as readonly TileHandle[]) : [tiles as TileHandle];
    return block(id, {
        ...options,
        shape: shape ?? CROSS_SHAPE,
        model: () => {
            const models = variants.map((tile) => ({
                type: 'custom' as const,
                quads: blockModel.cross(tile, { height, tileBlocks }),
            }));
            return models.length === 1 ? models[0]! : models;
        },
        cull: CullType.SELF,
        collision: false,
        lightOpacity: 0, // sparse cross-quads don't filter light; CullType.SELF would otherwise default opacity to 1
        material: options?.material ?? MaterialType.TRANSPARENT,
        vertexAnimation: VertexAnimation.PLANT_WIND_SWAY,
    });
}

// a cutout cube, optionally with overhanging foliage planes. SELF drops the cube faces shared by two adjacent leaf blocks, so only the canopy shell draws; `fluff` adds four crossed, unshaded, leaning planes per block, uncullable because they overhang their cell in both directions.

/*#__NO_SIDE_EFFECTS__*/
export function leaves(id: string, { tiles: tilesInput, fluff, varyRotation, ...options }: LeavesPresetOptions) {
    const tiles = resolveCubeTiles(tilesInput);
    const rotations = varyRotation ? [0, 1, 2, 3] : [0];
    return block(id, {
        ...options,
        model: () => {
            // plain cube when neither option is on, so the mesher's cube fast path still applies.
            if (!fluff && !varyRotation) return { type: 'cube' as const, tiles };
            const cube = blockModel.box([0, 0, 0], [1, 1, 1], tiles);
            const models = rotations.map((steps) => {
                const lean = steps % 2 === 0 ? blockModel.FLUFF_LEAN_DEG : -blockModel.FLUFF_LEAN_DEG;
                const quads = [...cube, ...(fluff ? blockModel.fluff(fluff, { lean }) : [])];
                return { type: 'custom' as const, quads: blockModel.rotateY(quads, steps) };
            });
            return models.length === 1 ? models[0]! : models;
        },
        cull: CullType.SELF,
        material: options?.material ?? MaterialType.TRANSPARENT,
        vertexAnimation: VertexAnimation.WAVE,
    });
}

// thin wall-mounted panel: a single textured quad backed against one wall, climbable, no collision so the character can occupy the cell. shape is kept anyway so selection only hits the panel, not the empty volume in front of it.
const LADDER_DEPTH = 1 / 16;

const LADDER_SHAPE = blockShape.aabbs([[0, 0, 1 - LADDER_DEPTH, 1, 1, 1]]);

const LadderFacingState = blockState.create({
    facing: blockState.enumeration(['north', 'east', 'south', 'west'] as const),
});

/*#__NO_SIDE_EFFECTS__*/
export function ladder(id: string, { tiles: tile, ...options }: LadderPresetOptions) {
    let handle: BlockHandle<typeof LadderFacingState.props>;
    handle = block(id, {
        ...options,
        material: options?.material ?? MaterialType.TRANSPARENT,
        states: LadderFacingState,
        // base panel sits at +Z facing -Z (texture normal points north); rotated by (4 - FACING4_STEPS[facing]) % 4, the CW-sense complement of rotateY's CCW steps.
        defaultState: { facing: 'south' },
        shape: (p) => blockShape.rotateY(LADDER_SHAPE, (4 - FACING4_STEPS[p.facing]) % 4),
        model: (p) => {
            const z = 1 - LADDER_DEPTH;
            // -Z-facing quad, matching the winding box() uses for its 'north' face so default UVs orient correctly.
            const quads = [
                blockModel.quad(
                    [
                        [1, 0, z],
                        [0, 0, z],
                        [0, 1, z],
                        [1, 1, z],
                    ],
                    [0, 0, -1],
                    tile,
                ),
            ];
            return {
                type: 'custom' as const,
                quads: blockModel.rotateY(quads, (4 - FACING4_STEPS[p.facing]) % 4),
            };
        },
        cull: CullType.PARTIAL,
        collision: false,
        climbable: true,
        place: (ctx, io) => io.set(ctx.worldX, ctx.worldY, ctx.worldZ, handle.stateKey({ facing: facing4FromPlaceCtx(ctx) })),
        rotate: (stateId, axis, cw) => {
            if (axis !== 'y') return stateId;
            const p = handle.def.states.decode(stateId - handle._baseStateId);
            return handle.stateId({ facing: rotateFacing4(p.facing as Facing4, cw) });
        },
        flip: (stateId, axis) => {
            if (axis === 'y') return stateId;
            const p = handle.def.states.decode(stateId - handle._baseStateId);
            const table = axis === 'x' ? FACING4_FLIP_X : FACING4_FLIP_Z;
            return handle.stateId({ facing: table[p.facing as Facing4] });
        },
    });
    return handle;
}

// reasonable starting tints for the two canonical liquids; callers can override via `tint` on `liquid()`.
export const WATER_DEFAULT_TINT: ScreenTintSpec = { color: [0.04, 0.1, 0.2], opacity: 0.3 };
export const LAVA_DEFAULT_TINT: ScreenTintSpec = { color: [1.0, 0.35, 0.05], opacity: 0.75 };

// MODEL_LIQUID block: character swims instead of colliding, mesher clips top/side quads to `surfaceHeight`. `translucent: true` gives water-style rendering; `levels` (default 1) introduces a `level` int prop (1..levels) for discrete surface heights; `fluidGroup` (default = block id) tags this liquid for same-fluid face culling.
export type LiquidHandle = BlockHandle & {
    /** state key for a specific level (1..levels). returns the default for stateless liquids. */
    level(n: number): string;
    /** state key for the highest level (full surface height). */
    max(): string;
};

/*#__NO_SIDE_EFFECTS__*/
export function liquid(id: string, { tiles: tilesInput, ...options }: LiquidPresetOptions): LiquidHandle {
    const tiles = resolveCubeTiles(tilesInput);
    const levels = Math.max(1, options?.levels ?? 1);
    const translucent = options?.translucent === true;
    const group = options?.fluidGroup ?? id;
    const maxHeight = options?.maxHeight ?? 1;
    const emission = options?.lightEmission;

    const baseConfig = {
        name: options?.name,
        tags: options?.tags,
        model: () => ({ type: 'cube' as const, tiles }),
        cull: translucent ? CullType.SELF : CullType.SOLID,
        material: translucent ? MaterialType.TRANSLUCENT : MaterialType.OPAQUE,
        collision: false,
        liquid: { viscosity: options?.viscosity ?? 1 },
        fluidGroup: group,
        screenTint: options?.tint,
        sounds: options?.sounds,
        emissive: options?.emissive,
        lightEmission: emission ? () => emission : undefined,
    } as const;

    if (levels === 1) {
        const handle = block(id, { ...baseConfig, surfaceHeight: maxHeight });
        const liquidHandle = handle as LiquidHandle;
        liquidHandle.level = () => handle.defaultKey();
        liquidHandle.max = () => handle.defaultKey();
        return liquidHandle;
    }

    const LevelState = blockState.create({ level: blockState.int(1, levels) });

    const handle = block(id, {
        ...baseConfig,
        states: LevelState,
        defaultState: { level: levels },
        surfaceHeight: (p) => (p.level / levels) * maxHeight,
    });

    const liquidHandle = handle as unknown as LiquidHandle;
    liquidHandle.level = (n: number) => handle.stateKey({ level: n });
    liquidHandle.max = () => handle.stateKey({ level: levels });
    return liquidHandle;
}

// 4-arm fence: a 4/16-wide post with up to 4 arms (top + bottom rail per side) connecting to any solid neighbour; connectivity is recomputed by onNeighbourUpdate every time a neighbour changes.
const FenceState = blockState.create({
    north: blockState.bool(),
    east: blockState.bool(),
    south: blockState.bool(),
    west: blockState.bool(),
});

// strides captured once so fence/pane onNeighbourUpdate can inline-encode the local state index without a props object.
const FENCE_STRIDE_NORTH = FenceState.stride('north');
const FENCE_STRIDE_EAST = FenceState.stride('east');
const FENCE_STRIDE_SOUTH = FenceState.stride('south');
const FENCE_STRIDE_WEST = FenceState.stride('west');

// collider is taller than the visual model (top = 1.25) so players can't hop over fences; straight runs collapse to a single strip so the player doesn't catch on a post bulge.
const FENCE_PHYSICS_TOP = 1.25;

function fenceShape(p: { north: boolean; east: boolean; south: boolean; west: boolean }) {
    const top = FENCE_PHYSICS_TOP;
    const ns = p.north && p.south;
    const ew = p.east && p.west;
    const boxes: [number, number, number, number, number, number][] = [];

    if (ns) {
        boxes.push([6 / 16, 0, 0, 10 / 16, top, 1]);
    } else {
        if (p.north) boxes.push([7 / 16, 0, 0, 9 / 16, top, 6 / 16]);
        if (p.south) boxes.push([7 / 16, 0, 10 / 16, 9 / 16, top, 1]);
    }

    if (ew) {
        boxes.push([0, 0, 6 / 16, 1, top, 10 / 16]);
    } else {
        if (p.east) boxes.push([10 / 16, 0, 7 / 16, 1, top, 9 / 16]);
        if (p.west) boxes.push([0, 0, 7 / 16, 6 / 16, top, 9 / 16]);
    }

    // post stands alone when neither axis is a straight pass-through; straight runs already cover the post extent with the wider strip.
    if (!ns && !ew) {
        boxes.push([6 / 16, 0, 6 / 16, 10 / 16, top, 10 / 16]);
    }

    return blockShape.aabbs(boxes);
}

function fenceArmQuads(tiles: CubeTiles, side: 'north' | 'south' | 'east' | 'west'): BlockQuad[] {
    // two thin rails per arm (top + bottom), 2/16 wide x 3/16 tall, local UVs so the texture isn't stretched.
    const quads: BlockQuad[] = [];
    const rail = (from: [number, number, number], to: [number, number, number]) =>
        blockModel.box(from, to, tiles, { uvs: 'local' });
    if (side === 'north') {
        quads.push(...rail([7 / 16, 12 / 16, 0], [9 / 16, 15 / 16, 6 / 16]));
        quads.push(...rail([7 / 16, 6 / 16, 0], [9 / 16, 9 / 16, 6 / 16]));
    } else if (side === 'south') {
        quads.push(...rail([7 / 16, 12 / 16, 10 / 16], [9 / 16, 15 / 16, 1]));
        quads.push(...rail([7 / 16, 6 / 16, 10 / 16], [9 / 16, 9 / 16, 1]));
    } else if (side === 'east') {
        quads.push(...rail([10 / 16, 12 / 16, 7 / 16], [1, 15 / 16, 9 / 16]));
        quads.push(...rail([10 / 16, 6 / 16, 7 / 16], [1, 9 / 16, 9 / 16]));
    } else {
        quads.push(...rail([0, 12 / 16, 7 / 16], [6 / 16, 15 / 16, 9 / 16]));
        quads.push(...rail([0, 6 / 16, 7 / 16], [6 / 16, 9 / 16, 9 / 16]));
    }
    return quads;
}

// connectivity check shared by fence/wall/pane: neighbour is a full solid cube or carries the same group flag (avoids the "fence-arm stuck into a slab" look any-collision matching produces).
function hasGroupConnection(voxels: import('./voxels').Voxels, wx: number, wy: number, wz: number, groupFlag: number): boolean {
    const id = getBlockState(voxels, wx, wy, wz);
    if (id === AIR) return false;
    if (voxels.registry.cull[id]! === CullType.SOLID) return true;
    return (voxels.registry.flags[id]! & groupFlag) !== 0;
}

/*#__NO_SIDE_EFFECTS__*/
export function fence(id: string, { tiles: tilesInput, ...options }: FencePresetOptions) {
    const tiles = resolveCubeTiles(tilesInput);
    let handle: BlockHandle<typeof FenceState.props>;
    handle = block(id, {
        ...options,
        material: options?.material ?? MaterialType.OPAQUE,
        states: FenceState,
        defaultState: { north: true, south: true, east: true, west: true },
        shape: (p) => fenceShape(p),
        model: (p) => {
            const quads = [...blockModel.box([6 / 16, 0, 6 / 16], [10 / 16, 1, 10 / 16], tiles, { uvs: 'local' })];
            if (p.north) quads.push(...fenceArmQuads(tiles, 'north'));
            if (p.south) quads.push(...fenceArmQuads(tiles, 'south'));
            if (p.east) quads.push(...fenceArmQuads(tiles, 'east'));
            if (p.west) quads.push(...fenceArmQuads(tiles, 'west'));
            return { type: 'custom' as const, quads };
        },
        cull: CullType.PARTIAL,
        flags: BLOCK_FLAG_FENCE,
        onNeighbourUpdate(ctx) {
            const north = hasGroupConnection(ctx.voxels, ctx.worldX, ctx.worldY, ctx.worldZ - 1, BLOCK_FLAG_FENCE);
            const south = hasGroupConnection(ctx.voxels, ctx.worldX, ctx.worldY, ctx.worldZ + 1, BLOCK_FLAG_FENCE);
            const east = hasGroupConnection(ctx.voxels, ctx.worldX + 1, ctx.worldY, ctx.worldZ, BLOCK_FLAG_FENCE);
            const west = hasGroupConnection(ctx.voxels, ctx.worldX - 1, ctx.worldY, ctx.worldZ, BLOCK_FLAG_FENCE);
            return handle.stateIdLocal(
                (north ? FENCE_STRIDE_NORTH : 0) +
                    (east ? FENCE_STRIDE_EAST : 0) +
                    (south ? FENCE_STRIDE_SOUTH : 0) +
                    (west ? FENCE_STRIDE_WEST : 0),
            );
        },
        rotate: (stateId, axis, cw) => {
            if (axis !== 'y') return stateId;
            const p = handle.def.states.decode(stateId - handle._baseStateId);
            // new bool at direction D' = old bool at the direction that rotates to D' (rotateFacing4(D', !cw)).
            return cw
                ? handle.stateId({ north: p.east, east: p.south, south: p.west, west: p.north })
                : handle.stateId({ north: p.west, east: p.north, south: p.east, west: p.south });
        },
        flip: (stateId, axis) => {
            if (axis === 'y') return stateId;
            const p = handle.def.states.decode(stateId - handle._baseStateId);
            if (axis === 'x') return handle.stateId({ north: p.north, south: p.south, east: p.west, west: p.east });
            return handle.stateId({ east: p.east, west: p.west, north: p.south, south: p.north });
        },
    });
    return handle;
}

// thin 4-way panel (glass pane / iron bars): 2/16-thick central post + 2/16-thick full-height arms.
const PaneState = FenceState;

function paneShape(p: { north: boolean; east: boolean; south: boolean; west: boolean }) {
    const boxes: [number, number, number, number, number, number][] = [
        [7 / 16, 0, 7 / 16, 9 / 16, 1, 9 / 16], // central post
    ];
    if (p.north) boxes.push([7 / 16, 0, 0, 9 / 16, 1, 7 / 16]);
    if (p.south) boxes.push([7 / 16, 0, 9 / 16, 9 / 16, 1, 1]);
    if (p.east) boxes.push([9 / 16, 0, 7 / 16, 1, 1, 9 / 16]);
    if (p.west) boxes.push([0, 0, 7 / 16, 7 / 16, 1, 9 / 16]);
    return blockShape.aabbs(boxes);
}

/*#__NO_SIDE_EFFECTS__*/
export function pane(id: string, { tiles: tilesInput, ...options }: PanePresetOptions) {
    const tiles = resolveCubeTiles(tilesInput);
    let handle: BlockHandle<typeof PaneState.props>;
    handle = block(id, {
        ...options,
        states: PaneState,
        defaultState: { north: true, south: true, east: true, west: true },
        material: options?.material ?? MaterialType.TRANSPARENT,
        shape: (p) => paneShape(p),
        model: (p) => {
            const quads = [...blockModel.box([7 / 16, 0, 7 / 16], [9 / 16, 1, 9 / 16], tiles, { uvs: 'local' })];
            if (p.north) quads.push(...blockModel.box([7 / 16, 0, 0], [9 / 16, 1, 7 / 16], tiles, { uvs: 'local' }));
            if (p.south) quads.push(...blockModel.box([7 / 16, 0, 9 / 16], [9 / 16, 1, 1], tiles, { uvs: 'local' }));
            if (p.east) quads.push(...blockModel.box([9 / 16, 0, 7 / 16], [1, 1, 9 / 16], tiles, { uvs: 'local' }));
            if (p.west) quads.push(...blockModel.box([0, 0, 7 / 16], [7 / 16, 1, 9 / 16], tiles, { uvs: 'local' }));
            return { type: 'custom' as const, quads };
        },
        cull: CullType.PARTIAL,
        flags: BLOCK_FLAG_PANE,
        onNeighbourUpdate(ctx) {
            const north = hasGroupConnection(ctx.voxels, ctx.worldX, ctx.worldY, ctx.worldZ - 1, BLOCK_FLAG_PANE);
            const south = hasGroupConnection(ctx.voxels, ctx.worldX, ctx.worldY, ctx.worldZ + 1, BLOCK_FLAG_PANE);
            const east = hasGroupConnection(ctx.voxels, ctx.worldX + 1, ctx.worldY, ctx.worldZ, BLOCK_FLAG_PANE);
            const west = hasGroupConnection(ctx.voxels, ctx.worldX - 1, ctx.worldY, ctx.worldZ, BLOCK_FLAG_PANE);
            // PaneState aliases FenceState, same strides apply.
            return handle.stateIdLocal(
                (north ? FENCE_STRIDE_NORTH : 0) +
                    (east ? FENCE_STRIDE_EAST : 0) +
                    (south ? FENCE_STRIDE_SOUTH : 0) +
                    (west ? FENCE_STRIDE_WEST : 0),
            );
        },
        rotate: (stateId, axis, cw) => {
            if (axis !== 'y') return stateId;
            const p = handle.def.states.decode(stateId - handle._baseStateId);
            return cw
                ? handle.stateId({ north: p.east, east: p.south, south: p.west, west: p.north })
                : handle.stateId({ north: p.west, east: p.north, south: p.east, west: p.south });
        },
        flip: (stateId, axis) => {
            if (axis === 'y') return stateId;
            const p = handle.def.states.decode(stateId - handle._baseStateId);
            if (axis === 'x') return handle.stateId({ north: p.north, south: p.south, east: p.west, west: p.east });
            return handle.stateId({ east: p.east, west: p.west, north: p.south, south: p.north });
        },
    });
    return handle;
}

// thin 1/16 layer sitting on the bottom of the cube; no state, no neighbour-awareness.
const CARPET_SHAPE = blockShape.aabbs([[0, 0, 0, 1, 1 / 16, 1]]);

/*#__NO_SIDE_EFFECTS__*/
export function carpet(id: string, { tiles: tilesInput, ...options }: CarpetPresetOptions) {
    const tiles = resolveCubeTiles(tilesInput);
    return block(id, {
        ...options,
        material: options?.material ?? MaterialType.OPAQUE,
        shape: CARPET_SHAPE,
        model: () => ({
            type: 'custom' as const,
            quads: blockModel.box([0, 0, 0], [1, 1 / 16, 1], tiles),
        }),
        cull: CullType.PARTIAL,
    });
}

// a cutout layer lying on the ground (leaf litter, petals): one up-facing quad a hair above the cell floor (never coplanar with the block below's top face), no thickness, no collision, PARTIAL with no cullFace.
const LITTER_HEIGHT = 1 / 32;
const LITTER_SHAPE = blockShape.aabbs([[0, 0, 0, 1, LITTER_HEIGHT, 1]]);

/*#__NO_SIDE_EFFECTS__*/
export function litter(id: string, { tiles, varyRotation = true, ...options }: LitterPresetOptions) {
    const variants = Array.isArray(tiles) ? (tiles as readonly TileHandle[]) : [tiles as TileHandle];
    const rotations = varyRotation ? [0, 1, 2, 3] : [0];
    return block(id, {
        ...options,
        shape: LITTER_SHAPE,
        model: () => {
            const models = variants.flatMap((tile) =>
                rotations.map((steps) => ({
                    type: 'custom' as const,
                    quads: blockModel.rotateY(blockModel.layer(tile, LITTER_HEIGHT), steps),
                })),
            );
            return models.length === 1 ? models[0]! : models;
        },
        cull: CullType.PARTIAL,
        collision: false,
        lightOpacity: 0,
        material: options?.material ?? MaterialType.TRANSPARENT,
    });
}

// independent hinged panel: `facing` is the wall it swings against when open, `half` is which side of the cube the hinge sits on (closed slab at bottom or top), `open` flips it from horizontal slab to vertical panel against the wall.
const TRAPDOOR_DEPTH = 3 / 16;

const TrapdoorState = blockState.create({
    facing: blockState.enumeration(['north', 'east', 'south', 'west'] as const),
    half: blockState.enumeration(['bottom', 'top'] as const),
    open: blockState.bool(),
});

function trapdoorShape(p: { facing: 'north' | 'east' | 'south' | 'west'; half: 'bottom' | 'top'; open: boolean }) {
    if (!p.open) {
        // closed: thin horizontal slab pinned to the half
        if (p.half === 'bottom') return blockShape.aabbs([[0, 0, 0, 1, TRAPDOOR_DEPTH, 1]]);
        return blockShape.aabbs([[0, 1 - TRAPDOOR_DEPTH, 0, 1, 1, 1]]);
    }
    // open: thin vertical panel against the facing wall
    switch (p.facing) {
        case 'north':
            return blockShape.aabbs([[0, 0, 0, 1, 1, TRAPDOOR_DEPTH]]);
        case 'south':
            return blockShape.aabbs([[0, 0, 1 - TRAPDOOR_DEPTH, 1, 1, 1]]);
        case 'east':
            return blockShape.aabbs([[1 - TRAPDOOR_DEPTH, 0, 0, 1, 1, 1]]);
        case 'west':
            return blockShape.aabbs([[0, 0, 0, TRAPDOOR_DEPTH, 1, 1]]);
    }
}

function trapdoorQuads(
    tiles: CubeTiles,
    p: { facing: 'north' | 'east' | 'south' | 'west'; half: 'bottom' | 'top'; open: boolean },
): BlockQuad[] {
    const opts = { uvs: 'local' as const };
    if (!p.open) {
        if (p.half === 'bottom') return blockModel.box([0, 0, 0], [1, TRAPDOOR_DEPTH, 1], tiles, opts);
        return blockModel.box([0, 1 - TRAPDOOR_DEPTH, 0], [1, 1, 1], tiles, opts);
    }
    switch (p.facing) {
        case 'north':
            return blockModel.box([0, 0, 0], [1, 1, TRAPDOOR_DEPTH], tiles, opts);
        case 'south':
            return blockModel.box([0, 0, 1 - TRAPDOOR_DEPTH], [1, 1, 1], tiles, opts);
        case 'east':
            return blockModel.box([1 - TRAPDOOR_DEPTH, 0, 0], [1, 1, 1], tiles, opts);
        case 'west':
            return blockModel.box([0, 0, 0], [TRAPDOOR_DEPTH, 1, 1], tiles, opts);
    }
}

/*#__NO_SIDE_EFFECTS__*/
export function trapdoor(id: string, { tiles: tilesInput, ...options }: TrapdoorPresetOptions) {
    const tiles = resolveCubeTiles(tilesInput);
    let handle: BlockHandle<typeof TrapdoorState.props>;
    handle = block(id, {
        ...options,
        material: options?.material ?? MaterialType.OPAQUE,
        states: TrapdoorState,
        shape: (p) => trapdoorShape(p),
        model: (p) => ({ type: 'custom' as const, quads: trapdoorQuads(tiles, p) }),
        cull: CullType.PARTIAL,
        // placement opens closed: half from where the player clicked, facing toward the placer; open toggles later via interaction.
        place: (ctx, io) =>
            io.set(
                ctx.worldX,
                ctx.worldY,
                ctx.worldZ,
                handle.stateKey({
                    facing: facing4FromPlaceCtx(ctx),
                    half: halfFromPlaceCtx(ctx),
                    open: false,
                }),
            ),
        rotate: (stateId, axis, cw) => {
            if (axis !== 'y') return stateId;
            const p = handle.def.states.decode(stateId - handle._baseStateId);
            return handle.stateId({
                facing: rotateFacing4(p.facing as Facing4, cw),
                half: p.half,
                open: p.open,
            });
        },
        flip: (stateId, axis) => {
            const p = handle.def.states.decode(stateId - handle._baseStateId);
            const f = p.facing as Facing4;
            if (axis === 'y') {
                return handle.stateId({
                    facing: f,
                    half: p.half === 'top' ? 'bottom' : 'top',
                    open: p.open,
                });
            }
            const table = axis === 'x' ? FACING4_FLIP_X : FACING4_FLIP_Z;
            return handle.stateId({ facing: table[f], half: p.half, open: p.open });
        },
    });
    return handle;
}

// pressure-plate-style pad, half-height when pressed, collision off; `pressed` is driven externally by entity-on-top detection.
const PLATE_INSET = 1 / 16;
const PLATE_HEIGHT_UP = 1 / 16;
const PLATE_HEIGHT_DOWN = 0.5 / 16;

const PlateState = blockState.create({
    pressed: blockState.bool(),
});

function plateShape(pressed: boolean) {
    const h = pressed ? PLATE_HEIGHT_DOWN : PLATE_HEIGHT_UP;
    return blockShape.aabbs([[PLATE_INSET, 0, PLATE_INSET, 1 - PLATE_INSET, h, 1 - PLATE_INSET]]);
}

/*#__NO_SIDE_EFFECTS__*/
export function plate(id: string, { tiles: tile, ...options }: PlatePresetOptions) {
    return block(id, {
        ...options,
        material: options?.material ?? MaterialType.OPAQUE,
        states: PlateState,
        shape: (p) => plateShape(p.pressed),
        model: (p) => {
            const h = p.pressed ? PLATE_HEIGHT_DOWN : PLATE_HEIGHT_UP;
            return {
                type: 'custom' as const,
                quads: blockModel.box(
                    [PLATE_INSET, 0, PLATE_INSET],
                    [1 - PLATE_INSET, h, 1 - PLATE_INSET],
                    { all: tile },
                    { uvs: 'local' },
                ),
            };
        },
        cull: CullType.PARTIAL,
        collision: false,
    });
}

// fence's stockier cousin: 8/16-wide post, 6/16-wide full-height arms. the post extends to y=1 (`up`) when the block above is solid or when the arms aren't a clean N+S or E+W straight pass-through.
const WallState = blockState.create({
    north: blockState.bool(),
    east: blockState.bool(),
    south: blockState.bool(),
    west: blockState.bool(),
    up: blockState.bool(),
});

const WALL_STRIDE_NORTH = WallState.stride('north');
const WALL_STRIDE_EAST = WallState.stride('east');
const WALL_STRIDE_SOUTH = WallState.stride('south');
const WALL_STRIDE_WEST = WallState.stride('west');
const WALL_STRIDE_UP = WallState.stride('up');

const WALL_POST_SHORT = 14 / 16;

function wallShape(p: { north: boolean; east: boolean; south: boolean; west: boolean; up: boolean }) {
    const postTop = p.up ? 1 : WALL_POST_SHORT;
    const boxes: [number, number, number, number, number, number][] = [
        [4 / 16, 0, 4 / 16, 12 / 16, postTop, 12 / 16], // post
    ];
    if (p.north) boxes.push([5 / 16, 0, 0, 11 / 16, WALL_POST_SHORT, 4 / 16]);
    if (p.south) boxes.push([5 / 16, 0, 12 / 16, 11 / 16, WALL_POST_SHORT, 1]);
    if (p.east) boxes.push([12 / 16, 0, 5 / 16, 1, WALL_POST_SHORT, 11 / 16]);
    if (p.west) boxes.push([0, 0, 5 / 16, 4 / 16, WALL_POST_SHORT, 11 / 16]);
    return blockShape.aabbs(boxes);
}

function wallQuads(
    tiles: CubeTiles,
    p: { north: boolean; east: boolean; south: boolean; west: boolean; up: boolean },
): BlockQuad[] {
    const opts = { uvs: 'local' as const };
    const postTop = p.up ? 1 : WALL_POST_SHORT;
    const quads = [...blockModel.box([4 / 16, 0, 4 / 16], [12 / 16, postTop, 12 / 16], tiles, opts)];
    if (p.north) quads.push(...blockModel.box([5 / 16, 0, 0], [11 / 16, WALL_POST_SHORT, 4 / 16], tiles, opts));
    if (p.south) quads.push(...blockModel.box([5 / 16, 0, 12 / 16], [11 / 16, WALL_POST_SHORT, 1], tiles, opts));
    if (p.east) quads.push(...blockModel.box([12 / 16, 0, 5 / 16], [1, WALL_POST_SHORT, 11 / 16], tiles, opts));
    if (p.west) quads.push(...blockModel.box([0, 0, 5 / 16], [4 / 16, WALL_POST_SHORT, 11 / 16], tiles, opts));
    return quads;
}

/*#__NO_SIDE_EFFECTS__*/
export function wall(id: string, { tiles: tilesInput, ...options }: WallPresetOptions) {
    const tiles = resolveCubeTiles(tilesInput);
    let handle: BlockHandle<typeof WallState.props>;
    handle = block(id, {
        ...options,
        material: options?.material ?? MaterialType.OPAQUE,
        states: WallState,
        defaultState: { north: true, south: true, east: true, west: true, up: true },
        shape: (p) => wallShape(p),
        model: (p) => ({ type: 'custom' as const, quads: wallQuads(tiles, p) }),
        cull: CullType.PARTIAL,
        flags: BLOCK_FLAG_WALL,
        onNeighbourUpdate(ctx) {
            const north = hasGroupConnection(ctx.voxels, ctx.worldX, ctx.worldY, ctx.worldZ - 1, BLOCK_FLAG_WALL);
            const south = hasGroupConnection(ctx.voxels, ctx.worldX, ctx.worldY, ctx.worldZ + 1, BLOCK_FLAG_WALL);
            const east = hasGroupConnection(ctx.voxels, ctx.worldX + 1, ctx.worldY, ctx.worldZ, BLOCK_FLAG_WALL);
            const west = hasGroupConnection(ctx.voxels, ctx.worldX - 1, ctx.worldY, ctx.worldZ, BLOCK_FLAG_WALL);
            // `up`: post extends full height when something rests on the wall or the arm layout isn't a clean straight pass.
            const above = getBlockState(ctx.voxels, ctx.worldX, ctx.worldY + 1, ctx.worldZ);
            const aboveSolid = above !== AIR && ctx.voxels.registry.cull[above]! === CullType.SOLID;
            const straightNS = north && south && !east && !west;
            const straightEW = east && west && !north && !south;
            const up = aboveSolid || !(straightNS || straightEW);
            return handle.stateIdLocal(
                (north ? WALL_STRIDE_NORTH : 0) +
                    (east ? WALL_STRIDE_EAST : 0) +
                    (south ? WALL_STRIDE_SOUTH : 0) +
                    (west ? WALL_STRIDE_WEST : 0) +
                    (up ? WALL_STRIDE_UP : 0),
            );
        },
        rotate: (stateId, axis, cw) => {
            if (axis !== 'y') return stateId;
            const p = handle.def.states.decode(stateId - handle._baseStateId);
            return cw
                ? handle.stateId({ north: p.east, east: p.south, south: p.west, west: p.north, up: p.up })
                : handle.stateId({ north: p.west, east: p.north, south: p.east, west: p.south, up: p.up });
        },
        flip: (stateId, axis) => {
            if (axis === 'y') return stateId;
            const p = handle.def.states.decode(stateId - handle._baseStateId);
            if (axis === 'x') return handle.stateId({ north: p.north, south: p.south, east: p.west, west: p.east, up: p.up });
            return handle.stateId({ east: p.east, west: p.west, north: p.south, south: p.north, up: p.up });
        },
    });
    return handle;
}

// floor or wall-mounted torch; `mount` is 'floor' or a cardinal wall. onNeighbourUpdate prefers floor when the block below is solid, else the first solid horizontal neighbour; with no support the torch keeps its orientation (floating).
const TorchState = blockState.create({
    mount: blockState.enumeration(['floor', 'north', 'east', 'south', 'west'] as const),
});

// wall torches lean ~22 degrees off the wall; the selection AABBs below wrap the tilted post to cover the leaning tip.
const TORCH_FLOOR_SHAPE = blockShape.aabbs([[7 / 16, 0, 7 / 16, 9 / 16, 10 / 16, 9 / 16]]);
const TORCH_NORTH_SHAPE = blockShape.aabbs([[7 / 16, 2 / 16, 0, 9 / 16, 13 / 16, 6 / 16]]);
const TORCH_SOUTH_SHAPE = blockShape.aabbs([[7 / 16, 2 / 16, 10 / 16, 9 / 16, 13 / 16, 1]]);
const TORCH_EAST_SHAPE = blockShape.aabbs([[10 / 16, 2 / 16, 7 / 16, 1, 13 / 16, 9 / 16]]);
const TORCH_WEST_SHAPE = blockShape.aabbs([[0, 2 / 16, 7 / 16, 6 / 16, 13 / 16, 9 / 16]]);

function torchShape(mount: 'floor' | 'north' | 'east' | 'south' | 'west') {
    switch (mount) {
        case 'floor':
            return TORCH_FLOOR_SHAPE;
        case 'north':
            return TORCH_NORTH_SHAPE;
        case 'south':
            return TORCH_SOUTH_SHAPE;
        case 'east':
            return TORCH_EAST_SHAPE;
        case 'west':
            return TORCH_WEST_SHAPE;
    }
}

// wall torch geometry stays snapped to the 1/16 vertex lattice: instead of an off-grid rotateAxis lean, the post's top is sheared TORCH_WALL_LEAN outward over its height, a grid-aligned lean close to 22.5 degrees.
const TORCH_WALL_LIFT = 3 / 16; // how far up the wall the base sits
const TORCH_WALL_LEAN = 4 / 16;

// wall mounts rotate a single north-mounted base model around Y (the north torch leans toward +z).
const TORCH_WALL_STEPS = { north: 0, west: 1, south: 2, east: 3 } as const;

// the upright 2x10x2 stick, centred in the cell; up/down caps get explicit UVs (not local) so the bottom shows the dim stick base and the top the lit neck under the flame, instead of both sampling the bright texture-centre rows.
function torchPostQuads(tile: TileHandle): BlockQuad[] {
    const tex: CubeTiles = { all: tile };
    // cull:false, the post is free-standing, no face sits on a boundary.
    const sides = blockModel.box([7 / 16, 0, 7 / 16], [9 / 16, 10 / 16, 9 / 16], tex, {
        uvs: 'local',
        cull: false,
        exclude: ['up', 'down'],
    });
    const up = blockModel.quad(
        [
            [7 / 16, 10 / 16, 7 / 16],
            [7 / 16, 10 / 16, 9 / 16],
            [9 / 16, 10 / 16, 9 / 16],
            [9 / 16, 10 / 16, 7 / 16],
        ],
        [0, 1, 0],
        tile,
        {
            uvs: [
                [7 / 16, 6 / 16],
                [7 / 16, 8 / 16],
                [9 / 16, 8 / 16],
                [9 / 16, 6 / 16],
            ],
        },
    );
    const down = blockModel.quad(
        [
            [7 / 16, 0, 9 / 16],
            [7 / 16, 0, 7 / 16],
            [9 / 16, 0, 7 / 16],
            [9 / 16, 0, 9 / 16],
        ],
        [0, -1, 0],
        tile,
        {
            uvs: [
                [7 / 16, 15 / 16],
                [7 / 16, 13 / 16],
                [9 / 16, 13 / 16],
                [9 / 16, 15 / 16],
            ],
        },
    );
    return [...sides, up, down];
}

function torchQuads(tile: TileHandle, mount: 'floor' | 'north' | 'east' | 'south' | 'west'): BlockQuad[] {
    const post = torchPostQuads(tile);
    if (mount === 'floor') return post;
    // wall: shift the post to the wall, shear its top for a grid-aligned lean, lift it, then rotate to the mount.
    const atWall = blockModel.translate(post, [0, 0, -7 / 16]);
    const leaned = blockModel.shearByHeight(atWall, 'z', 0, 10 / 16, TORCH_WALL_LEAN);
    const lifted = blockModel.translate(leaned, [0, TORCH_WALL_LIFT, 0]);
    return blockModel.rotateY(lifted, TORCH_WALL_STEPS[mount]);
}

function isTorchSupport(voxels: Voxels, wx: number, wy: number, wz: number): boolean {
    const id = getBlockState(voxels, wx, wy, wz);
    if (id === AIR) return false;
    return (voxels.registry.flags[id]! & BLOCK_FLAG_COLLISION) !== 0;
}

type TorchMount = 'floor' | 'north' | 'east' | 'south' | 'west';

// order the torch re-homes through when its current support is removed.
const TORCH_MOUNTS: readonly TorchMount[] = ['floor', 'north', 'east', 'south', 'west'];

/** is the surface this mount attaches to solid? floor = the cell below, wall mounts = the neighbour in that direction. */
function torchMountSupported(voxels: Voxels, wx: number, wy: number, wz: number, mount: TorchMount): boolean {
    switch (mount) {
        case 'floor':
            return isTorchSupport(voxels, wx, wy - 1, wz);
        case 'north':
            return isTorchSupport(voxels, wx, wy, wz - 1);
        case 'east':
            return isTorchSupport(voxels, wx + 1, wy, wz);
        case 'south':
            return isTorchSupport(voxels, wx, wy, wz + 1);
        case 'west':
            return isTorchSupport(voxels, wx - 1, wy, wz);
    }
}

/** mount from the clicked face: a wall click attaches to that wall, a floor/ceiling click stands the torch up. */
function torchMountFromPlaceCtx(ctx: BlockPlaceCtx): TorchMount {
    const ax = Math.abs(ctx.normalX);
    const ay = Math.abs(ctx.normalY);
    const az = Math.abs(ctx.normalZ);
    if (ay >= ax && ay >= az) return 'floor';
    if (ax >= az) return ctx.normalX >= 0 ? 'west' : 'east';
    return ctx.normalZ >= 0 ? 'north' : 'south';
}

/*#__NO_SIDE_EFFECTS__*/
export function torch(id: string, { tiles: tile, ...options }: TorchPresetOptions) {
    let handle: BlockHandle<typeof TorchState.props>;
    handle = block(id, {
        ...options,
        material: options?.material ?? MaterialType.OPAQUE,
        states: TorchState,
        shape: (p) => torchShape(p.mount),
        model: (p) => ({ type: 'custom' as const, quads: torchQuads(tile, p.mount) }),
        cull: CullType.PARTIAL,
        collision: false,
        emissive: true,
        lightEmission: options?.lightEmission ?? [14, 12, 6],
        place: (ctx, io) => io.set(ctx.worldX, ctx.worldY, ctx.worldZ, handle.stateKey({ mount: torchMountFromPlaceCtx(ctx) })),
        onNeighbourUpdate(ctx) {
            const current = handle.def.states.decode(ctx.stateId - handle._baseStateId).mount as TorchMount;
            if (torchMountSupported(ctx.voxels, ctx.worldX, ctx.worldY, ctx.worldZ, current)) return ctx.stateId;
            for (const mount of TORCH_MOUNTS) {
                if (torchMountSupported(ctx.voxels, ctx.worldX, ctx.worldY, ctx.worldZ, mount)) {
                    return handle.stateId({ mount });
                }
            }
            return ctx.stateId;
        },
        rotate: (stateId, axis, cw) => {
            if (axis !== 'y') return stateId;
            const p = handle.def.states.decode(stateId - handle._baseStateId);
            if (p.mount === 'floor') return stateId;
            return handle.stateId({ mount: rotateFacing4(p.mount as Facing4, cw) });
        },
        flip: (stateId, axis) => {
            if (axis === 'y') return stateId;
            const p = handle.def.states.decode(stateId - handle._baseStateId);
            if (p.mount === 'floor') return stateId;
            const table = axis === 'x' ? FACING4_FLIP_X : FACING4_FLIP_Z;
            return handle.stateId({ mount: table[p.mount as Facing4] });
        },
    });
    return handle;
}

/** what a hanging block may hang from: a collidable block, or one flagged `BLOCK_FLAG_SUPPORTS_HANGING` (e.g. a chain). */
function supportsHanging(voxels: Voxels, wx: number, wy: number, wz: number): boolean {
    const id = getBlockState(voxels, wx, wy, wz);
    if (id === AIR) return false;
    return (voxels.registry.flags[id]! & (BLOCK_FLAG_COLLISION | BLOCK_FLAG_SUPPORTS_HANGING)) !== 0;
}

// a 3px link chain along an axis: two 3/16-wide planes the block tall, crossed at 45 degrees, `axis` set like a log so chains hang from ceilings and run along walls. a chain supports a hanging block below it.
const CHAIN_HALF = 1.5 / 16;
const CHAIN_SHAPE_Y = blockShape.aabbs([[0.5 - CHAIN_HALF, 0, 0.5 - CHAIN_HALF, 0.5 + CHAIN_HALF, 1, 0.5 + CHAIN_HALF]]);
const CHAIN_SHAPE_X = blockShape.aabbs([[0, 0.5 - CHAIN_HALF, 0.5 - CHAIN_HALF, 1, 0.5 + CHAIN_HALF, 0.5 + CHAIN_HALF]]);
const CHAIN_SHAPE_Z = blockShape.aabbs([[0.5 - CHAIN_HALF, 0.5 - CHAIN_HALF, 0, 0.5 + CHAIN_HALF, 0.5 + CHAIN_HALF, 1]]);
const CHAIN_STRIP_U = 3 / 16;

/** two crossed vertical planes from `y0` to `y1`, sampling the tile's left `CHAIN_STRIP_U` strip, swung 45 degrees so they never sit on a cell boundary. */
function chainLinkQuads(tile: TileHandle, y0: number, y1: number, v0: number, v1: number): BlockQuad[] {
    const lo = 0.5 - CHAIN_HALF;
    const hi = 0.5 + CHAIN_HALF;
    const front: [Vec2, Vec2, Vec2, Vec2] = [
        [0, v1],
        [CHAIN_STRIP_U, v1],
        [CHAIN_STRIP_U, v0],
        [0, v0],
    ];
    const back: [Vec2, Vec2, Vec2, Vec2] = [
        [0, v0],
        [CHAIN_STRIP_U, v0],
        [CHAIN_STRIP_U, v1],
        [0, v1],
    ];
    const opts = (uvs: [Vec2, Vec2, Vec2, Vec2]) => ({ uvs });
    const planes = [
        blockModel.quad(
            [
                [lo, y0, 0.5],
                [hi, y0, 0.5],
                [hi, y1, 0.5],
                [lo, y1, 0.5],
            ],
            [0, 0, 1],
            tile,
            opts(front),
        ),
        blockModel.quad(
            [
                [lo, y1, 0.5],
                [hi, y1, 0.5],
                [hi, y0, 0.5],
                [lo, y0, 0.5],
            ],
            [0, 0, -1],
            tile,
            opts(back),
        ),
        blockModel.quad(
            [
                [0.5, y0, hi],
                [0.5, y0, lo],
                [0.5, y1, lo],
                [0.5, y1, hi],
            ],
            [1, 0, 0],
            tile,
            opts(front),
        ),
        blockModel.quad(
            [
                [0.5, y1, hi],
                [0.5, y1, lo],
                [0.5, y0, lo],
                [0.5, y0, hi],
            ],
            [-1, 0, 0],
            tile,
            opts(back),
        ),
    ];
    return blockModel.rotateAxis(planes, 'y', 45, [0.5, 0.5, 0.5]);
}

/*#__NO_SIDE_EFFECTS__*/
export function chain(id: string, { tiles: tile, ...options }: ChainPresetOptions) {
    let handle: BlockHandle<typeof ColumnState.props>;
    const upright = () => chainLinkQuads(tile, 0, 1, 0, 1);
    handle = block(id, {
        ...options,
        material: options?.material ?? MaterialType.TRANSPARENT,
        states: ColumnState,
        defaultState: { axis: 'y' },
        shape: ({ axis }) => (axis === 'x' ? CHAIN_SHAPE_X : axis === 'z' ? CHAIN_SHAPE_Z : CHAIN_SHAPE_Y),
        model: ({ axis }) => ({
            type: 'custom' as const,
            quads:
                axis === 'y'
                    ? upright()
                    : axis === 'x'
                      ? blockModel.rotateAxis(upright(), 'z', 90, [0.5, 0.5, 0.5])
                      : blockModel.rotateAxis(upright(), 'x', 90, [0.5, 0.5, 0.5]),
        }),
        cull: CullType.PARTIAL,
        lightOpacity: 0,
        flags: BLOCK_FLAG_SUPPORTS_HANGING,
        place: (ctx, io) => io.set(ctx.worldX, ctx.worldY, ctx.worldZ, handle.stateKey({ axis: axisFromPlaceCtx(ctx) })),
        rotate: (stateId, axis) => {
            const p = handle.def.states.decode(stateId - handle._baseStateId);
            return handle.stateId({ axis: AXIS_REMAP[axis][p.axis as 'x' | 'y' | 'z'] });
        },
    });
    return handle;
}

// a lantern: a 6x7x6 body with a 4x2x4 cap and a crossed-plane handle, standing on the floor or, with `hanging`, hung from a handle reaching the ceiling. re-homes to the other side on support loss, like the torch. `lit` swaps the sheet and the light; flip it with setLanternLit. tile layout (16x16): body sides (0,2)-(6,9), ends (0,9)-(6,15), cap sides (1,0)-(5,2), cap top (1,10)-(5,14), handle strip (11,1)-(14,12); give it three frames for the flicker.
const LanternState = blockState.create({ hanging: blockState.bool(), lit: blockState.bool() });
type LanternProps = { hanging: boolean; lit: boolean };
const LANTERN_FLOOR_SHAPE = blockShape.aabbs([
    [5 / 16, 0, 5 / 16, 11 / 16, 7 / 16, 11 / 16],
    [6 / 16, 7 / 16, 6 / 16, 10 / 16, 9 / 16, 10 / 16],
]);
const LANTERN_HANGING_SHAPE = blockShape.aabbs([
    [5 / 16, 1 / 16, 5 / 16, 11 / 16, 8 / 16, 11 / 16],
    [6 / 16, 8 / 16, 6 / 16, 10 / 16, 10 / 16, 10 / 16],
]);

const px = (a: number, b: number, c: number, d: number): [Vec2, Vec2, Vec2, Vec2] => [
    [a / 16, d / 16],
    [c / 16, d / 16],
    [c / 16, b / 16],
    [a / 16, b / 16],
];

function lanternQuads(tile: TileHandle, hanging: boolean): BlockQuad[] {
    const lift = hanging ? 1 / 16 : 0;
    const t: CubeTiles = { all: tile };
    const quads: BlockQuad[] = [];
    const body = blockModel.box([5 / 16, lift, 5 / 16], [11 / 16, lift + 7 / 16, 11 / 16], t, { cull: false });
    const cap = blockModel.box([6 / 16, lift + 7 / 16, 6 / 16], [10 / 16, lift + 9 / 16, 10 / 16], t, { cull: false });
    for (const q of body) q.uvs = q.normal[1] === 0 ? px(0, 2, 6, 9) : px(0, 9, 6, 15);
    for (const q of cap) q.uvs = q.normal[1] === 0 ? px(1, 0, 5, 2) : px(1, 10, 5, 14);
    quads.push(...body, ...cap);
    // handle: crossed planes on the chain strip, 2 texels tall on the floor, reaching the ceiling when hanging.
    const y0 = lift + 9 / 16;
    const y1 = hanging ? 1 : 11 / 16;
    const rows = (y1 - y0) * 16;
    quads.push(
        ...chainLinkQuads(tile, y0, y1, 1 / 16, (1 + rows) / 16).map((q) => ({ ...q, uvs: q.uvs && shiftU(q.uvs, 11 / 16) })),
    );
    return quads;
}

/** slide a quad's uvs along u: the handle samples the strip at x 11..14, not the chain's x 0..3. */
function shiftU(uvs: [Vec2, Vec2, Vec2, Vec2], du: number): [Vec2, Vec2, Vec2, Vec2] {
    return [
        [uvs[0][0] + du, uvs[0][1]],
        [uvs[1][0] + du, uvs[1][1]],
        [uvs[2][0] + du, uvs[2][1]],
        [uvs[3][0] + du, uvs[3][1]],
    ];
}

function lanternSupported(voxels: Voxels, wx: number, wy: number, wz: number, hanging: boolean): boolean {
    return hanging ? supportsHanging(voxels, wx, wy + 1, wz) : supportsHanging(voxels, wx, wy - 1, wz);
}

/*#__NO_SIDE_EFFECTS__*/
export function lantern(id: string, { tiles, ...options }: LanternPresetOptions) {
    let handle: BlockHandle<typeof LanternState.props>;
    const emission = options?.lightEmission;
    const litEmission = (props: LanternProps): [number, number, number] =>
        typeof emission === 'function' ? emission(props) : (emission ?? [15, 13, 8]);
    handle = block(id, {
        ...options,
        material: options?.material ?? MaterialType.TRANSPARENT,
        states: LanternState,
        defaultState: { hanging: false, lit: true },
        shape: ({ hanging }) => (hanging ? LANTERN_HANGING_SHAPE : LANTERN_FLOOR_SHAPE),
        model: ({ hanging, lit }) => ({ type: 'custom' as const, quads: lanternQuads(lit ? tiles.lit : tiles.unlit, hanging) }),
        cull: CullType.PARTIAL,
        lightOpacity: 0,
        emissive: ({ lit }) => lit,
        lightEmission: (props) => (props.lit ? litEmission(props) : [0, 0, 0]),
        // a ceiling click hangs it, anything else stands it; onNeighbourUpdate re-homes it on placement if unsupported.
        place: (ctx, io) =>
            io.set(ctx.worldX, ctx.worldY, ctx.worldZ, handle.stateKey({ hanging: ctx.normalY < -0.5, lit: true })),
        onNeighbourUpdate(ctx) {
            const { hanging, lit } = handle.def.states.decode(ctx.stateId - handle._baseStateId);
            if (lanternSupported(ctx.voxels, ctx.worldX, ctx.worldY, ctx.worldZ, hanging)) return ctx.stateId;
            if (lanternSupported(ctx.voxels, ctx.worldX, ctx.worldY, ctx.worldZ, !hanging))
                return handle.stateId({ hanging: !hanging, lit });
            return ctx.stateId;
        },
    });
    return handle;
}

function lanternAt(voxels: Voxels, x: number, y: number, z: number): { idx: number; p: LanternProps } | null {
    const stateId = getBlockState(voxels, x, y, z);
    if (stateId === AIR) return null;
    const reg = voxels.registry;
    const idx = reg.stateToBlockIndex[stateId]!;
    const handle = reg.handles[idx]!;
    if (handle.def.states !== LanternState) return null;
    return { idx, p: LanternState.decode(stateId - handle._baseStateId) as LanternProps };
}

/** whether the lantern at (x,y,z) is lit. false if the cell isn't a lantern. */
export function getLanternLit(voxels: Voxels, x: number, y: number, z: number): boolean {
    return lanternAt(voxels, x, y, z)?.p.lit ?? false;
}

/** light or put out the lantern at (x,y,z), keeping how it hangs. no-op if the
 *  cell isn't a lantern or already matches.
 *  toggle = `setLanternLit(v, x, y, z, !getLanternLit(v, x, y, z))`. */
export function setLanternLit(voxels: Voxels, x: number, y: number, z: number, lit: boolean): void {
    const found = lanternAt(voxels, x, y, z);
    if (!found || found.p.lit === lit) return;
    setBlock(voxels, x, y, z, voxels.registry.handles[found.idx]!.stateKey({ ...found.p, lit }));
}

// two-cell (lower + upper) door; state is (facing, half, hinge, open): facing points toward the placer, half is which cell (identical facing/hinge/open, differing only in texture), hinge is which vertical edge it pivots on (sets double-door pairing), open swings the panel 90 degrees to the hinge side. placement writes both cells (validates air first) and hinges right if a same-facing door sits immediately to the right, so adjacent doors pair up. removal cohesion (break one half, remove the other) is deferred to a future onBlockBreak hook; v1 leaves an orphaned half.
const DoorState = blockState.create({
    facing: blockState.enumeration(['north', 'east', 'south', 'west'] as const),
    half: blockState.enumeration(['lower', 'upper'] as const),
    hinge: blockState.enumeration(['left', 'right'] as const),
    open: blockState.bool(),
});

type DoorProps = { facing: Facing4; half: 'lower' | 'upper'; hinge: 'left' | 'right'; open: boolean };

const DOOR_DEPTH = 3 / 16;

// (dx,dz) step per cardinal (world convention: north=-Z, south=+Z, east=+X, west=-X).
const FACING_DELTA: Record<Facing4, readonly [number, number]> = {
    north: [0, -1],
    south: [0, 1],
    east: [1, 0],
    west: [-1, 0],
};

// door panel AABB in the base (facing=north) orientation: closed is a thin slab on the -Z edge, open swings 90 degrees onto the hinge-side edge.
function doorBox(hinge: 'left' | 'right', open: boolean): blockShape.AABB {
    if (!open) return [0, 0, 0, 1, 1, DOOR_DEPTH];
    return hinge === 'left' ? [0, 0, 0, DOOR_DEPTH, 1, 1] : [1 - DOOR_DEPTH, 0, 0, 1, 1, 1];
}

/*#__NO_SIDE_EFFECTS__*/
export function door(id: string, { tiles, ...options }: DoorPresetOptions) {
    let handle: BlockHandle<typeof DoorState.props>;
    handle = block(id, {
        ...options,
        material: options?.material ?? MaterialType.TRANSPARENT,
        states: DoorState,
        defaultState: { facing: 'north', half: 'lower', hinge: 'left', open: false },
        flags: BLOCK_FLAG_DOOR,
        cull: CullType.PARTIAL,
        shape: (p) => blockShape.rotateY(blockShape.aabbs([doorBox(p.hinge, p.open)]), (4 - FACING4_STEPS[p.facing]) % 4),
        model: (p) => {
            // model the left door always; mirror across X for the right hinge.
            const b = doorBox('left', p.open);
            const tile = p.half === 'lower' ? tiles.bottom : tiles.top;
            let quads = blockModel.box([b[0], b[1], b[2]], [b[3], b[4], b[5]], { all: tile }, { uvs: 'local', cull: false });
            if (p.hinge === 'right') quads = blockModel.mirrorX(quads);
            return { type: 'custom' as const, quads: blockModel.rotateY(quads, (4 - FACING4_STEPS[p.facing]) % 4) };
        },
        // place both cells (validate both air first); hinge right if a same-facing door is immediately to our right.
        place: (ctx, io) => {
            const { worldX: x, worldY: y, worldZ: z } = ctx;
            if (io.get(x, y, z) !== BLOCK_AIR) return;
            if (io.get(x, y + 1, z) !== BLOCK_AIR) return;
            const facing = facing4FromPlaceCtx(ctx);
            const [rdx, rdz] = FACING_DELTA[rotateFacing4(facing, false)];
            const right = parseKey(io.get(x + rdx, y, z + rdz));
            const hinge: 'left' | 'right' =
                right && right.blockId === handle.id && right.props.facing === facing ? 'right' : 'left';
            io.set(x, y, z, handle.stateKey({ facing, half: 'lower', hinge, open: false }));
            io.set(x, y + 1, z, handle.stateKey({ facing, half: 'upper', hinge, open: false }));
        },
        rotate: (stateId, axis, cw) => {
            if (axis !== 'y') return stateId;
            const p = handle.def.states.decode(stateId - handle._baseStateId);
            return handle.stateId({ ...p, facing: rotateFacing4(p.facing as Facing4, cw) });
        },
        flip: (stateId, axis) => {
            const p = handle.def.states.decode(stateId - handle._baseStateId);
            const facing =
                axis === 'y' ? (p.facing as Facing4) : (axis === 'x' ? FACING4_FLIP_X : FACING4_FLIP_Z)[p.facing as Facing4];
            const hinge = axis === 'y' ? p.hinge : p.hinge === 'left' ? 'right' : 'left';
            const half = axis === 'y' ? (p.half === 'lower' ? 'upper' : 'lower') : p.half;
            return handle.stateId({ facing, half, hinge, open: p.open });
        },
    });
    return handle;
}

// door open/close utils, flag-gated + decoded via the shared DoorState so they work across every door block.
function doorAt(voxels: Voxels, x: number, y: number, z: number): { idx: number; p: DoorProps } | null {
    const stateId = getBlockState(voxels, x, y, z);
    if (stateId === AIR) return null;
    const reg = voxels.registry;
    if ((reg.flags[stateId]! & BLOCK_FLAG_DOOR) === 0) return null;
    const idx = reg.stateToBlockIndex[stateId]!;
    const local = stateId - reg.handles[idx]!._baseStateId;
    return { idx, p: DoorState.decode(local) as DoorProps };
}

/** whether the door at (x,y,z) is open. false if the cell isn't a door. */
export function getDoorOpen(voxels: Voxels, x: number, y: number, z: number): boolean {
    return doorAt(voxels, x, y, z)?.p.open ?? false;
}

/** set the open state of the door at (x,y,z), writes both halves (partner
 *  re-derived from `half`). no-op if the cell isn't a door or already matches.
 *  toggle = `setDoorOpen(v, x, y, z, !getDoorOpen(v, x, y, z))`. */
export function setDoorOpen(voxels: Voxels, x: number, y: number, z: number, open: boolean): void {
    const d = doorAt(voxels, x, y, z);
    if (!d || d.p.open === open) return;
    const handle = voxels.registry.handles[d.idx]!;
    setBlock(voxels, x, y, z, handle.stateKey({ ...d.p, open }));
    const dy = d.p.half === 'lower' ? 1 : -1;
    const o = doorAt(voxels, x, y + dy, z);
    if (o && o.idx === d.idx) setBlock(voxels, x, y + dy, z, handle.stateKey({ ...o.p, open }));
}
