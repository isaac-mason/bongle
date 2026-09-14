import type { Vec2, Vec3 } from 'math';
import { type BlockQuad, type CubeTiles, faceTile, type MaterialType, type TileHandle } from './blocks';

type CullFace = BlockQuad['cullFace'];

/** default quad uvs, full texture. V=0 at top of image, V=1 at bottom. */
const DEFAULT_QUAD_UVS: [Vec2, Vec2, Vec2, Vec2] = [
    [0, 1],
    [1, 1],
    [1, 0],
    [0, 0],
];

/** create a single quad from 4 CCW vertices in block-local [0,1] space. */
export function quad(
    verts: [Vec3, Vec3, Vec3, Vec3],
    normal: Vec3,
    tile: TileHandle,
    options?: {
        uvs?: [Vec2, Vec2, Vec2, Vec2];
        cullFace?: CullFace;
        material?: MaterialType;
        shade?: boolean;
    },
): BlockQuad {
    return {
        verts,
        normal,
        tile,
        uvs: options?.uvs ?? DEFAULT_QUAD_UVS,
        cullFace: options?.cullFace,
        material: options?.material,
        shade: options?.shade,
    };
}

type FaceDir = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';

/** generate the 6 quads of an axis-aligned box in block-local [0,1] space. */
export function box(
    from: Vec3,
    to: Vec3,
    tiles: CubeTiles,
    options?: {
        exclude?: FaceDir[];
        /** faces flush with the block boundary auto-cull by default; false disables, or override per face. */
        cull?: boolean | Partial<Record<FaceDir, boolean>>;
        material?: MaterialType;
        /** 'stretch' fills each face; 'local' samples the sub-rect matching the face's local extent. */
        uvs?: 'stretch' | 'local';
    },
): BlockQuad[] {
    const [x0, y0, z0] = from;
    const [x1, y1, z1] = to;
    const excluded = new Set(options?.exclude);
    const quads: BlockQuad[] = [];
    const mat = options?.material;
    const useLocalUv = options?.uvs === 'local';

    const tex = resolveTiles(tiles);

    function shouldCull(dir: FaceDir, coord: number, boundary: number): CullFace | undefined {
        if (options?.cull === false) return undefined;
        if (typeof options?.cull === 'object') {
            const override = options.cull[dir];
            if (override === false) return undefined;
            if (override === true) return dir;
        }
        return Math.abs(coord - boundary) < 1e-6 ? dir : undefined;
    }

    function emitQuad(
        verts: [Vec3, Vec3, Vec3, Vec3],
        normal: Vec3,
        tile: TileHandle,
        cullFace: CullFace | undefined,
        localUvs: [Vec2, Vec2, Vec2, Vec2] | undefined,
    ): void {
        quads.push(quad(verts, normal, tile, { cullFace, material: mat, uvs: localUvs }));
    }

    if (!excluded.has('up')) {
        // up face UVs use u=z, v=1-x to match the default cube convention.
        const uvs: [Vec2, Vec2, Vec2, Vec2] | undefined = useLocalUv
            ? [
                  [z0, 1 - x0],
                  [z1, 1 - x0],
                  [z1, 1 - x1],
                  [z0, 1 - x1],
              ]
            : undefined;
        emitQuad(
            [
                [x0, y1, z0],
                [x0, y1, z1],
                [x1, y1, z1],
                [x1, y1, z0],
            ],
            [0, 1, 0],
            tex.up,
            shouldCull('up', y1, 1),
            uvs,
        );
    }

    if (!excluded.has('down')) {
        const uvs: [Vec2, Vec2, Vec2, Vec2] | undefined = useLocalUv
            ? [
                  [1 - z1, 1 - x0],
                  [1 - z0, 1 - x0],
                  [1 - z0, 1 - x1],
                  [1 - z1, 1 - x1],
              ]
            : undefined;
        emitQuad(
            [
                [x0, y0, z1],
                [x0, y0, z0],
                [x1, y0, z0],
                [x1, y0, z1],
            ],
            [0, -1, 0],
            tex.down,
            shouldCull('down', y0, 0),
            uvs,
        );
    }

    if (!excluded.has('south')) {
        const uvs: [Vec2, Vec2, Vec2, Vec2] | undefined = useLocalUv
            ? [
                  [x0, 1 - y0],
                  [x1, 1 - y0],
                  [x1, 1 - y1],
                  [x0, 1 - y1],
              ]
            : undefined;
        emitQuad(
            [
                [x0, y0, z1],
                [x1, y0, z1],
                [x1, y1, z1],
                [x0, y1, z1],
            ],
            [0, 0, 1],
            tex.south,
            shouldCull('south', z1, 1),
            uvs,
        );
    }

    if (!excluded.has('north')) {
        const uvs: [Vec2, Vec2, Vec2, Vec2] | undefined = useLocalUv
            ? [
                  [1 - x1, 1 - y0],
                  [1 - x0, 1 - y0],
                  [1 - x0, 1 - y1],
                  [1 - x1, 1 - y1],
              ]
            : undefined;
        emitQuad(
            [
                [x1, y0, z0],
                [x0, y0, z0],
                [x0, y1, z0],
                [x1, y1, z0],
            ],
            [0, 0, -1],
            tex.north,
            shouldCull('north', z0, 0),
            uvs,
        );
    }

    if (!excluded.has('east')) {
        const uvs: [Vec2, Vec2, Vec2, Vec2] | undefined = useLocalUv
            ? [
                  [1 - z1, 1 - y0],
                  [1 - z0, 1 - y0],
                  [1 - z0, 1 - y1],
                  [1 - z1, 1 - y1],
              ]
            : undefined;
        emitQuad(
            [
                [x1, y0, z1],
                [x1, y0, z0],
                [x1, y1, z0],
                [x1, y1, z1],
            ],
            [1, 0, 0],
            tex.east,
            shouldCull('east', x1, 1),
            uvs,
        );
    }

    if (!excluded.has('west')) {
        const uvs: [Vec2, Vec2, Vec2, Vec2] | undefined = useLocalUv
            ? [
                  [z0, 1 - y0],
                  [z1, 1 - y0],
                  [z1, 1 - y1],
                  [z0, 1 - y1],
              ]
            : undefined;
        emitQuad(
            [
                [x0, y0, z0],
                [x0, y0, z1],
                [x0, y1, z1],
                [x0, y1, z0],
            ],
            [-1, 0, 0],
            tex.west,
            shouldCull('west', x0, 0),
            uvs,
        );
    }

    return quads;
}

