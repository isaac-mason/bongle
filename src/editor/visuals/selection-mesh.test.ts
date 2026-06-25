// verifies buildSelectionGeometry produces geometry equivalent to a
// reference implementation that probes Selection.has directly. catches
// off-by-one / shift / chunk-coord mistakes in the dense-bitmask path.

import { describe, expect, test } from 'vitest';
import * as Selection from '../../core/scene/selection';
import { meshOccupancy, meshToGeometry } from '../../core/voxels/greedy-mesh';
import { buildMeshEdgeSegments, buildSelectionGeometry } from './selection-mesh';

// reference edge classifier — the original per-voxel + Selection.has +
// Map<string, Set<number>> implementation. compared against the
// bitmask-native rewrite below.
const TANGENTS: readonly (readonly [number, number])[] = [
    [1, 2],
    [2, 0],
    [0, 1],
];
function referenceMeshEdgeSegments(sel: Selection.Selection): number[] | null {
    if (sel.chunks.size === 0) return null;
    const lines = new Map<string, Set<number>>();
    const seen = new Set<string>();
    const classify = (axis: number, a: number, b: number, c: number): boolean => {
        const B = TANGENTS[axis]![0];
        const C = TANGENTS[axis]![1];
        const cellOcc = (db: number, dc: number): boolean => {
            const co: [number, number, number] = [0, 0, 0];
            co[axis] = a;
            co[B] = b + db;
            co[C] = c + dc;
            return Selection.has(sel, co[0], co[1], co[2]);
        };
        const c00 = cellOcc(-1, -1),
            c10 = cellOcc(0, -1);
        const c01 = cellOcc(-1, 0),
            c11 = cellOcc(0, 0);
        const posB = B * 2,
            negB = B * 2 + 1;
        const posC = C * 2,
            negC = C * 2 + 1;
        let count = 0,
            firstOri = -1,
            allSame = true;
        if (c00 !== c10) {
            const o = c00 ? posB : negB;
            count++;
            firstOri = o;
        }
        if (c01 !== c11) {
            const o = c01 ? posB : negB;
            count++;
            if (firstOri === -1) firstOri = o;
            else if (firstOri !== o) allSame = false;
        }
        if (c00 !== c01) {
            const o = c00 ? posC : negC;
            count++;
            if (firstOri === -1) firstOri = o;
            else if (firstOri !== o) allSame = false;
        }
        if (c10 !== c11) {
            const o = c10 ? posC : negC;
            count++;
            if (firstOri === -1) firstOri = o;
            else if (firstOri !== o) allSame = false;
        }
        if (count === 0) return false;
        if (count === 2 && allSame) return false;
        return true;
    };
    const tryEdge = (axis: number, a: number, b: number, c: number): void => {
        const k = `${axis},${a},${b},${c}`;
        if (seen.has(k)) return;
        seen.add(k);
        if (!classify(axis, a, b, c)) return;
        const lk = `${axis},${b},${c}`;
        let s = lines.get(lk);
        if (!s) {
            s = new Set();
            lines.set(lk, s);
        }
        s.add(a);
    };
    Selection.forEach(sel, (vx, vy, vz) => {
        tryEdge(0, vx, vy, vz);
        tryEdge(0, vx, vy + 1, vz);
        tryEdge(0, vx, vy, vz + 1);
        tryEdge(0, vx, vy + 1, vz + 1);
        tryEdge(1, vy, vz, vx);
        tryEdge(1, vy, vz + 1, vx);
        tryEdge(1, vy, vz, vx + 1);
        tryEdge(1, vy, vz + 1, vx + 1);
        tryEdge(2, vz, vx, vy);
        tryEdge(2, vz, vx + 1, vy);
        tryEdge(2, vz, vx, vy + 1);
        tryEdge(2, vz, vx + 1, vy + 1);
    });
    const pts: number[] = [];
    for (const [lk, set] of lines) {
        const parts = lk.split(',');
        const axis = parseInt(parts[0]!, 10);
        const b = parseInt(parts[1]!, 10);
        const c = parseInt(parts[2]!, 10);
        const B = TANGENTS[axis]![0];
        const C = TANGENTS[axis]![1];
        const sorted = [...set].sort((x, y) => x - y);
        let rs = sorted[0]!,
            re = rs;
        const emit = (s: number, e: number): void => {
            const p0: [number, number, number] = [0, 0, 0];
            const p1: [number, number, number] = [0, 0, 0];
            p0[axis] = s;
            p0[B] = b;
            p0[C] = c;
            p1[axis] = e + 1;
            p1[B] = b;
            p1[C] = c;
            pts.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2]);
        };
        for (let i = 1; i < sorted.length; i++) {
            const a = sorted[i]!;
            if (a === re + 1) re = a;
            else {
                emit(rs, re);
                rs = a;
                re = a;
            }
        }
        emit(rs, re);
    }
    return pts.length > 0 ? pts : null;
}

