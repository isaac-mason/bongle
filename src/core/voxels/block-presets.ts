// pre-baked block factories for common shapes (stairs, slab, cross,
// leaves). each preset returns a fully-configured BlockHandle so callers
// don't have to assemble the shape + model + cull + collision themselves.
// drop down to block() directly when a preset doesn't fit.

import {
    AIR,
    BLOCK_FLAG_COLLISION,
    BLOCK_FLAG_FENCE,
    BLOCK_FLAG_PANE,
    BLOCK_FLAG_WALL,
} from './block-registry';
import * as blockShape from './block-collider';
import * as blockModel from './block-model';
import * as blockState from './block-state';
import {
    block,
    type BlockHandle,
    type BlockPlaceCtx,
    type BlockQuad,
    type BlockSoundConfig,
    type CubeTextures,
    CullType,
    MaterialType,
    type ScreenTintSpec,
    type TextureRef,
    VertexAnimation,
} from './blocks';

/**
 * Common preset options. `name` is the human-readable display label
 * shown in editor UIs (inventory, hotbar, inspector) — falls back to
 * the string id when omitted. `sounds` lets games wire a
 * `blockSoundPresets.*` bundle on derived blocks the same way raw
 * `block(...)` calls do.
 */
/**
 * `material` overrides the preset's default render pass. Most presets
 * default to OPAQUE; `plant`, `leaves`, and `pane` default to TRANSPARENT
 * (alpha cutout) since their textures conventionally have holes. Pass
 * `MaterialType.TRANSPARENT` to opt a cube/wall/stairs/etc into alpha
 * cutout (e.g. a glass wall), or `MaterialType.TRANSLUCENT` for alpha
 * blending (stained glass cube).
 */
type PresetOptions = { name?: string; sounds?: BlockSoundConfig; material?: MaterialType };
import { getBlock } from './voxels';

// ── cube ────────────────────────────────────────────────────────────
//
// the most basic block: a full opaque cube with the given textures. drop
// down to block() directly if you need to override cull, friction, or any
// other field — this preset deliberately keeps the surface small.

export function cube(id: string, textures: CubeTextures, options?: PresetOptions) {
    return block(id, {
        name: options?.name,
        model: () => ({ type: 'cube' as const, textures }),
        material: options?.material ?? MaterialType.OPAQUE,
        sounds: options?.sounds,
    });
}

// ── column ──────────────────────────────────────────────────────────
//
// axis-oriented full cube — end-cap texture on faces perpendicular to
// the axis, wrap texture on the other four (logs, basalt pillars, hay
// bales, ...). placement axis is set by the build tool via the
// build-direction convention (axis = dominant hit-normal axis).

const ColumnState = blockState.create({
    axis: blockState.enumeration(['x', 'y', 'z'] as const),
});

// axis-enum rotation for `column` and other `axis` blocks: a single 90°
// rotation around `rotAxis` swaps the two axes perpendicular to it. flips
// are identity (axis is directionless).
const AXIS_REMAP: Record<'x' | 'y' | 'z', Record<'x' | 'y' | 'z', 'x' | 'y' | 'z'>> = {
    x: { x: 'x', y: 'z', z: 'y' },
    y: { x: 'z', y: 'y', z: 'x' },
    z: { x: 'y', y: 'x', z: 'z' },
};

export function column(
    id: string,
    textures: { end: TextureRef; side: TextureRef },
    options?: PresetOptions,
) {
    const end = textures.end;
    const side = textures.side;
    let handle: BlockHandle<typeof ColumnState.props>;
    handle = block(id, {
        name: options?.name,
        sounds: options?.sounds,
        material: options?.material ?? MaterialType.OPAQUE,
        states: ColumnState,
        defaultState: { axis: 'y' },
        // axis-aligned cube — geometry never changes. grain follows axis via
        // per-face UV rotation baked into the registry's cubeFaceUVs. AO and
        // smooth lighting stay on the cube fast-path. mirrors Luanti's
        // facedir / MC's blockstate-rotation approach (see plan notes).
        model: ({ axis }) => {
            if (axis === 'y') {
                return {
                    type: 'cube' as const,
                    textures: {
                        top: { texture: end },
                        bottom: { texture: end },
                        sides: { texture: side },
                    },
                };
            }
            if (axis === 'x') {
                return {
                    type: 'cube' as const,
                    textures: {
                        top: { texture: side, rotation: 90 },
                        bottom: { texture: side, rotation: 90 },
                        north: { texture: side, rotation: 90 },
                        south: { texture: side, rotation: 90 },
                        east: { texture: end },
                        west: { texture: end },
                    },
                };
            }
            // axis === 'z'
            return {
                type: 'cube' as const,
                textures: {
                    top: { texture: side },
                    bottom: { texture: side },
                    north: { texture: end },
                    south: { texture: end },
                    east: { texture: side, rotation: 90 },
                    west: { texture: side, rotation: 90 },
                },
            };
        },
        rotate: (stateId, axis) => {
            const local = stateId - handle._baseStateId;
            const p = handle.states.decode(local);
            return handle.stateId({ axis: AXIS_REMAP[axis][p.axis as 'x' | 'y' | 'z'] });
        },
        // axis is directionless — flips are identity.
    });
    return handle;
}

// ── stairs ──────────────────────────────────────────────────────────
//
// neighbour-aware staircase with corner shapes. state is (facing, half,
// shape):
//   facing: rotation around Y. follows the engine-wide directional-prop
//     convention shared with ladders/signs: `facing=X` is the direction
//     the block's identifying front face points = direction toward the
//     placer. for a stair the "front" face is the low/climbable side
//     (the side you step onto from ground level). base orientation has
//     the high back step at +Z (south); rotateY is CCW compass, so we
//     rotate by `(4 - FACING_STEPS[facing]) % 4` — same inversion the
//     ladder uses — so that `facing=name` lands the low step on the
//     named side for all four cardinals.
//   half: 'bottom' = staircase rests on the floor, 'top' = upside-down
//     (ceiling-mounted; player climbs along the bottom).
//   shape: 'straight' = full back strip. outer_* removes half of the
//     back strip; inner_* adds a quarter step to the front corner. the
//     l/r suffix indicates which side of the facing direction the
//     corner sits on.
//
// onNeighbourUpdate derives `shape` from same-block neighbours with
// matching half whose facing is perpendicular to ours.