type ResolvedTiles = {
    up: TileHandle;
    down: TileHandle;
    north: TileHandle;
    south: TileHandle;
    east: TileHandle;
    west: TileHandle;
};

function resolveTiles(tex: CubeTiles): ResolvedTiles {
    if ('all' in tex) {
        const t = faceTile(tex.all);
        return { up: t, down: t, north: t, south: t, east: t, west: t };
    }
    if ('sides' in tex) {
        const s = faceTile(tex.sides);
        return { up: faceTile(tex.top), down: faceTile(tex.bottom), north: s, south: s, east: s, west: s };
    }
    return {
        up: faceTile(tex.top),
        down: faceTile(tex.bottom),
        north: faceTile(tex.north),
        south: faceTile(tex.south),
        east: faceTile(tex.east),
        west: faceTile(tex.west),
    };
}

/** rotate a cullFace direction CW by `steps` 90° increments around Y. */
const CULL_FACE_ROTATE: Record<string, readonly [CullFace, CullFace, CullFace, CullFace]> = {
    north: ['north', 'west', 'south', 'east'],
    west: ['west', 'south', 'east', 'north'],
    south: ['south', 'east', 'north', 'west'],
    east: ['east', 'north', 'west', 'south'],
    up: ['up', 'up', 'up', 'up'],
    down: ['down', 'down', 'down', 'down'],
};

function rotateCullFace(cf: CullFace | undefined, steps: number): CullFace | undefined {
    if (!cf) return undefined;
    return CULL_FACE_ROTATE[cf]![steps]!;
}

/** rotate a position [x,y,z] around the block center (0.5, y, 0.5) by steps x 90 degrees CW. */
function rotatePos(v: Vec3, steps: number): Vec3 {
    const [x, y, z] = v;
    switch (steps) {
        case 1:
            return [z, y, 1 - x];
        case 2:
            return [1 - x, y, 1 - z];
        case 3:
            return [1 - z, y, x];
        default:
            return v;
    }
}

/** rotate a normal [nx,ny,nz] by steps x 90 degrees CW around Y. */
function rotateNormal(n: Vec3, steps: number): Vec3 {
    const [nx, ny, nz] = n;
    switch (steps) {
        case 1:
            return [nz, ny, -nx];
        case 2:
            return [-nx, ny, -nz];
        case 3:
            return [-nz, ny, nx];
        default:
            return n;
    }
}

