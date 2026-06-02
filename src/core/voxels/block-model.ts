import type { Vec2, Vec3 } from 'mathcat';
import type { BlockQuad, CubeTextures, MaterialType, TextureRef } from './blocks';

type CullFace = BlockQuad['cullFace'];

/** default quad uvs — full texture. V=0 at top of image, V=1 at bottom. */
const DEFAULT_QUAD_UVS: [Vec2, Vec2, Vec2, Vec2] = [
    [0, 1],
    [1, 1],
    [1, 0],
    [0, 0],
];

/**
 * create a single quad. quad-only authoring is the convention —
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
         *   'stretch' (default) — full texture stretched across each face.
         *     mostly useful for full-block boxes where the face is 1×1.
         *   'local' — sample only the texture sub-rect matching the face's
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
            ? [[z0, 1 - x0], [z1, 1 - x0], [z1, 1 - x1], [z0, 1 - x1]]
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
            ? [[1 - z1, 1 - x0], [1 - z0, 1 - x0], [1 - z0, 1 - x1], [1 - z1, 1 - x1]]
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
            ? [[x0, 1 - y0], [x1, 1 - y0], [x1, 1 - y1], [x0, 1 - y1]]
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
            ? [[1 - x1, 1 - y0], [1 - x0, 1 - y0], [1 - x0, 1 - y1], [1 - x1, 1 - y1]]
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
            ? [[1 - z1, 1 - y0], [1 - z0, 1 - y0], [1 - z0, 1 - y1], [1 - z1, 1 - y1]]
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
            ? [[z0, 1 - y0], [z1, 1 - y0], [z1, 1 - y1], [z0, 1 - y1]]
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
 * rotate an array of BlockQuad around the Y axis by `steps` × 90° CW.
 * positions rotate around block center (0.5, y, 0.5).
 * normals and cullFace directions rotate accordingly.
 * uvs are preserved — texture orientation stays the same relative to the face.
 */
export function rotateY(quads: BlockQuad[], steps: number): BlockQuad[] {
    const s = ((steps % 4) + 4) % 4;
    if (s === 0) return quads;

    return quads.map((q) => ({
        verts: [
            rotatePos(q.verts[0], s),
            rotatePos(q.verts[1], s),
            rotatePos(q.verts[2], s),
            rotatePos(q.verts[3], s),
        ] as const,
        normal: rotateNormal(q.normal, s),
        texture: q.texture,
        uvs: q.uvs,
        cullFace: rotateCullFace(q.cullFace, s),
        material: q.material,
    }));
}

// ── cross helper ────────────────────────────────────────────────────
//
// two diagonal planes, each double-sided (4 quads).
// double-sided because gpucat uses backface culling by default —
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
 * create two intersecting diagonal planes (4 quads — front + back per plane).
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