const FACING_STEPS = { north: 0, east: 1, south: 2, west: 3 } as const;
const FACING_ORDER = ['north', 'east', 'south', 'west'] as const;
type Facing = 'north' | 'east' | 'south' | 'west';

// ── shared rotate/flip tables for the 4-cardinal facing enum ────────
//
// convention: `cw=true` matches the position rotation used by
// rotateVoxelsByQuat / Blueprint.rotateAxis: under axis='y', +X → -Z.
// applied to facing vectors: east(+X) → north(-Z) → west(-X) → south(+Z).
// X / Z rotations are not defined for these horizontal-only presets — the
// `rotate` hook returns the input stateId in those cases (matches MC).
const FACING4_ROT_Y_CW: Record<Facing, Facing> = {
    east: 'north', north: 'west', west: 'south', south: 'east',
};
const FACING4_ROT_Y_CCW: Record<Facing, Facing> = {
    north: 'east', east: 'south', south: 'west', west: 'north',
};
const FACING4_FLIP_X: Record<Facing, Facing> = {
    east: 'west', west: 'east', north: 'north', south: 'south',
};
const FACING4_FLIP_Z: Record<Facing, Facing> = {
    north: 'south', south: 'north', east: 'east', west: 'west',
};
function rotFacing4(f: Facing, cw: boolean): Facing {
    return (cw ? FACING4_ROT_Y_CW : FACING4_ROT_Y_CCW)[f];
}

// shared place-ctx helpers for directional half-block presets (stairs,
// trapdoor, slab). mirrors the `applyDirectionalProps` convention so the
// hooked path produces the same result for the common cases.

// facing toward the placer: wall click → opposite of clicked face (direction
// of the hit normal); floor/ceiling click → snap from camera yaw.
function facingFromPlaceCtx(ctx: BlockPlaceCtx): Facing {
    const ax = Math.abs(ctx.normalX);
    const ay = Math.abs(ctx.normalY);
    const az = Math.abs(ctx.normalZ);
    if (ax >= ay || az >= ay) {
        if (ax >= az) return ctx.normalX >= 0 ? 'east' : 'west';
        return ctx.normalZ >= 0 ? 'south' : 'north';
    }
    const fx = Math.sin(ctx.yaw);
    const fz = Math.cos(ctx.yaw);
    if (Math.abs(fx) >= Math.abs(fz)) return fx >= 0 ? 'east' : 'west';
    return fz >= 0 ? 'south' : 'north';
}

// half pick for stair/trapdoor/slab: clicking the top face of a block places
// the half-block at the bottom of the cell above; clicking the bottom face
// places at the top; wall clicks pick by where on the wall the player aimed.
function halfFromPlaceCtx(ctx: BlockPlaceCtx): 'bottom' | 'top' {
    if (ctx.normalY > 0.5) return 'bottom';
    if (ctx.normalY < -0.5) return 'top';
    return ctx.hitY < 0.5 ? 'bottom' : 'top';
}

const StairState = blockState.create({
    facing: blockState.enumeration(['north', 'east', 'south', 'west'] as const),
    half: blockState.enumeration(['bottom', 'top'] as const),
    shape: blockState.enumeration(['straight', 'inner_left', 'inner_right', 'outer_left', 'outer_right'] as const),
});

type StairShape = 'straight' | 'inner_left' | 'inner_right' | 'outer_left' | 'outer_right';
type StairHalf = 'bottom' | 'top';

// chirality swap for any horizontal mirror: left ↔ right, straight unchanged.
// applied under flip-x and flip-z regardless of facing — see plan notes.
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
        case 'straight': return [[0, 0.5, 0.5, 1, 1, 1]];
        case 'outer_left': return [[0, 0.5, 0.5, 0.5, 1, 1]];        // back-west quarter
        case 'outer_right': return [[0.5, 0.5, 0.5, 1, 1, 1]];       // back-east quarter
        case 'inner_left': return [
            [0, 0.5, 0.5, 1, 1, 1],
            [0, 0.5, 0, 0.5, 1, 0.5],                                // + front-west quarter
        ];
        case 'inner_right': return [
            [0, 0.5, 0.5, 1, 1, 1],
            [0.5, 0.5, 0, 1, 1, 0.5],                                // + front-east quarter
        ];
    }
}

// exposed top-of-slab regions (y=0.5) for the bottom-half facing=north.
function stairExposedTopRects(shape: StairShape): [number, number, number, number][] {
    switch (shape) {
        case 'straight': return [[0, 0, 1, 0.5]];
        case 'outer_left': return [[0, 0, 1, 0.5], [0.5, 0.5, 1, 1]];
        case 'outer_right': return [[0, 0, 1, 0.5], [0, 0.5, 0.5, 1]];
        case 'inner_left': return [[0.5, 0, 1, 0.5]];
        case 'inner_right': return [[0, 0, 0.5, 0.5]];
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
            texture: q.texture,
            uvs: q.uvs ? [q.uvs[3], q.uvs[2], q.uvs[1], q.uvs[0]] : undefined,
            cullFace: cf,
            material: q.material,
        };
    });
}

function pickTopTexture(textures: CubeTextures): TextureRef {
    if ('all' in textures) return textures.all.texture;
    return textures.top.texture;
}

function stairBoxes(p: { half: StairHalf; shape: StairShape }) {
    const lower: [number, number, number, number, number, number] = [0, 0, 0, 1, 0.5, 1];
    const boxes = [lower, ...stairUpperBoxes(p.shape)];
    return p.half === 'top' ? boxes.map(reflectAabbY) : boxes;
}

