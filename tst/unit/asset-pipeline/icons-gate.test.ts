// ── icon bake cache gate ────────────────────────────────────────────────
//
// `planIconBake` is what keeps a GPU icon render off every bake pass, so the
// interesting cases are the ones where it must NOT skip: a moved block atlas, a
// block joining the set, an edited prefab def, an artifact missing from disk. The
// mirror case matters just as much — a repeat pass over untouched inputs has to
// come back a no-op, or the editor re-decodes a multi-MB atlas on every keystroke.

import { registerAllShapes } from 'crashcat';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Filesystem, FsPath } from '../../../src/../os/interface';
import { iconBakeIsNoop, planIconBake } from '../../../src/asset-pipeline/icons';
import { registry } from '../../../src/core/registry';
import { cube } from '../../../src/core/voxels/block-presets';
import { buildBlockRegistry } from '../../../src/core/voxels/block-registry';
import type { BlockDef, BlockHandle, BlockTextureDef } from '../../../src/core/voxels/blocks';

const BLOCK_ICON_PNG = 'resources/client/voxels-icons.png';
const BLOCK_ICON_JSON = 'resources/client/voxels-icons.json';
const PREFAB_ICON_MANIFEST = 'resources/client/prefab-icons.json';

function texture(id: string): BlockTextureDef {
    return { id, frames: [`${id}.png`], fps: 1, interpolate: false };
}

/** map-backed stand-in for the project disk: the read/write/exists surface the
 *  plan touches, enough to replay a bake across passes. */
function memFs(): Filesystem & { files: Map<string, string> } {
    const files = new Map<string, string>();
    return {
        files,
        read: async (p: FsPath) => new TextEncoder().encode(files.get(p) ?? ''),
        readText: async (p: FsPath) => {
            const text = files.get(p);
            if (text === undefined) throw new Error(`ENOENT ${p}`);
            return text;
        },
        exists: async (p: FsPath) => files.has(p),
        readDir: async (dir: FsPath = '') => {
            const out = new Map<string, 'file' | 'dir'>();
            for (const p of files.keys()) {
                if (!p.startsWith(`${dir}/`)) continue;
                const rest = p.slice(dir.length + 1);
                const slash = rest.indexOf('/');
                out.set(slash === -1 ? rest : rest.slice(0, slash), slash === -1 ? 'file' : 'dir');
            }
            return out;
        },
        write: async (p: FsPath, data: Uint8Array | string) => {
            files.set(p, typeof data === 'string' ? data : new TextDecoder().decode(data));
        },
        writeIfChanged: async (p: FsPath, data: Uint8Array | string) => {
            const next = typeof data === 'string' ? data : new TextDecoder().decode(data);
            if (files.get(p) === next) return false;
            files.set(p, next);
            return true;
        },
        remove: async (p: FsPath) => {
            files.delete(p);
        },
    } as unknown as Filesystem & { files: Map<string, string> };
}

const stone = texture('stone');
const dirt = texture('dirt');
const moss = texture('moss');

/** publish a block registry onto the engine registry, the way `reindexRegistry`
 *  does after a declaration flush. */
function declareBlocks(...wearing: [id: string, texture: BlockTextureDef][]): void {
    const handles = wearing.map(
        ([id, t]) =>
            cube(id, { textures: { id: t.id, dependency: { registry: 'blockTextures', id: t.id }, def: t } }) as BlockHandle,
    );
    const defs = new Map<string, BlockDef>(handles.map((h) => [h.id, h.def]));
    const handleMap = new Map<string, BlockHandle>(handles.map((h) => [h.id, h]));
    const textures = new Map<string, BlockTextureDef>([
        [stone.id, stone],
        [dirt.id, dirt],
        [moss.id, moss],
    ]);
    buildBlockRegistry(registry.blockRegistry, defs, handleMap, textures);
}

const BASE_BLOCKS: [string, BlockTextureDef][] = [
    ['test:stone', stone],
    ['test:dirt', dirt],
];

/** what `runIconBake` would leave behind for a plan, so the next pass sees a
 *  bake that actually happened. */
function completeBake(fs: ReturnType<typeof memFs>, plan: Awaited<ReturnType<typeof planIconBake>>): void {
    fs.files.set(BLOCK_ICON_PNG, 'png-bytes');
    fs.files.set(BLOCK_ICON_JSON, JSON.stringify({ coords: {}, cols: 1, rows: 1, iconPx: 128, hash: plan.blockIconsHash }));
    for (const id of plan.stalePrefabs) fs.files.set(`resources/client/prefab-icons/${encodeURIComponent(id)}.png`, 'png-bytes');
    for (const id of plan.removedPrefabs) fs.files.delete(`resources/client/prefab-icons/${encodeURIComponent(id)}.png`);
    fs.files.set(PREFAB_ICON_MANIFEST, JSON.stringify(plan.prefabManifest));
}

