// ── HMR block add → icon bake gate (integration) ────────────────────────
//
// When a newly declared block showed up in the editor palette WITHOUT an icon,
// every link in this chain was a suspect: does an HMR edit reach a worker realm
// at all, does the re-declared block land in that realm's registry, does the
// capture postlude's flush fire there, and does the icon gate then report the
// artifacts stale? Each half is covered elsewhere (shakeup's propagation,
// tst/unit/editor/hmr-capture, tst/unit/asset-pipeline/icons-gate) and each half
// was fine — only the join was untested, which is why the real cause sat on the
// consumer side for so long.
//
// So this drives the join: a realm on a real shakeup dev server, a block module
// edited on disk, and the pipeline realm's own flush handler (reindex + gate).

import { registerAllShapes } from 'crashcat';
import type { Fs } from 'shakeup';
import { describe, expect, it } from 'vitest';
import { createShakeupBundlerHost } from '../../build/dev/shakeup-host';
import { connectRealmPort, type RealmPort } from '../../build/dev/shakeup-port';
import { browserEvaluator, makeImportMeta } from '../../build/dev/shakeup-runner-host';
import type { Filesystem, FsPath } from '../../os/interface';
import { type IconBakePlan, iconBakeIsNoop, planIconBake } from '../../src/asset-pipeline/icons';
import { registerFlushHandler } from '../../src/core/capture/flush';
import { registry, reindexRegistry } from '../../src/core/registry';
import { block, blockTexture } from '../../src/core/voxels/blocks';
import { env } from '../../src/env';
import { __bongle } from '../../src/internal-runtime';

const BLOCK_ICON_PNG = 'resources/client/voxels-icons.png';
const BLOCK_ICON_JSON = 'resources/client/voxels-icons.json';

/** The engine surface the game module imports from 'bongle', bound to THIS registry. */
const bongleApi = { block, blockTexture, env };

/** just enough project disk for the gate: it reads the icon sidecar's hash and
 *  probes for the png. */
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
        readDir: async () => new Map<string, 'file' | 'dir'>(),
        write: async () => {},
        writeIfChanged: async () => true,
        remove: async (p: FsPath) => {
            files.delete(p);
        },
    } as unknown as Filesystem & { files: Map<string, string> };
}

function portPair(): [RealmPort, RealmPort] {
    const a: RealmPort = { postMessage: (d) => queueMicrotask(() => b.onmessage?.({ data: d })), onmessage: null };
    const b: RealmPort = { postMessage: (d) => queueMicrotask(() => a.onmessage?.({ data: d })), onmessage: null };
    return [a, b];
}

/** a block module declaring `ids`, all wearing one texture — so a block joining
 *  the set adds no atlas layer and only the DERIVED registry says it changed. */
const blocksModule = (ids: string[]) =>
    `import { block, blockTexture } from 'bongle';
const stone = blockTexture('hmr-icons/stone', { src: 'stone.png' });
${ids
    .map(
        (id, i) =>
            `export const B${i} = block('${id}', { model: () => ({ type: 'cube', textures: { all: { texture: stone } } }) });`,
    )
    .join('\n')}`;

/** what a completed icon bake leaves on disk for the next pass's gate. */
function completeBake(disk: ReturnType<typeof memFs>, plan: IconBakePlan): void {
    disk.files.set(BLOCK_ICON_PNG, 'png-bytes');
    disk.files.set(BLOCK_ICON_JSON, JSON.stringify({ hash: plan.blockIconsHash }));
}

describe('hmr block add → icon bake (integration)', () => {
    it('re-declares into the realm registry, fires a flush, and leaves the icon gate stale', async () => {
        registerAllShapes();
        const files: Record<string, string> = {
            '/index.ts': `import './blocks';`,
            '/blocks.ts': blocksModule(['hmr-icons/a']),
        };
        const fsAdapter: Fs = { read: async (id) => files[id] ?? null, exists: async (id) => id in files };
        const host = createShakeupBundlerHost({ fs: fsAdapter, jsx: false, isUserModule: () => true });
        const [bundlerPort, runnerPort] = portPair();
        // the pipeline app's realm: a worker with no surface, holding the user graph.
        host.connectRealm('pipeline', bundlerPort);
        const realm = connectRealmPort(runnerPort, {
            name: 'pipeline',
            evaluator: {
                ...browserEvaluator,
                async runExternalModule(spec: string): Promise<unknown> {
                    if (spec === 'bongle/internal') return { __bongle };
                    if (spec === 'bongle') return bongleApi;
                    return browserEvaluator.runExternalModule(spec);
                },
            },
            createImportMeta: (p) => makeImportMeta((m) => `https://app.test/@project${m}`)(p),
        });
        await realm.import('/index.ts');
        expect(registry.blocks.byId.has('hmr-icons/a')).toBe(true);

        // the boot bake, banked on disk so the next gate has something to match.
        const disk = memFs();
        reindexRegistry(registry);
        const boot = await planIconBake(disk, { atlasHash: 'atlas-1', cache: true });
        expect(boot.blockAtlasStale).toBe(true);
        completeBake(disk, boot);
        expect(iconBakeIsNoop(await planIconBake(disk, { atlasHash: 'atlas-1', cache: true }))).toBe(true);

        // what EditPipeline registers: a re-declare re-runs the gate.
        const plans: IconBakePlan[] = [];
        const unregister = registerFlushHandler(async () => {
            reindexRegistry(registry);
            plans.push(await planIconBake(disk, { atlasHash: 'atlas-1', cache: true }));
        });
        try {
            files['/blocks.ts'] = blocksModule(['hmr-icons/a', 'hmr-icons/b']);
            await host.server.handleChange('/blocks.ts');
            await new Promise((r) => setTimeout(r, 50));

            // the new block reached the realm's registry at all,
            expect(registry.blocks.byId.has('hmr-icons/b')).toBe(true);
            // the capture postlude's flush fired exactly once for the cascade,
            expect(plans).toHaveLength(1);
            // and the gate saw a block the banked artifacts don't cover. The atlas
            // hash never moved (both blocks wear one texture), so this can only come
            // from the derived block registry — the reason the gate hashes it.
            expect(plans[0]?.blockAtlasStale).toBe(true);
            expect(plans[0]?.blockIconsHash).not.toBe(boot.blockIconsHash);
        } finally {
            unregister();
            host.close();
        }
    });
});