function stairQuads(
    textures: CubeTextures,
    topTex: TextureRef,
    p: { half: StairHalf; shape: StairShape },
): BlockQuad[] {
    const quads: BlockQuad[] = [
        // bottom slab (top face emitted separately as exposed quads)
        ...blockModel.box([0, 0, 0], [1, 0.5, 1], textures, { exclude: ['up'] }),
    ];
    for (const b of stairUpperBoxes(p.shape)) {
        // upper step boxes rest on the slab top — exclude their down face.
        quads.push(...blockModel.box([b[0], b[1], b[2]], [b[3], b[4], b[5]], textures, { exclude: ['down'] }));
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
    wx: number, wy: number, wz: number,
    matchHalf: StairHalf,
): Facing | null {
    const id = getBlock(voxels, wx, wy, wz);
    if (id === AIR) return null;
    if (voxels.registry.stateToBlockIndex[id] !== handle._index) return null;
    const local = voxels.registry.stateToLocalIndex[id]!;
    const props = handle.states.decode(local);
    if (props.half !== matchHalf) return null;
    return props.facing as Facing;
}

export function stairs(id: string, textures: CubeTextures, options?: PresetOptions) {
    const topTex = pickTopTexture(textures);
    let handle: BlockHandle<typeof StairState.props>;
    handle = block(id, {
        name: options?.name,
        sounds: options?.sounds,
        material: options?.material ?? MaterialType.OPAQUE,
        states: StairState,
        defaultState: { facing: 'south', half: 'bottom', shape: 'straight' },
        shape: (p) => blockShape.rotateY(blockShape.aabbs(stairBoxes(p)), (4 - FACING_STEPS[p.facing]) % 4),
        model: (p) => ({
            type: 'custom' as const,
            quads: blockModel.rotateY(stairQuads(textures, topTex, p), (4 - FACING_STEPS[p.facing]) % 4),
        }),
        cull: CullType.PARTIAL,
        place: (ctx) => {
            const facing = facingFromPlaceCtx(ctx);
            const half = halfFromPlaceCtx(ctx);
            // shape stays 'straight' — onNeighbourUpdate re-derives corners post-placement.
            return handle.stateId({ facing, half, shape: 'straight' });
        },
        onNeighbourUpdate(ctx) {
            const me = handle.states.decode(ctx.voxels.registry.stateToLocalIndex[ctx.stateId]!);
            const f = me.facing as Facing;
            const h = me.half as StairHalf;
            // CW / CCW rotations of our facing (from above). used to recognise
            // perpendicular neighbours and pick a corner side.
            const cw = FACING_ORDER[(FACING_STEPS[f] + 1) % 4]!;
            const ccw = FACING_ORDER[(FACING_STEPS[f] + 3) % 4]!;

            // world-direction the stair faces — same direction the low/front
            // step points (= where the placer was standing).
            const dir = ({
                north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0],
            } as const)[f];

            // FRONT neighbour (one cell beyond the low step): if it's a
            // perpendicular stair, we form an OUTER corner. CW-facing
            // neighbour → outer_left; CCW → outer_right.
            const front = readStairAt(ctx.voxels, handle, ctx.worldX + dir[0], ctx.worldY, ctx.worldZ + dir[1], h);
            if (front === cw) return handle.stateId({ facing: f, half: h, shape: 'outer_left' });
            if (front === ccw) return handle.stateId({ facing: f, half: h, shape: 'outer_right' });

            // BACK neighbour (one cell beyond the high step): perpendicular
            // stair pointing toward us → INNER corner.
            const back = readStairAt(ctx.voxels, handle, ctx.worldX - dir[0], ctx.worldY, ctx.worldZ - dir[1], h);
            if (back === ccw) return handle.stateId({ facing: f, half: h, shape: 'inner_left' });
            if (back === cw) return handle.stateId({ facing: f, half: h, shape: 'inner_right' });

            return handle.stateId({ facing: f, half: h, shape: 'straight' });
        },
        rotate: (stateId, axis, cw) => {
            // sideways stair has no valid state — only Y rotation maps cleanly.
            if (axis !== 'y') return stateId;
            const p = handle.states.decode(stateId - handle._baseStateId);
            return handle.stateId({
                facing: rotFacing4(p.facing as Facing, cw),
                half: p.half,
                shape: p.shape,
            });
        },
        flip: (stateId, axis) => {
            const p = handle.states.decode(stateId - handle._baseStateId);
            const f = p.facing as Facing;
            const h = p.half as StairHalf;
            const s = p.shape as StairShape;
            if (axis === 'y') {
                return handle.stateId({ facing: f, half: h === 'top' ? 'bottom' : 'top', shape: s });
            }
            // X / Z mirror: chirality always swaps. facing flips iff it has a
            // component along the mirror axis.
            const table = axis === 'x' ? FACING4_FLIP_X : FACING4_FLIP_Z;
            return handle.stateId({ facing: table[f], half: h, shape: STAIR_SHAPE_FLIP[s] });
        },
    });
    return handle;
}

// ── slab ────────────────────────────────────────────────────────────
//
// `half` picks the slab's vertical placement: 'bottom' (y=0..0.5),
// 'top' (y=0.5..1), or 'double' (full cube — two slabs merged).
// double-slab is SOLID so adjacent doubles cull each other; the half
// slabs are PARTIAL.

const SlabState = blockState.create({
    half: blockState.enumeration(['bottom', 'top', 'double'] as const),
});

const SLAB_BOTTOM_SHAPE = blockShape.aabbs([[0, 0, 0, 1, 0.5, 1]]);
const SLAB_TOP_SHAPE = blockShape.aabbs([[0, 0.5, 0, 1, 1, 1]]);

