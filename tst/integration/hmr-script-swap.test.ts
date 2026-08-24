// ── HMR script swap (integration) ───────────────────────────────────
//
// The last link in the chain, and the one nothing else covered: does an edit on disk actually
// change what a RUNNING script instance does on the next tick?
//
// Everything upstream is tested elsewhere — shakeup's propagation (shakeup/tst/hmr.test.ts), the
// capture bracket + reload decision (tst/unit/editor/hmr-capture.test.ts). Here a real EngineServer
// boots with a real Room and real live script instances, and the edit is driven end to end:
// fs write → dev server handleChange → module re-eval → the capture POSTLUDE's hot.accept →
// __bongle.reload → flush → applyRegistryChanges → applyTraitSwap → the live instance.
//
// `applyRegistryChanges` has no other coverage at all, and the narrow `dirtyScriptIds` branch it
// takes for a script-body edit is the branch that was starved for as long as the dep-wrap never
// fired (see build/capture/capture-native.ts).
//
// NOTE the realm's `bongle` namespace is assembled from `src/...` rather than imported from the
// package: the package specifier resolves to a SEPARATE module instance here, which would give the
// game module its own registry singleton and leave the server looking at an empty one.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Fs } from 'shakeup';
import { afterEach, describe, expect, it } from 'vitest';
import { createShakeupBundlerHost } from '../../build/dev/shakeup-host';
import { connectRealmPort, type RealmPort } from '../../build/dev/shakeup-port';
import { browserEvaluator, makeImportMeta } from '../../build/dev/shakeup-runner-host';
import { openNodeFs } from '../../cli/node-fs';
import { registerFlushHandler } from '../../src/core/capture/flush';
import { registry, reindexRegistry } from '../../src/core/registry';
import { addTrait, createNode, serializeNode } from '../../src/core/scene/scene-tree';
import { onSwap, onTick, script } from '../../src/core/scene/scripts';
import { trait } from '../../src/core/scene/traits';
import { block } from '../../src/core/voxels/blocks';
import { env } from '../../src/env';
import { __bongle } from '../../src/internal-runtime';
import { createFallbackAvatarsDriver } from '../../src/node/sample-avatars-driver';
import { nodeZstd } from '../../src/node/zstd';
import { applyRegistryChanges } from '../../src/server/registry-dispatch';
import * as EngineServerModule from '../../src/server/server';
import { createInMemoryStorageDriver } from '../../src/server/storage-in-memory';

const DT = 1 / 60;

/** The engine surface a game module imports from 'bongle', bound to THIS registry instance. */
const bongleApi = { trait, script, onTick, onSwap, block, env };

function portPair(): [RealmPort, RealmPort] {
    const a: RealmPort = { postMessage: (d) => queueMicrotask(() => b.onmessage?.({ data: d })), onmessage: null };
    const b: RealmPort = { postMessage: (d) => queueMicrotask(() => a.onmessage?.({ data: d })), onmessage: null };
    return [a, b];
}