// must stay in sync with chunk-mesher.ts FACE_UVS faces 2/3 (rotated 90° from box()'s local formula).
function lockUvsY(
    verts: readonly Vec3[],
    normal: Vec3,
    uvs: [Vec2, Vec2, Vec2, Vec2] | undefined,
): [Vec2, Vec2, Vec2, Vec2] | undefined {
    const ny = normal[1];
    if (ny > 0.5) {
        return [
            [verts[0]![0], verts[0]![2]],
            [verts[1]![0], verts[1]![2]],
            [verts[2]![0], verts[2]![2]],
            [verts[3]![0], verts[3]![2]],
        ];
    }
    if (ny < -0.5) {
        return [
            [verts[0]![0], 1 - verts[0]![2]],
            [verts[1]![0], 1 - verts[1]![2]],
            [verts[2]![0], 1 - verts[2]![2]],
            [verts[3]![0], 1 - verts[3]![2]],
        ];
    }
    return uvs;
}

/** rotate quads around Y by `steps` x 90 degrees CW about the block center; `uvlock` pins top/bottom UVs to world axes. */
export function rotateY(quads: BlockQuad[], steps: number, options?: { uvlock?: boolean }): BlockQuad[] {
    const s = ((steps % 4) + 4) % 4;
    const uvlock = options?.uvlock ?? false;
    if (s === 0 && !uvlock) return quads;

    return quads.map((q) => {
        const verts: [Vec3, Vec3, Vec3, Vec3] = [
            rotatePos(q.verts[0], s),
            rotatePos(q.verts[1], s),
            rotatePos(q.verts[2], s),
            rotatePos(q.verts[3], s),
        ];
        return {
            verts,
            normal: rotateNormal(q.normal, s),
            tile: q.tile,
            uvs: uvlock ? lockUvsY(verts, q.normal, q.uvs) : q.uvs,
            cullFace: rotateCullFace(q.cullFace, s),
            material: q.material,
            shade: q.shade,
        };
    });
}

/** mirror a position [x,y,z] across the plane x = 0.5. */
function mirrorPosX(v: Vec3): Vec3 {
    return [1 - v[0], v[1], v[2]];
}

function mirrorNormalX(n: Vec3): Vec3 {
    return [-n[0], n[1], n[2]];
}

function mirrorCullFaceX(cf: CullFace | undefined): CullFace | undefined {
    if (cf === 'east') return 'west';
    if (cf === 'west') return 'east';
    return cf;
}

// mirroring flips winding, so vertex and uv order reverses to keep faces outward; involutive (mirrorX(mirrorX(q)) === q).
export function mirrorX(quads: BlockQuad[]): BlockQuad[] {
    return quads.map((q) => ({
        verts: [mirrorPosX(q.verts[3]), mirrorPosX(q.verts[2]), mirrorPosX(q.verts[1]), mirrorPosX(q.verts[0])] as const,
        normal: mirrorNormalX(q.normal),
        tile: q.tile,
        uvs: q.uvs ? ([q.uvs[3], q.uvs[2], q.uvs[1], q.uvs[0]] as const) : undefined,
        cullFace: mirrorCullFaceX(q.cullFace),
        material: q.material,
        shade: q.shade,
    }));
}

// for off-axis geometry (tilted like a wall torch); build the source box with cull: false since tilted faces don't sit flush with the block boundary.

/** rotate a position about `axis` through `pivot` by `cos`/`sin` of the angle. */
function rotateAxisPos(v: Vec3, axis: 'x' | 'y' | 'z', cos: number, sin: number, pivot: Vec3): Vec3 {
    const dx = v[0] - pivot[0];
    const dy = v[1] - pivot[1];
    const dz = v[2] - pivot[2];
    switch (axis) {
        case 'x':
            return [v[0], pivot[1] + dy * cos - dz * sin, pivot[2] + dy * sin + dz * cos];
        case 'y':
            return [pivot[0] + dx * cos + dz * sin, v[1], pivot[2] - dx * sin + dz * cos];
        case 'z':
            return [pivot[0] + dx * cos - dy * sin, pivot[1] + dx * sin + dy * cos, v[2]];
    }
}

/** rotate a normal about `axis` by `cos`/`sin` of the angle (pivot-independent). */
function rotateAxisNormal(n: Vec3, axis: 'x' | 'y' | 'z', cos: number, sin: number): Vec3 {
    switch (axis) {
        case 'x':
            return [n[0], n[1] * cos - n[2] * sin, n[1] * sin + n[2] * cos];
        case 'y':
            return [n[0] * cos + n[2] * sin, n[1], -n[0] * sin + n[2] * cos];
        case 'z':
            return [n[0] * cos - n[1] * sin, n[0] * sin + n[1] * cos, n[2]];
    }
}

