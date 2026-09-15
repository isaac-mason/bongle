import {
    createIndexBuffer,
    createVertexBuffer,
    d,
    f32,
    Geometry,
    LineMaterial,
    LineSegmentsGeometry,
    Material,
    Mesh,
    mix,
    type Node,
    Object3D,
    positionClip,
    Uniform,
    uniform,
    vec4f,
} from 'gpucat';
import * as Selection from '../../core/scene/selection';
import { type GreedyMesh, meshOccupancy, meshToGeometry } from '../../core/voxels/greedy-mesh';
import { CHUNK_BITS, CHUNK_VOLUME } from '../../core/voxels/voxels';
import type { TimeResources } from '../../render/time';
import type { EditRoomState } from '../edit-room-store';
import {
    BRUSH_EDGES_DEFAULT,
    BRUSH_FILL_DEFAULT,
    HOVER_OUTLINE,
    OCCLUDED_FILL_ALPHA,
    OCCLUDED_LINE_ALPHA,
    SELECTION_EDGES,
    SELECTION_FILL,
    SELECTION_OUTLINE,
} from './editor-colors';
import { rainbowFillColor, rainbowLineColor } from './rainbow';

/** an overlay is drawn twice: the half in front of the world, and the ghosted half behind it.
 *  the two depth compares are mutually exclusive per pixel, so the halves never blend against
 *  each other and their draw order relative to one another does not matter. */
type MaterialPair<M extends Material> = { visible: M; occluded: M };

let _selectionMaterials: MaterialPair<Material> | null = null;
let _brushMaterials: MaterialPair<Material> | null = null;
let _brushFillUniform: Uniform<d.vec4f> | null = null;
let _selectionOutlineMaterials: MaterialPair<LineMaterial> | null = null;
let _selectionEdgesMaterials: MaterialPair<LineMaterial> | null = null;
let _brushEdgesMaterials: MaterialPair<LineMaterial> | null = null;
let _brushEdgesUniform: Uniform<d.vec4f> | null = null;
let _hoverOutlineMaterials: MaterialPair<LineMaterial> | null = null;

// brush tint blend: 0 = flowing rainbow, 1 = solid semantic tint. shared by
// the brush fill + edges materials.
const _brushTintStrength = new Uniform(d.f32, 0);

/** world-space clearance between the selection fill and the block faces it covers; matches OUTLINE_EXPAND.
 *  the fill's faces ARE the block faces, so a depth bias can only guess at the offset; this is exact. */
const SURFACE_LIFT = 0.005;

// lines get a depth bias instead: their quads are screen-space expanded, so there is no single world
// direction to lift them in. BOTH halves take the same bias, so they stay exactly complementary and a
// pixel draws one or the other, never both. biasing only the visible half lets a coplanar pixel pass
// `less-equal` at the biased depth and `greater` at the unbiased one, double-drawing the line.
const LINE_DEPTH_BIAS = -4;

/** the same colour graph at a flat ghost alpha; sharing the graph keeps the brush uniforms single-sourced. */
function ghost(color: Node<d.vec4f>, alpha: number): Node<d.vec4f> {
    return vec4f(color.rgb, f32(alpha));
}

function fillPair(name: string, color: Node<d.vec4f>): MaterialPair<Material> {
    const make = (half: string, depthCompare: GPUCompareFunction, fragment: Node<d.vec4f>) =>
        new Material({
            name: `${name}-${half}`,
            vertex: positionClip,
            fragment,
            transparent: true,
            cullMode: 'none',
            depthTest: true,
            depthCompare,
            depthWrite: false,
        });
    return {
        visible: make('visible', 'less-equal', color),
        occluded: make('occluded', 'greater', ghost(color, OCCLUDED_FILL_ALPHA)),
    };
}

function linePair(color: Node<d.vec4f>, lineWidth: number): MaterialPair<LineMaterial> {
    const make = (depthCompare: GPUCompareFunction, c: Node<d.vec4f>, bias: number) => {
        const material = new LineMaterial({ color: c, lineWidth, transparent: true });
        material.depthTest = true;
        material.depthCompare = depthCompare;
        material.depthWrite = false;
        material.depthBias = bias;
        return material;
    };
    return {
        visible: make('less-equal', color, LINE_DEPTH_BIAS),
        occluded: make('greater', ghost(color, OCCLUDED_LINE_ALPHA), LINE_DEPTH_BIAS),
    };
}

