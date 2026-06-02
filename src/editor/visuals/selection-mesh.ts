// selection mesh for the voxel editor.
//
// renders a translucent highlight over the current voxel selection and
// the active brush. each is a separate gpucat Mesh.
//
// meshing: shared binary greedy mesher (`core/voxels/greedy-mesh.ts`).
// derives a tight AABB from the Selection.T chunk map + a per-voxel scan,
// then calls `meshOccupancy` with `Selection.has` as the occupancy probe.
// normals omitted — the flat-colour material doesn't need them.
//
// materials are created once and shared.
//   selection: blue tint, depthTest:false so it overlays everything.
//   brush:     cyan tint — used for hovered block (idle), wip box-select, future brush shapes.
//   hover outline: white aabb outline around the single hovered block (separate from brush mesh).

import { createIndexBuffer, createVertexBuffer, d, Geometry, LineMaterial, LineSegmentsGeometry, Material, Mesh, positionClip, type Scene, Uniform, uniform, vec4f } from 'gpucat';
import * as Selection from '../../core/scene/selection';
import { meshOccupancy, meshToGeometry } from '../../core/voxels/greedy-mesh';
import { CHUNK_BITS, CHUNK_VOLUME } from '../../core/voxels/voxels';
import type { EditRoomState } from '../edit-room-store';
import type { Rgba } from './editor-colors';
import {
    BRUSH_EDGES_DEFAULT,
    BRUSH_FILL_DEFAULT,
    HOVER_OUTLINE,
    SELECTION_EDGES,
    SELECTION_FILL,
    SELECTION_OUTLINE,
} from './editor-colors';

// ── materials ──────────────────────────────────────────────────────

let _selectionMaterial: Material | null = null;
let _brushMaterial: Material | null = null;
let _brushFillUniform: Uniform<d.vec4f> | null = null;
let _selectionOutlineMaterial: LineMaterial | null = null;
let _selectionEdgesMaterial: LineMaterial | null = null;
let _brushEdgesMaterial: LineMaterial | null = null;
let _brushEdgesUniform: Uniform<d.vec4f> | null = null;
let _hoverOutlineMaterial: LineMaterial | null = null;

function getSelectionMaterial(): Material {
    if (!_selectionMaterial) {
        _selectionMaterial = new Material({
            name: 'editor-selection-fill',
            vertex: positionClip,
            fragment: vec4f(...SELECTION_FILL),
            transparent: true,
            cullMode: 'none',
            depthTest: false,
            depthWrite: false,
        });
    }
    return _selectionMaterial;
}

function getBrushMaterial(): Material {
    if (!_brushMaterial) {
        // single material; color driven by a vec4f uniform. tools push rgba
        // into the store, selection-mesh forwards new references to this
        // uniform — no material swap, no mesh rebind. animated colors
        // (pulse) just allocate a fresh tuple per frame: the reference
        // changes → the uniform writes.
        _brushFillUniform = new Uniform(d.vec4f, BRUSH_FILL_DEFAULT);
        _brushMaterial = new Material({
            name: 'editor-brush-fill',
            vertex: positionClip,
            fragment: uniform(_brushFillUniform),
            transparent: true,
            cullMode: 'none',
            depthTest: false,
            depthWrite: false,
        });
    }
    return _brushMaterial;
}

function getSelectionOutlineMaterial(): LineMaterial {
    if (!_selectionOutlineMaterial) {
        _selectionOutlineMaterial = new LineMaterial({
            color: vec4f(...SELECTION_OUTLINE),
            lineWidth: 4,
            transparent: false,
        });
        _selectionOutlineMaterial.depthTest = false;
        _selectionOutlineMaterial.depthWrite = false;
    }
    return _selectionOutlineMaterial;
}

function getSelectionEdgesMaterial(): LineMaterial {
    if (!_selectionEdgesMaterial) {
        _selectionEdgesMaterial = new LineMaterial({
            color: vec4f(...SELECTION_EDGES),
            lineWidth: 2,
            transparent: false,
        });
        _selectionEdgesMaterial.depthTest = false;
        _selectionEdgesMaterial.depthWrite = false;
    }
    return _selectionEdgesMaterial;
}

function getBrushEdgesMaterial(): LineMaterial {
    if (!_brushEdgesMaterial) {
        _brushEdgesUniform = new Uniform(d.vec4f, BRUSH_EDGES_DEFAULT);
        _brushEdgesMaterial = new LineMaterial({
            color: uniform(_brushEdgesUniform),
            lineWidth: 2,
            transparent: false,
        });
        _brushEdgesMaterial.depthTest = false;
        _brushEdgesMaterial.depthWrite = false;
    }
    return _brushEdgesMaterial;
}

