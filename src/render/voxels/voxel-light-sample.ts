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

/** Sodium-style brightness curve, `f(x) = (-0.5x + 1.5) * x * x` on [0, 1].
 *  Lives here so light consumers import this module, never the reverse. */
export function brightnessCurve(x: Node<d.f32>): Node<d.f32> {
    return x.mul(f32(-0.5)).add(f32(1.5)).mul(x).mul(x);
}

/** packed u16 with sky=15, rgb=0. The value a MISS resolves to, matching
 *  `light-lattice.ts`'s absent-chunk read and the mesher's sky-lit void. */
const SKY_FULL = 0xf000;

/** Splits a packed lattice u16 (sky4|R4|G4|B4) into vec4f(sky, r, g, b), each 0..1 with
 *  brightnessCurve applied. Channels stay separate since consumers combine them differently
 *  (terrain is additive-clamped, particles take max); the combine is a consumer choice. */
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

/** The volume's buffers as shader nodes, plus its grid dims. */
export type LightVolumeNodes = {
    tiles: Node<d.array<d.u32>>;
    grid: Node<d.array<d.i32>>;
    mask: Node<d.i32>;
    /** row stride (`dim`) and slice stride (`dim*dim`); see `LightVolumeConfig`. */
    rowStride: Node<d.i32>;
    sliceStride: Node<d.i32>;
};

/** Binds the volume's two buffers by name plus its shape from the env-held uniform.
 *  Call inside a material builder; per-room resources route buffers to these names via setBuffer. */
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

/** Routes a volume's buffers to the names bindLightVolume binds. */
export function routeLightVolumeBuffers(geometry: Geometry, volume: LightVolume): void {
    geometry.setBuffer('lightTiles', volume.buffer);
    geometry.setBuffer('lightGrid', volume.gridBuffer);
}

/** mirrors voxel-light-volume.ts's packed entry: slot+1 in the low bits, a coord check above it. */
const ENTRY_SLOT_BITS = 12;
const ENTRY_SLOT_MASK = (1 << ENTRY_SLOT_BITS) - 1;

/** A resolved world cell: where its tile starts, and which cell within it.
 *  Resolved once and reused for both the light and the solidity fetch. */
export type CellRef = {
    /** tile base in u32, or -1 when the chunk is not resident. */
    base: Node<d.i32>;
    idx: Node<d.u32>;
};

/** Resolves a world cell. Chunk and local coords are derived in float since WGSL
 *  needs a u32 shift amount that gpucat's node types can't express from an i32, and
 *  floor is also correct for negative coords where integer divide truncates toward zero.
 *  The coord check catches grid aliases: the grid wraps, so verifying turns a chunk
 *  landing on a nearer chunk's cell into a clean miss rather than wrong light. */
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
    // division stands in for a shift here since entry is always positive.
    const ok = entry.notEqual(i32(0)).and(entry.div(i32(1 << ENTRY_SLOT_BITS)).equal(check));

    const slot = entry.bitwiseAnd(i32(ENTRY_SLOT_MASK));
    const base = select(i32(-1), slot.sub(i32(1)).mul(i32(TILE_U32S)), ok).toVar('rcBase');

    // local coords reuse the same floors, not a second set
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

/** Terrain entry point: the light a face with normal n shows at one of its corners, for
 *  the block at world position b. Reads only the four cells on the face's own side (the
 *  mesher's centre/edgeA/edgeB/diagonal tap) so light cannot leak across a corner diagonal.
 *  The corner is identified by vertex position rather than a corner index, so this does
 *  not assume the mesher's corner ordering. */
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

    // the basis above only holds for an axis-aligned normal. a cross quad (grass, flowers)
    // has no face to anchor to, so collapsing the normal and corner offsets to zero makes
    // all four taps resolve to the block's own cell, giving it flat light at no extra cost.
    const axisAligned = abs(nx).add(abs(ny)).add(abs(nz)).equal(i32(1)).toVar('lfcAligned');
    const zero = f32(0);
    const ou = select(zero, ouRaw, axisAligned).toVar('lfcOu');
    const ov = select(zero, ovRaw, axisAligned).toVar('lfcOv');

    // centre is the cell beyond the face, matching what the mesher sampled
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

    // four resolves, not six: e0 and e1 each need both light and solidity.
    const rCentre = resolveCell(v, cx, cy, cz);
    const rE0 = resolveCell(v, e0x, e0y, cz);
    const rE1 = resolveCell(v, cx, e1y, e1z);
    const rDiag = resolveCell(v, dgx, dgy, dgz);

    // both edges opaque: the diagonal is unreachable, so substitute an edge.
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

/** Sky and block light combined the way terrain does it: additive, clamped (not max, which
 *  sprites and particles use). Additive lets a torch fill sky shadow instead of being overridden. */
export function combineVoxelLight(channels: Node<d.vec4f>, skyBrightness: Node<d.f32>): Node<d.vec3f> {
    const sky = channels.x.mul(skyBrightness);
    return min(vec3f(channels.y, channels.z, channels.w).add(vec3f(sky, sky, sky)), vec3f(f32(1.0), f32(1.0), f32(1.0)));
}

/** Entity/sprite/particle entry point: tetrahedral interpolation over the cells around
 *  worldPos, as vec4f(sky, r, g, b). Four taps, not eight: the cube around a sample splits
 *  into six tetrahedra, and the one containing it is picked by the ordering of the
 *  fractional coordinates, with corners (0,0,0), the max axis, the complement of the min
 *  axis, and (1,1,1), weighted (1-wmax, wmax-wmid, wmid-wmin, wmin). Interpolated over cell
 *  centres since light is defined per cell. Solid cells are excluded from the weighted mean,
 *  or one would still carry weight and drag an entity dark near a wall. */
export function sampleWorldLight(v: LightVolumeNodes, worldPos: Node<d.vec3f>): Node<d.vec4f> {
    // cell centres sit at +0.5, so the interpolation lattice is offset half a cell
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

    // accumulate raw nibbles and curve once, so the curve acts on the final level
    const mean = acc.div(max(wsum, f32(0.0001))).div(f32(15.0));
    const lit = vec4f(brightnessCurve(mean.x), brightnessCurve(mean.y), brightnessCurve(mean.z), brightnessCurve(mean.w));
    // every tap solid: the sample is inside geometry, with no light to find.
    return select(vec4f(f32(0), f32(0), f32(0), f32(0)), lit, wsum.greaterThan(f32(0)));
}
