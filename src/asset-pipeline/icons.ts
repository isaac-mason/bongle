// Icon baking for the pipeline worker. The bake is a pure data step; icons
// are a GPU render step that runs after it, in the same realm, so it draws
// against the registry the user code populated. Grouped here (not in the bake)
// because both are the pipeline's concern once it owns a headless renderer.
//
// The heavy lifting lives in client/: `createHeadlessRenderContext` +
// `buildRenderDeps` stand up a canvas-less render stack, and the same
// `renderBlockIconAtlas` / `renderPrefabIcon` the live client uses draw the
// icons through the shared `RenderRoomDeps` seam.
//
// Both hosts (browser pipeline realm, node CLI) drive the same two steps:
// `planIconBake` decides what is stale — pure fs + hashing, no GPU — and
// `runIconBake` renders exactly that. Standing up the device is the caller's
// business, so a no-op pass never pays for a handshake.

import type { Filesystem } from '../../os/interface';
import { ICON_PX as BLOCK_ICON_PX, renderableBlockStates, renderBlockIconAtlas } from '../client/block-icons';
import { prefabIconRelPath, renderPrefabIcon } from '../client/prefab-icons';
import type { RenderRoomDeps } from '../client/rooms';
import { registry } from '../core/registry';
import type { Blocks } from '../core/voxels/block-registry';
import { readArtifactHash } from './bake/cache';
import { sha256HexParts } from './bake/raster';

export type { BlockIconAtlas } from '../client/block-icons';
export { renderBlockIconAtlas } from '../client/block-icons';
export type { HeadlessRenderContext } from '../client/headless-render';
export { buildRenderDeps, createHeadlessRenderContext } from '../client/headless-render';
export type { PrefabIcon } from '../client/prefab-icons';
export { prefabIconRelPath, renderPrefabIcon } from '../client/prefab-icons';

/** Bumped when the render itself changes (camera, environment, tile layout) so a
 *  new engine invalidates every icon artifact baked by an older one. */
const ICON_BAKE_VERSION = 'icons/v1';

const BLOCK_ICON_PNG = 'resources/client/voxels-icons.png';
const BLOCK_ICON_JSON = 'resources/client/voxels-icons.json';
/** prefab-icon freshness manifest: the block atlas it was baked against, plus
 *  id -> def hash. Per-file artifacts, so freshness is per id — this is the one
 *  icon artifact that can't ride a single sidecar hash. */
const PREFAB_ICON_MANIFEST = 'resources/client/prefab-icons.json';
/** directory the per-prefab icon pngs live in (`prefabIconRelPath`'s parent). */
const PREFAB_ICON_DIR = 'resources/client/prefab-icons';

/** FNV-1a string hash → base36, for the prefab-icon freshness manifest. */
function fnv1a(s: string): string {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}

export type PrefabIconManifest = {
    /** block-atlas content hash these icons were rendered against. */
    atlas: string;
    /** prefab id -> def hash. */
    icons: Record<string, string>;
};

/** Sidecar written next to `voxels-icons.png`. `hash` is the rebuild gate, read
 *  back by `readArtifactHash` exactly like the atlas sidecars. */
export type BlockIconAtlasMetadata = {
    coords: Record<string, [number, number]>;
    cols: number;
    rows: number;
    iconPx: number;
    atlasWidth: number;
    atlasHeight: number;
    hash: string;
};

export type IconBakePlan = {
    /** the block-icon atlas needs a (re)render. */
    blockAtlasStale: boolean;
    /** content hash over the block-icon render inputs; written into the sidecar. */
    blockIconsHash: string;
    /** prefab ids whose icon needs a (re)render. */
    stalePrefabs: string[];
    /** prefab ids whose icon file should be pruned (no longer registered). */
    removedPrefabs: string[];
    /** manifest to write once the render lands. */
    prefabManifest: PrefabIconManifest;
};