function getSelectionMaterials(elapsedTime: Node<d.f32>): MaterialPair<Material> {
    if (!_selectionMaterials) {
        _selectionMaterials = fillPair('editor-selection-fill', rainbowFillColor(elapsedTime, SELECTION_FILL[3]));
    }
    return _selectionMaterials;
}

function getBrushMaterials(elapsedTime: Node<d.f32>): MaterialPair<Material> {
    if (!_brushMaterials) {
        _brushFillUniform = new Uniform(d.vec4f, BRUSH_FILL_DEFAULT);
        _brushMaterials = fillPair(
            'editor-brush-fill',
            mix(rainbowFillColor(elapsedTime, BRUSH_FILL_DEFAULT[3]), uniform(_brushFillUniform), uniform(_brushTintStrength)),
        );
    }
    return _brushMaterials;
}

function getSelectionOutlineMaterials(elapsedTime: Node<d.f32>): MaterialPair<LineMaterial> {
    if (!_selectionOutlineMaterials) {
        _selectionOutlineMaterials = linePair(rainbowLineColor(elapsedTime, SELECTION_OUTLINE[3]), 4);
    }
    return _selectionOutlineMaterials;
}

function getSelectionEdgesMaterials(elapsedTime: Node<d.f32>): MaterialPair<LineMaterial> {
    if (!_selectionEdgesMaterials) {
        _selectionEdgesMaterials = linePair(rainbowLineColor(elapsedTime, SELECTION_EDGES[3]), 4);
    }
    return _selectionEdgesMaterials;
}

function getBrushEdgesMaterials(elapsedTime: Node<d.f32>): MaterialPair<LineMaterial> {
    if (!_brushEdgesMaterials) {
        _brushEdgesUniform = new Uniform(d.vec4f, BRUSH_EDGES_DEFAULT);
        _brushEdgesMaterials = linePair(
            mix(rainbowLineColor(elapsedTime, BRUSH_EDGES_DEFAULT[3]), uniform(_brushEdgesUniform), uniform(_brushTintStrength)),
            4,
        );
    }
    return _brushEdgesMaterials;
}

function getHoverOutlineMaterials(elapsedTime: Node<d.f32>): MaterialPair<LineMaterial> {
    if (!_hoverOutlineMaterials) {
        _hoverOutlineMaterials = linePair(rainbowLineColor(elapsedTime, HOVER_OUTLINE[3]), 3);
    }
    return _hoverOutlineMaterials;
}

// dense selection buffer: copies each chunk's 128-word bit grid into a
// dense X-bit-packed Uint32Array spanning the chunk-aligned AABB, one zero
// row padding each side of Y and Z so the edge classifier can probe +/-1 on
// two axes without a bounds check. chunk layout: bit `(ly << 8) | (lz << 4)
// | lx`; one u32 word holds two z-rows of 16 lx-bits (low 16 = lz even, high
// 16 = lz odd), so chunks land on bit 0 or bit 16 of a dense word, never split.

const WORDS_PER_CHUNK = CHUNK_VOLUME >> 5; // 128

type DenseSelection = {
    occ: Uint32Array;
    SX: number;
    SY: number;
    SZ: number;
    wpr: number; // words per X row
    rowStride: number; // = wpr
    slabStride: number; // = (SZ + 2) * rowStride; one Y-slab including z-padding
    minX: number;
    minY: number;
    minZ: number;
    empty: boolean;
};

