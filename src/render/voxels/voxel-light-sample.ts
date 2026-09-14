// ── voxel light volume: shader-side sampling ────────────────────────
//
// The read half of `voxel-light-volume.ts`, shared by every consumer. Two entry
// points, because terrain and everything else address the lattice differently:
//
//   - TERRAIN knows its chunk and its exact integer corner (block-local + face +
//     corner index), so it fetches one corner directly. No interpolation, and
//     every face touching a corner reads the same value, so light cannot
//     disagree across a shared vertex.
//   - ENTITIES / SPRITES / PARTICLES have an arbitrary world position, so they
//     resolve the chunk through the residency grid and blend the surrounding
//     corners.
//
// These are plain node-building functions, not `Fn` wrappers, because they read
// `storage()` buffers and the codebase's convention is that `storage()` is bound
// by name inside a shader-building function (see `voxel-material.ts`,
// `mesh-resources.ts`). The caller declares the buffers and passes the nodes in,
// exactly as `unpackVoxelLight` takes an already-fetched `Node<d.u32>`.
//
// BUFFER NAMES the caller must bind:
//   `lightTiles`  d.array(d.u32)  the tile arena  (LightVolume.buffer)
//   `lightGrid`   d.array(d.i32)  the residency grid (LightVolume.gridBuffer)
// plus the grid's shape, `LightVolumeConfig`, a frameGroup uniform on
// `EnvironmentResources` whose value is pointed at the live volume by
// `VoxelResources.init` (the same way env config is flushed per room). Three
// ints do not earn a storage binding, and storage bindings per stage are the
// scarce resource (8 by default; the baked-mesh material was at 9).

import { abs, d, f32, floor, type Geometry, i32, max, min, type Node, select, storage, u32, vec3f, vec4f } from 'gpucat';

import { CHUNK_SIZE } from '../../core/voxels/voxels';
import type { EnvironmentResources } from '../environment/environment';
import type { LightVolume } from './voxel-light-volume';
import { TILE_LIGHT_U32S, TILE_U32S } from './voxel-light-volume';

/** the `LightVolumeConfig` uniform's value for a volume (the struct lives on
 *  `EnvironmentResources`, which owns the uniform; this module only reads it). */
export function lightVolumeConfigOf(volume: LightVolume): { mask: number; rowStride: number; sliceStride: number } {
    return { mask: volume.mask, rowStride: volume.dim, sliceStride: volume.dim * volume.dim };
}

/**
 * Sodium-aligned brightness curve, `f(x) = (-0.5x + 1.5) * x * x` on [0, 1].
 * Lives here rather than in `voxel-material` so the dependency runs one way:
 * every consumer of light imports this module, and this module imports none of
 * them. (voxel-material used to own it, which would have made a cycle.)
 */
export function brightnessCurve(x: Node<d.f32>): Node<d.f32> {
    return x.mul(f32(-0.5)).add(f32(1.5)).mul(x).mul(x);
}

/** packed u16 with sky=15, rgb=0. The value a MISS resolves to, matching
 *  `light-lattice.ts`'s absent-chunk read and the mesher's sky-lit void. */
const SKY_FULL = 0xf000;

/**
 * Split a packed lattice u16 (`sky4|R4|G4|B4`) into `vec4f(sky, r, g, b)`, each
 * 0..1 with `brightnessCurve` applied.
 *
 * Deliberately returns the channels SEPARATELY rather than a combined colour.
 * Consumers do not agree on how sky and block light combine: terrain
 * (`unpackVoxelLight`) is additive-clamped, particles take `max`. Combining here
 * would silently move every consumer onto one of those. The volume is a data
 * source; the combine stays a look decision at the consumer.
 */
export function latticeChannels(packed: Node<d.u32>): Node<d.vec4f> {
    const nib = (shift: number) => brightnessCurve(packed.shiftRight(u32(shift)).bitwiseAnd(u32(0xf)).toF32().div(f32(15.0)));
    return vec4f(nib(12), nib(8), nib(4), nib(0));
}

