// ── selection mesh benchmark ────────────────────────────────────────
//
// run with: pnpm vitest bench src/editor/selection-mesh.bench.ts
//
// the editor pipeline rebuilds three CPU-side artifacts every time the
// committed selection (or the brush) changes:
//
//   1. buildSelectionGeometry  — greedy-mesh quads for the translucent fill
//   2. buildMeshEdgeSegments   — per-voxel crease + boundary edges (heavy)
//   3. buildOutlineSegments    — 12-edge AABB outline (trivial)
//
// then `setOutlineMesh` wraps the segments into a fresh LineSegmentsGeometry
// (which writes 4 instance buffers + an index buffer — also non-trivial for
// dense edge sets).
//
// these benches isolate each stage so we can see which one dominates per
// pattern, and a "combined" bench that mimics one updateSelectionMeshes
// pass over the committed selection (fill + outline + edges).

import { bench, describe } from 'vitest';
import { LineSegmentsGeometry } from 'gpucat';
import {
    buildMeshEdgeSegments,
    buildOutlineSegments,
    buildSelectionGeometry,
} from './selection-mesh';
import * as Selection from '../core/scene/selection';

// ── scenario builders ───────────────────────────────────────────────

function aabb(min: number, max: number): Selection.Selection {
    const sel = Selection.create();
    Selection.setAABB(sel, min, min, min, max, max, max);
    return sel;
}

function single(): Selection.Selection {
    const sel = Selection.create();
    Selection.set(sel, 0, 0, 0);
    return sel;
}

/** hollow box shell — only the surface voxels of an N^3 cube */
function shell(n: number): Selection.Selection {
    const sel = Selection.create();
    for (let z = 0; z < n; z++) {
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                const onSurf =
                    x === 0 || x === n - 1 || y === 0 || y === n - 1 || z === 0 || z === n - 1;
                if (onSurf) Selection.set(sel, x, y, z);
            }
        }
    }
    return sel;
}

/** sparse scatter — `count` voxels in a region of side `range` (deterministic). */
function sparse(count: number, range: number): Selection.Selection {
    const sel = Selection.create();
    let seed = 0xdeadbeef;
    for (let i = 0; i < count; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const x = seed % range;
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const y = seed % range;
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const z = seed % range;
        Selection.set(sel, x, y, z);
    }
    return sel;
}

/** worst-case crease pattern — every other voxel set in an n^3 cube */
function checkerboard(n: number): Selection.Selection {
    const sel = Selection.create();
    for (let z = 0; z < n; z++)
        for (let y = 0; y < n; y++)
            for (let x = 0; x < n; x++) if ((x + y + z) % 2 === 0) Selection.set(sel, x, y, z);
    return sel;
}

/** thin slab — 1 voxel tall, n×n footprint. very common box-select pattern. */
function slab(n: number): Selection.Selection {
    const sel = Selection.create();
    Selection.setAABB(sel, 0, 0, 0, n - 1, 0, n - 1);
    return sel;
}

// ── scenarios ───────────────────────────────────────────────────────
// pre-built so the bench measures only the rebuild, not the population.

const SCENARIOS: { name: string; sel: Selection.Selection }[] = [
    { name: 'single voxel', sel: single() },
    { name: 'slab 16x1x16 (256 voxels, 1 chunk)', sel: slab(16) },
    { name: 'slab 64x1x64 (4096 voxels, 16 chunks)', sel: slab(64) },
    { name: 'box 8^3 (512 voxels, 1 chunk)', sel: aabb(0, 7) },
    { name: 'box 16^3 (4096 voxels, 1 chunk)', sel: aabb(0, 15) },
    { name: 'box 32^3 (32k voxels, 8 chunks)', sel: aabb(0, 31) },
    { name: 'box 64^3 (262k voxels, 64 chunks)', sel: aabb(0, 63) },
    { name: 'shell 16^3 (488 voxels, 1 chunk)', sel: shell(16) },
    { name: 'shell 32^3 (3768 voxels, 8 chunks)', sel: shell(32) },
    { name: 'sparse 256 voxels across 64-wide region', sel: sparse(256, 64) },
    { name: 'checkerboard 16^3 (~2048 voxels, max creases)', sel: checkerboard(16) },
];

// ── 1. buildSelectionGeometry (fill mesh) ───────────────────────────
//
// path: derive AABB → tighten via per-voxel scan → meshOccupancy →
//       meshToGeometry (allocates Float32Array + Uint32Array + GpuBuffer wrappers).

describe('buildSelectionGeometry', () => {
    for (const { name, sel } of SCENARIOS) {
        bench(name, () => {
            buildSelectionGeometry(sel);
        });
    }
});

// ── 2. buildMeshEdgeSegments (crease/boundary edge lines) ───────────
//
// path: per-voxel emit 12 candidate unit edges → 4-cell classify via
//       Selection.has → bucket into Map<string, Set<number>> → sort +
//       merge runs → flat number[].
//
// hot spots in this function:
//   - string keys for dedup `seen` (per candidate edge, 12×voxels)
//   - string keys for line buckets `lines`
//   - 4 Selection.has lookups per candidate
//   - final sort per line

describe('buildMeshEdgeSegments', () => {
    for (const { name, sel } of SCENARIOS) {
        bench(name, () => {
            buildMeshEdgeSegments(sel);
        });
    }
});

// ── 3. buildOutlineSegments (12-edge AABB outline) ──────────────────
//
// path: per-voxel scan for bounds → emit 24 line endpoints. should be
// fast and bounded by O(set voxels) from the bounds scan.

describe('buildOutlineSegments', () => {
    for (const { name, sel } of SCENARIOS) {
        bench(name, () => {
            buildOutlineSegments(sel);
        });
    }
});

// ── 4. LineSegmentsGeometry construction ────────────────────────────
//
// this is the cost setOutlineMesh adds on top of the builder. it
// allocates instanceStart/instanceEnd/side/uv float arrays and an index
// buffer, then runs writeSegmentPairs. dominated by the number of
// segments returned by the builder.

describe('LineSegmentsGeometry from buildMeshEdgeSegments output', () => {
    for (const { name, sel } of SCENARIOS) {
        const pts = buildMeshEdgeSegments(sel);
        if (!pts) continue;
        bench(name, () => {
            new LineSegmentsGeometry(pts);
        });
    }
});

describe('LineSegmentsGeometry from buildOutlineSegments output', () => {
    for (const { name, sel } of SCENARIOS) {
        const pts = buildOutlineSegments(sel);
        if (!pts) continue;
        bench(name, () => {
            new LineSegmentsGeometry(pts);
        });
    }
});

// ── 5. combined "selection changed" rebuild ─────────────────────────
//
// mimics updateSelectionMeshes for a committed selection swap:
//   setMesh(selection)         → buildSelectionGeometry
//   setOutlineMesh(outline)    → buildOutlineSegments       + new LineSegmentsGeometry
//   setOutlineMesh(edges)      → buildMeshEdgeSegments      + new LineSegmentsGeometry
//
// this is the number the editor user actually feels when the selection
// reference changes (and again when the brush reference changes).

describe('combined selection rebuild (fill + outline + edges)', () => {
    for (const { name, sel } of SCENARIOS) {
        bench(name, () => {
            buildSelectionGeometry(sel);
            const outlinePts = buildOutlineSegments(sel);
            if (outlinePts) new LineSegmentsGeometry(outlinePts);
            const edgePts = buildMeshEdgeSegments(sel);
            if (edgePts) new LineSegmentsGeometry(edgePts);
        });
    }
});
