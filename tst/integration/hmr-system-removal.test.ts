// ── HMR system removal, the editor's flow (integration) ─────────────────────
//
// The exact shape the editor runs: an EDIT-mode server, the user entry imported as a root under the
// fs-relative id `src/index.ts` (what `os/apps/server.ts` imports), a `system()` on the engine's own
// `WorldTrait`, then the `system()` call deleted from source and a PLAY room created from the edit
// room, the way the editor's play button does (`createPlayRoom` with the edit room as source).
//
// WorldTrait is the case `pruneRemovedScript` exists for: its def lives in an engine module that
// never re-evaluates, so nothing but the registry's passive removal can take the orphan off it.
// `hmr-script-swap.test.ts` covers user traits in a play-mode server; this covers the built-in host
// trait in the mode the editor actually edits in, and the room that gets created afterwards.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Fs } from 'shakeup';
import { afterEach, describe, expect, it } from 'vitest';
import { createShakeupBundlerHost } from '../../build/dev/shakeup-host';
import { connectRealmPort, type RealmPort } from '../../build/dev/shakeup-port';
import { browserEvaluator, makeImportMeta } from '../../build/dev/shakeup-runner-host';
import { openNodeFs } from '../../cli/node-fs';
import { system } from '../../src/api/scripts';
import { WorldTrait } from '../../src/builtins/world';
import { registerFlushHandler } from '../../src/core/capture/flush';
import { registry } from '../../src/core/registry';
import { DEFAULT_SCENE_ID } from '../../src/core/scene/scene-handle';
import { createNode, serializeNode } from '../../src/core/scene/scene-tree';
import { onDispose, onTick } from '../../src/core/scene/scripts';
import { env } from '../../src/env';
import { __bongle } from '../../src/internal-runtime';
import { createFallbackAvatarsDriver } from '../../src/node/sample-avatars-driver';
import { nodeZstd } from '../../src/node/zstd';
import { applyRegistryChanges } from '../../src/server/registry-dispatch';
import * as Rooms from '../../src/server/rooms';
import * as EngineServerModule from '../../src/server/server';
import { createInMemoryStorageDriver } from '../../src/server/storage-in-memory';

const DT = 1 / 60;
const ENTRY = 'src/index.ts';

/** The engine surface a game module imports from 'bongle', bound to THIS registry instance. */
const bongleApi = { system, onTick, onDispose, env };

function portPair(): [RealmPort, RealmPort] {
    const a: RealmPort = { postMessage: (d) => queueMicrotask(() => b.onmessage?.({ data: d })), onmessage: null };
    const b: RealmPort = { postMessage: (d) => queueMicrotask(() => a.onmessage?.({ data: d })), onmessage: null };
    return [a, b];
}

/** The editor's fs shape: ids are fs-relative, a leading slash reads the same file. */
function devHost(files: Record<string, string>, log: string[]) {
    const norm = (id: string) => id.replace(/^\/+/, '');
    const fsAdapter: Fs = { read: async (id) => files[norm(id)] ?? null, exists: async (id) => norm(id) in files };
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
        createImportMeta: (p) => makeImportMeta((m) => `https://app.test/@project/${m.replace(/^\/+/, '')}`)(p),
    });
    return { host, realm, files };
}

type Booted = {
    server: EngineServerModule.EngineServer;
    editRoom: Rooms.Room;
    tick(): void;
    edit(code: string): Promise<void>;
    dispose(): void;
};

async function boot(entryCode: string, log: string[]): Promise<Booted> {
    const dev = devHost({ [ENTRY]: entryCode }, log);
    const originalCwd = process.cwd();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bongle-hmr-sys-'));
    fs.mkdirSync(path.join(tmpDir, 'content', 'scenes'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'resources', 'server'), { recursive: true });
    process.chdir(tmpDir);

    env.server = true;
    env.client = false;
    env.editor = true;

    await dev.realm.import(ENTRY);
    expect(dev.host.server.moduleIds()).toContain(ENTRY);

    const root = createNode({ name: 'Root' });
    fs.writeFileSync(
        path.join(tmpDir, 'content', 'scenes', `${DEFAULT_SCENE_ID}.scene.json`),
        JSON.stringify({ version: 1, nodes: { root: serializeNode(root) } }, null, 2),
    );

    const server = EngineServerModule.init({
        mode: 'edit',
        fs: openNodeFs(tmpDir),
        zstd: nodeZstd,
        options: {},
        driver: { storage: createInMemoryStorageDriver(), avatars: createFallbackAvatarsDriver() },
        send: () => {},
    });
    await EngineServerModule.load(server);
    const unregisterFlush = registerFlushHandler(() => applyRegistryChanges(server));
    for (const store of [registry.traits, registry.scripts]) store.pendingChanges.length = 0;

    const editRoom = [...server.rooms.rooms.values()].find((room) => room.mode === 'edit');
    if (!editRoom) throw new Error('edit-mode load did not create the edit room');

    return {
        server,
        editRoom,
        tick: () => EngineServerModule.update(server, DT),
        edit: async (code) => {
            dev.files[ENTRY] = code;
            await dev.host.server.handleChange(ENTRY);
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

const SPIN_KEY = `${WorldTrait.id}.spin`;

const entry = (withSystem: boolean) => `import { system, onTick, onDispose } from 'bongle';
${
    withSystem
        ? `system('spin', (ctx) => {
    onTick(ctx, () => { import.meta.env.log.push('spin'); });
    onDispose(ctx, () => { import.meta.env.log.push('dispose:spin'); });
});`
        : ''
}`;

const rootInstances = (room: Rooms.Room) => [...(room.context.instances.get(room.scene.root.id)?.keys() ?? [])];

describe('hmr system removal in the editor flow (integration)', () => {
    let booted: Booted | null = null;

    afterEach(() => {
        booted?.dispose();
        booted = null;
    });

    it('a system declared in src/index.ts runs in a play room created from the edit room', async () => {
        // positive control for the removal test: the harness has to actually see the system.
        const log: string[] = [];
        booted = await boot(entry(true), log);
        expect(rootInstances(booted.editRoom)).toContain(SPIN_KEY);

        const playRoom = Rooms.createPlayRoom(booted.server, DEFAULT_SCENE_ID, booted.editRoom.id);
        expect(rootInstances(playRoom)).toContain(SPIN_KEY);
        booted.tick();
        expect(log).toContain('spin');
    });

    it('a system() deleted from src/index.ts is gone from the edit room AND from a play room created after', async () => {
        const log: string[] = [];
        booted = await boot(entry(true), log);
        expect(rootInstances(booted.editRoom)).toContain(SPIN_KEY);
        expect(WorldTrait.def.scripts.map((s) => s.key)).toContain(SPIN_KEY);

        await booted.edit(entry(false));

        // the registry dropped the key, the engine-owned WorldTrait def was pruned, and the edit
        // room's live instance is disposed.
        expect(registry.scripts.byId.has(SPIN_KEY)).toBe(false);
        expect(WorldTrait.scriptsById.has('spin')).toBe(false);
        expect(WorldTrait.def.scripts.map((s) => s.key)).not.toContain(SPIN_KEY);
        expect(rootInstances(booted.editRoom)).not.toContain(SPIN_KEY);

        // the editor's play button: a play room booted from the edit room, after the edit.
        const playRoom = Rooms.createPlayRoom(booted.server, DEFAULT_SCENE_ID, booted.editRoom.id);
        expect(rootInstances(playRoom)).not.toContain(SPIN_KEY);
        log.length = 0;
        booted.tick();
        expect(log).toEqual([]);
    });
});