/** flat cell index within a chunk, matching `voxelIndex`'s YZX order. */
function cellIndexNode(lx: Node<d.i32>, ly: Node<d.i32>, lz: Node<d.i32>): Node<d.u32> {
    return ly
        .mul(i32(256))
        .add(lz.mul(i32(16)))
        .add(lx)
        .toU32();
}

/** one cell's packed light from a resolved tile. Two cells per u32, low first. */
function fetchCell(tiles: Node<d.array<d.u32>>, base: Node<d.u32>, cellIdx: Node<d.u32>): Node<d.u32> {
    const word = tiles.element(base.add(cellIdx.shiftRight(u32(1))));
    const hi = word.shiftRight(u32(16)).bitwiseAnd(u32(0xffff));
    const lo = word.bitwiseAnd(u32(0xffff));
    return select(hi, lo, cellIdx.bitwiseAnd(u32(1)).equal(u32(0)));
}

/** one cell's solidity bit from the tile's trailing bitset. */
function fetchCellSolid(tiles: Node<d.array<d.u32>>, base: Node<d.u32>, cellIdx: Node<d.u32>): Node<d.u32> {
    const word = tiles.element(base.add(u32(TILE_LIGHT_U32S)).add(cellIdx.shiftRight(u32(5))));
    return word.shiftRight(cellIdx.bitwiseAnd(u32(31))).bitwiseAnd(u32(1));
}

// ── binding ─────────────────────────────────────────────────────────

/** The volume's buffers as shader nodes, plus its grid dims. */
export type LightVolumeNodes = {
    tiles: Node<d.array<d.u32>>;
    grid: Node<d.array<d.i32>>;
    mask: Node<d.i32>;
    /** row stride (`dim`) and slice stride (`dim*dim`); see `LightVolumeConfig`. */
    rowStride: Node<d.i32>;
    sliceStride: Node<d.i32>;
};

/**
 * Bind the volume: the two big buffers by name, the shape from the env-held
 * uniform. Call this INSIDE a material builder, the same way `voxel-material.ts`
 * binds `quads` / `chunkInfo`; the per-room resources route the actual buffers
 * to these names with `setBuffer`.
 */
export function bindLightVolume(env: EnvironmentResources): LightVolumeNodes {
    const tiles = storage('lightTiles', d.array(d.u32), 'read');
    const grid = storage('lightGrid', d.array(d.i32), 'read');
    const config = env.lightVolumeCfgNode;
    return {
        tiles,
        grid,
        mask: config.mask,
        rowStride: config.rowStride,
        sliceStride: config.sliceStride,
    };
}

/**
 * Route a volume's buffers to the names `bindLightVolume` binds. Every consumer
 * needs the same two, so this lives here rather than being restated by each
 * resources module.
 */
export function routeLightVolumeBuffers(geometry: Geometry, volume: LightVolume): void {
    geometry.setBuffer('lightTiles', volume.buffer);
    geometry.setBuffer('lightGrid', volume.gridBuffer);
}

// ── residency lookup ────────────────────────────────────────────────

/** mirrors `voxel-light-volume.ts`'s packed entry: slot+1 in the low bits, a
 *  coord check above it. ONE read per lookup instead of four. */
const ENTRY_SLOT_BITS = 12;
const ENTRY_SLOT_MASK = (1 << ENTRY_SLOT_BITS) - 1;

/**
 * A resolved world cell: where its tile starts, and which cell within it.
 *
 * Resolved ONCE and reused for both the light and the solidity fetch. Each used
 * to resolve independently, so every tap paid the grid lookup and the chunk/local
 * float split twice over - the single largest waste in the sampler.
 */
export type CellRef = {
    /** tile base in u32, or -1 when the chunk is not resident. */
    base: Node<d.i32>;
    idx: Node<d.u32>;
};

/**
 * Resolve a WORLD cell.
 *
 * Chunk and local coords are derived in float, because WGSL requires a shift
 * amount to be u32 while gpucat's node types insist it match the value, so an
 * i32 `>> 4` cannot be expressed; `floor` is also correct for negative coords
 * where an integer divide truncates toward zero.
 *
 * The coord check separates ALIASES: the grid wraps, so a chunk outside the
 * window lands on a cell a nearer chunk owns, and verifying is what turns that
 * into a clean miss rather than plausible-looking wrong light.
 */
