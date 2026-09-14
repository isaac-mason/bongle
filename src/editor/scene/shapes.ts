import * as Selection from '../../core/scene/selection';

export type BrushShape = 'sphere' | 'cube' | 'cylinder' | 'disc';

/** `size` is the radius from the centre voxel; `height` is the cylinder's total vertical extent, clamped to >= 1. */
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
    // dx^2+dy^2+dz^2 <= r^2+r rounds better than <= r^2, which makes radius 1 a plus-sign.
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
    // odd h centers symmetrically, even h tips up by one.
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