export type PlanOpts = {
    /** content hash of the baked block-texture atlas (`AssetPipeline.run`'s
     *  `atlasHash`) — block AND prefab icons draw with it, so it's part of both
     *  cache keys. Null when no atlas has been baked. */
    atlasHash: string | null;
    /** consult the on-disk hashes and skip fresh work. False (the one-shot node
     *  bake) forces a full re-render, matching the atlas builders: a cache hit
     *  can mask a draw-fn change between build invocations. */
    cache: boolean;
};

/** byte view over a typed array, for hashing. */
function bytesOf(a: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }): Uint8Array {
    return new Uint8Array(a.buffer as ArrayBuffer, a.byteOffset, a.byteLength);
}

/**
 * Content hash over everything the block-icon render reads: which states get a
 * tile, the per-state data the mesher emits from, and the atlas they sample.
 * Hashing the DERIVED arrays (not the source defs) is deliberate — a def edit
 * that doesn't change the rendered result shouldn't churn the icons. The atlas
 * hash alone wouldn't do: a block joining the set while wearing an
 * already-referenced texture adds no atlas layer, but does need a tile.
 */
async function hashBlockIconInputs(blocks: Blocks, states: number[], atlasHash: string | null): Promise<string> {
    const parts: (string | Uint8Array)[] = [
        ICON_BAKE_VERSION,
        String(BLOCK_ICON_PX),
        atlasHash ?? '',
        states.map((sid) => blocks.stateToKey[sid]).join('\n'),
        bytesOf(blocks.modelType),
        bytesOf(blocks.cubeTexIndices),
        bytesOf(blocks.cubeFaceUVs),
        bytesOf(blocks.meshId),
    ];
    // mesh blocks: the flattened per-quad tables the mesher emits from. Geometry,
    // uvs, texture indices and material all move the rendered icon.
    for (let meshIdx = 1; meshIdx < blocks.meshQuads.length; meshIdx++) {
        const texIndices = blocks.meshTexIndices[meshIdx];
        const materials = blocks.meshQuadMaterials[meshIdx];
        const verts = blocks.meshQuadVerts[meshIdx];
        const uvs = blocks.meshQuadUVs[meshIdx];
        const normals = blocks.meshQuadNormal[meshIdx];
        if (!texIndices || !materials || !verts || !uvs || !normals) continue;
        parts.push(bytesOf(texIndices), bytesOf(materials), bytesOf(verts), bytesOf(uvs), bytesOf(normals));
    }
    return sha256HexParts(parts);
}

/**
 * Decide what the icon bake has to do, without touching the GPU: hash the
 * block-icon render inputs against the `voxels-icons.json` sidecar, and diff each
 * prefab's def hash against the manifest. Callers skip the whole render (device
 * handshake, atlas upload and all) when `iconBakeIsNoop`.
 *
 * Reads the DERIVED `registry.blockRegistry`, so the caller must have reindexed
 * since the last declaration flush. This runs ahead of `buildRenderDeps` (whose
 * own reindex used to be what covered this), and the pipeline worker never calls
 * `engine-client.load()`, so neither one can be relied on here.
 */
