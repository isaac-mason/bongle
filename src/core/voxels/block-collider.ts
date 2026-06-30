import * as crashcat from 'crashcat';

// ── block shape types ───────────────────────────────────────────────
//
// pure data objects describing collision shapes in block-local [0,1]³
// space. rotation operates on these descriptions. conversion to
// crashcat shapes happens at registry freeze time via blockShapeToShape().
//
// taxonomy:
//   cube, full unit cube (the implicit default; explicit form accepted too)
//   aabbs, axis-aligned box list (stairs, slabs, fences, walls, panes, ...)

/** [minX, minY, minZ, maxX, maxY, maxZ] in block-local [0,1]³. */
export type AABB = readonly [number, number, number, number, number, number];

export type BlockShapeCube = { type: 'cube' };

export type BlockShapeAabbs = { type: 'aabbs'; boxes: AABB[] };

export type BlockShape = BlockShapeCube | BlockShapeAabbs;

// ── builder helpers ─────────────────────────────────────────────────

export function cube(): BlockShapeCube {
    return { type: 'cube' };
}

export function aabbs(boxes: AABB[]): BlockShapeAabbs {
    return { type: 'aabbs', boxes };
}

// ── rotation ────────────────────────────────────────────────────────
//
// rotate a block shape around the Y axis by steps × 90° CW
// (viewed from +Y). rotation is around block center (0.5, y, 0.5).
//
// step 1: (x,y,z) → (z, y, 1-x)
// step 2: (x,y,z) → (1-x, y, 1-z)
// step 3: (x,y,z) → (1-z, y, x)

function rotatePosY(x: number, y: number, z: number, steps: number): [number, number, number] {
    switch (steps) {
        case 1:
            return [z, y, 1 - x];
        case 2:
            return [1 - x, y, 1 - z];
        case 3:
            return [1 - z, y, x];
        default:
            return [x, y, z];
    }
}

function rotateAabbY(box: AABB, steps: number): AABB {
    const [minA, minB, minC] = rotatePosY(box[0], box[1], box[2], steps);
    const [maxA, maxB, maxC] = rotatePosY(box[3], box[4], box[5], steps);
    // rotation flips min/max on the swapped axes; renormalize.
    return [
        Math.min(minA, maxA),
        Math.min(minB, maxB),
        Math.min(minC, maxC),
        Math.max(minA, maxA),
        Math.max(minB, maxB),
        Math.max(minC, maxC),
    ];
}

/**
 * rotate a block shape around the Y axis by steps × 90° CW.
 * rotation is around block center (0.5, y, 0.5).
 *
 * @param shape - input shape (not mutated)
 * @param steps - rotation steps: 0=0°, 1=90° CW, 2=180°, 3=270° CW (viewed from +Y)
 */
export function rotateY(shape: BlockShape, steps: number): BlockShape {
    const s = ((steps % 4) + 4) % 4;
    if (s === 0) return shape;

    switch (shape.type) {
        case 'cube':
            return shape;

        case 'aabbs':
            return { type: 'aabbs', boxes: shape.boxes.map((b) => rotateAabbY(b, s)) };
    }
}

// ── conversion to crashcat shapes ───────────────────────────────────
//
// called once at registry freeze time. not exported to user API.
//
// cube is intentionally absent, the registry handles cubes via the
// colliderId=0 sentinel and never builds a crashcat shape for them.

export function blockShapeToShape(shape: Exclude<BlockShape, BlockShapeCube>): crashcat.Shape {
    if (shape.boxes.length === 1) {
        const b = shape.boxes[0]!;
        const hx = (b[3] - b[0]) * 0.5;
        const hy = (b[4] - b[1]) * 0.5;
        const hz = (b[5] - b[2]) * 0.5;
        const cx = (b[3] + b[0]) * 0.5;
        const cy = (b[4] + b[1]) * 0.5;
        const cz = (b[5] + b[2]) * 0.5;
        const inner = crashcat.box.create({ halfExtents: [hx, hy, hz] });
        if (cx === 0 && cy === 0 && cz === 0) return inner;
        return crashcat.transformed.create({
            shape: inner,
            position: [cx, cy, cz],
            quaternion: [0, 0, 0, 1],
        });
    }

    const children: crashcat.StaticCompoundShapeSettings['children'] = shape.boxes.map((b) => {
        const hx = (b[3] - b[0]) * 0.5;
        const hy = (b[4] - b[1]) * 0.5;
        const hz = (b[5] - b[2]) * 0.5;
        const cx = (b[3] + b[0]) * 0.5;
        const cy = (b[4] + b[1]) * 0.5;
        const cz = (b[5] + b[2]) * 0.5;
        return {
            position: [cx, cy, cz] as [number, number, number],
            quaternion: [0, 0, 0, 1] as [number, number, number, number],
            shape: crashcat.box.create({ halfExtents: [hx, hy, hz] }),
        };
    });
    return crashcat.staticCompound.create({ children });
}