export function slab(id: string, textures: CubeTextures, options?: PresetOptions) {
    let handle: BlockHandle<typeof SlabState.props>;
    handle = block(id, {
        name: options?.name,
        sounds: options?.sounds,
        material: options?.material ?? MaterialType.OPAQUE,
        states: SlabState,
        shape: (p) => {
            if (p.half === 'double') return blockShape.cube();
            return p.half === 'top' ? SLAB_TOP_SHAPE : SLAB_BOTTOM_SHAPE;
        },
        model: (p) => {
            if (p.half === 'double') return { type: 'cube' as const, textures };
            const from: [number, number, number] = p.half === 'top' ? [0, 0.5, 0] : [0, 0, 0];
            const to: [number, number, number] = p.half === 'top' ? [1, 1, 1] : [1, 0.5, 1];
            return { type: 'custom' as const, quads: blockModel.box(from, to, textures) };
        },
        cull: (p) => (p.half === 'double' ? CullType.SOLID : CullType.PARTIAL),
        place: (ctx) => handle.stateId({ half: halfFromPlaceCtx(ctx) }),
        // rotate is identity (half/double are axis-aligned).
        flip: (stateId, axis) => {
            if (axis !== 'y') return stateId;
            const p = handle.states.decode(stateId - handle._baseStateId);
            if (p.half === 'double') return stateId;
            return handle.stateId({ half: p.half === 'top' ? 'bottom' : 'top' });
        },
    });
    return handle;
}

// ── plant (flowers, grass, saplings) ────────────────────────────────

export function plant(id: string, texture: TextureRef, options?: PresetOptions) {
    return block(id, {
        name: options?.name,
        model: () => ({ type: 'custom' as const, quads: blockModel.cross(texture) }),
        cull: CullType.SELF,
        collision: false,
        material: options?.material ?? MaterialType.TRANSPARENT,
        vertexAnimation: VertexAnimation.PLANT_WIND_SWAY,
        sounds: options?.sounds,
    });
}

// ── leaves ──────────────────────────────────────────────────────────

export function leaves(id: string, textures: CubeTextures, options?: PresetOptions) {
    return block(id, {
        name: options?.name,
        model: () => ({ type: 'cube' as const, textures }),
        cull: CullType.SELF,
        material: options?.material ?? MaterialType.TRANSPARENT,
        vertexAnimation: VertexAnimation.WAVE,
        sounds: options?.sounds,
    });
}

// ── ladder ──────────────────────────────────────────────────────────
//
// thin wall-mounted panel: a single textured quad backed against one wall,
// climbable, no collision so the character can occupy the same cell. the
// shape is kept (despite collision=false) so selection raycasts only hit
// the panel itself, not the empty volume in front of it.
//
// `facing` follows the same convention as stairs: it is the direction the
// visible texture faces. facing='north' → panel mounted on the south wall
// of the cube, texture visible to a player standing on the north side.

const LADDER_DEPTH = 1 / 16;

const LADDER_SHAPE = blockShape.aabbs([[0, 0, 1 - LADDER_DEPTH, 1, 1, 1]]);

const LadderFacingState = blockState.create({
    facing: blockState.enumeration(['north', 'east', 'south', 'west'] as const),
});

export function ladder(id: string, texture: TextureRef, options?: PresetOptions) {
    let handle: BlockHandle<typeof LadderFacingState.props>;
    handle = block(id, {
        name: options?.name,
        sounds: options?.sounds,
        material: options?.material ?? MaterialType.TRANSPARENT,
        states: LadderFacingState,
        // base panel sits at +Z facing -Z (texture normal points north). the
        // rotation goes CCW per step around Y, so to make the texture face
        // the named direction we rotate by (4 - FACING_STEPS[facing]) — the
        // CW-sense complement. without this inversion N/S would look right
        // (180° is self-inverse) but E/W would be swapped.
        defaultState: { facing: 'south' },
        shape: (p) => blockShape.rotateY(LADDER_SHAPE, (4 - FACING_STEPS[p.facing]) % 4),
        model: (p) => {
            const z = 1 - LADDER_DEPTH;
            // -Z-facing quad, matching the winding box() uses for its
            // 'north' face so default UVs orient correctly.
            const quads = [
                blockModel.quad(
                    [
                        [1, 0, z],
                        [0, 0, z],
                        [0, 1, z],
                        [1, 1, z],
                    ],
                    [0, 0, -1],
                    texture,
                ),
            ];
            return {
                type: 'custom' as const,
                quads: blockModel.rotateY(quads, (4 - FACING_STEPS[p.facing]) % 4),
            };
        },
        cull: CullType.PARTIAL,
        collision: false,
        climbable: true,
        rotate: (stateId, axis, cw) => {
            if (axis !== 'y') return stateId;
            const p = handle.states.decode(stateId - handle._baseStateId);
            return handle.stateId({ facing: rotFacing4(p.facing as Facing, cw) });
        },
        flip: (stateId, axis) => {
            if (axis === 'y') return stateId;
            const p = handle.states.decode(stateId - handle._baseStateId);
            const table = axis === 'x' ? FACING4_FLIP_X : FACING4_FLIP_Z;
            return handle.stateId({ facing: table[p.facing as Facing] });
        },
    });
    return handle;
}

// ── liquid ──────────────────────────────────────────────────────────
//
// reasonable starting tints for the two canonical liquids. dark muddy
// blue for water, warm orange for lava. callers can override via the
// `tint` option on `liquid()`.

export const WATER_DEFAULT_TINT: ScreenTintSpec = { color: [0.04, 0.1, 0.2], opacity: 0.3 };
export const LAVA_DEFAULT_TINT: ScreenTintSpec = { color: [1.0, 0.35, 0.05], opacity: 0.75 };


//
// MODEL_LIQUID block — the character swims in it instead of colliding,
// and the mesher emits a cube whose top quad and side quads are clipped
// to `surfaceHeight`.
//
// `translucent: true` gives water-style rendering (TRANSLUCENT material,
// same-fluid face culling); omitting it gives an opaque liquid like lava.
//
// `levels` (default 1) controls how many discrete surface heights this
// block exposes. levels=1 stays stateless — a full-height cube, same as
// the old preset. levels>1 introduces a `level` int prop (1..levels) and
// a `level(n)` helper on the handle for picking a specific height —
// e.g. `Water.level(4)` for half-height on an 8-level liquid. the
// `defaultState` is the highest level, so `defaultKey()` returns the full-
// height surface (handy for icons and bare `setBlock(..., Water.defaultKey())`).
//
// `fluidGroup` (default = block id) tags this liquid for same-fluid face
// culling between adjacent cells. liquids that should merge visually
// (e.g. flowing variants sharing a body) pass the same group string.