function buildDenseSelection(sel: Selection.Selection): DenseSelection | null {
    if (sel.chunks.size === 0) return null;

    let cxMin = Infinity,
        cyMin = Infinity,
        czMin = Infinity;
    let cxMax = -Infinity,
        cyMax = -Infinity,
        czMax = -Infinity;
    for (const [key] of sel.chunks) {
        const parts = key.split(',');
        const cx = parseInt(parts[0]!, 10);
        const cy = parseInt(parts[1]!, 10);
        const cz = parseInt(parts[2]!, 10);
        if (cx < cxMin) cxMin = cx;
        if (cx > cxMax) cxMax = cx;
        if (cy < cyMin) cyMin = cy;
        if (cy > cyMax) cyMax = cy;
        if (cz < czMin) czMin = cz;
        if (cz > czMax) czMax = cz;
    }

    const minX = cxMin << CHUNK_BITS;
    const minY = cyMin << CHUNK_BITS;
    const minZ = czMin << CHUNK_BITS;
    const SX = (cxMax - cxMin + 1) << CHUNK_BITS;
    const SY = (cyMax - cyMin + 1) << CHUNK_BITS;
    const SZ = (czMax - czMin + 1) << CHUNK_BITS;
    const wpr = (SX + 31) >> 5;
    // +1 phantom zero word per row so edge-pass reads at wi=wpr (the +X
    // boundary Y/Z-edge word) safely return 0.
    const rowStride = wpr + 1;
    const slabStride = (SZ + 2) * rowStride;
    const occ = new Uint32Array((SY + 2) * slabStride);

    let anyBits = false;
    for (const [key, chunk] of sel.chunks) {
        const parts = key.split(',');
        const cx = parseInt(parts[0]!, 10);
        const cy = parseInt(parts[1]!, 10);
        const cz = parseInt(parts[2]!, 10);
        const xBase = (cx - cxMin) << CHUNK_BITS;
        const yBase = (cy - cyMin) << CHUNK_BITS;
        const zBase = (cz - czMin) << CHUNK_BITS;
        const xWord = xBase >> 5;
        const xShift = xBase & 31;

        const bits = chunk.bits;
        for (let w = 0; w < WORDS_PER_CHUNK; w++) {
            const cw = bits[w]!;
            if (cw === 0) continue;
            anyBits = true;
            const ly = w >> 3;
            const lzLo = (w & 7) << 1;
            const y = yBase + ly;
            const baseLo = (y + 1) * slabStride + (zBase + lzLo + 1) * rowStride + xWord;
            const baseHi = baseLo + rowStride;
            const low = cw & 0xffff;
            const high = (cw >>> 16) & 0xffff;
            if (low !== 0) occ[baseLo] = (occ[baseLo]! | (low << xShift)) >>> 0;
            if (high !== 0) occ[baseHi] = (occ[baseHi]! | (high << xShift)) >>> 0;
        }
    }

    return {
        occ,
        SX,
        SY,
        SZ,
        wpr,
        rowStride,
        slabStride,
        minX,
        minY,
        minZ,
        empty: !anyBits,
    };
}

/** `lift` nudges each face out along its own normal, clearing the block faces the fill sits on.
 *  0 leaves the geometry exactly voxel-aligned. */
export function buildSelectionGeometry(sel: Selection.Selection, lift = 0): Geometry | null {
    const dense = buildDenseSelection(sel);
    if (!dense || dense.empty) return null;

    // tight bit-level bounds, keeps meshOccupancy from scanning empty
    // space in partially-filled chunks.
    const tight = Selection.bounds(sel);
    if (!tight) return null;

    const { occ, rowStride, slabStride, minX, minY, minZ, SX, SY, SZ } = dense;

    // ~5 ns per call vs ~440 ns for Selection.has.
    const denseHas = (wx: number, wy: number, wz: number): boolean => {
        const dx = wx - minX;
        const dy = wy - minY;
        const dz = wz - minZ;
        if (dx < 0 || dx >= SX || dy < 0 || dy >= SY || dz < 0 || dz >= SZ) return false;
        return (occ[(dy + 1) * slabStride + (dz + 1) * rowStride + (dx >> 5)]! & (1 << (dx & 31))) !== 0;
    };

    const mesh = meshOccupancy({
        occ: denseHas,
        min: tight.min,
        max: tight.max,
        emitNormals: lift !== 0,
    });
    if (!mesh) return null;
    if (lift !== 0) liftAlongNormals(mesh, lift);
    return meshToGeometry(mesh);
}

/** normals are dropped afterwards, the flat-colour fill never reads them. */
function liftAlongNormals(mesh: GreedyMesh, lift: number): void {
    const { positions, normals } = mesh;
    if (!normals) return;
    for (let i = 0; i < positions.length; i++) positions[i]! += normals[i]! * lift;
    mesh.normals = null;
}

// emits surface boundary + crease edges of the voxel selection, computed
// directly from voxel occupancy rather than greedy-mesh decomposition, so a
// long merged quad's edge never draws on top of several shorter
// perpendicular-quad sub-edges.
//
// for each axis-aligned unit edge, look at the 4 cells around it in the
// perpendicular plane (s00, s10, s01, s11, indexed by (db, dc)) and skip
// when 0 faces are exposed (not on a surface) or when 2 exposed faces share
// the same (axis, sign) normal (flat-surface seam); keep otherwise
// (boundary, crease, step, saddle, corner). Exposed-face slots are XORs of
// adjacent cells: e1 = s00^s10, e2 = s01^s11, e3 = s00^s01, e4 = s10^s11.
// The four formulas run on 32 candidate edges at once via bitwise ops on
// packed words. X-edges read s00..s11 directly (no shift) and walk per-bit
// within/across words; Y- and Z-edges need a +1 X-shift to reach the
// neighbor column (`(word << 1) | (prevWord >>> 31)`) and track runs via
// `starts = kept & ~prev`, `ends = prev & ~kept` across slabs, closed by a
// phantom all-zero row past the tight max.
//
// output depends only on Selection.has(...), independent of greedy-mesh
// sweep order or chunk size.