/** A shakeup dev host serving `files` to a realm wired to the real engine api + capture runtime. */
function devHost(files: Record<string, string>, log: string[]) {
    const fsAdapter: Fs = { read: async (id) => files[id] ?? null, exists: async (id) => id in files };
    const host = createShakeupBundlerHost({ fs: fsAdapter, jsx: false, isUserModule: () => true });
    const [bundlerPort, runnerPort] = portPair();
    host.connectRealm('server', bundlerPort);
    const realm = connectRealmPort(runnerPort, {
        name: 'server',
        env: { log },
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
    return { host, realm, files };
}

type Booted = {
    server: EngineServerModule.EngineServer;
    tick(): void;
    /** write an edit and drive it exactly as the editor's fs watcher would, incl. the flush drain. */
    edit(path: string, code: string): Promise<void>;
    dispose(): void;
};

/**
 * Boot a real server whose game module is served by a dev host — the server half of the e2e
 * harness (no client, no DOM), so the module can be edited and re-evaluated mid-session.
 */
async function boot(files: Record<string, string>, log: string[], entry = '/game.ts'): Promise<Booted> {
    const dev = devHost(files, log);
    const originalCwd = process.cwd();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bongle-hmr-'));
    fs.mkdirSync(path.join(tmpDir, 'content', 'scenes'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'resources', 'server'), { recursive: true });
    process.chdir(tmpDir);

    // the env a user module would see at load on the server side.
    env.server = true;
    env.client = false;
    env.editor = false;

    const root = createNode({ name: 'Root' });
    const ns = await dev.realm.import(entry);
    addTrait(root, ns.T as Parameters<typeof addTrait>[1]);
    // serializeTrait resolves each slot through the derived `slotToTrait` index, so the traits the
    // game module just declared have to be indexed before the scene is written — a real server boot
    // reindexes for the same reason.
    reindexRegistry(registry);
    fs.writeFileSync(
        path.join(tmpDir, 'content', 'scenes', 'main.scene.json'),
        JSON.stringify({ version: 1, nodes: { root: serializeNode(root) } }, null, 2),
    );

    const server = EngineServerModule.init({
        mode: 'play',
        fs: openNodeFs(tmpDir),
        zstd: nodeZstd,
        driver: { storage: createInMemoryStorageDriver(), avatars: createFallbackAvatarsDriver() },
    });
    await EngineServerModule.load(server);

    // the same wiring the editor's server realm boot does (see engine-server-editor.ts).
    const unregisterFlush = registerFlushHandler(() => applyRegistryChanges(server));
    // boot-time registrations are already reflected in the room; isolate the edits under test.
    for (const store of [registry.traits, registry.scripts, registry.blocks, registry.blockTextures]) {
        store.pendingChanges.length = 0;
    }

    return {
        server,
        tick: () => EngineServerModule.update(server, DT),
        edit: async (p, code) => {
            dev.files[p] = code;
            await dev.host.server.handleChange(p);
            await new Promise((r) => setTimeout(r, 0)); // the POSTLUDE's flush is a microtask
        },
        dispose: () => {
            unregisterFlush();
            dev.host.close();
            EngineServerModule.dispose(server);
            process.chdir(originalCwd);
        },
    };
}

const ticker = (traitId: string, tag: string) => `import { trait, script, onTick } from 'bongle';
export const T = trait('${traitId}');
script(T, 'tick', (ctx) => {
    onTick(ctx, () => { import.meta.env.log.push('${tag}'); });
});`;

describe('hmr script swap (integration)', () => {
    let booted: Booted | null = null;

    afterEach(() => {
        booted?.dispose();
        booted = null;
    });

    it('an edited script body is what the next tick runs', async () => {
        const log: string[] = [];
        booted = await boot({ '/game.ts': ticker('hmr-int/a', 'v1') }, log);

        booted.tick();
        expect(log).toEqual(['v1']);

        log.length = 0;
        await booted.edit('/game.ts', ticker('hmr-int/a', 'v2'));
        booted.tick();

        // the whole point: the LIVE instance runs the edited body, and the old one is gone rather
        // than still running alongside it.
        expect(log).toEqual(['v2']);
    });

    it('swaps the instance rather than accumulating another one', async () => {
        const log: string[] = [];
        booted = await boot({ '/game.ts': ticker('hmr-int/b', 'v1') }, log);
        booted.tick();

        for (const tag of ['v2', 'v3', 'v4']) {
            log.length = 0;
            await booted.edit('/game.ts', ticker('hmr-int/b', tag));
            booted.tick();
            // exactly one entry per tick, every time — a swap that disposed nothing would grow this.
            expect(log).toEqual([tag]);
        }
    });

    it('onSwap carries opt-in state across the swap', async () => {
        const counter = (tag: string) => `import { trait, script, onTick, onSwap } from 'bongle';
export const T = trait('hmr-int/c');
script(T, 'tick', (ctx) => {
    let count = 0;
    onSwap(ctx, () => count, (saved) => { count = saved; });
    onTick(ctx, () => { count++; import.meta.env.log.push('${tag}:' + count); });
});`;
        const log: string[] = [];
        booted = await boot({ '/game.ts': counter('v1') }, log);

        booted.tick();
        booted.tick();
        expect(log).toEqual(['v1:1', 'v1:2']);

        log.length = 0;
        await booted.edit('/game.ts', counter('v2'));
        booted.tick();
        // factory-closure locals reset by design; onSwap is the opt-in that survives, so the count
        // continues from 2 rather than restarting at 0.
        expect(log).toEqual(['v2:3']);
    });

    it('a producer edit in ANOTHER module reaches the script that closes over it', async () => {
        // The narrow `dirtyScriptIds` path. Nothing in /game.ts changes, so the swap can only happen
        // if the DepGraph carries an edge from the script to the block it closes over — the edge the
        // capture dep-wrap emits. /game.ts is transformed BEFORE /blocks.ts here, which is exactly
        // the order that used to leave that edge unwired.
        const blocks = (texture: string) => `import { block } from 'bongle';
export const Stone = block('hmr-int/stone', { model: () => ({ type: 'cube', textures: { all: { texture: '${texture}' } } }) });`;
        const game = `import { trait, script, onTick } from 'bongle';
import { Stone } from './blocks';
export const T = trait('hmr-int/d');
script(T, 'tick', (ctx) => {
    import.meta.env.log.push('factory:' + Stone.id);
    onTick(ctx, () => {});
});`;
        const log: string[] = [];
        booted = await boot({ '/game.ts': game, '/blocks.ts': blocks('stone') }, log);

        expect(log).toEqual(['factory:hmr-int/stone']); // the factory ran once at instantiation
        log.length = 0;

        await booted.edit('/blocks.ts', blocks('cobblestone'));
        booted.tick();

        // the factory re-ran, so the instance's closure now holds the rebuilt block handle. Without
        // the producer edge this stays empty and the instance keeps its stale closure, silently.
        expect(log).toEqual(['factory:hmr-int/stone']);
    });

    it('leaves a script that does NOT close over the producer alone', async () => {
        // The negative control for the test above: if a block edit re-ran every script, that test
        // would pass without any DepGraph edge existing. The narrow path has to actually be narrow.
        const blocks = (texture: string) => `import { block } from 'bongle';
export const Stone = block('hmr-int/stone2', { model: () => ({ type: 'cube', textures: { all: { texture: '${texture}' } } }) });`;
        const game = `import { trait, script, onTick } from 'bongle';
import './blocks';
export const T = trait('hmr-int/e');
script(T, 'tick', (ctx) => {
    import.meta.env.log.push('factory-ran');
    onTick(ctx, () => {});
});`;
        const log: string[] = [];
        booted = await boot({ '/game.ts': game, '/blocks.ts': blocks('stone') }, log);

        expect(log).toEqual(['factory-ran']);
        log.length = 0;

        await booted.edit('/blocks.ts', blocks('cobblestone'));
        booted.tick();

        // the module imports ./blocks for its side effect but the script body never touches Stone,
        // so there is no edge and nothing to swap.
        expect(log).toEqual([]);
    });
});
