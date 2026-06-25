// ── e2e test harness ────────────────────────────────────────────────
//
// boots a real EngineServer + headless EngineClients in one process,
// piping packets through memory. runs the full engine — server init +
// load (atlas, scene file), client init + load (renderer, ui, dispatch).
//
// the only differences from production:
//   1. happy-dom provides the browser DOM
//   2. webgpu-stub provides a fake GPU
//   3. networking is memory pipes instead of websockets
//   4. cwd is a throwaway tmp dir (atlas/scene writes stay isolated)
//
// usage:
//   const harness = await createTestHarness((root) => {
//       block('stone', { model: () => ({ type: 'cube', textures: { all: { texture: 'stone' } } }) });
//       const Gameplay = trait('gameplay', {}, { persist: false });
//       script(Gameplay, 'session', (ctx) => onJoin(ctx, ...));
//
//       addTrait(root, Gameplay);
//       return { Gameplay };       // becomes harness.data
//   });
//
//   const client = await harness.connect();
//   harness.tick();
//   harness.data.Gameplay          // typed, no string lookup
//   harness.dispose();

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { CharacterControllerTrait, env, TransformTrait, type TraitType } from 'bongle';
import * as EngineClientModule from '../../src/client/engine-client';
import * as ClientNet from '../../src/client/net';
import type * as ClientRooms from '../../src/client/rooms';
import * as Nodes from '../../src/core/scene/nodes';
import { registry } from '../../src/core/registry';
import * as EngineServerModule from '../../src/server/engine-server';
import * as Rooms from '../../src/server/rooms';
import { createInMemoryStorageDriver } from '../../src/server/storage-in-memory';
import { createFallbackAvatarsDriver } from '../../src/server/avatars-fallback';

// ── types ───────────────────────────────────────────────────────────

export type SetupFn<D> = (root: Nodes.Node) => D | Promise<D>;

export type TestHarness<D> = {
    /** raw server engine state */
    server: EngineServerModule.EngineServer;

    /** the default room — shorthand for server.rooms.rooms[defaultRoomId] */
    get room(): Rooms.Room;

    /** whatever the setup function returned — typed via inference. */
    data: D;

    /** connect a headless client. awaits full client init + load. */
    connect(): Promise<TestClient>;

    /**
     * advance one tick. default dt = 1/60.
     *
     * order:
     *   1. flush each client outbox → server inbox
     *   2. server.update(dt)
     *   3. flush server outbox → each client inbox
     *   4. each client.update(dt)
     */
    tick(dt?: number): void;

    /** advance N ticks */
    tickN(n: number, dt?: number): void;

    /** cleanup — closes file watcher, restores cwd, removes tmp dir */
    dispose(): void;
};

export type TestClient = {
    id: number;
    state: EngineClientModule.EngineClient;
    get room(): ClientRooms.ClientRoom | null;
    get characterController(): TraitType<typeof CharacterControllerTrait> | null;
    get transform(): TraitType<typeof TransformTrait> | null;
};

// ── registry baseline (built-ins survive _reset) ────────────────────

type AnyStore = {
    byId: Map<string, unknown>;
    byModule: Map<string, Set<string>>;
    pending: Map<string, Set<string>>;
    pendingChanges: unknown[];
    revision: number;
};

type StoreSnap = {
    byId: Map<string, unknown>;
    byModule: Map<string, Set<string>>;
    pending: Map<string, Set<string>>;
    pendingChanges: unknown[];
    revision: number;
};

const STORE_NAMES = [
    'blockTextures', 'blocks', 'models', 'traits', 'controls', 'sync',
    'scripts', 'commands', 'scenes', 'prefabs', 'sounds', 'sprites',
    'particles', 'matchmaking',
] as const;

let baseline: Record<string, StoreSnap> | null = null;