export function buildMeshEdgeSegments(sel: Selection.Selection): number[] | null {
    const dense = buildDenseSelection(sel);
    if (!dense || dense.empty) return null;
    const tight = Selection.bounds(sel);
    if (!tight) return null;

    const { occ, rowStride, slabStride, minX, minY, minZ } = dense;

    // tight local bounds (voxel coords), set bits live in [lxMin..lxMax] etc.
    const lxMin = tight.min[0] - minX;
    const lxMax = tight.max[0] - minX;
    const lyMin = tight.min[1] - minY;
    const lyMax = tight.max[1] - minY;
    const lzMin = tight.min[2] - minZ;
    const lzMax = tight.max[2] - minZ;

    // covers [lxMin..lxMax] (X-edges) and [lxMin..lxMax+1] (Y/Z edges, which
    // extend one bit past the voxel range on the +X face); wMax can hit the
    // phantom zero padding word from buildDenseSelection, so reads stay in-bounds.
    const wMin = lxMin >> 5;
    const wMax = (lxMax + 1) >> 5;
    const wRange = wMax - wMin + 1;

    const pts: number[] = [];

    // X-edge pass, axis=0, runs along X.
    for (let ey = lyMin; ey <= lyMax + 1; ey++) {
        const rowY1 = (ey - 1 + 1) * slabStride;
        const rowY = (ey + 1) * slabStride;
        for (let ez = lzMin; ez <= lzMax + 1; ez++) {
            const baseY1Z1 = rowY1 + (ez - 1 + 1) * rowStride;
            const baseYZ1 = rowY + (ez - 1 + 1) * rowStride;
            const baseY1Z = rowY1 + (ez + 1) * rowStride;
            const baseYZ = rowY + (ez + 1) * rowStride;

            let inRun = false;
            let runStart = 0;

            for (let wi = wMin; wi <= wMax; wi++) {
                const s00 = occ[baseY1Z1 + wi]!;
                const s10 = occ[baseYZ1 + wi]!;
                const s01 = occ[baseY1Z + wi]!;
                const s11 = occ[baseYZ + wi]!;

                const e1 = (s00 ^ s10) >>> 0;
                const e2 = (s01 ^ s11) >>> 0;
                const e3 = (s00 ^ s01) >>> 0;
                const e4 = (s10 ^ s11) >>> 0;
                const skipB = (e1 & e2 & ~e3 & ~e4) >>> 0;
                const skipC = (~e1 & ~e2 & e3 & e4) >>> 0;
                const kept = ((e1 | e2 | e3 | e4) & ~(skipB | skipC)) >>> 0;

                const xWordLow = wi << 5;
                if (kept === 0 && !inRun) continue;
                for (let bit = 0; bit < 32; bit++) {
                    const ks = (kept >>> bit) & 1;
                    if (ks === 1) {
                        if (!inRun) {
                            inRun = true;
                            runStart = xWordLow + bit;
                        }
                    } else if (inRun) {
                        const a = xWordLow + bit;
                        pts.push(runStart + minX, ey + minY, ez + minZ, a + minX, ey + minY, ez + minZ);
                        inRun = false;
                    }
                }
            }
            // the bit at e_x = lxMax+1 lives in word wMax where kept = 0
            // (voxels stop at lxMax), so the run always closes above.
        }
    }

    const prevKept = new Uint32Array(wRange);
    const runStart = new Int32Array(wRange << 5);

    // Y-edge pass, axis=1, B=Z, C=X. outer ez, inner ey; runs along Y.
    // s00=(x=ex-1, z=ez-1), s10=(x=ex-1, z=ez), s01=(x=ex, z=ez-1), s11=(x=ex, z=ez)
    for (let ez = lzMin; ez <= lzMax + 1; ez++) {
        prevKept.fill(0);
        const baseZ1 = (ez - 1 + 1) * rowStride;
        const baseZ = (ez + 1) * rowStride;

        for (let ey = lyMin; ey <= lyMax + 1; ey++) {
            const isPhantom = ey > lyMax;
            const baseYZ1 = (ey + 1) * slabStride + baseZ1;
            const baseYZ = (ey + 1) * slabStride + baseZ;

            let prevWordZ1 = 0;
            let prevWordZ = 0;

            for (let wi = wMin; wi <= wMax; wi++) {
                let kept = 0;
                if (!isPhantom) {
                    const wordZ1 = occ[baseYZ1 + wi]!;
                    const wordZ = occ[baseYZ + wi]!;
                    const s00 = ((wordZ1 << 1) | (prevWordZ1 >>> 31)) >>> 0;
                    const s10 = ((wordZ << 1) | (prevWordZ >>> 31)) >>> 0;
                    const s01 = wordZ1;
                    const s11 = wordZ;
                    const e1 = (s00 ^ s10) >>> 0;
                    const e2 = (s01 ^ s11) >>> 0;
                    const e3 = (s00 ^ s01) >>> 0;
                    const e4 = (s10 ^ s11) >>> 0;
                    const skipB = (e1 & e2 & ~e3 & ~e4) >>> 0;
                    const skipC = (~e1 & ~e2 & e3 & e4) >>> 0;
                    kept = ((e1 | e2 | e3 | e4) & ~(skipB | skipC)) >>> 0;
                    prevWordZ1 = wordZ1;
                    prevWordZ = wordZ;
                }

                const wOff = wi - wMin;
                const prev = prevKept[wOff]!;
                const starts = (kept & ~prev) >>> 0;
                const ends = (prev & ~kept) >>> 0;
                const xWordLow = wi << 5;

                // record starts: runStart[xpos] = ey
                let m = starts;
                while (m !== 0) {
                    const lsb = (m & -m) >>> 0;
                    const bp = 31 - Math.clz32(lsb);
                    runStart[(wOff << 5) | bp] = ey;
                    m = (m ^ lsb) >>> 0;
                }

                // emit ends: run [runStart[xpos], ey-1] in Y at (x=xpos, z=ez)
                m = ends;
                while (m !== 0) {
                    const lsb = (m & -m) >>> 0;
                    const bp = 31 - Math.clz32(lsb);
                    const ex = xWordLow + bp;
                    const ay0 = runStart[(wOff << 5) | bp]!;
                    pts.push(ex + minX, ay0 + minY, ez + minZ, ex + minX, ey + minY, ez + minZ);
                    m = (m ^ lsb) >>> 0;
                }

                prevKept[wOff] = kept;
            }
        }
    }

    // Z-edge pass, axis=2, B=X, C=Y. outer ey, inner ez; runs along Z.
    // s00=(x=ex-1, y=ey-1), s10=(x=ex, y=ey-1), s01=(x=ex-1, y=ey), s11=(x=ex, y=ey)
    for (let ey = lyMin; ey <= lyMax + 1; ey++) {
        prevKept.fill(0);
        const baseY1 = (ey - 1 + 1) * slabStride;
        const baseY = (ey + 1) * slabStride;

        for (let ez = lzMin; ez <= lzMax + 1; ez++) {
            const isPhantom = ez > lzMax;
            const baseY1Z = baseY1 + (ez + 1) * rowStride;
            const baseYZ = baseY + (ez + 1) * rowStride;

            let prevWordY1 = 0;
            let prevWordY = 0;

            for (let wi = wMin; wi <= wMax; wi++) {
                let kept = 0;
                if (!isPhantom) {
                    const wordY1 = occ[baseY1Z + wi]!;
                    const wordY = occ[baseYZ + wi]!;
                    const s00 = ((wordY1 << 1) | (prevWordY1 >>> 31)) >>> 0;
                    const s10 = wordY1;
                    const s01 = ((wordY << 1) | (prevWordY >>> 31)) >>> 0;
                    const s11 = wordY;
                    const e1 = (s00 ^ s10) >>> 0;
                    const e2 = (s01 ^ s11) >>> 0;
                    const e3 = (s00 ^ s01) >>> 0;
                    const e4 = (s10 ^ s11) >>> 0;
                    const skipB = (e1 & e2 & ~e3 & ~e4) >>> 0;
                    const skipC = (~e1 & ~e2 & e3 & e4) >>> 0;
                    kept = ((e1 | e2 | e3 | e4) & ~(skipB | skipC)) >>> 0;
                    prevWordY1 = wordY1;
                    prevWordY = wordY;
                }

                const wOff = wi - wMin;
                const prev = prevKept[wOff]!;
                const starts = (kept & ~prev) >>> 0;
                const ends = (prev & ~kept) >>> 0;
                const xWordLow = wi << 5;

                let m = starts;
                while (m !== 0) {
                    const lsb = (m & -m) >>> 0;
                    const bp = 31 - Math.clz32(lsb);
                    runStart[(wOff << 5) | bp] = ez;
                    m = (m ^ lsb) >>> 0;
                }

                m = ends;
                while (m !== 0) {
                    const lsb = (m & -m) >>> 0;
                    const bp = 31 - Math.clz32(lsb);
                    const ex = xWordLow + bp;
                    const az0 = runStart[(wOff << 5) | bp]!;
                    pts.push(ex + minX, ey + minY, az0 + minZ, ex + minX, ey + minY, ez + minZ);
                    m = (m ^ lsb) >>> 0;
                }

                prevKept[wOff] = kept;
            }
        }
    }

    return pts.length > 0 ? pts : null;
}