export function resolveCell(v: LightVolumeNodes, wx: Node<d.f32>, wy: Node<d.f32>, wz: Node<d.f32>): CellRef {
    const dimF = v.rowStride.toF32();
    const ccxF = floor(wx.div(f32(CHUNK_SIZE))).toVar('rcCcx');
    const ccyF = floor(wy.div(f32(CHUNK_SIZE))).toVar('rcCcy');
    const cczF = floor(wz.div(f32(CHUNK_SIZE))).toVar('rcCcz');
    const ccx = ccxF.toI32();
    const ccy = ccyF.toI32();
    const ccz = cczF.toI32();

    const cell = ccx
        .bitwiseAnd(v.mask)
        .add(ccy.bitwiseAnd(v.mask).mul(v.rowStride))
        .add(ccz.bitwiseAnd(v.mask).mul(v.sliceStride));
    const entry = v.grid.element(cell).toVar('rcEntry');

    const check = floor(ccxF.div(dimF))
        .toI32()
        .bitwiseAnd(i32(0x3f))
        .add(floor(ccyF.div(dimF)).toI32().bitwiseAnd(i32(0x3f)).mul(i32(64)))
        .add(floor(cczF.div(dimF)).toI32().bitwiseAnd(i32(0x3f)).mul(i32(4096)));
    // `/ 2^bits` rather than `>> bits`: WGSL wants a u32 shift amount while
    // gpucat's node types want it to match the i32 value, and the entry is always
    // positive so integer division is the same thing.
    const ok = entry.notEqual(i32(0)).and(entry.div(i32(1 << ENTRY_SLOT_BITS)).equal(check));

    const slot = entry.bitwiseAnd(i32(ENTRY_SLOT_MASK));
    const base = select(i32(-1), slot.sub(i32(1)).mul(i32(TILE_U32S)), ok).toVar('rcBase');

    // local coords come from the SAME floors, not a second set
    const lx = wx.sub(ccxF.mul(f32(CHUNK_SIZE))).toI32();
    const ly = wy.sub(ccyF.mul(f32(CHUNK_SIZE))).toI32();
    const lz = wz.sub(cczF.mul(f32(CHUNK_SIZE))).toI32();
    return { base, idx: cellIndexNode(lx, ly, lz) };
}

/** one resolved cell's packed light, SKY_FULL when its chunk is not resident. */
function cellLightAt(v: LightVolumeNodes, c: CellRef): Node<d.u32> {
    return select(u32(SKY_FULL), fetchCell(v.tiles, c.base.toU32(), c.idx), c.base.greaterThan(i32(-1)));
}

/** one resolved cell's solidity. A non-resident chunk is NOT solid, so a face at
 *  the residency edge shades against open sky rather than a phantom wall. */
function cellSolidAt(v: LightVolumeNodes, c: CellRef): Node<d.u32> {
    return select(u32(0), fetchCellSolid(v.tiles, c.base.toU32(), c.idx), c.base.greaterThan(i32(-1)));
}

/** min-non-zero substitution over 4 inputs, the mesher's rule: a zero is "no
 *  data" and takes the smallest non-zero, then a plain mean. All zero stays 0. */
function blendChannel4(a: Node<d.u32>, b: Node<d.u32>, c: Node<d.u32>, dd: Node<d.u32>): Node<d.u32> {
    const nz = (x: Node<d.u32>) => select(u32(16), x, x.notEqual(u32(0)));
    const m = min(min(nz(a), nz(b)), min(nz(c), nz(dd))).toVar('blendMin');
    const sub = (x: Node<d.u32>) => select(m, x, x.notEqual(u32(0)));
    const sum = sub(a).add(sub(b)).add(sub(c)).add(sub(dd));
    return select(sum.shiftRight(u32(2)), u32(0), m.equal(u32(16)));
}

/** split a packed cell into `vec4f(sky, r, g, b)`, curve applied. */
function cellChannels(packed: Node<d.u32>): Node<d.vec4f> {
    return latticeChannels(packed);
}