export async function planIconBake(fs: Filesystem, opts: PlanOpts): Promise<IconBakePlan> {
    const { atlasHash, cache } = opts;
    const blocks = registry.blockRegistry;
    const states = renderableBlockStates(blocks);
    const blockIconsHash = await hashBlockIconInputs(blocks, states, atlasHash);
    // nothing renderable → no atlas to draw, and the render would bail on an empty
    // grid anyway. Saying so here is what keeps a block-less project off the GPU.
    const blockAtlasStale =
        states.length > 0 &&
        (!cache || (await readArtifactHash(fs, BLOCK_ICON_JSON)) !== blockIconsHash || !(await fs.exists(BLOCK_ICON_PNG)));

    let prev: PrefabIconManifest = { atlas: '', icons: {} };
    try {
        const parsed = JSON.parse(await fs.readText(PREFAB_ICON_MANIFEST)) as Partial<PrefabIconManifest>;
        if (parsed.icons) prev = { atlas: typeof parsed.atlas === 'string' ? parsed.atlas : '', icons: parsed.icons };
    } catch {
        // no manifest yet (first bake) — everything is fresh work.
    }
    // one listing, not an exists() per prefab: a guest realm reaches the project
    // disk over the relay, where every call is a round trip (os/remote-fs).
    const bakedNames = await fs.readDir(PREFAB_ICON_DIR).catch(() => new Map<string, 'file' | 'dir'>());
    const baked = new Set<string>();
    for (const name of bakedNames.keys()) baked.add(`prefab-icons/${name}`);

    // textures affect every prefab's appearance, so an atlas move re-renders all.
    const atlasMoved = prev.atlas !== (atlasHash ?? '');
    const icons: Record<string, string> = {};
    const stalePrefabs: string[] = [];
    for (const [id, def] of registry.prefabs.byId) {
        // empty hash (unserializable def) → can't detect changes, so always re-render.
        let hash = '';
        try {
            hash = fnv1a(JSON.stringify(def));
        } catch {}
        icons[id] = hash;
        const fresh = cache && hash !== '' && !atlasMoved && prev.icons[id] === hash && baked.has(prefabIconRelPath(id));
        if (!fresh) stalePrefabs.push(id);
    }
    const removedPrefabs = Object.keys(prev.icons).filter((id) => !(id in icons));

    return {
        blockAtlasStale,
        blockIconsHash,
        stalePrefabs,
        removedPrefabs,
        prefabManifest: { atlas: atlasHash ?? '', icons },
    };
}

/** True when the plan has nothing to render or prune — the caller can return
 *  before standing up a render context. */
export function iconBakeIsNoop(plan: IconBakePlan): boolean {
    return !plan.blockAtlasStale && plan.stalePrefabs.length === 0 && plan.removedPrefabs.length === 0;
}

export type IconBakeResult = {
    /** the block-icon atlas was re-rendered (false = skipped or empty). */
    blockAtlas: boolean;
    /** prefab icons re-rendered this pass. */
    prefabs: number;
};

/**
 * Render exactly the work `planIconBake` found stale, writing the icon artifacts
 * into `resources/client/`: the block atlas (`voxels-icons.{png,json}`) and one
 * png per prefab, plus the freshness manifest. Shared by the browser pipeline
 * realm and the node CLI — only `encodePng` differs (OffscreenCanvas vs
 * skia-canvas). Every write goes through `writeIfChanged`, so a bake that
 * reproduces identical bytes wakes no fs watcher. Never throws for a single
 * prefab — a failed render is skipped.
 */
export async function runIconBake(
    deps: RenderRoomDeps,
    fs: Filesystem,
    plan: IconBakePlan,
    encodePng: (pixels: Uint8Array, width: number, height: number) => Promise<Uint8Array>,
): Promise<IconBakeResult> {
    let blockAtlas = false;
    if (plan.blockAtlasStale) {
        const atlas = await renderBlockIconAtlas(deps);
        if (atlas.atlasWidth > 0 && atlas.atlasHeight > 0) {
            const metadata: BlockIconAtlasMetadata = {
                coords: atlas.coords,
                cols: atlas.cols,
                rows: atlas.rows,
                iconPx: atlas.iconPx,
                atlasWidth: atlas.atlasWidth,
                atlasHeight: atlas.atlasHeight,
                hash: plan.blockIconsHash,
            };
            await fs.writeIfChanged(BLOCK_ICON_PNG, await encodePng(atlas.pixels, atlas.atlasWidth, atlas.atlasHeight));
            await fs.writeIfChanged(BLOCK_ICON_JSON, JSON.stringify(metadata));
            blockAtlas = true;
        }
    }

    let prefabs = 0;
    for (const id of plan.stalePrefabs) {
        const icon = await renderPrefabIcon(deps, id);
        if (!icon) continue;
        await fs.writeIfChanged(
            `resources/client/${prefabIconRelPath(id)}`,
            await encodePng(icon.pixels, icon.pxSize, icon.pxSize),
        );
        prefabs++;
    }
    for (const id of plan.removedPrefabs) {
        await fs.remove(`resources/client/${prefabIconRelPath(id)}`).catch(() => {});
    }
    await fs.writeIfChanged(PREFAB_ICON_MANIFEST, JSON.stringify(plan.prefabManifest));

    return { blockAtlas, prefabs };
}