function snapStore(s: AnyStore): StoreSnap {
    return {
        byId: new Map(s.byId),
        byModule: new Map([...s.byModule].map(([k, v]) => [k, new Set(v)])),
        pending: new Map([...s.pending].map(([k, v]) => [k, new Set(v)])),
        pendingChanges: [...s.pendingChanges],
        revision: s.revision,
    };
}

function restoreStore(s: AnyStore, snap: StoreSnap): void {
    s.byId.clear();
    for (const [k, v] of snap.byId) s.byId.set(k, v);
    s.byModule.clear();
    for (const [k, v] of snap.byModule) s.byModule.set(k, new Set(v));
    s.pending.clear();
    for (const [k, v] of snap.pending) s.pending.set(k, new Set(v));
    s.pendingChanges.length = 0;
    s.pendingChanges.push(...snap.pendingChanges);
    s.revision = snap.revision;
}

/**
 * first call: snapshot the registry (engine built-ins already loaded).
 * subsequent calls: restore to that snapshot, dropping any user-test
 * registrations from prior tests. registry._reset() invalidates derived
 * caches before we refill the stores.
 */
function captureOrRestoreBaseline(): void {
    const reg = registry as unknown as Record<string, AnyStore>;
    if (baseline === null) {
        baseline = {};
        for (const name of STORE_NAMES) baseline[name] = snapStore(reg[name]);
        return;
    }
    registry._reset();
    for (const name of STORE_NAMES) restoreStore(reg[name], baseline[name]);
}

// ── harness creation ────────────────────────────────────────────────

const DEFAULT_DT = 1 / 60;

/**
 * create a test harness. flow:
 *   - sets env flags for module-eval (server context)
 *   - constructs a fresh Root node, hands it to `setup(root)`
 *   - setup registers blocks/traits/scripts and mutates `root` (addTrait,
 *     addChild, etc.) using the normal engine APIs
 *   - whatever setup returns becomes `harness.data` (passthrough)
 *   - serializes the root tree to tmp/data/scenes/main.scene.json
 *   - server: init → loadModule → load (scene file read, room creation, watcher)
 *   - client: init → load (renderer, ui, dispatch — everything)
 */