export type LiquidHandle = BlockHandle & {
    /** state key for a specific level (1..levels). returns the default for stateless liquids. */
    level(n: number): string;
    /** state key for the highest level (full surface height). */
    max(): string;
};

export function liquid(
    id: string,
    textures: CubeTextures,
    options?: PresetOptions & {
        viscosity?: number;
        translucent?: boolean;
        levels?: number;
        fluidGroup?: string;
        /** screen tint applied when the camera eye sits inside the filled band. */
        tint?: ScreenTintSpec;
        /** scales the surface for every level. 1 = full cube at max level; lower
         * (e.g. 15/16) gives a visible meniscus from above. defaults to 1. */
        maxHeight?: number;
        /** per-channel light output (0..15) — set for lava-style glow. */
        lightEmission?: [number, number, number];
        /** mark the texture as self-lit so it stays bright in shadow. */
        emissive?: boolean;
    },
): LiquidHandle {
    const levels = Math.max(1, options?.levels ?? 1);
    const translucent = options?.translucent === true;
    const group = options?.fluidGroup ?? id;
    const maxHeight = options?.maxHeight ?? 1;
    const emission = options?.lightEmission;

    const baseConfig = {
        name: options?.name,
        model: () => ({ type: 'cube' as const, textures }),
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

// ── fence ───────────────────────────────────────────────────────────
//
// 4-arm fence: a 4/16-wide post with up to 4 arms (top + bottom rail
// per side) that connect to any solid neighbour. connectivity is
// recomputed by onNeighbourUpdate every time a neighbour changes.

const FenceState = blockState.create({
    north: blockState.bool(),
    east: blockState.bool(),
    south: blockState.bool(),
    west: blockState.bool(),
});

// strides captured once so the fence/pane onNeighbourUpdate path can
// inline-encode the local state index without allocating a props object.
const FENCE_STRIDE_NORTH = FenceState.stride('north');
const FENCE_STRIDE_EAST = FenceState.stride('east');
const FENCE_STRIDE_SOUTH = FenceState.stride('south');
const FENCE_STRIDE_WEST = FenceState.stride('west');

// collider is taller than the visual model (top = 1.25) so players can't
// hop over fences, and contiguous straight runs collapse to a single
// 4/16-wide strip the full length of the axis so the player slides along
// without catching on a post bulge every block.
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

    // post stands alone when neither axis is a straight pass-through;
    // straight runs already cover the post extent with the wider strip.
    if (!ns && !ew) {
        boxes.push([6 / 16, 0, 6 / 16, 10 / 16, top, 10 / 16]);
    }

    return blockShape.aabbs(boxes);
}

function fenceArmQuads(textures: CubeTextures, side: 'north' | 'south' | 'east' | 'west'): BlockQuad[] {
    // two thin rails per arm (top + bottom), 2/16 wide × 3/16 tall.
    // local UVs so the texture isn't stretched across the narrow rails.
    const quads: BlockQuad[] = [];
    const rail = (from: [number, number, number], to: [number, number, number]) =>
        blockModel.box(from, to, textures, { uvs: 'local' });
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

// connectivity check shared by fence/wall/pane: neighbour is a full solid
// cube (cull=SOLID) or carries the same group flag. avoids the "fence-arm
// stuck into a slab" look that any-collision matching produces.
function hasGroupConnection(
    voxels: import('./voxels').Voxels,
    wx: number, wy: number, wz: number,
    groupFlag: number,
): boolean {
    const id = getBlock(voxels, wx, wy, wz);
    if (id === AIR) return false;
    if (voxels.registry.cull[id]! === CullType.SOLID) return true;
    return (voxels.registry.flags[id]! & groupFlag) !== 0;
}

export function fence(id: string, textures: CubeTextures, options?: PresetOptions) {
    let handle: BlockHandle<typeof FenceState.props>;
    handle = block(id, {
        name: options?.name,
        sounds: options?.sounds,
        material: options?.material ?? MaterialType.OPAQUE,
        states: FenceState,
        defaultState: { north: true, south: true, east: true, west: true },
        shape: (p) => fenceShape(p),
        model: (p) => {
            const quads = [
                ...blockModel.box([6 / 16, 0, 6 / 16], [10 / 16, 1, 10 / 16], textures, { uvs: 'local' }),
            ];
            if (p.north) quads.push(...fenceArmQuads(textures, 'north'));
            if (p.south) quads.push(...fenceArmQuads(textures, 'south'));
            if (p.east) quads.push(...fenceArmQuads(textures, 'east'));
            if (p.west) quads.push(...fenceArmQuads(textures, 'west'));
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
                (north ? FENCE_STRIDE_NORTH : 0)
                + (east ? FENCE_STRIDE_EAST : 0)
                + (south ? FENCE_STRIDE_SOUTH : 0)
                + (west ? FENCE_STRIDE_WEST : 0),
            );
        },
        rotate: (stateId, axis, cw) => {
            if (axis !== 'y') return stateId;
            const p = handle.states.decode(stateId - handle._baseStateId);
            // a neighbour that was at direction D before rotation is at
            // direction rotFacing4(D, cw) after rotation. so the new bool
            // at direction D' = old bool at the direction that rotates *to*
            // D' = rotFacing4(D', !cw).
            return cw
                ? handle.stateId({ north: p.east, east: p.south, south: p.west, west: p.north })
                : handle.stateId({ north: p.west, east: p.north, south: p.east, west: p.south });
        },
        flip: (stateId, axis) => {
            if (axis === 'y') return stateId;
            const p = handle.states.decode(stateId - handle._baseStateId);
            if (axis === 'x') return handle.stateId({ north: p.north, south: p.south, east: p.west, west: p.east });
            return handle.stateId({ east: p.east, west: p.west, north: p.south, south: p.north });
        },
    });
    return handle;
}

// ── pane ────────────────────────────────────────────────────────────
//
// thin 4-way panel (glass pane / iron bars). 2/16-thick central post +
// 2/16-thick full-height arms. connects to full solid cubes or other
// pane-flagged blocks.

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

export function pane(id: string, textures: CubeTextures, options?: PresetOptions) {
    let handle: BlockHandle<typeof PaneState.props>;
    handle = block(id, {
        name: options?.name,
        sounds: options?.sounds,
        states: PaneState,
        defaultState: { north: true, south: true, east: true, west: true },
        material: options?.material ?? MaterialType.TRANSPARENT,
        shape: (p) => paneShape(p),
        model: (p) => {
            const quads = [
                ...blockModel.box([7 / 16, 0, 7 / 16], [9 / 16, 1, 9 / 16], textures, { uvs: 'local' }),
            ];
            if (p.north) quads.push(...blockModel.box([7 / 16, 0, 0], [9 / 16, 1, 7 / 16], textures, { uvs: 'local' }));
            if (p.south) quads.push(...blockModel.box([7 / 16, 0, 9 / 16], [9 / 16, 1, 1], textures, { uvs: 'local' }));
            if (p.east) quads.push(...blockModel.box([9 / 16, 0, 7 / 16], [1, 1, 9 / 16], textures, { uvs: 'local' }));
            if (p.west) quads.push(...blockModel.box([0, 0, 7 / 16], [7 / 16, 1, 9 / 16], textures, { uvs: 'local' }));
            return { type: 'custom' as const, quads };
        },
        cull: CullType.PARTIAL,
        flags: BLOCK_FLAG_PANE,
        onNeighbourUpdate(ctx) {
            const north = hasGroupConnection(ctx.voxels, ctx.worldX, ctx.worldY, ctx.worldZ - 1, BLOCK_FLAG_PANE);
            const south = hasGroupConnection(ctx.voxels, ctx.worldX, ctx.worldY, ctx.worldZ + 1, BLOCK_FLAG_PANE);
            const east = hasGroupConnection(ctx.voxels, ctx.worldX + 1, ctx.worldY, ctx.worldZ, BLOCK_FLAG_PANE);
            const west = hasGroupConnection(ctx.voxels, ctx.worldX - 1, ctx.worldY, ctx.worldZ, BLOCK_FLAG_PANE);
            // PaneState aliases FenceState — same strides apply.
            return handle.stateIdLocal(
                (north ? FENCE_STRIDE_NORTH : 0)
                + (east ? FENCE_STRIDE_EAST : 0)
                + (south ? FENCE_STRIDE_SOUTH : 0)
                + (west ? FENCE_STRIDE_WEST : 0),
            );
        },
        rotate: (stateId, axis, cw) => {
            if (axis !== 'y') return stateId;
            const p = handle.states.decode(stateId - handle._baseStateId);
            return cw
                ? handle.stateId({ north: p.east, east: p.south, south: p.west, west: p.north })
                : handle.stateId({ north: p.west, east: p.north, south: p.east, west: p.south });
        },
        flip: (stateId, axis) => {
            if (axis === 'y') return stateId;
            const p = handle.states.decode(stateId - handle._baseStateId);
            if (axis === 'x') return handle.stateId({ north: p.north, south: p.south, east: p.west, west: p.east });
            return handle.stateId({ east: p.east, west: p.west, north: p.south, south: p.north });
        },
    });
    return handle;
}

// ── carpet ──────────────────────────────────────────────────────────
//
// thin 1/16 layer sitting on the bottom of the cube. no state, no
// neighbour-awareness. visible on top of whatever sits below.

const CARPET_SHAPE = blockShape.aabbs([[0, 0, 0, 1, 1 / 16, 1]]);

export function carpet(id: string, textures: CubeTextures, options?: PresetOptions) {
    return block(id, {
        name: options?.name,
        material: options?.material ?? MaterialType.OPAQUE,
        shape: CARPET_SHAPE,
        model: () => ({
            type: 'custom' as const,
            quads: blockModel.box([0, 0, 0], [1, 1 / 16, 1], textures),
        }),
        cull: CullType.PARTIAL,
        sounds: options?.sounds,
    });
}

// ── trapdoor ────────────────────────────────────────────────────────
//
// independent hinged panel. `facing` is the wall the panel swings
// against when open. `half` is which side of the cube the hinge sits
// on (closed: slab at bottom or top of cube). `open` flips it from
// horizontal slab to vertical panel against the facing wall.

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
        case 'north': return blockShape.aabbs([[0, 0, 0, 1, 1, TRAPDOOR_DEPTH]]);
        case 'south': return blockShape.aabbs([[0, 0, 1 - TRAPDOOR_DEPTH, 1, 1, 1]]);
        case 'east': return blockShape.aabbs([[1 - TRAPDOOR_DEPTH, 0, 0, 1, 1, 1]]);
        case 'west': return blockShape.aabbs([[0, 0, 0, TRAPDOOR_DEPTH, 1, 1]]);
    }
}