/**
 * TERRAIN entry point. The light a face with normal `n` shows at one of its
 * corners, for the block at WORLD position `b`.
 *
 * Reads ONLY the four cells on the face's own side - the mesher's
 * centre/edgeA/edgeB/diagonal tap - so the far side of the surface is never in
 * the input set and light cannot leak across a corner diagonal. A shared,
 * pre-blended corner value cannot avoid that leak: a corner joins cells light
 * cannot travel between, and one number cannot be both lit and dark.
 *
 * The corner is identified by the VERTEX POSITION rather than a corner index, so
 * this does not assume the mesher's corner ordering: the offsets are the sign of
 * the vertex relative to the block centre along each in-plane axis.
 */
export function lightAtFaceCorner(
    v: LightVolumeNodes,
    bx: Node<d.f32>,
    by: Node<d.f32>,
    bz: Node<d.f32>,
    nx: Node<d.i32>,
    ny: Node<d.i32>,
    nz: Node<d.i32>,
    vx: Node<d.f32>,
    vy: Node<d.f32>,
    vz: Node<d.f32>,
): Node<d.vec4f> {
    // in-plane basis, chosen per normal so neither axis is the normal
    const ux = select(f32(0), f32(1), nx.equal(i32(0))).toVar('lfcUx');
    const uy = select(f32(0), f32(1), nx.notEqual(i32(0))).toVar('lfcUy');
    const wy2 = select(f32(0), f32(1), nz.notEqual(i32(0))).toVar('lfcVy');
    const wz2 = select(f32(0), f32(1), nz.equal(i32(0))).toVar('lfcVz');

    // corner offsets from the vertex's side of the block centre
    const uVert = ux.mul(vx).add(uy.mul(vy));
    const uMid = ux.mul(bx.add(f32(0.5))).add(uy.mul(by.add(f32(0.5))));
    const vVert = wy2.mul(vy).add(wz2.mul(vz));
    const vMid = wy2.mul(by.add(f32(0.5))).add(wz2.mul(bz.add(f32(0.5))));
    const ouRaw = select(f32(-1), f32(1), uVert.greaterThanEqual(uMid));
    const ovRaw = select(f32(-1), f32(1), vVert.greaterThanEqual(vMid));

    // THE BASIS ABOVE ONLY HOLDS FOR AN AXIS-ALIGNED NORMAL. A cross quad (grass,
    // flowers, any plant) has a ~45 degree normal, which the caller rounds to two
    // non-zero components - and then `u` and `v` both collapse onto Y, while
    // `centre` lands on a DIAGONAL neighbour rather than the cell in front of the
    // face. Inside terrain that reads 0 on all four taps and the quad renders
    // black.
    //
    // For those quads there is no face to anchor to: the plant sits IN a cell, so
    // its light is that cell's, flat. Collapsing the normal and both corner offsets
    // to zero makes centre/edge/edge/diagonal all resolve to the block's own cell,
    // and a blend of four identical values is that value. Same tap count, so this
    // costs nothing on the axis-aligned path. Matches how MC lights cross quads.
    const axisAligned = abs(nx).add(abs(ny)).add(abs(nz)).equal(i32(1)).toVar('lfcAligned');
    const zero = f32(0);
    const ou = select(zero, ouRaw, axisAligned).toVar('lfcOu');
    const ov = select(zero, ovRaw, axisAligned).toVar('lfcOv');

    // centre is the cell BEYOND the face, which is what the mesher sampled
    const cx = bx.add(select(zero, nx.toF32(), axisAligned)).toVar('lfcCx');
    const cy = by.add(select(zero, ny.toF32(), axisAligned)).toVar('lfcCy');
    const cz = bz.add(select(zero, nz.toF32(), axisAligned)).toVar('lfcCz');

    const e0x = cx.add(ux.mul(ou));
    const e0y = cy.add(uy.mul(ou));
    const e1y = cy.add(wy2.mul(ov));
    const e1z = cz.add(wz2.mul(ov));
    const dgx = cx.add(ux.mul(ou));
    const dgy = cy.add(uy.mul(ou)).add(wy2.mul(ov));
    const dgz = cz.add(wz2.mul(ov));

    // FOUR resolves, not six: e0 and e1 need both light and solidity, and each
    // used to resolve twice over.
    const rCentre = resolveCell(v, cx, cy, cz);
    const rE0 = resolveCell(v, e0x, e0y, cz);
    const rE1 = resolveCell(v, cx, e1y, e1z);
    const rDiag = resolveCell(v, dgx, dgy, dgz);

    // both edges opaque: the diagonal is unreachable, so substitute an edge.
    // The mesher's anti-leak fixup, and why a 2x2 pinch does not bleed.
    const bothSolid = cellSolidAt(v, rE0)
        .equal(u32(1))
        .and(cellSolidAt(v, rE1).equal(u32(1)));

    const w0 = cellLightAt(v, rCentre).toVar('lfcW0');
    const w1 = cellLightAt(v, rE0).toVar('lfcW1');
    const w2 = cellLightAt(v, rE1).toVar('lfcW2');
    const w3 = select(cellLightAt(v, rDiag), w1, bothSolid).toVar('lfcW3');

    const nib = (w: Node<d.u32>, sh: number) => w.shiftRight(u32(sh)).bitwiseAnd(u32(0xf));
    return cellChannels(
        blendChannel4(nib(w0, 12), nib(w1, 12), nib(w2, 12), nib(w3, 12))
            .shiftLeft(u32(12))
            .bitwiseOr(blendChannel4(nib(w0, 8), nib(w1, 8), nib(w2, 8), nib(w3, 8)).shiftLeft(u32(8)))
            .bitwiseOr(blendChannel4(nib(w0, 4), nib(w1, 4), nib(w2, 4), nib(w3, 4)).shiftLeft(u32(4)))
            .bitwiseOr(blendChannel4(nib(w0, 0), nib(w1, 0), nib(w2, 0), nib(w3, 0))),
    );
}