function getHoverOutlineMaterial(): LineMaterial {
    if (!_hoverOutlineMaterial) {
        _hoverOutlineMaterial = new LineMaterial({
            color: vec4f(...HOVER_OUTLINE),
            lineWidth: 3,
            transparent: false,
        });
        _hoverOutlineMaterial.depthTest = false;
        _hoverOutlineMaterial.depthWrite = false;
    }
    return _hoverOutlineMaterial;
}

// ── dense selection buffer ─────────────────────────────────────────
//
// bitmask-native scratch: copy each chunk's 128-word bit grid into a
// dense X-bit-packed Uint32Array spanning the chunk-aligned AABB. one
// row = wpr words covering SX bits along X; reads outside the populated
// chunk set are zero by construction.
//
// padding: one zero row on each side of Y and Z so reads at (y=-1),
// (y=SY), (z=-1), (z=SZ) all hit zero rows without a bounds check —
// critical for the edge-segment classifier which probes ±1 on two axes.
//
// chunk layout: bit `(ly << 8) | (lz << 4) | lx`. one u32 word holds
// two z-rows of 16 lx-bits each (low 16 = lz even, high 16 = lz odd).
// chunks land on either bit 0 or bit 16 of a dense word — never split.

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
    // +1 phantom zero word per row so edge-pass reads at wi=wpr (the word
    // containing e_x = lxMax+1, needed for +X boundary Y/Z-edges when the
    // selection is chunk-aligned) safely return 0.
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

// ── selection geometry ─────────────────────────────────────────────

export function buildSelectionGeometry(sel: Selection.Selection): Geometry | null {
    const dense = buildDenseSelection(sel);
    if (!dense || dense.empty) return null;

    // tight bit-level bounds — keeps meshOccupancy from scanning empty
    // space in partially-filled chunks (huge win on single voxels / thin slabs).
    const tight = Selection.bounds(sel);
    if (!tight) return null;

    const { occ, wpr, rowStride, slabStride, minX, minY, minZ, SX, SY, SZ } = dense;

    // dense lookup probe — closed over the populated buffer. ~5 ns per
    // call vs ~440 ns for Selection.has; greedy mesher calls this 12×
    // bounds-volume times per pass.
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
        emitNormals: false,
    });
    if (!mesh) return null;
    return meshToGeometry(mesh);
}

// ── mesh edge segments ─────────────────────────────────────────────
//
// emits surface boundary + crease edges of the voxel selection, computed
// directly from voxel occupancy (no dependency on greedy-mesh
// decomposition). this avoids T-junction artifacts where a long merged
// quad's edge would otherwise be drawn on top of several shorter
// perpendicular-quad sub-edges.
//
// algorithm:
//   1. for each axis-aligned unit edge incident to a selected voxel,
//      classify by looking at the 4 cells around the edge (in the plane
//      perpendicular to the edge axis):
//        - 0 exposed faces                → skip (edge isn't on the surface)
//        - 2 exposed faces, same (axis,sign) normal → skip (flat-surface seam)
//        - everything else (boundary, crease, step, saddle, corner) → keep
//   2. bucket kept unit edges by the line they lie on (axis + the 2
//      perpendicular coords), then merge consecutive integer positions into
//      single long segments.
//
// invariant: output depends only on Selection.has(...). running greedy
// meshing with different sweep orders, chunk sizes, etc. cannot change the
// edges drawn here.