function trapdoorQuads(textures: CubeTextures, p: { facing: 'north' | 'east' | 'south' | 'west'; half: 'bottom' | 'top'; open: boolean }): BlockQuad[] {
    const opts = { uvs: 'local' as const };
    if (!p.open) {
        if (p.half === 'bottom') return blockModel.box([0, 0, 0], [1, TRAPDOOR_DEPTH, 1], textures, opts);
        return blockModel.box([0, 1 - TRAPDOOR_DEPTH, 0], [1, 1, 1], textures, opts);
    }
    switch (p.facing) {
        case 'north': return blockModel.box([0, 0, 0], [1, 1, TRAPDOOR_DEPTH], textures, opts);
        case 'south': return blockModel.box([0, 0, 1 - TRAPDOOR_DEPTH], [1, 1, 1], textures, opts);
        case 'east': return blockModel.box([1 - TRAPDOOR_DEPTH, 0, 0], [1, 1, 1], textures, opts);
        case 'west': return blockModel.box([0, 0, 0], [TRAPDOOR_DEPTH, 1, 1], textures, opts);
    }
}

export function trapdoor(id: string, textures: CubeTextures, options?: PresetOptions) {
    let handle: BlockHandle<typeof TrapdoorState.props>;
    handle = block(id, {
        name: options?.name,
        material: options?.material ?? MaterialType.OPAQUE,
        states: TrapdoorState,
        shape: (p) => trapdoorShape(p),
        model: (p) => ({ type: 'custom' as const, quads: trapdoorQuads(textures, p) }),
        cull: CullType.PARTIAL,
        sounds: options?.sounds,
        // placement opens closed: half from where the player clicked, facing
        // toward the placer. open can be toggled later via interaction.
        place: (ctx) => handle.stateId({
            facing: facingFromPlaceCtx(ctx),
            half: halfFromPlaceCtx(ctx),
            open: false,
        }),
        rotate: (stateId, axis, cw) => {
            if (axis !== 'y') return stateId;
            const p = handle.states.decode(stateId - handle._baseStateId);
            return handle.stateId({
                facing: rotFacing4(p.facing as Facing, cw),
                half: p.half,
                open: p.open,
            });
        },
        flip: (stateId, axis) => {
            const p = handle.states.decode(stateId - handle._baseStateId);
            const f = p.facing as Facing;
            if (axis === 'y') {
                return handle.stateId({
                    facing: f, half: p.half === 'top' ? 'bottom' : 'top', open: p.open,
                });
            }
            const table = axis === 'x' ? FACING4_FLIP_X : FACING4_FLIP_Z;
            return handle.stateId({ facing: table[f], half: p.half, open: p.open });
        },
    });
    return handle;
}