// keeps the outline just outside the fill mesh to avoid z-fighting.
const OUTLINE_EXPAND = 0.005;

export function buildOutlineSegments(sel: Selection.Selection): number[] | null {
    if (sel.chunks.size === 0) return null;

    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;

    Selection.forEach(sel, (wx, wy, wz) => {
        if (wx < minX) minX = wx;
        if (wy < minY) minY = wy;
        if (wz < minZ) minZ = wz;
        if (wx > maxX) maxX = wx;
        if (wy > maxY) maxY = wy;
        if (wz > maxZ) maxZ = wz;
    });

    if (minX > maxX) return null;

    const e = OUTLINE_EXPAND;
    // +1 because voxel at maxX occupies [maxX, maxX+1]
    return aabbOutlineSegments(minX - e, minY - e, minZ - e, maxX + 1 + e, maxY + 1 + e, maxZ + 1 + e);
}

/** 12 edges of the AABB [x0,y0,z0]..[x1,y1,z1] as a flat segment-pair array for LineSegmentsGeometry. */
export function aabbOutlineSegments(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
    return [
        // bottom face
        x0,
        y0,
        z0,
        x1,
        y0,
        z0,
        x1,
        y0,
        z0,
        x1,
        y0,
        z1,
        x1,
        y0,
        z1,
        x0,
        y0,
        z1,
        x0,
        y0,
        z1,
        x0,
        y0,
        z0,
        // top face
        x0,
        y1,
        z0,
        x1,
        y1,
        z0,
        x1,
        y1,
        z0,
        x1,
        y1,
        z1,
        x1,
        y1,
        z1,
        x0,
        y1,
        z1,
        x0,
        y1,
        z1,
        x0,
        y1,
        z0,
        // vertical edges
        x0,
        y0,
        z0,
        x0,
        y1,
        z0,
        x1,
        y0,
        z0,
        x1,
        y1,
        z0,
        x1,
        y0,
        z1,
        x1,
        y1,
        z1,
        x0,
        y0,
        z1,
        x0,
        y1,
        z1,
    ];
}