/** rotate quads by `angleDeg` around `axis` through `pivot` (block-local space, right-hand rule); clears cullFace. */
export function rotateAxis(quads: BlockQuad[], axis: 'x' | 'y' | 'z', angleDeg: number, pivot: Vec3): BlockQuad[] {
    const rad = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return quads.map((q) => ({
        verts: [
            rotateAxisPos(q.verts[0], axis, cos, sin, pivot),
            rotateAxisPos(q.verts[1], axis, cos, sin, pivot),
            rotateAxisPos(q.verts[2], axis, cos, sin, pivot),
            rotateAxisPos(q.verts[3], axis, cos, sin, pivot),
        ] as const,
        normal: rotateAxisNormal(q.normal, axis, cos, sin),
        tile: q.tile,
        uvs: q.uvs,
        cullFace: undefined,
        material: q.material,
        shade: q.shade,
    }));
}

/** shear quads along `axis` as a linear function of height: a vertex at `yBase` is unmoved, one at `yBase + ySpan` shifts by `delta`. */
export function shearByHeight(quads: BlockQuad[], axis: 'x' | 'z', yBase: number, ySpan: number, delta: number): BlockQuad[] {
    const ai = axis === 'x' ? 0 : 2;
    const shift = (v: Vec3): Vec3 => {
        const moved: Vec3 = [v[0], v[1], v[2]];
        moved[ai] = v[ai] + ((v[1] - yBase) / ySpan) * delta;
        return moved;
    };
    return quads.map((q) => ({
        verts: [shift(q.verts[0]), shift(q.verts[1]), shift(q.verts[2]), shift(q.verts[3])] as const,
        normal: q.normal,
        tile: q.tile,
        uvs: q.uvs,
        cullFace: q.cullFace,
        material: q.material,
        shade: q.shade,
    }));
}

/** translate an array of BlockQuad by `delta` (block-local space). */
export function translate(quads: BlockQuad[], delta: Vec3): BlockQuad[] {
    const [dx, dy, dz] = delta;
    return quads.map((q) => ({
        verts: [
            [q.verts[0][0] + dx, q.verts[0][1] + dy, q.verts[0][2] + dz],
            [q.verts[1][0] + dx, q.verts[1][1] + dy, q.verts[1][2] + dz],
            [q.verts[2][0] + dx, q.verts[2][1] + dy, q.verts[2][2] + dz],
            [q.verts[3][0] + dx, q.verts[3][1] + dy, q.verts[3][2] + dz],
        ] as const,
        normal: q.normal,
        tile: q.tile,
        uvs: q.uvs,
        cullFace: q.cullFace,
        material: q.material,
        shade: q.shade,
    }));
}

/** create one up-facing quad covering the cell at height `y` (block units). */
export function layer(tile: TileHandle, y: number, options?: { material?: MaterialType }): BlockQuad[] {
    return [
        quad(
            [
                [0, y, 0],
                [0, y, 1],
                [1, y, 1],
                [1, y, 0],
            ],
            [0, 1, 0],
            tile,
            { material: options?.material },
        ),
    ];
}

// double-sided: gpucat backface-culls by default, so each plane needs a reversed-winding duplicate.
const INV_SQRT2 = Math.SQRT1_2;

// uvs: V=0 at top of image (high Y verts), V=1 at bottom (low Y verts)
const CROSS_FRONT_UVS: [Vec2, Vec2, Vec2, Vec2] = [
    [0, 1],
    [1, 1],
    [1, 0],
    [0, 0],
];
const CROSS_BACK_UVS: [Vec2, Vec2, Vec2, Vec2] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
];