// ── plate ───────────────────────────────────────────────────────────
//
// pressure-plate-style pad. half-height when pressed. collision off so
// entities walk over it; `pressed` is driven externally by entity-on-top
// detection in higher-layer code.

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

export function plate(id: string, texture: TextureRef, options?: PresetOptions) {
    return block(id, {
        name: options?.name,
        sounds: options?.sounds,
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
                    { all: { texture } },
                    { uvs: 'local' },
                ),
            };
        },
        cull: CullType.PARTIAL,
        collision: false,
    });
}

// ── wall ────────────────────────────────────────────────────────────
//
// fence's stockier cousin. 8/16-wide post, 6/16-wide full-height arms.
// connects to full solid cubes and other wall-flagged blocks. the post
// extends to y=1 (`up`) when the block above is solid or when the arms
// aren't a clean N+S or E+W straight pass-through.

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

function wallQuads(textures: CubeTextures, p: { north: boolean; east: boolean; south: boolean; west: boolean; up: boolean }): BlockQuad[] {
    const opts = { uvs: 'local' as const };
    const postTop = p.up ? 1 : WALL_POST_SHORT;
    const quads = [
        ...blockModel.box([4 / 16, 0, 4 / 16], [12 / 16, postTop, 12 / 16], textures, opts),
    ];
    if (p.north) quads.push(...blockModel.box([5 / 16, 0, 0], [11 / 16, WALL_POST_SHORT, 4 / 16], textures, opts));
    if (p.south) quads.push(...blockModel.box([5 / 16, 0, 12 / 16], [11 / 16, WALL_POST_SHORT, 1], textures, opts));
    if (p.east) quads.push(...blockModel.box([12 / 16, 0, 5 / 16], [1, WALL_POST_SHORT, 11 / 16], textures, opts));
    if (p.west) quads.push(...blockModel.box([0, 0, 5 / 16], [4 / 16, WALL_POST_SHORT, 11 / 16], textures, opts));
    return quads;
}

export function wall(id: string, textures: CubeTextures, options?: PresetOptions) {
    let handle: BlockHandle<typeof WallState.props>;
    handle = block(id, {
        name: options?.name,
        sounds: options?.sounds,
        material: options?.material ?? MaterialType.OPAQUE,
        states: WallState,
        defaultState: { north: true, south: true, east: true, west: true, up: true },
        shape: (p) => wallShape(p),
        model: (p) => ({ type: 'custom' as const, quads: wallQuads(textures, p) }),
        cull: CullType.PARTIAL,
        flags: BLOCK_FLAG_WALL,
        onNeighbourUpdate(ctx) {
            const north = hasGroupConnection(ctx.voxels, ctx.worldX, ctx.worldY, ctx.worldZ - 1, BLOCK_FLAG_WALL);
            const south = hasGroupConnection(ctx.voxels, ctx.worldX, ctx.worldY, ctx.worldZ + 1, BLOCK_FLAG_WALL);
            const east = hasGroupConnection(ctx.voxels, ctx.worldX + 1, ctx.worldY, ctx.worldZ, BLOCK_FLAG_WALL);
            const west = hasGroupConnection(ctx.voxels, ctx.worldX - 1, ctx.worldY, ctx.worldZ, BLOCK_FLAG_WALL);
            // `up` rule: the post extends full height when something rests
            // on the wall or when the arm layout isn't a clean straight pass.
            // exactly two opposite arms (N+S or E+W only) gives the low post.
            const above = getBlock(ctx.voxels, ctx.worldX, ctx.worldY + 1, ctx.worldZ);
            const aboveSolid = above !== AIR && ctx.voxels.registry.cull[above]! === CullType.SOLID;
            const straightNS = north && south && !east && !west;
            const straightEW = east && west && !north && !south;
            const up = aboveSolid || !(straightNS || straightEW);
            return handle.stateIdLocal(
                (north ? WALL_STRIDE_NORTH : 0)
                + (east ? WALL_STRIDE_EAST : 0)
                + (south ? WALL_STRIDE_SOUTH : 0)
                + (west ? WALL_STRIDE_WEST : 0)
                + (up ? WALL_STRIDE_UP : 0),
            );
        },
        rotate: (stateId, axis, cw) => {
            if (axis !== 'y') return stateId;
            const p = handle.states.decode(stateId - handle._baseStateId);
            return cw
                ? handle.stateId({ north: p.east, east: p.south, south: p.west, west: p.north, up: p.up })
                : handle.stateId({ north: p.west, east: p.north, south: p.east, west: p.south, up: p.up });
        },
        flip: (stateId, axis) => {
            if (axis === 'y') return stateId;
            const p = handle.states.decode(stateId - handle._baseStateId);
            if (axis === 'x') return handle.stateId({ north: p.north, south: p.south, east: p.west, west: p.east, up: p.up });
            return handle.stateId({ east: p.east, west: p.west, north: p.south, south: p.north, up: p.up });
        },
    });
    return handle;
}