/** 12 triangles forming a closed box for the AABB [x0,y0,z0]..[x1,y1,z1], for sub-unit collider shapes the cell-based Selection mesher can't represent. */
export function buildAabbBoxGeometry(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Geometry {
    const positions = new Float32Array([
        x0,
        y0,
        z0,
        x1,
        y0,
        z0,
        x1,
        y1,
        z0,
        x0,
        y1,
        z0,
        x0,
        y0,
        z1,
        x1,
        y0,
        z1,
        x1,
        y1,
        z1,
        x0,
        y1,
        z1,
    ]);
    const indices = new Uint32Array([
        0,
        1,
        2,
        0,
        2,
        3, // -Z
        4,
        6,
        5,
        4,
        7,
        6, // +Z
        0,
        3,
        7,
        0,
        7,
        4, // -X
        1,
        5,
        6,
        1,
        6,
        2, // +X
        0,
        4,
        5,
        0,
        5,
        1, // -Y
        3,
        2,
        6,
        3,
        6,
        7, // +Y
    ]);
    const geo = new Geometry();
    geo.setBuffer('position', createVertexBuffer(d.vec3f, positions));
    geo.setIndex(createIndexBuffer(indices));
    geo.drawRange = { start: 0, count: indices.length };
    return geo;
}

/** one overlay's two draws over a single shared geometry. */
type OverlayMeshes = { visible: Mesh; occluded: Mesh; geometry: Geometry };

export type SelectionMeshState = {
    selectionMesh: OverlayMeshes | null;
    selectionOutline: OverlayMeshes | null;
    selectionEdges: OverlayMeshes | null;
    // any-shape selection (hovered block idle, box-select region, brush shapes).
    brushMesh: OverlayMeshes | null;
    brushEdges: OverlayMeshes | null;
    // tight aabb outline around the exact hovered voxel.
    hoverOutline: OverlayMeshes | null;
    /** this module's own group; the caller parents it and never touches what's inside. */
    root: Object3D;
    // re-applied every frame since setOutlineMesh reuses its Mesh across geometry swaps.
    hoverOutlineWanted: boolean;
    _lastSelection: Selection.Selection | null;
    // a Selection ref when the brush is cell-based, or a string key
    // `aabb:x0,y0,...,z1` when it's a synthesized sub-unit collider box.
    _lastBrushSig: string | Selection.Selection | null;
    _lastHoverKey: string; // serialised "x,y,z" or ""
};

export function createSelectionMeshState(parent: Object3D): SelectionMeshState {
    const root = new Object3D();
    root.name = 'editor-selection';
    parent.add(root);
    return {
        selectionMesh: null,
        selectionOutline: null,
        selectionEdges: null,
        brushMesh: null,
        brushEdges: null,
        hoverOutline: null,
        root,
        hoverOutlineWanted: false,
        _lastSelection: null,
        _lastBrushSig: null,
        _lastHoverKey: '',
    };
}

export function disposeSelectionMeshState(state: SelectionMeshState): void {
    state.root.removeFromParent();
    state.selectionMesh?.geometry.dispose();
    state.selectionOutline?.geometry.dispose();
    state.selectionEdges?.geometry.dispose();
    state.brushMesh?.geometry.dispose();
    state.brushEdges?.geometry.dispose();
    state.hoverOutline?.geometry.dispose();
}

/** both halves over one geometry; `renderOrder` keeps the whole overlay above the world's transparents. */
function addOverlayMeshes(
    state: SelectionMeshState,
    name: string,
    geometry: Geometry,
    materials: MaterialPair<Material>,
): OverlayMeshes {
    const make = (half: string, material: Material): Mesh => {
        const mesh = new Mesh(geometry, material);
        mesh.name = `${name}-${half}`;
        mesh.frustumCulled = false;
        mesh.renderOrder = Infinity;
        state.root.add(mesh);
        return mesh;
    };
    return { visible: make('visible', materials.visible), occluded: make('occluded', materials.occluded), geometry };
}

function removeOverlayMeshes(meshes: OverlayMeshes): void {
    meshes.visible.removeFromParent();
    meshes.occluded.removeFromParent();
    meshes.geometry.dispose();
}

function swapOverlayGeometry(meshes: OverlayMeshes, geometry: Geometry): void {
    meshes.geometry.dispose();
    meshes.geometry = geometry;
    meshes.visible.geometry = geometry;
    meshes.occluded.geometry = geometry;
}

function setMesh(
    state: SelectionMeshState,
    which: 'selectionMesh' | 'brushMesh',
    geo: Geometry | null,
    materials: MaterialPair<Material>,
): void {
    const current = state[which];

    if (!geo) {
        if (current) {
            removeOverlayMeshes(current);
            state[which] = null;
        }
        return;
    }

    if (current) swapOverlayGeometry(current, geo);
    else state[which] = addOverlayMeshes(state, `editor-selection-${which}`, geo, materials);
}

function setOutlineMesh(
    state: SelectionMeshState,
    which: 'selectionOutline' | 'selectionEdges' | 'brushEdges' | 'hoverOutline',
    pts: number[] | null,
    materials: MaterialPair<LineMaterial>,
): void {
    const current = state[which];

    if (!pts) {
        if (current) {
            removeOverlayMeshes(current);
            state[which] = null;
        }
        return;
    }

    if (current) swapOverlayGeometry(current, new LineSegmentsGeometry(pts));
    else state[which] = addOverlayMeshes(state, `editor-selection-${which}`, new LineSegmentsGeometry(pts), materials);
}

/** the hover outline is the only overlay here with a show condition of its own. */
function applyVisibility(state: SelectionMeshState): void {
    const hover = state.hoverOutline;
    if (!hover) return;
    hover.visible.visible = state.hoverOutlineWanted;
    hover.occluded.visible = state.hoverOutlineWanted;
}

export function updateSelectionMeshes(meshState: SelectionMeshState, state: EditRoomState, time: TimeResources): void {
    const elapsedTime = time.elapsedTime;
    if (state.selection !== meshState._lastSelection) {
        meshState._lastSelection = state.selection;
        setMesh(
            meshState,
            'selectionMesh',
            state.selection ? buildSelectionGeometry(state.selection, SURFACE_LIFT) : null,
            getSelectionMaterials(elapsedTime),
        );
        setOutlineMesh(
            meshState,
            'selectionOutline',
            state.selection ? buildOutlineSegments(state.selection) : null,
            getSelectionOutlineMaterials(elapsedTime),
        );
        setOutlineMesh(
            meshState,
            'selectionEdges',
            state.selection ? buildMeshEdgeSegments(state.selection) : null,
            getSelectionEdgesMaterials(elapsedTime),
        );
    }

    // brushSig folds brush ref + aabb-shape mode + aabb key so the brush
    // rebuilds when the mode flips or the AABB moves between cells.
    const hoverAabb = state.hoverAabb;
    const hasBrush = state.brush !== null;
    const brushBig = hasBrush && Selection.count(state.brush!) > 1;
    const isSubUnit =
        hoverAabb !== null &&
        (hoverAabb[3] - hoverAabb[0] < 1 - 1e-6 ||
            hoverAabb[4] - hoverAabb[1] < 1 - 1e-6 ||
            hoverAabb[5] - hoverAabb[2] < 1 - 1e-6);
    const useAabbBrush = hasBrush && isSubUnit && !brushBig;
    const brushSig: string | Selection.Selection | null = useAabbBrush
        ? `aabb:${hoverAabb![0]},${hoverAabb![1]},${hoverAabb![2]},${hoverAabb![3]},${hoverAabb![4]},${hoverAabb![5]}`
        : state.brush;

    if (brushSig !== meshState._lastBrushSig) {
        meshState._lastBrushSig = brushSig;
        if (useAabbBrush && hoverAabb) {
            const e = OUTLINE_EXPAND;
            // lifted like the greedy-meshed fill is: a sub-unit collider's faces sit exactly on the
            // block's own, so the box needs the same world-space clearance.
            const lift = SURFACE_LIFT;
            setMesh(
                meshState,
                'brushMesh',
                buildAabbBoxGeometry(
                    hoverAabb[0] - lift,
                    hoverAabb[1] - lift,
                    hoverAabb[2] - lift,
                    hoverAabb[3] + lift,
                    hoverAabb[4] + lift,
                    hoverAabb[5] + lift,
                ),
                getBrushMaterials(elapsedTime),
            );
            setOutlineMesh(
                meshState,
                'brushEdges',
                aabbOutlineSegments(
                    hoverAabb[0] - e,
                    hoverAabb[1] - e,
                    hoverAabb[2] - e,
                    hoverAabb[3] + e,
                    hoverAabb[4] + e,
                    hoverAabb[5] + e,
                ),
                getBrushEdgesMaterials(elapsedTime),
            );
        } else {
            setMesh(
                meshState,
                'brushMesh',
                state.brush ? buildSelectionGeometry(state.brush, SURFACE_LIFT) : null,
                getBrushMaterials(elapsedTime),
            );
            setOutlineMesh(
                meshState,
                'brushEdges',
                state.brush ? buildMeshEdgeSegments(state.brush) : null,
                getBrushEdgesMaterials(elapsedTime),
            );
        }
    }

    // null brushFill/brushEdges means the default flowing rainbow (strength 0);
    // a set rgba means a solid semantic tint (strength 1) blended in by the brush materials.
    const fill = state.brushFill;
    const edges = state.brushEdges;
    _brushTintStrength.value = fill ? 1 : 0;
    if (fill && _brushFillUniform) _brushFillUniform.value = fill;
    if (edges && _brushEdgesUniform) _brushEdgesUniform.value = edges;

    const hoverKey = hoverAabb
        ? `${hoverAabb[0]},${hoverAabb[1]},${hoverAabb[2]},${hoverAabb[3]},${hoverAabb[4]},${hoverAabb[5]}`
        : '';

    if (hoverKey !== meshState._lastHoverKey) {
        meshState._lastHoverKey = hoverKey;
        const e = OUTLINE_EXPAND;
        const pts = hoverAabb
            ? aabbOutlineSegments(
                  hoverAabb[0] - e,
                  hoverAabb[1] - e,
                  hoverAabb[2] - e,
                  hoverAabb[3] + e,
                  hoverAabb[4] + e,
                  hoverAabb[5] + e,
              )
            : null;
        setOutlineMesh(meshState, 'hoverOutline', pts, getHoverOutlineMaterials(elapsedTime));
    }

    // only shown for multi-cell brushes; single-cell brushes already show
    // bounds via the brush mesh+edges.
    meshState.hoverOutlineWanted = hasBrush && brushBig;
    applyVisibility(meshState);
}