/** create two intersecting double-sided diagonal planes (4 quads) for vegetation. */
export function cross(
    tile: TileHandle,
    options?: { height?: number; tileBlocks?: number; material?: MaterialType },
): BlockQuad[] {
    const mat = options?.material;
    const height = options?.height ?? 1;
    // top sits 0.1 below height so fract(world.y) > 0 there, since PLANT_WIND_SWAY freezes at integer block y.
    const TOP = height - 0.1;
    const tileBlocks = options?.tileBlocks ?? Math.ceil(height);
    const v0 = tileBlocks > 1 ? 1 - TOP / tileBlocks : 0;
    const front: [Vec2, Vec2, Vec2, Vec2] = [
        [0, 1],
        [1, 1],
        [1, v0],
        [0, v0],
    ];
    const back: [Vec2, Vec2, Vec2, Vec2] = [
        [0, v0],
        [1, v0],
        [1, 1],
        [0, 1],
    ];
    const INSET = 0.01;
    const LO = INSET;
    const HI = 1 - INSET;
    return [
        quad(
            [
                [LO, 0, LO],
                [HI, 0, HI],
                [HI, TOP, HI],
                [LO, TOP, LO],
            ],
            [INV_SQRT2, 0, -INV_SQRT2],
            tile,
            { uvs: front, material: mat },
        ),
        quad(
            [
                [LO, TOP, LO],
                [HI, TOP, HI],
                [HI, 0, HI],
                [LO, 0, LO],
            ],
            [-INV_SQRT2, 0, INV_SQRT2],
            tile,
            { uvs: back, material: mat },
        ),
        quad(
            [
                [HI, 0, LO],
                [LO, 0, HI],
                [LO, TOP, HI],
                [HI, TOP, LO],
            ],
            [-INV_SQRT2, 0, -INV_SQRT2],
            tile,
            { uvs: front, material: mat },
        ),
        quad(
            [
                [HI, TOP, LO],
                [LO, TOP, HI],
                [LO, 0, HI],
                [HI, 0, LO],
            ],
            [INV_SQRT2, 0, INV_SQRT2],
            tile,
            { uvs: back, material: mat },
        ),
    ];
}

// normals must match box()'s CCW winding, not cross()'s inverted one: classifyFacing (chunk-mesher.ts) cone-culls by facing.
const PLANE_TOP = 0.9;
const PLANE_INSET = 0.01;

// each plane leans outward from block center by leanDeg so planted fields read as a bush, not rows of cards.
function axisPlanes(tile: TileHandle, offsets: readonly number[], mat: MaterialType | undefined, leanDeg = 0): BlockQuad[] {
    const TOP = PLANE_TOP;
    const LO = PLANE_INSET;
    const HI = 1 - PLANE_INSET;
    const quads: BlockQuad[] = [];

    for (const offset of offsets) {
        // +1 past the centre, -1 before it: which way "outward" is
        const outward = Math.sign(offset - 0.5);
        const lean = leanDeg * outward;
        const zPlane: BlockQuad[] = [];
        const xPlane: BlockQuad[] = [];
        zPlane.push(
            quad(
                [
                    [LO, 0, offset],
                    [HI, 0, offset],
                    [HI, TOP, offset],
                    [LO, TOP, offset],
                ],
                [0, 0, 1],
                tile,
                { uvs: CROSS_FRONT_UVS, material: mat },
            ),
            quad(
                [
                    [LO, TOP, offset],
                    [HI, TOP, offset],
                    [HI, 0, offset],
                    [LO, 0, offset],
                ],
                [0, 0, -1],
                tile,
                { uvs: CROSS_BACK_UVS, material: mat },
            ),
        );
        xPlane.push(
            quad(
                [
                    [offset, 0, HI],
                    [offset, 0, LO],
                    [offset, TOP, LO],
                    [offset, TOP, HI],
                ],
                [1, 0, 0],
                tile,
                { uvs: CROSS_FRONT_UVS, material: mat },
            ),
            quad(
                [
                    [offset, TOP, HI],
                    [offset, TOP, LO],
                    [offset, 0, LO],
                    [offset, 0, HI],
                ],
                [-1, 0, 0],
                tile,
                { uvs: CROSS_BACK_UVS, material: mat },
            ),
        );
        if (lean === 0) {
            quads.push(...zPlane, ...xPlane);
            continue;
        }
        // right-hand rule: about +x a z-plane's top swings toward +z, about +z an x-plane's top swings toward -x.
        quads.push(...rotateAxis(zPlane, 'x', lean, [0.5, 0, offset]), ...rotateAxis(xPlane, 'z', -lean, [offset, 0, 0.5]));
    }
    return quads;
}

const HASH_OFFSETS = [0.25, 0.75] as const;
const PLUS_OFFSETS = [0.5] as const;

/** create four axis-aligned vertical planes (8 quads) on the quarter marks, reading as a hash from above; used for crops. */
export function hash(tile: TileHandle, options?: { lean?: number; material?: MaterialType }): BlockQuad[] {
    return axisPlanes(tile, HASH_OFFSETS, options?.material, options?.lean ?? 0);
}