// ── torch ───────────────────────────────────────────────────────────
//
// floor or wall-mounted torch. `mount` records which side the torch is
// attached to: 'floor' for a standing torch, or 'north'/'east'/'south'
// /'west' when mounted on the corresponding wall (the wall is in that
// direction from this cell).
//
// onNeighbourUpdate prefers floor-mount when the block below is solid;
// otherwise picks the first solid horizontal neighbour. with no
// support at all the torch stays in its current orientation rather
// than dropping — floating torches are allowed.

const TorchState = blockState.create({
    mount: blockState.enumeration(['floor', 'north', 'east', 'south', 'west'] as const),
});

const TORCH_FLOOR_SHAPE = blockShape.aabbs([[7 / 16, 0, 7 / 16, 9 / 16, 10 / 16, 9 / 16]]);
const TORCH_NORTH_SHAPE = blockShape.aabbs([[7 / 16, 3 / 16, 0, 9 / 16, 13 / 16, 4 / 16]]);
const TORCH_SOUTH_SHAPE = blockShape.aabbs([[7 / 16, 3 / 16, 12 / 16, 9 / 16, 13 / 16, 1]]);
const TORCH_EAST_SHAPE = blockShape.aabbs([[12 / 16, 3 / 16, 7 / 16, 1, 13 / 16, 9 / 16]]);
const TORCH_WEST_SHAPE = blockShape.aabbs([[0, 3 / 16, 7 / 16, 4 / 16, 13 / 16, 9 / 16]]);

function torchShape(mount: 'floor' | 'north' | 'east' | 'south' | 'west') {
    switch (mount) {
        case 'floor': return TORCH_FLOOR_SHAPE;
        case 'north': return TORCH_NORTH_SHAPE;
        case 'south': return TORCH_SOUTH_SHAPE;
        case 'east': return TORCH_EAST_SHAPE;
        case 'west': return TORCH_WEST_SHAPE;
    }
}

function torchQuads(texture: TextureRef, mount: 'floor' | 'north' | 'east' | 'south' | 'west'): BlockQuad[] {
    const tex: CubeTextures = { all:  { texture } };
    const opts = { uvs: 'local' as const };
    switch (mount) {
        case 'floor':
            return blockModel.box([7 / 16, 0, 7 / 16], [9 / 16, 10 / 16, 9 / 16], tex, opts);
        case 'north':
            return blockModel.box([7 / 16, 3 / 16, 0], [9 / 16, 13 / 16, 4 / 16], tex, opts);
        case 'south':
            return blockModel.box([7 / 16, 3 / 16, 12 / 16], [9 / 16, 13 / 16, 1], tex, opts);
        case 'east':
            return blockModel.box([12 / 16, 3 / 16, 7 / 16], [1, 13 / 16, 9 / 16], tex, opts);
        case 'west':
            return blockModel.box([0, 3 / 16, 7 / 16], [4 / 16, 13 / 16, 9 / 16], tex, opts);
    }
}

function isTorchSupport(voxels: import('./voxels').Voxels, wx: number, wy: number, wz: number): boolean {
    const id = getBlock(voxels, wx, wy, wz);
    if (id === AIR) return false;
    return (voxels.registry.flags[id]! & BLOCK_FLAG_COLLISION) !== 0;
}

export function torch(
    id: string,
    texture: TextureRef,
    options?: PresetOptions & { lightEmission?: [number, number, number] },
) {
    const emission = options?.lightEmission ?? [14, 12, 6];
    let handle: BlockHandle<typeof TorchState.props>;
    handle = block(id, {
        name: options?.name,
        sounds: options?.sounds,
        material: options?.material ?? MaterialType.OPAQUE,
        states: TorchState,
        shape: (p) => torchShape(p.mount),
        model: (p) => ({ type: 'custom' as const, quads: torchQuads(texture, p.mount) }),
        cull: CullType.PARTIAL,
        collision: false,
        emissive: true,
        lightEmission: () => emission,
        onNeighbourUpdate(ctx) {
            if (isTorchSupport(ctx.voxels, ctx.worldX, ctx.worldY - 1, ctx.worldZ)) {
                return handle.stateId({ mount: 'floor' });
            }
            if (isTorchSupport(ctx.voxels, ctx.worldX, ctx.worldY, ctx.worldZ - 1)) {
                return handle.stateId({ mount: 'north' });
            }
            if (isTorchSupport(ctx.voxels, ctx.worldX + 1, ctx.worldY, ctx.worldZ)) {
                return handle.stateId({ mount: 'east' });
            }
            if (isTorchSupport(ctx.voxels, ctx.worldX, ctx.worldY, ctx.worldZ + 1)) {
                return handle.stateId({ mount: 'south' });
            }
            if (isTorchSupport(ctx.voxels, ctx.worldX - 1, ctx.worldY, ctx.worldZ)) {
                return handle.stateId({ mount: 'west' });
            }
            return ctx.stateId;
        },
        rotate: (stateId, axis, cw) => {
            if (axis !== 'y') return stateId;
            const p = handle.states.decode(stateId - handle._baseStateId);
            if (p.mount === 'floor') return stateId;
            return handle.stateId({ mount: rotFacing4(p.mount as Facing, cw) });
        },
        flip: (stateId, axis) => {
            if (axis === 'y') return stateId;
            const p = handle.states.decode(stateId - handle._baseStateId);
            if (p.mount === 'floor') return stateId;
            const table = axis === 'x' ? FACING4_FLIP_X : FACING4_FLIP_Z;
            return handle.stateId({ mount: table[p.mount as Facing] });
        },
    });
    return handle;
}
