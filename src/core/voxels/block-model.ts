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

/**
 * create a single quad. quad-only authoring is the convention,
 * the mesher rejects non-quad input at registry-build time.
 *
 * @param verts - 4 vertices in CCW order, block-local [0,1] space
 * @param normal - face normal
 * @param tile - the tile this quad samples
 * @param options - optional uvs, cullFace, material
 */
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

/**
 * generate 6 quads (one per face) from an axis-aligned box.
 *
 * @param from - min corner [x, y, z] in block-local space [0, 1]
 * @param to - max corner [x, y, z] in block-local space [0, 1]
 * @param tiles - per-face tile assignment, same format as CubeTiles
 * @param options - optionally exclude faces or override cull behavior
 */
export function box(
    from: Vec3,
    to: Vec3,
    tiles: CubeTiles,
    options?: {
        /** faces to exclude from generation */
        exclude?: FaceDir[];
        /**
         * override cull face auto-detection. by default, faces flush
         * with the block boundary (0 or 1) get a cullFace. set to false
         * to disable, or provide a map of overrides.
         */
        cull?: boolean | Partial<Record<FaceDir, boolean>>;
        /** material type for all quads in this box. */
        material?: MaterialType;
        /**
         * uv mapping mode.
         *   'stretch' (default), full texture stretched across each face.
         *     mostly useful for full-block boxes where the face is 1×1.
         *   'local', sample only the texture sub-rect matching the face's
         *     world-local extent. preserves pixel density across boxes of
         *     different sizes (post + arms, torches, panels).
         */
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

    // auto-cull: face is cullable if it sits exactly on the block boundary
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

    // +y (up)
    if (!excluded.has('up')) {
        // up face UVs match the default cube convention (u=z, v=1-x) so a
        // local sub-rect samples the same orientation as a full-cube top.
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

    // -y (down)
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

    // +z (south)
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

    // -z (north)
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

    // +x (east)
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

    // -x (west)
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

// ── rotation helpers ────────────────────────────────────────────────
//
// rotate BlockQuad[] around the Y axis by 90° increments.
// positions rotate around the block center (0.5, y, 0.5).
// normals and cullFace directions rotate accordingly.
//
// steps: 0=0°, 1=90° CW, 2=180°, 3=270° CW (all viewed from +Y)

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

/** rotate a position [x,y,z] around the block center (0.5, y, 0.5) by steps × 90° CW. */
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

/** rotate a normal [nx,ny,nz] by steps × 90° CW around Y. */
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

/**
 * "uvlock" for a Y rotation: re-derive the uvs of the two faces perpendicular
 * to the Y axis (normal ±Y) straight from each vertex's (already rotated) world
 * position, matching Minecraft's uvlock. this pins their texture to world axes
 * regardless of facing AND keeps 1:1 texel density (the sub-rect a face samples
 * equals its world footprint), so non-square faces — stair step tops and
 * exposed tread rects — don't squish.
 *
 * the mapping (u=x,v=z for +Y; u=x,v=1-z for -Y) mirrors the full-cube mesher's
 * top/bottom convention (chunk-mesher.ts FACE_UVS, faces 2/3) — NOT box()'s
 * local formula, which is rotated 90° from it. keep these in sync with the
 * mesher so a locked stair tread's grain continues an adjacent full block's.
 *
 * faces in the XZ plane are left as authored: a Y rotation keeps their vertical
 * axis vertical, so their texture is already world-consistent.
 *
 * note: for ±Y faces this ignores the authored uvs (they'd fight the lock).
 * only opt in (uvlock: true) for blocks whose top/bottom should track world,
 * i.e. planar-tiled surfaces like stairs — not ones with a bespoke top atlas.
 */
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

/**
 * rotate an array of BlockQuad around the Y axis by `steps` × 90° CW.
 * positions rotate around block center (0.5, y, 0.5).
 * normals and cullFace directions rotate accordingly.
 *
 * uvs are preserved by default (texture orientation stays fixed relative to the
 * face, so it spins with the geometry). pass `uvlock: true` to instead pin the
 * top/bottom faces' texture to world axes (see lockUvsY) — this is what keeps a
 * directional top texture (e.g. wood grain on stairs) aligned across facings.
 * because uvlock derives ±Y uvs from world position, it applies even at steps=0
 * so the reference facing matches the rotated ones.
 */
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

// ── mirror (X) helper ───────────────────────────────────────────────
//
// reflect across the plane x = 0.5 to produce the chiral opposite, used
// for left/right-handed variants (door hinge, etc.). a reflection flips
// winding, so per-quad vertex + uv order reverses to keep faces outward;
// the x-normal flips and east↔west cullFaces swap. because uvs reverse in
// lockstep with verts, the texture mirrors with the geometry.

/** mirror a position [x,y,z] across the plane x = 0.5. */
function mirrorPosX(v: Vec3): Vec3 {
    return [1 - v[0], v[1], v[2]];
}

/** mirror a normal across X (negate x). */
function mirrorNormalX(n: Vec3): Vec3 {
    return [-n[0], n[1], n[2]];
}

/** mirror a cullFace direction across X (east ↔ west; others unchanged). */
function mirrorCullFaceX(cf: CullFace | undefined): CullFace | undefined {
    if (cf === 'east') return 'west';
    if (cf === 'west') return 'east';
    return cf;
}

/**
 * mirror an array of BlockQuad across the plane x = 0.5 (block-local).
 * involutive: mirrorX(mirrorX(q)) === q.
 */
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

// ── free-form rotate / translate helpers ────────────────────────────
//
// rotateY handles the common 90° cases with cullFace remapping. these
// cover the off-axis cases (tilted geometry like a wall torch): a
// free-form rotation about an arbitrary axis through a pivot, and a
// plain translation. faces of tilted geometry no longer sit flush with
// the block boundary, so rotateAxis clears cullFace, build the source
// box with `cull: false`.

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

/**
 * rotate an array of BlockQuad by `angleDeg` around `axis` through `pivot`
 * (block-local space). positive angles follow the right-hand rule. cullFace
 * is cleared because tilted faces no longer align to a block boundary.
 */
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

/**
 * shear an array of BlockQuad along `axis` as a linear function of height:
 * a vertex at y=`yBase` is unmoved, one at y=`yBase + ySpan` shifts by
 * `delta` along `axis`, with a proportional shift in between. unlike
 * rotateAxis (which introduces sin/cos and pulls vertices off the lattice),
 * a shear by lattice-aligned `delta`/`ySpan` keeps every input vertex on the
 * 1/16 grid, so geometry survives the voxel vertex format's 1/16 position
 * quantization with uniform thickness, instead of rounding unevenly per
 * corner. used for the wall torch's grid-aligned lean. normals are left
 * as-is: callers shear emissive geometry (face-shade bypassed) and gpucat
 * culls by winding, which the shear preserves.
 */
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

// ── layer helper ────────────────────────────────────────────────────

/**
 * create one up-facing quad covering the cell at height `y` (block units),
 * for ground cover that has no thickness (leaf litter, petals). same uv
 * orientation as a cube's top face, so `rotateY` keeps it in step with the
 * block below. nothing faces down: the block under it is what it lies on.
 */
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

// ── cross helper ────────────────────────────────────────────────────
//
// two diagonal planes, each double-sided (4 quads).
// double-sided because gpucat uses backface culling by default,
// without reversed-winding duplicates, one side of each plane
// would be invisible. no z-fighting because only the camera-facing
// side rasterizes fragments at any given pixel.

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

/**
 * create two intersecting diagonal planes (4 quads, front + back per plane).
 * used for vegetation: flowers, tall grass, saplings, mushrooms, etc.
 */
export function cross(
    tile: TileHandle,
    options?: { height?: number; tileBlocks?: number; material?: MaterialType },
): BlockQuad[] {
    const mat = options?.material;
    const height = options?.height ?? 1;
    // y top capped 0.1 below the height so fract(world.y) > 0 at the top vert
    // for PLANT_WIND_SWAY (at integer block y, fract(N+1)=0 would freeze it).
    // x/z inset by INSET so floor(world.x), floor(world.z) is identical for
    // all four corners of one block.
    //
    // A plane taller than a block reaches into the cell above and samples a
    // tile `tileBlocks` blocks tall (default: as many as the height needs),
    // showing its bottom `TOP` blocks, so the texel density stays the cube's.
    // A crop's early stages pass `tileBlocks` explicitly to show the bottom of
    // the same tall tile while still short. A one-block plane on a one-block
    // tile keeps the whole tile, as it always has.
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
        // plane A front
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
        // plane A back (reversed winding)
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
        // plane B front
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
        // plane B back (reversed winding)
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

// axis-aligned plant planes. `hash` and `plus` differ only in where the planes
// sit, so the geometry is built once and each shape supplies its own offsets.
//
// TOP/INSET carry the same constraints as `cross`: the top verts stay below 1.0
// so fract(world.y) > 0 keeps PLANT_WIND_SWAY alive at the tip, and every vert
// stays strictly inside the cell so floor(world.x), floor(world.z) is identical
// across the whole block and the sway phases as one piece.
//
// normals MUST match the CCW winding (the `box` convention), not `cross`'s
// inverted one. `classifyFacing` (chunk-mesher.ts) bins an exactly-axis-aligned
// normal into a cardinal facing slice, and the opaque/transparent passes
// back-face cone-cull whole slices per chunk (voxel-resources-gpu.ts:375). An
// inverted normal puts the quad in the slice opposite the side it is visible
// from, so the cull drops it exactly when it should be drawn and the planes pop
// as chunks cross the camera's half-plane.
//
// `cross` gets away with inverted normals only because its 0.707 components
// fail the |axis| > 0.999 test and land in UNASSIGNED, which is exempt.
const PLANE_TOP = 0.9;
const PLANE_INSET = 0.01;

/** one double-sided plane per offset, on both axes. `leanDeg` tilts each
 *  plane away from the block centre about its own base line, so the tops fan
 *  out over the neighbouring cells and a planted field closes up into a bush
 *  rather than reading as rows of cards; a centred plane (offset 0.5) has no
 *  outward side and stays upright. A leaned normal is off-axis and lands in
 *  the UNASSIGNED facing, which the cone-cull exempts. */
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
        // plane facing Z (spans X), front then back.
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
        // plane facing X (spans Z), front then back.
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
        // right-hand rotations: about +x the top of a z plane swings toward +z,
        // about +z the top of an x plane swings toward -x. Pivot on the plane's
        // own base line so the roots stay put.
        quads.push(...rotateAxis(zPlane, 'x', lean, [0.5, 0, offset]), ...rotateAxis(xPlane, 'z', -lean, [offset, 0, 0.5]));
    }
    return quads;
}

/** the quarter marks, matching minecraft's 4/16 crop inset and luanti's "#". */
const HASH_OFFSETS = [0.25, 0.75] as const;
/** the centre line: one plane per axis, crossing in the middle of the cell. */
const PLUS_OFFSETS = [0.5] as const;

/**
 * create four axis-aligned vertical planes (8 quads, front + back per plane),
 * two facing X and two facing Z, on the quarter marks. viewed from above the
 * arrangement reads as a `#`, where `cross` reads as an `x`.
 *
 * used for crops. the planes line up with the block grid across neighbouring
 * cells, so a tilled field reads as rows; `cross`'s diagonals read as one
 * isolated clump per cell instead.
 *
 * @param tile - the tile every plane samples
 */
export function hash(tile: TileHandle, options?: { lean?: number; material?: MaterialType }): BlockQuad[] {
    return axisPlanes(tile, HASH_OFFSETS, options?.material, options?.lean ?? 0);
}

/**
 * create two axis-aligned vertical planes (4 quads, front + back per plane),
 * one facing X and one facing Z, crossing on the cell's centre line. viewed
 * from above it reads as a `+`.
 *
 * the sparse sibling of `hash`: same grid alignment, half the geometry. `cross`
 * has the same quad count but sits diagonally, so it clumps where this still
 * lines up with the cells either side.
 *
 * @param tile - the tile every plane samples
 */
export function plus(tile: TileHandle, options?: { material?: MaterialType }): BlockQuad[] {
    return axisPlanes(tile, PLUS_OFFSETS, options?.material);
}

// ── fluff ───────────────────────────────────────────────────────────
//
// Overhanging planes for foliage that should not end on a hard cube edge. The
// plane layout is Jerm's Better Leaves `template_leaves_cross`: four
// zero-thickness planes, two crossed pairs (an x-spanning and a z-spanning
// plane each), one pair swung -22.5 degrees about y and the other +22.5,
// every plane 2 blocks wide and 2 blocks tall (half a block past the cell on
// every side). Every plane carries the same round leaf blob, so each is one
// full clump and the four together are a layered mass. Unshaded
// (`shade: false`), as the source is.
//
// Two departures from the source. Each plane also LEANS about its own
// horizontal axis (`lean`, the -22.5 pair one way and the +22.5 pair the
// other), which puts y into every plane equation so vertically stacked
// blocks never share a plane, and shows the planes' area from above where a
// vertical plane is edge-on. And the source's split upper/lower textures are
// one blob here, so the canopy reads as layers of clumps rather than as
// hemispheres.
//
// Deliberately NOT cullFaced. `leaves()` is CullType.PARTIAL, which never culls
// against a neighbouring leaf, so a cullFace pointing at one could not fire
// anyway. This is the whole cost question for the technique: every leaf block
// pays for these quads, including ones buried inside a canopy.
//
// 22.5 degrees is not an accident: no lattice translation lies in a 22.5
// degree plane (tan 22.5 is irrational), so horizontally adjacent blocks
// never share a plane. The rotation also keeps the planes out of the cardinal
// facing slices: a rotated normal fails `classifyFacing`'s |axis| > 0.999 test
// and lands in UNASSIGNED, which the renderer's back-face cone-cull exempts.

/** one plane of the source model in its 0..16 units: a zero-thickness box
 *  from `from` to `to` (x or z constant), swung `angle` degrees about y
 *  through `origin`. */
type FluffPlane = { from: Vec3; to: Vec3; angle: number; origin: Vec3 };

const FLUFF_PLANES: readonly FluffPlane[] = [
    { from: [13.9375, -8, -6.875], to: [13.9375, 24, 25.125], angle: -22.5, origin: [14.0625, -10, -6.6875] },
    { from: [-7.1875, -8, 1.625], to: [24.8125, 24, 1.625], angle: -22.5, origin: [-7, -10, 1.5] },
    { from: [-6.6876, -8, 13.7498], to: [25.3124, 24, 13.7498], angle: 22.5, origin: [-6.5, -10, 13.625] },
    { from: [13.9999, -8, -9.3125], to: [13.9999, 24, 22.6875], angle: 22.5, origin: [13.875, -10, 22.5] },
];

/** default lean, degrees. Enough that stacked blocks sit ~0.05 apart and the
 *  planes show from above; small enough that the clumps still read upright. */
export const FLUFF_LEAN_DEG = 10;

/** front and back share a texel at every point: the back's u runs the same
 *  way in world space, so the blob is not mirrored when seen from behind. */
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

/** a double-sided vertical plane. `from`/`to` in block units with either x or
 *  z equal; the front face's normal points +z (x-spanning) or +x (z-spanning). */
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

/**
 * create the four crossed, overhanging, unshaded, leaning planes (8 quads)
 * that soften a foliage cube's silhouette. meant to be concatenated onto a
 * `box`, not used alone; `leaves()` adds the y rotations.
 *
 * costs 8 quads per block with no culling, so a canopy multiplies its quad
 * count. the transparent pass is capped and truncates silently
 * (`MAX_QUADS_PER_PASS`), so measure before shipping it on every leaf type.
 *
 * @param tile - the round blob every plane samples (`textures.leavesFluff`);
 *   a square leaf tile here reads as a card, not foliage
 * @param options.lean - degrees each plane tilts about its own horizontal
 *   axis, the -22.5 pair by `+lean` and the +22.5 pair by `-lean` (default
 *   `FLUFF_LEAN_DEG`); pass the negative to mirror the splay
 */
export function fluff(tile: TileHandle, options?: { lean?: number; material?: MaterialType }): BlockQuad[] {
    const lean = options?.lean ?? FLUFF_LEAN_DEG;
    const quads: BlockQuad[] = [];
    for (const { from, to, angle, origin } of FLUFF_PLANES) {
        const a = sixteenth(from);
        const b = sixteenth(to);
        const plane = fluffPlaneQuads(tile, a, b, options?.material);
        // lean about the plane's own horizontal axis through its centre, before
        // the swing carries that axis round with it.
        const centre: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
        const leanAxis = a[2] === b[2] ? 'x' : 'z';
        const leaned = rotateAxis(plane, leanAxis, angle < 0 ? lean : -lean, centre);
        quads.push(...rotateAxis(leaned, 'y', angle, sixteenth(origin)));
    }
    return quads;
}