/** create two axis-aligned vertical planes (4 quads) crossing at the cell center, reading as a plus from above. */
export function plus(tile: TileHandle, options?: { material?: MaterialType }): BlockQuad[] {
    return axisPlanes(tile, PLUS_OFFSETS, options?.material);
}

// 22.5 degrees keeps tan irrational so adjacent blocks never share a plane, and keeps the normal out of classifyFacing's cardinal slices.

/** a zero-thickness plane in 0..16 units, swung `angle` degrees about y through `origin`. */
type FluffPlane = { from: Vec3; to: Vec3; angle: number; origin: Vec3 };

const FLUFF_PLANES: readonly FluffPlane[] = [
    { from: [13.9375, -8, -6.875], to: [13.9375, 24, 25.125], angle: -22.5, origin: [14.0625, -10, -6.6875] },
    { from: [-7.1875, -8, 1.625], to: [24.8125, 24, 1.625], angle: -22.5, origin: [-7, -10, 1.5] },
    { from: [-6.6876, -8, 13.7498], to: [25.3124, 24, 13.7498], angle: 22.5, origin: [-6.5, -10, 13.625] },
    { from: [13.9999, -8, -9.3125], to: [13.9999, 24, 22.6875], angle: 22.5, origin: [13.875, -10, 22.5] },
];

/** default lean in degrees; stacked blocks sit ~0.05 apart while the clumps still read upright. */
export const FLUFF_LEAN_DEG = 10;

// front and back share a texel at every point so the blob isn't mirrored when seen from behind.
const FLUFF_FRONT_UVS: [Vec2, Vec2, Vec2, Vec2] = [
    [0, 1],
    [1, 1],
    [1, 0],
    [0, 0],
];
const FLUFF_BACK_UVS: [Vec2, Vec2, Vec2, Vec2] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
];

/** a double-sided vertical plane between `from` and `to` (block units, x or z constant). */
function fluffPlaneQuads(tile: TileHandle, from: Vec3, to: Vec3, mat: MaterialType | undefined): BlockQuad[] {
    const [x0, y0, z0] = from;
    const [x1, y1, z1] = to;
    const opts = (uvs: [Vec2, Vec2, Vec2, Vec2]) => ({ uvs, material: mat, shade: false });
    if (z0 === z1) {
        return [
            quad(
                [
                    [x0, y0, z0],
                    [x1, y0, z0],
                    [x1, y1, z0],
                    [x0, y1, z0],
                ],
                [0, 0, 1],
                tile,
                opts(FLUFF_FRONT_UVS),
            ),
            quad(
                [
                    [x0, y1, z0],
                    [x1, y1, z0],
                    [x1, y0, z0],
                    [x0, y0, z0],
                ],
                [0, 0, -1],
                tile,
                opts(FLUFF_BACK_UVS),
            ),
        ];
    }
    return [
        quad(
            [
                [x0, y0, z1],
                [x0, y0, z0],
                [x0, y1, z0],
                [x0, y1, z1],
            ],
            [1, 0, 0],
            tile,
            opts(FLUFF_FRONT_UVS),
        ),
        quad(
            [
                [x0, y1, z1],
                [x0, y1, z0],
                [x0, y0, z0],
                [x0, y0, z1],
            ],
            [-1, 0, 0],
            tile,
            opts(FLUFF_BACK_UVS),
        ),
    ];
}

const sixteenth = (v: Vec3): Vec3 => [v[0] / 16, v[1] / 16, v[2] / 16];

/** create the four crossed, overhanging, unshaded leaning planes (8 quads) that soften a foliage cube's silhouette. */
export function fluff(tile: TileHandle, options?: { lean?: number; material?: MaterialType }): BlockQuad[] {
    const lean = options?.lean ?? FLUFF_LEAN_DEG;
    const quads: BlockQuad[] = [];
    for (const { from, to, angle, origin } of FLUFF_PLANES) {
        const a = sixteenth(from);
        const b = sixteenth(to);
        const plane = fluffPlaneQuads(tile, a, b, options?.material);
        // lean about the plane's own horizontal axis through its centre, before the y-swing carries it around.
        const centre: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
        const leanAxis = a[2] === b[2] ? 'x' : 'z';
        const leaned = rotateAxis(plane, leanAxis, angle < 0 ? lean : -lean, centre);
        quads.push(...rotateAxis(leaned, 'y', angle, sixteenth(origin)));
    }
    return quads;
}