export async function createTestHarness<D>(setup: SetupFn<D>): Promise<TestHarness<D>> {
    // ── -1. restore global registry to its engine-baseline ──────
    // block/trait/script registrations accumulate on the module-scope
    // singleton; without this, the Nth test sees stale defs from N-1.
    // first call captures the baseline (engine built-ins already loaded);
    // subsequent calls restore to that baseline so user-test registrations
    // (added below) are wiped while built-ins survive.
    captureOrRestoreBaseline();

    // ── 0. throwaway project directory ──────────────────────────
    const originalCwd = process.cwd();
    const tmpDir = path.join(__dirname, 'tmp', `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const contentDir = path.join(tmpDir, 'content');
    const resourcesDir = path.join(tmpDir, 'resources', 'server');
    const scenesDir = path.join(contentDir, 'scenes');
    fs.mkdirSync(scenesDir, { recursive: true });
    fs.mkdirSync(resourcesDir, { recursive: true });
    process.chdir(tmpDir);

    // ── 1. set server env flags BEFORE setup runs ───────────────
    //
    // block()/trait()/script() check env to decide whether to register
    // server-side handlers. setup is the moral equivalent of an evaluated
    // user module — give it the same env it would have had at module load.
    env.server = true;
    env.client = false;
    env.editor = false;

    // ── 2. build root node + run user setup ─────────────────────
    const root = Nodes.createNode({ name: 'Root' });
    const data = await setup(root);

    // ── 3. serialize root tree to disk for the real loader ──────
    const serialized = Nodes.serializeNode(root);
    fs.writeFileSync(
        path.join(scenesDir, 'main.scene.json'),
        JSON.stringify({ version: 1, nodes: { root: serialized } }, null, 2),
    );

    // ── 4. static file server for client fetch() requests ───────
    const httpServer = http.createServer((req, res) => {
        const filePath = path.join(tmpDir, req.url ?? '/');
        fs.readFile(filePath, (err, bytes) => {
            if (err) {
                res.writeHead(404);
                res.end();
                return;
            }
            if (filePath.endsWith('.json')) res.setHeader('Content-Type', 'application/json');
            else if (filePath.endsWith('.png')) res.setHeader('Content-Type', 'image/png');
            res.writeHead(200);
            res.end(bytes);
        });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as { port: number }).port;
    // point happy-dom's document origin at this harness's static server so
    // `fetch('/path')` (assetUrl in dev mode) resolves to the right file.
    const win = (globalThis as { window?: { happyDOM?: { setURL: (u: string) => void } } }).window;
    win?.happyDOM?.setURL(`http://localhost:${port}/`);

    // ── 5. boot server ──────────────────────────────────────────
    const server = EngineServerModule.init({
        mode: 'play',
        contentDir,
        resourcesDir,
        driver: {
            storage: createInMemoryStorageDriver(),
            avatars: createFallbackAvatarsDriver(),
        },
    });
    await EngineServerModule.load(server);

    // ── 6. track clients ────────────────────────────────────────
    let nextClientId = 1;
    const clients: TestClient[] = [];

    const harness: TestHarness<D> = {
        server,
        data,

        get room() {
            return Rooms.getRoom(server.rooms, server.defaultRoomId!)!;
        },

        async connect(): Promise<TestClient> {
            const clientId = nextClientId++;

            env.server = false;
            env.client = true;

            const clientState = EngineClientModule.init({
                mode: 'play',
                resourceLoader: { loadBytes: async () => new Uint8Array() },
                driver: {
                    matchmake: () => {},
                    platform: { commercialBreak: async () => {}, rewardedBreak: async () => false },
                },
            });
            await EngineClientModule.load(clientState);

            env.server = true;
            env.client = false;

            const testClient: TestClient = {
                id: clientId,
                state: clientState,
                get room() {
                    if (!clientState.rooms.activePlayerId) return null;
                    return clientState.rooms.rooms.get(clientState.rooms.activePlayerId) ?? null;
                },
                get characterController() {
                    const room = this.room;
                    if (!room?.playerNode) return null;
                    return Nodes.getTrait(room.playerNode, CharacterControllerTrait) ?? null;
                },
                get transform() {
                    const room = this.room;
                    if (!room?.playerNode) return null;
                    return Nodes.getTrait(room.playerNode, TransformTrait) ?? null;
                },
            };

            clients.push(testClient);

            EngineServerModule.onClientJoin(
                server,
                clientId,
                { id: `user-${clientId}`, username: `test-${clientId}` },
                {},
            );

            return testClient;
        },

        tick(dt = DEFAULT_DT) {
            for (const client of clients) {
                ClientNet.flush(client.state.net);
                const packets = client.state.net.outbox.splice(0);
                if (packets.length > 0) {
                    let inbox = server.net.inbox.get(client.id);
                    if (!inbox) {
                        inbox = [];
                        server.net.inbox.set(client.id, inbox);
                    }
                    inbox.push(...packets);
                }
            }

            env.server = true;
            env.client = false;
            EngineServerModule.update(server, dt);

            for (const client of clients) {
                const packets = server.net.outbox.get(client.id);
                if (packets && packets.length > 0) {
                    client.state.net.inbox.push(...packets);
                }
            }
            server.net.outbox.clear();

            env.server = false;
            env.client = true;
            for (const client of clients) {
                EngineClientModule.update(client.state, dt);
            }
        },

        tickN(n: number, dt = DEFAULT_DT) {
            for (let i = 0; i < n; i++) this.tick(dt);
        },

        dispose() {
            for (const client of clients) {
                EngineServerModule.onClientLeave(server, client.id);
                EngineClientModule.dispose(client.state);
            }
            clients.length = 0;

            EngineServerModule.dispose(server);
            httpServer.close();

            env.server = false;
            env.client = false;

            process.chdir(originalCwd);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        },
    };

    return harness;
}