// bitmask-native edge classifier.
//
// for each axis-aligned unit edge, look at the 4 cells around it in the
// perpendicular plane (s00, s10, s01, s11 — indexed by (db, dc)). the
// reference logic counts exposed faces and skips when:
//   - 0 exposed faces                          → edge isn't on a surface
//   - 2 exposed faces, both of the same kind   → flat-surface seam
//
// the four exposed-face slots (each a XOR of two cells):
//   e1 = s00 ^ s10   F1: B-perp face at dc=-1
//   e2 = s01 ^ s11   F2: B-perp face at dc=0
//   e3 = s00 ^ s01   F3: C-perp face at db=-1
//   e4 = s10 ^ s11   F4: C-perp face at db=0
//
// "2 same B-faces" ⟺ e1=e2=1, e3=e4=0 (F3 absent implies c00==c01, which
// forces F1 and F2 to share orientation). "2 same C-faces" mirrors it.
// kept = (any exposed) AND NOT (either skip pattern).
//
// the four formulas operate on 32 candidate edges in parallel as bitwise
// ops on packed words, replacing per-cell Selection.has + Map<string,
// Set<number>> string-key bookkeeping with raw word arithmetic.
//
// per pass:
//   X-edges: 4 cells all at the same X, so s00..s11 are direct row
//            reads (no shift); runs along the bit direction → walked
//            per-bit within / across words.
//   Y-edges: 4 cells share Y; s00 and s10 need a +1 X-shift to reach
//            the (x=c-1) column. runs along Y → outer e_z, inner e_y,
//            state-machine via prevKept + runStartY[xpos].
//   Z-edges: 4 cells share Z; s00 and s01 need the +1 X-shift. runs
//            along Z → outer e_y, inner e_z, mirror state machine.
//
// shift +1 in X (extract bit at position p-1 of original word):
//   shifted = (word << 1) | (prevWord >>> 31)
//
// run state machine (Y/Z passes): per word,
//   starts = kept & ~prev    bits where a Y/Z-run begins at this slab
//   ends   = prev & ~kept    bits where the prior slab ended a run
// a phantom row (kept = 0 past the tight max) closes any active runs.

export function buildMeshEdgeSegments(sel: Selection.Selection): number[] | null {
    const dense = buildDenseSelection(sel);
    if (!dense || dense.empty) return null;
    const tight = Selection.bounds(sel);
    if (!tight) return null;

    const { occ, wpr, rowStride, slabStride, minX, minY, minZ } = dense;

    // tight local bounds (voxel coords) — set bits live in [lxMin..lxMax] etc.
    const lxMin = tight.min[0] - minX;
    const lxMax = tight.max[0] - minX;
    const lyMin = tight.min[1] - minY;
    const lyMax = tight.max[1] - minY;
    const lzMin = tight.min[2] - minZ;
    const lzMax = tight.max[2] - minZ;

    // X-word range covering both [lxMin..lxMax] (X-edges) and [lxMin..lxMax+1]
    // (Y/Z edges, which extend one bit past the voxel range on the +X face).
    // wMax can hit the phantom zero word at wi=wpr — that's the row's padding
    // word from buildDenseSelection, so reads remain in-bounds.
    const wMin = lxMin >> 5;
    const wMax = (lxMax + 1) >> 5;
    const wRange = wMax - wMin + 1;

    const pts: number[] = [];

    // ── X-edge pass ─────────────────────────────────────────────────
    // axis=0, runs along X. for each (ey, ez), kept[bit] tells us whether
    // an X-edge at e_x=bit should be drawn; per-bit walk merges runs.
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
            // no explicit closer needed: the bit at e_x = lxMax+1 lives in
            // word wMax (kept = 0 there since voxels stop at lxMax), so the
            // run always closes during the per-bit walk above.
        }
    }

    // shared state for Y- and Z-edge passes — per-X-position kept word
    // and run-start tracking. allocated once, reset on each outer slab.
    const prevKept = new Uint32Array(wRange);
    const runStart = new Int32Array(wRange << 5);

    // ── Y-edge pass ─────────────────────────────────────────────────
    // axis=1, B=Z, C=X. outer ez, inner ey; runs along Y.
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

    // ── Z-edge pass ─────────────────────────────────────────────────
    // axis=2, B=X, C=Y. outer ey, inner ez; runs along Z.
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

// ── bounding-box outline segments ──────────────────────────────────
//
// emits the 12 edges of an AABB as a flat [x,y,z, x,y,z, ...] segment
// pair array for LineSegmentsGeometry. callers pass either Selection
// bounds (committed selection / brush outline) or a precomputed world
// AABB (hover collider outline). OUTLINE_EXPAND keeps the outline just
// outside the fill mesh to avoid z-fighting.

const OUTLINE_EXPAND = 0.02;

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

/**
 * 12 edges of the AABB [x0,y0,z0]..[x1,y1,z1] as a flat segment-pair array
 * for LineSegmentsGeometry. coords are passed through verbatim — callers
 * apply any expansion they need before calling.
 */