/**
 * Sky and block light combined the way TERRAIN does it: additive, clamped.
 * Deliberately not `max` (what sprites and particles use) - the combine is the
 * consumer's choice. Additive lets a torch fill sky shadow instead of a dark sky
 * corner overriding it.
 */
export function combineVoxelLight(channels: Node<d.vec4f>, skyBrightness: Node<d.f32>): Node<d.vec3f> {
    const sky = channels.x.mul(skyBrightness);
    return min(vec3f(channels.y, channels.z, channels.w).add(vec3f(sky, sky, sky)), vec3f(f32(1.0), f32(1.0), f32(1.0)));
}

/**
 * ENTITY / SPRITE / PARTICLE entry point: TETRAHEDRAL interpolation over the
 * cells around `worldPos`, as `vec4f(sky, r, g, b)`.
 *
 * Four taps, not eight. The cube around a sample splits into six tetrahedra; the
 * one containing it is picked by the ordering of the fractional coordinates, and
 * its corners are `(0,0,0)`, the max axis, the complement of the min axis, and
 * `(1,1,1)`, with weights `(1-wmax, wmax-wmid, wmid-wmin, wmin)`.
 *
 * Interpolated over CELL CENTRES, because light is defined per cell. A single
 * fetch of the containing cell was tried: it is what MC, Luanti, Veloren and
 * Cubyz do, but they interpolate nothing at all so their light cannot visibly
 * step, whereas ours moved with the entity and jittered at every cell boundary.
 *
 * SOLID CELLS ARE EXCLUDED from the weighted mean, or a solid cell - which holds
 * no light - would still carry weight and drag an entity dark near a wall.
 */