// canonicalize a flat [x,y,z,x,y,z,...] segment array into a sorted list
// of "x0,y0,z0|x1,y1,z1" keys, with each segment's endpoints ordered
// lex-smaller-first.
function canonSegments(pts: number[] | null): string[] {
    if (!pts) return [];
    const segs: string[] = [];
    for (let i = 0; i < pts.length; i += 6) {
        const a = [pts[i]!, pts[i + 1]!, pts[i + 2]!];
        const b = [pts[i + 3]!, pts[i + 4]!, pts[i + 5]!];
        const aFirst = a[0]! < b[0]! || (a[0] === b[0] && (a[1]! < b[1]! || (a[1] === b[1] && a[2]! <= b[2]!)));
        const [p, q] = aFirst ? [a, b] : [b, a];
        segs.push(`${p[0]},${p[1]},${p[2]}|${q[0]},${q[1]},${q[2]}`);
    }
    segs.sort();
    return segs;
}

function referenceGeometry(sel: Selection.Selection) {
    if (sel.chunks.size === 0) return null;
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
    let found = false;
    Selection.forEach(sel, (x, y, z) => {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
        found = true;
    });
    if (!found) return null;
    const mesh = meshOccupancy({
        occ: (x, y, z) => Selection.has(sel, x, y, z),
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
        emitNormals: false,
    });
    return mesh ? meshToGeometry(mesh) : null;
}

function indexCount(g: ReturnType<typeof buildSelectionGeometry>): number {
    if (!g) return 0;
    return g.drawRange?.count ?? 0;
}

function positionCount(g: ReturnType<typeof buildSelectionGeometry>): number {
    if (!g) return 0;
    const buf = g.getBuffer('position');
    return buf?.array?.length ?? 0;
}

const scenarios: { name: string; build: () => Selection.Selection }[] = [
    { name: 'empty', build: () => Selection.create() },
    {
        name: 'single voxel at origin',
        build: () => {
            const s = Selection.create();
            Selection.set(s, 0, 0, 0);
            return s;
        },
    },
    {
        name: 'single voxel at negative coords',
        build: () => {
            const s = Selection.create();
            Selection.set(s, -3, -7, -11);
            return s;
        },
    },
    {
        name: 'box 8^3',
        build: () => {
            const s = Selection.create();
            Selection.setAABB(s, 0, 0, 0, 7, 7, 7);
            return s;
        },
    },
    {
        name: 'box 16^3',
        build: () => {
            const s = Selection.create();
            Selection.setAABB(s, 0, 0, 0, 15, 15, 15);
            return s;
        },
    },
    {
        name: 'box 32^3',
        build: () => {
            const s = Selection.create();
            Selection.setAABB(s, 0, 0, 0, 31, 31, 31);
            return s;
        },
    },
    {
        name: 'box spanning chunk boundary',
        build: () => {
            const s = Selection.create();
            Selection.setAABB(s, 14, 14, 14, 17, 17, 17);
            return s;
        },
    },
    {
        name: 'box spanning 3 chunks in X',
        build: () => {
            const s = Selection.create();
            Selection.setAABB(s, 0, 0, 0, 47, 0, 0);
            return s;
        },
    },
    {
        name: 'sparse scatter',
        build: () => {
            const s = Selection.create();
            let seed = 12345;
            for (let i = 0; i < 64; i++) {
                seed = (seed * 1103515245 + 12345) & 0x7fffffff;
                const x = seed % 48;
                seed = (seed * 1103515245 + 12345) & 0x7fffffff;
                const y = seed % 48;
                seed = (seed * 1103515245 + 12345) & 0x7fffffff;
                const z = seed % 48;
                Selection.set(s, x, y, z);
            }
            return s;
        },
    },
    {
        name: 'shell 8^3',
        build: () => {
            const s = Selection.create();
            const n = 8;
            for (let z = 0; z < n; z++)
                for (let y = 0; y < n; y++)
                    for (let x = 0; x < n; x++) {
                        if (x === 0 || x === n - 1 || y === 0 || y === n - 1 || z === 0 || z === n - 1) Selection.set(s, x, y, z);
                    }
            return s;
        },
    },
];

describe('buildSelectionGeometry — bitmask-native vs reference', () => {
    for (const sc of scenarios) {
        test(sc.name, () => {
            const sel = sc.build();
            const a = buildSelectionGeometry(sel);
            const b = referenceGeometry(sel);

            expect(indexCount(a)).toBe(indexCount(b));
            expect(positionCount(a)).toBe(positionCount(b));

            if (a && b) {
                // exact position-buffer match — meshOccupancy is deterministic, so
                // identical occupancy must produce byte-identical positions.
                const pa = a.getBuffer('position')!.array as Float32Array;
                const pb = b.getBuffer('position')!.array as Float32Array;
                expect(pa.length).toBe(pb.length);
                for (let i = 0; i < pa.length; i++) expect(pa[i]).toBe(pb[i]);
            }
        });
    }
});

describe('buildMeshEdgeSegments — bitmask-native vs reference', () => {
    for (const sc of scenarios) {
        test(sc.name, () => {
            const sel = sc.build();
            const a = canonSegments(buildMeshEdgeSegments(sel));
            const b = canonSegments(referenceMeshEdgeSegments(sel));
            expect(a).toEqual(b);
        });
    }
});
