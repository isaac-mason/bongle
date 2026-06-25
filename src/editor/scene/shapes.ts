/**
 * brush shape rasterisers — fill a `Selection` with the voxels covered by
 * a centered primitive (sphere / cube / cylinder / disc). callers use the
 * resulting selection as input to resolveFill / overlay / replace, so
 * brush click application reuses the same pattern + mask machinery as the
 * selection-based verbs.
 *
 * size semantics: `size` is the radius from the centre voxel (size=0
 * yields a single voxel for sphere/cube/disc; size=1 yields a 3³ cube
 * or a small ball / cross). `height` is total vertical extent for the
 * cylinder, centred on the click; cylinder with height=1 is a single-
 * layer disc and is equivalent to `disc`. heights are clamped to ≥1.
 *
 * sphere test is `dx²+dy²+dz² ≤ r²+r` — a well-known voxel-sphere formula
 * that produces a rounder shape than the naive `≤ r²` (which makes radius
 * 1 a 6-voxel plus-sign rather than a small ball).
 */

import * as Selection from '../../core/scene/selection';

export type BrushShape = 'sphere' | 'cube' | 'cylinder' | 'disc';

/** clear `out` and fill it with the brush shape centred at (cx, cy, cz). */
export function buildShape(
    out: Selection.Selection,
    shape: BrushShape,
    cx: number,
    cy: number,
    cz: number,
    size: number,
    height: number,
): void {
    out.chunks.clear();
    out.nodes.clear();
    const r = Math.max(0, Math.floor(size));
    const h = Math.max(1, Math.floor(height));
    switch (shape) {
        case 'sphere':
            sphere(out, cx, cy, cz, r);
            return;
        case 'cube':
            Selection.setAABB(out, cx - r, cy - r, cz - r, cx + r, cy + r, cz + r);
            return;
        case 'cylinder':
            cylinder(out, cx, cy, cz, r, h);
            return;
        case 'disc':
            cylinder(out, cx, cy, cz, r, 1);
            return;
    }
}

function sphere(out: Selection.Selection, cx: number, cy: number, cz: number, r: number): void {
    const rsq = r * r + r;
    for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
            for (let dx = -r; dx <= r; dx++) {
                if (dx * dx + dy * dy + dz * dz <= rsq) {
                    Selection.set(out, cx + dx, cy + dy, cz + dz);
                }
            }
        }
    }
}

function cylinder(out: Selection.Selection, cx: number, cy: number, cz: number, r: number, h: number): void {
    // centre the vertical extent: odd h is symmetric, even h tips up by one.
    const yLo = cy - ((h - 1) >> 1);
    const yHi = yLo + h - 1;
    const rsq = r * r + r;
    for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
            if (dx * dx + dz * dz > rsq) continue;
            const wx = cx + dx;
            const wz = cz + dz;
            for (let wy = yLo; wy <= yHi; wy++) {
                Selection.set(out, wx, wy, wz);
            }
        }
    }
}
