import type { Vec2, Vec3 } from 'mathcat';
import type { BlockQuad, CubeTextures, MaterialType, TextureRef } from './blocks';

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
 * @param texture - texture ref (BlockTextureDef handle or string id)
 * @param options - optional uvs, cullFace, material
 */
export function quad(
    verts: [Vec3, Vec3, Vec3, Vec3],
    normal: Vec3,
    texture: TextureRef,
    options?: {
        uvs?: [Vec2, Vec2, Vec2, Vec2];
        cullFace?: CullFace;
        material?: MaterialType;
    },
): BlockQuad {
    return {
        verts,
        normal,
        texture,
        uvs: options?.uvs ?? DEFAULT_QUAD_UVS,
        cullFace: options?.cullFace,
        material: options?.material,
    };
}

type FaceDir = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';

/**
 * generate 6 quads (one per face) from an axis-aligned box.
 *
 * @param from - min corner [x, y, z] in block-local space [0, 1]
 * @param to - max corner [x, y, z] in block-local space [0, 1]
 * @param textures - texture assignment, same format as CubeTextures
 * @param options - optionally exclude faces or override cull behavior
 */
export function box(
    from: Vec3,
    to: Vec3,
    textures: CubeTextures,
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

    const tex = resolveTextures(textures);

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
        texture: TextureRef,
        cullFace: CullFace | undefined,
        localUvs: [Vec2, Vec2, Vec2, Vec2] | undefined,
    ): void {
        quads.push(quad(verts, normal, texture, { cullFace, material: mat, uvs: localUvs }));
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

type ResolvedTextures = {
    up: TextureRef;
    down: TextureRef;
    north: TextureRef;
    south: TextureRef;
    east: TextureRef;
    west: TextureRef;
};

function resolveTextures(tex: CubeTextures): ResolvedTextures {
    if ('all' in tex) {
        const t = tex.all.texture;
        return { up: t, down: t, north: t, south: t, east: t, west: t };
    }
    if ('sides' in tex) {
        const s = tex.sides.texture;
        return { up: tex.top.texture, down: tex.bottom.texture, north: s, south: s, east: s, west: s };
    }
    return {
        up: tex.top.texture,
        down: tex.bottom.texture,
        north: tex.north.texture,
        south: tex.south.texture,
        east: tex.east.texture,
        west: tex.west.texture,
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
function lockUvsY(verts: readonly Vec3[], normal: Vec3, uvs: [Vec2, Vec2, Vec2, Vec2] | undefined): [Vec2, Vec2, Vec2, Vec2] | undefined {
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
        const verts: [Vec3, Vec3, Vec3, Vec3] = [rotatePos(q.verts[0], s), rotatePos(q.verts[1], s), rotatePos(q.verts[2], s), rotatePos(q.verts[3], s)];
        return {
            verts,
            normal: rotateNormal(q.normal, s),
            texture: q.texture,
            uvs: uvlock ? lockUvsY(verts, q.normal, q.uvs) : q.uvs,
            cullFace: rotateCullFace(q.cullFace, s),
            material: q.material,
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
        texture: q.texture,
        uvs: q.uvs ? ([q.uvs[3], q.uvs[2], q.uvs[1], q.uvs[0]] as const) : undefined,
        cullFace: mirrorCullFaceX(q.cullFace),
        material: q.material,
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
        texture: q.texture,
        uvs: q.uvs,
        cullFace: undefined,
        material: q.material,
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
        texture: q.texture,
        uvs: q.uvs,
        cullFace: q.cullFace,
        material: q.material,
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
        texture: q.texture,
        uvs: q.uvs,
        cullFace: q.cullFace,
        material: q.material,
    }));
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
export function cross(texture: TextureRef, options?: { material?: MaterialType }): BlockQuad[] {
    const mat = options?.material;
    // y top capped at 0.9 so fract(world.y) > 0 at the top vert for
    // PLANT_WIND_SWAY (at integer block y, fract(N+1)=0 would freeze it).
    // x/z inset by INSET so floor(world.x), floor(world.z) is identical for
    // all four corners of one block.
    const TOP = 0.9;
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
            texture,
            { uvs: CROSS_FRONT_UVS, material: mat },
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
            texture,
            { uvs: CROSS_BACK_UVS, material: mat },
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
            texture,
            { uvs: CROSS_FRONT_UVS, material: mat },
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
            texture,
            { uvs: CROSS_BACK_UVS, material: mat },
        ),
    ];
}