describe('planIconBake', () => {
    beforeAll(() => {
        registerAllShapes();
        declareBlocks(...BASE_BLOCKS);
        registry.prefabs.byId.set('test:hut', { id: 'test:hut', nodes: [] } as never);
    });

    it('bakes everything on a cold disk, then skips a repeat pass', async () => {
        const fs = memFs();
        const cold = await planIconBake(fs, { atlasHash: 'atlas-1', cache: true });
        expect(cold.blockAtlasStale).toBe(true);
        expect(cold.stalePrefabs).toContain('test:hut');
        expect(iconBakeIsNoop(cold)).toBe(false);

        completeBake(fs, cold);
        const warm = await planIconBake(fs, { atlasHash: 'atlas-1', cache: true });
        expect(warm.blockIconsHash).toBe(cold.blockIconsHash);
        expect(iconBakeIsNoop(warm)).toBe(true);
    });

    it('re-bakes everything when the block atlas moves', async () => {
        const fs = memFs();
        completeBake(fs, await planIconBake(fs, { atlasHash: 'atlas-1', cache: true }));

        const moved = await planIconBake(fs, { atlasHash: 'atlas-2', cache: true });
        expect(moved.blockAtlasStale).toBe(true);
        expect(moved.stalePrefabs).toContain('test:hut');
    });

    it('re-bakes the block atlas when a block joins the set the atlas can not see', async () => {
        const fs = memFs();
        completeBake(fs, await planIconBake(fs, { atlasHash: 'atlas-1', cache: true }));

        // a new block wearing an already-referenced texture adds no atlas layer, so
        // the atlas hash does NOT move — but it still needs a tile. This is why the
        // gate hashes the derived block registry and not just the atlas.
        declareBlocks(...BASE_BLOCKS, ['test:cobble', stone]);
        const added = await planIconBake(fs, { atlasHash: 'atlas-1', cache: true });
        expect(added.blockAtlasStale).toBe(true);

        declareBlocks(...BASE_BLOCKS);
    });

    it('re-bakes only the prefab whose def changed', async () => {
        const fs = memFs();
        registry.prefabs.byId.set('test:shed', { id: 'test:shed', nodes: [] } as never);
        completeBake(fs, await planIconBake(fs, { atlasHash: 'atlas-1', cache: true }));

        registry.prefabs.byId.set('test:shed', { id: 'test:shed', nodes: [{ name: 'wall' }] } as never);
        const edited = await planIconBake(fs, { atlasHash: 'atlas-1', cache: true });
        expect(edited.stalePrefabs).toEqual(['test:shed']);
        expect(edited.blockAtlasStale).toBe(false);

        registry.prefabs.byId.delete('test:shed');
    });

    it('prunes icons for prefabs that are gone', async () => {
        const fs = memFs();
        registry.prefabs.byId.set('test:gone', { id: 'test:gone', nodes: [] } as never);
        completeBake(fs, await planIconBake(fs, { atlasHash: 'atlas-1', cache: true }));

        registry.prefabs.byId.delete('test:gone');
        const pruned = await planIconBake(fs, { atlasHash: 'atlas-1', cache: true });
        expect(pruned.removedPrefabs).toEqual(['test:gone']);
        expect(iconBakeIsNoop(pruned)).toBe(false);
    });

    it('re-bakes when an artifact is missing even though the hash matches', async () => {
        const fs = memFs();
        completeBake(fs, await planIconBake(fs, { atlasHash: 'atlas-1', cache: true }));

        fs.files.delete(BLOCK_ICON_PNG);
        expect((await planIconBake(fs, { atlasHash: 'atlas-1', cache: true })).blockAtlasStale).toBe(true);

        fs.files.set(BLOCK_ICON_PNG, 'png-bytes');
        fs.files.delete('resources/client/prefab-icons/test%3Ahut.png');
        expect((await planIconBake(fs, { atlasHash: 'atlas-1', cache: true })).stalePrefabs).toContain('test:hut');
    });

    it('keeps a project with no renderable blocks off the render path', async () => {
        const fs = memFs();
        declareBlocks();
        const empty = await planIconBake(fs, { atlasHash: null, cache: true });
        expect(empty.blockAtlasStale).toBe(false);

        declareBlocks(...BASE_BLOCKS);
    });

    it('ignores the on-disk hashes entirely when uncached', async () => {
        const fs = memFs();
        completeBake(fs, await planIconBake(fs, { atlasHash: 'atlas-1', cache: true }));

        const uncached = await planIconBake(fs, { atlasHash: 'atlas-1', cache: false });
        expect(uncached.blockAtlasStale).toBe(true);
        expect(uncached.stalePrefabs).toContain('test:hut');
    });
});