export function aabbOutlineSegments(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
): number[] {
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

/**
 * 12 triangles forming a closed box for the AABB [x0,y0,z0]..[x1,y1,z1].
 * used for the cyan brush mesh when hovering a sub-unit collider — the
 * cell-based Selection greedy mesher can't represent <1m shapes, so we
 * synthesize the box directly. brush material has cullMode:'none', so
 * winding doesn't matter.
 */
export function buildAabbBoxGeometry(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
): Geometry {
    const positions = new Float32Array([
        x0, y0, z0,
        x1, y0, z0,
        x1, y1, z0,
        x0, y1, z0,
        x0, y0, z1,
        x1, y0, z1,
        x1, y1, z1,
        x0, y1, z1,
    ]);
    const indices = new Uint32Array([
        0, 1, 2, 0, 2, 3, // -Z
        4, 6, 5, 4, 7, 6, // +Z
        0, 3, 7, 0, 7, 4, // -X
        1, 5, 6, 1, 6, 2, // +X
        0, 4, 5, 0, 5, 1, // -Y
        3, 2, 6, 3, 6, 7, // +Y
    ]);
    const geo = new Geometry();
    geo.setBuffer('position', createVertexBuffer(d.vec3f, positions));
    geo.setIndex(createIndexBuffer(indices));
    geo.drawRange = { start: 0, count: indices.length };
    return geo;
}

// ── SelectionMeshState ─────────────────────────────────────────────

export type SelectionMeshState = {
    selectionMesh: Mesh | null;
    selectionOutline: Mesh | null;
    selectionEdges: Mesh | null;
    // brush: any-shape selection displayed in cyan. used for hovered block (idle),
    // wip box-select region, and future arbitrary brush shapes.
    brushMesh: Mesh | null;
    brushEdges: Mesh | null;
    // single-block aabb outline around the exact hovered voxel — white, tight box.
    hoverOutline: Mesh | null;
    scene: Scene;
    // track last updated data to avoid redundant rebuilds
    _lastSelection: Selection.Selection | null;
    // brush signature: a Selection ref when the brush is cell-based, or a
    // string key `aabb:x0,y0,…,z1` when the brush is a synthesized sub-unit
    // collider box. covers both rebuild triggers via one identity check.
    _lastBrushSig: string | Selection.Selection | null;
    // last brush color refs pushed into the fill / edges uniforms. reference
    // equality matches both patterns: static presets (stable refs → write once)
    // and animated colors (fresh allocation each frame → writes every frame).
    _lastBrushFill: Rgba | null;
    _lastBrushEdges: Rgba | null;
    _lastHoverKey: string; // serialised "x,y,z" or ""
};

export function createSelectionMeshState(scene: Scene): SelectionMeshState {
    return {
        selectionMesh: null,
        selectionOutline: null,
        selectionEdges: null,
        brushMesh: null,
        brushEdges: null,
        hoverOutline: null,
        scene,
        _lastSelection: null,
        _lastBrushSig: null,
        _lastBrushFill: null,
        _lastBrushEdges: null,
        _lastHoverKey: '',
    };
}

export function disposeSelectionMeshState(state: SelectionMeshState): void {
    if (state.selectionMesh) {
        state.scene.remove(state.selectionMesh);
        state.selectionMesh.geometry.dispose();
        state.selectionMesh = null;
    }
    if (state.selectionOutline) {
        state.scene.remove(state.selectionOutline);
        state.selectionOutline.geometry.dispose();
        state.selectionOutline = null;
    }
    if (state.selectionEdges) {
        state.scene.remove(state.selectionEdges);
        state.selectionEdges.geometry.dispose();
        state.selectionEdges = null;
    }
    if (state.brushMesh) {
        state.scene.remove(state.brushMesh);
        state.brushMesh.geometry.dispose();
        state.brushMesh = null;
    }
    if (state.brushEdges) {
        state.scene.remove(state.brushEdges);
        state.brushEdges.geometry.dispose();
        state.brushEdges = null;
    }
    if (state.hoverOutline) {
        state.scene.remove(state.hoverOutline);
        state.hoverOutline.geometry.dispose();
        state.hoverOutline = null;
    }
}

// ── per-frame update ───────────────────────────────────────────────

function setMesh(
    state: SelectionMeshState,
    which: 'selectionMesh' | 'brushMesh',
    geo: Geometry | null,
    material: Material,
): void {
    const current = state[which];

    if (!geo) {
        if (current) {
            state.scene.remove(current);
            current.geometry.dispose();
            state[which] = null;
        }
        return;
    }

    if (current) {
        current.geometry.dispose();
        current.geometry = geo;
    } else {
        const mesh = new Mesh(geo, material);
        mesh.name = `editor-selection-${which}`;
        mesh.frustumCulled = false;
        state.scene.add(mesh);
        state[which] = mesh;
    }
}

function setOutlineMesh(
    state: SelectionMeshState,
    which: 'selectionOutline' | 'selectionEdges' | 'brushEdges' | 'hoverOutline',
    pts: number[] | null,
    material: LineMaterial,
): void {
    const current = state[which];

    if (!pts) {
        if (current) {
            state.scene.remove(current);
            current.geometry.dispose();
            state[which] = null;
        }
        return;
    }

    if (current) {
        // reuse the existing mesh — just swap geometry
        current.geometry.dispose();
        current.geometry = new LineSegmentsGeometry(pts);
    } else {
        const mesh = new Mesh(new LineSegmentsGeometry(pts), material);
        mesh.name = `editor-selection-${which}`;
        mesh.frustumCulled = false;
        state.scene.add(mesh);
        state[which] = mesh;
    }
}

export function updateSelectionMeshes(meshState: SelectionMeshState, state: EditRoomState): void {
    // update committed selection mesh + outline when the object reference changes
    if (state.selection !== meshState._lastSelection) {
        meshState._lastSelection = state.selection;
        setMesh(
            meshState,
            'selectionMesh',
            state.selection ? buildSelectionGeometry(state.selection) : null,
            getSelectionMaterial(),
        );
        setOutlineMesh(
            meshState,
            'selectionOutline',
            state.selection ? buildOutlineSegments(state.selection) : null,
            getSelectionOutlineMaterial(),
        );
        setOutlineMesh(
            meshState,
            'selectionEdges',
            state.selection ? buildMeshEdgeSegments(state.selection) : null,
            getSelectionEdgesMaterial(),
        );
    }

    // brush mesh: cell-based Selection most of the time, but for hovers on
    // sub-unit colliders (torches, fences, …) we synthesize a single-box
    // geometry at the collider AABB so the cyan visualization matches the
    // actual shape. brush is set by editor/index.ts each frame from
    // hoverVoxel (idle) or boxSelect.previewB (wip).
    //
    // signature folds brush ref + aabb-shape mode + aabb key so the brush
    // rebuilds when the mode flips OR the AABB moves between cells, even if
    // the underlying hoverVoxel Selection ref change wouldn't have triggered it.
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
            setMesh(
                meshState,
                'brushMesh',
                buildAabbBoxGeometry(hoverAabb[0], hoverAabb[1], hoverAabb[2], hoverAabb[3], hoverAabb[4], hoverAabb[5]),
                getBrushMaterial(),
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
                getBrushEdgesMaterial(),
            );
        } else {
            setMesh(
                meshState,
                'brushMesh',
                state.brush ? buildSelectionGeometry(state.brush) : null,
                getBrushMaterial(),
            );
            setOutlineMesh(
                meshState,
                'brushEdges',
                state.brush ? buildMeshEdgeSegments(state.brush) : null,
                getBrushEdgesMaterial(),
            );
        }
    }

    // brush fill / edges colors → vec4f uniforms on the shared materials.
    // tools set rgba via `brushFill` / `brushEdges` (null = default cyan).
    // reference equality covers both the static-preset and per-frame-pulse
    // cases without any special "is animated?" flag.
    const fill = state.brushFill ?? BRUSH_FILL_DEFAULT;
    if (fill !== meshState._lastBrushFill) {
        meshState._lastBrushFill = fill;
        if (_brushFillUniform) _brushFillUniform.value = fill;
    }
    const edges = state.brushEdges ?? BRUSH_EDGES_DEFAULT;
    if (edges !== meshState._lastBrushEdges) {
        meshState._lastBrushEdges = edges;
        if (_brushEdgesUniform) _brushEdgesUniform.value = edges;
    }

    // hover outline geometry — tight white box around the hovered block's
    // collider AABB. visibility is decided below.
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
        setOutlineMesh(meshState, 'hoverOutline', pts, getHoverOutlineMaterial());
    }

    // white hover outline pins down the focal cell within a multi-cell
    // brush region. for single-cell brushes the brush mesh+edges already
    // show the cell bounds (or the sub-unit AABB in the useAabbBrush path),
    // so the outline would be redundant. tools without a brush (inspect,
    // transform) render no hover affordance at all.
    if (meshState.hoverOutline) {
        meshState.hoverOutline.visible = hasBrush && brushBig;
    }
}