export function sampleWorldLight(v: LightVolumeNodes, worldPos: Node<d.vec3f>): Node<d.vec4f> {
    // cell CENTRES sit at +0.5, so the interpolation lattice is offset half a cell
    const px = worldPos.x.sub(f32(0.5)).toVar('swlPx');
    const py = worldPos.y.sub(f32(0.5)).toVar('swlPy');
    const pz = worldPos.z.sub(f32(0.5)).toVar('swlPz');
    const bx = floor(px).toVar('swlBx');
    const by = floor(py).toVar('swlBy');
    const bz = floor(pz).toVar('swlBz');
    const wx = px.sub(bx).toVar('swlWx');
    const wy = py.sub(by).toVar('swlWy');
    const wz = pz.sub(bz).toVar('swlWz');

    // which axis is largest / smallest picks the tetrahedron. Ties resolve to a
    // single axis by the cascade, so the four corners are always distinct.
    const maxX = wx.greaterThanEqual(wy).and(wx.greaterThanEqual(wz)).toVar('swlMaxX');
    const maxY = maxX.not().and(wy.greaterThanEqual(wz)).toVar('swlMaxY');
    const minZ = wz.lessThanEqual(wx).and(wz.lessThanEqual(wy)).toVar('swlMinZ');
    const minY = minZ.not().and(wy.lessThanEqual(wx)).toVar('swlMinY');
    const minX = minZ.not().and(minY.not()).toVar('swlMinX');

    const o1x = select(f32(0), f32(1), maxX).toVar('swlO1x');
    const o1y = select(f32(0), f32(1), maxY).toVar('swlO1y');
    const o1z = f32(1).sub(o1x).sub(o1y).toVar('swlO1z');
    // off2 is (1,1,1) minus the min axis
    const o2x = select(f32(1), f32(0), minX).toVar('swlO2x');
    const o2y = select(f32(1), f32(0), minY).toVar('swlO2y');
    const o2z = select(f32(1), f32(0), minZ).toVar('swlO2z');

    const wmax = max(wx, max(wy, wz)).toVar('swlWmax');
    const wmin = min(wx, min(wy, wz)).toVar('swlWmin');
    const wmid = wx.add(wy).add(wz).sub(wmax).sub(wmin).toVar('swlWmid');

    const offs: [Node<d.f32>, Node<d.f32>, Node<d.f32>][] = [
        [f32(0), f32(0), f32(0)],
        [o1x, o1y, o1z],
        [o2x, o2y, o2z],
        [f32(1), f32(1), f32(1)],
    ];
    const weights = [f32(1).sub(wmax), wmax.sub(wmid), wmid.sub(wmin), wmin];

    // folded as a pure expression: `Var`/`assign` are control flow and are only
    // legal inside an `Fn` body, while this is called from material builders.
    const taps: Node<d.vec4f>[] = [];
    const tapWeights: Node<d.f32>[] = [];
    for (let k = 0; k < 4; k++) {
        const [dx, dy, dz] = offs[k]!;
        const cx = bx.add(dx);
        const cy = by.add(dy);
        const cz = bz.add(dz);
        const ref = resolveCell(v, cx, cy, cz);
        const w = weights[k]!.mul(select(f32(1), f32(0), cellSolidAt(v, ref).equal(u32(1)))).toVar(`swlW${k}`);
        const packed = cellLightAt(v, ref).toVar(`swlP${k}`);
        const nib = (sh: number) => packed.shiftRight(u32(sh)).bitwiseAnd(u32(0xf)).toF32();
        taps.push(vec4f(nib(12), nib(8), nib(4), nib(0)).mul(w));
        tapWeights.push(w);
    }
    const acc = taps[0]!.add(taps[1]!).add(taps[2]!).add(taps[3]!).toVar('swlAcc');
    const wsum = tapWeights[0]!.add(tapWeights[1]!).add(tapWeights[2]!).add(tapWeights[3]!).toVar('swlWsum');

    // accumulate RAW nibbles and curve ONCE, so the curve acts on the final level
    const mean = acc.div(max(wsum, f32(0.0001))).div(f32(15.0));
    const lit = vec4f(brightnessCurve(mean.x), brightnessCurve(mean.y), brightnessCurve(mean.z), brightnessCurve(mean.w));
    // every tap solid: the sample is inside geometry, so there is no light to
    // find and no sensible neighbour to borrow from.
    return select(vec4f(f32(0), f32(0), f32(0), f32(0)), lit, wsum.greaterThan(f32(0)));
}
