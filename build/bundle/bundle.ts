// lib/build/bundle.ts — the PROD build (Option A), host-neutral.
//
// Two env-DCE'd bundles over a per-target entry (the existing generated barrels +
// src/index + a play-* adapter) → client/index.js + server/index.js;
// baked resources copied in; a bongle.json manifest (schema 1, sha384 SRI,
// config + compat matchmaking.maxPlayers) written; the tree zipped.
//
// A standalone (client-only) game — `config({ server: false })` — has no
// server, so its build skips the server target entirely: no server/index.js, no
// server resources, no content copy, and no manifest `server` entry. Multiplayer
// (`config({ server })`) builds both targets exactly as before.
//
// The `rolldown` impl is INJECTED (see Bundler): the browser editor passes
// @rolldown/browser (its wasm lives in a library-managed worker); a node CLI
// passes node `rolldown`. Same graph, same output.
//
// The bundle is byte-shaped for the platform's ingest (client/index.js +
// server/index.js + bongle.json required). The server entry (PLAY_SERVER) wires
// the refactored EngineServer: node zstd, a node-fs loadResource rooted at the
// unpacked bundle, and scenes seeded from content/.

import { zipSync } from 'fflate';
import { INTERFACE_VERSION } from '../../interface/index';
import { BONGLE_VERSION } from '../../src/build-info';
import { type Config, isStandalone, serverMaxPlayers } from '../../src/core/config';
import type { EnvValues } from '../env-replace';
import type { BuildFs } from '../resolve';
import { type Bundler, bundleWorkers, createBonglePlugin } from './bongle-plugin';

type Target = 'client' | 'server';

/** virtual entry id (per build call — a fresh rolldown graph per target). */
const ENTRY_ID = '\0bongle:build-entry';

/** bumped when the bundle layout the platform expects changes. */
const BUNDLE_SCHEMA = 1;

function envFor(target: Target): EnvValues {
    return target === 'client'
        ? { client: true, server: false, editor: false, offline: false }
        : { client: false, server: true, editor: false, offline: false };
}

// ── play-* adapters (the deployed client/server entry shims) ────────────────
//
// Same shape the dev realms' play-{client,server} emit: a `bongle/interface`
// adapter default-exported after the user side-effect imports run. Env is set
// inside init(), matching the prod ordering.

const PLAY_CLIENT = `
import { env } from 'bongle';
import { client } from 'bongle/interface';
import { EngineClient, browserResourceLoader } from 'bongle/engine-client';
export default client({
    init: (driver) => {
        env.client = true; env.server = false; env.editor = false;
        return EngineClient.init({ mode: 'play', driver, resourceLoader: browserResourceLoader, domElement: document.body });
    },
    // a standalone (client-only) build self-boots its local room here; multiplayer
    // builds no-op and boot from the server's join_room. See startStandaloneRoomIfConfigured.
    load: async (state) => { EngineClient.mountPlayUI(state.domElement); await EngineClient.load(state); EngineClient.startStandaloneRoomIfConfigured(state); },
    update: (state, dt) => EngineClient.update(state, dt),
    dispose: (state) => EngineClient.dispose(state),
    getInbox: (state) => state.net.inbox,
    getOutbox: (state) => state.net.outbox,
    clearOutbox: (state) => { state.net.outbox.length = 0; },
});
`;

const PLAY_SERVER = `
import { env } from 'bongle';
import { server } from 'bongle/interface';
import { EngineServer } from 'bongle/engine-server';

// Host-neutral: no node imports. The host injects fs (project files: scenes under
// content/scenes/, model bins under resources/server/), zstd (native node:zlib or
// wasm), and the driver (storage + avatars). Runs unchanged in a node process
// (deploy) or a browser worker (solo).
export default server({
    init: (opts) => {
        env.client = false; env.server = true; env.editor = false;
        return EngineServer.init({
            mode: 'play',
            fs: opts.fs,
            zstd: opts.zstd,
            options: opts.options,
            driver: opts.driver,
        });
    },
    load: async (state) => { await EngineServer.load(state); },
    update: (state, dt) => EngineServer.update(state, dt),
    dispose: (state) => EngineServer.dispose(state),
    onClientJoin: (state, c, user, joinData, avatar) => EngineServer.onClientJoin(state, c, user, joinData, avatar),
    onClientLeave: (state, c) => EngineServer.onClientLeave(state, c),
    getInbox: (state) => state.net.inbox,
    getOutbox: (state) => state.net.outbox,
    clearOutbox: (state) => { state.net.outbox.clear(); },
});
`;

// Asset registrations reference their SOURCE files with `asset('./x', import.meta.url)`
// (a plain fn, not the `new URL(literal, import.meta.url)` the bundler treats as an
// emit-me asset), so nothing pulls the raw source file into the client — the model /
// sound / texture is served from the baked atlas/bin the pipeline produced, and the
// `asset()` href sits unused in the shipped registry. No stripping needed.

/** the per-target entry: side-effect-import every existing generated barrel +
 *  user src (registries populate), then the play-* adapter as default. */
async function entrySource(fs: BuildFs, target: Target): Promise<string> {
    const generated = (await fs.list('src/generated', { recursive: true }).catch(() => []))
        .filter((e) => e.kind === 'file' && e.path.endsWith('.ts'))
        .map((e) => e.path)
        .sort();
    const imports = [...generated, 'src/index.ts'].map((p) => `import ${JSON.stringify(`/${p}`)};`).join('\n');
    return `${imports}\n${target === 'client' ? PLAY_CLIENT : PLAY_SERVER}`;
}

// Module resolution + load + env-bake is the shared createBonglePlugin (resolve.ts-
// backed). The build only supplies the per-target specifics: the virtual play
// entry and the sharp external (server). Generated barrels import their registry
// primitives (registerModel/…) from bongle/internal directly, so no prelude.
function buildTargetPlugin(fs: BuildFs, target: Target, entry: string, workers: Map<string, string>) {
    return createBonglePlugin(fs, {
        env: envFor(target),
        entry: { id: ENTRY_ID, code: entry },
        external: (source) => target === 'server' && source === 'sharp',
        workers,
    });
}

// ── build a single target → { fileName: bytes } ─────────────────────────────

async function buildTarget(
    fs: BuildFs,
    target: Target,
    workers: Map<string, string>,
    bundler: Bundler,
    progress: (label: string) => void = () => {},
): Promise<Record<string, Uint8Array>> {
    bundler.prepare?.(); // browser: @rolldown/browser reads `process` in bindingifyInputOptions
    const entry = await entrySource(fs, target);
    progress(`Bundling ${target}`);
    const bundle = await bundler.rolldown({
        input: { index: ENTRY_ID },
        plugins: [buildTargetPlugin(fs, target, entry, workers)],
        external: [/^node:/, ...(target === 'server' ? [/^sharp$/] : [])],
        // NODE_ENV is already build-defined into the prebundled engine dist (where
        // React lives); user + play-shell code don't read process.env, so no define.
        // server is host-neutral: it runs in a node process (deploy) AND a browser
        // worker (solo/editor), injecting node/browser capabilities per host.
        platform: target === 'server' ? 'neutral' : 'browser',
        // bongle/index is both statically (our entry) + dynamically (engine-server)
        // imported — an expected, harmless chunking note; drop it, surface the rest.
        onLog: (level, log, handler) => {
            if (log.code === 'INEFFECTIVE_DYNAMIC_IMPORT') return;
            handler(level, log);
        },
    });
    const { output } = await bundle.generate({
        format: 'es',
        entryFileNames: 'index.js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        // the server must be one self-contained file: the solo host blob-imports
        // server/index.js, and a blob URL can't resolve relative ./assets chunks.
        // (Practically the server graph has no runtime dynamic imports, so this is a
        // guarantee, not a reshape.) Deploy is unaffected — node imports it from disk.
        inlineDynamicImports: target === 'server',
        minify: true,
    });
    await bundle.close();

    const enc = new TextEncoder();
    const files: Record<string, Uint8Array> = {};
    for (const o of output) {
        files[o.fileName] =
            o.type === 'chunk' ? enc.encode(o.code) : typeof o.source === 'string' ? enc.encode(o.source) : o.source;
    }
    return files;
}

// ── manifest (sha384 SRI) ───────────────────────────────────────────────────

async function sri(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-384', bytes as unknown as BufferSource));
    let bin = '';
    for (const b of digest) bin += String.fromCharCode(b);
    return `sha384-${btoa(bin)}`;
}

/** copy an OPFS subtree into the zip map under `dest/`, stripping `srcDir/`. */
async function copyTree(fs: BuildFs, srcDir: string, zip: Record<string, Uint8Array>, dest: string): Promise<void> {
    for (const e of await fs.list(srcDir, { recursive: true }).catch(() => [])) {
        if (e.kind !== 'file') continue;
        const rel = e.path.slice(srcDir.length + 1);
        zip[`${dest}/${rel}`] = await fs.read(e.path);
    }
}

export type BuildOptions = {
    /** the project's config for the manifest. The build can't evaluate
     *  user code to read the registry, so the caller supplies it (the pipeline
     *  realm / node bake reports it — see stores/build-meta). Drives the
     *  `config` manifest key, the compat `matchmaking.maxPlayers`, and whether
     *  the server target is built at all (standalone omits it). */
    config: Config;
    /** phase label callback for the progress UI. */
    onProgress?: (label: string) => void;
};

/** build the whole bundle → zip bytes (client/ + server/ + bongle.json). The
 *  `bundler` (rolldown impl + host prep) is injected — see Bundler. */
export async function buildBundle(fs: BuildFs, bundler: Bundler, opts: BuildOptions): Promise<Uint8Array> {
    const progress = opts.onProgress ?? (() => {});
    // a standalone game is client-only: no server bundle, no server resources,
    // no content copy, no manifest `server` entry (the "no double chunks" win).
    const standalone = isStandalone(opts.config);
    // workers first: `?worker` entries (mesh worker) bundle standalone BEFORE the
    // main build — a nested @rolldown/browser build from inside a plugin hook
    // deadlocks on main-thread Atomics.wait. They're client-side compute.
    progress('Bundling workers');
    const workers = await bundleWorkers(fs, envFor('client'), bundler);
    // sequential, NOT Promise.all: the browser bundler (@rolldown/browser) is one
    // wasm instance over a shared WASI thread pool — two concurrent rolldown()
    // bundles deadlock its async runtime (one finishes, the other hangs). Native
    // node rolldown is reentrant and wouldn't care, but the core is host-neutral,
    // and the server graph is tiny so serializing costs ~nothing.
    const clientFiles = await buildTarget(fs, 'client', workers, bundler, progress);
    const serverFiles = standalone ? {} : await buildTarget(fs, 'server', workers, bundler, progress);

    const zip: Record<string, Uint8Array> = {};
    for (const [name, bytes] of Object.entries(clientFiles)) zip[`client/${name}`] = bytes;
    for (const [name, bytes] of Object.entries(serverFiles)) zip[`server/${name}`] = bytes;

    // engine UI css was extracted at prebundle time (dist/bongle.css) rather than
    // re-emitted by this bundle, so ship it as client/index.css for the deployed
    // client's styled UI.
    let clientCss: Uint8Array | undefined;
    try {
        clientCss = await fs.read('node_modules/bongle/dist/bongle.css');
        zip['client/index.css'] = clientCss;
    } catch {
        /* no engine css seeded */
    }

    // baked outputs (the pipeline already produced these) + authored content +
    // the project's static public/ dir (copied to the client root).
    progress('Copying baked resources');
    await copyTree(fs, 'resources/client', zip, 'client');
    if (!standalone) {
        // server model bins nest under the server realm dir at the engine's `resources/
        // server/` convention (the deployed host roots its fs at the extracted server/).
        // content/ is server-only (the client bakes its scenes into the client bundle
        // via codegen), so a standalone package needs neither.
        await copyTree(fs, 'resources/server', zip, 'server/resources/server');
        await copyTree(fs, 'content', zip, 'server/content');
    }
    await copyTree(fs, 'public', zip, 'client');

    progress('Writing manifest');
    const client: Record<string, unknown> = { entry: 'client/index.js', integrity: await sri(zip['client/index.js']) };
    if (clientCss) client.styles = { entry: 'client/index.css', integrity: await sri(clientCss) };

    // compat matchmaking field: serverMaxPlayers is null for standalone → 1.
    const maxPlayers = serverMaxPlayers(opts.config) ?? 1;

    const manifest: Record<string, unknown> = {
        schema: BUNDLE_SCHEMA,
        engine: { bongle: BONGLE_VERSION, interface: INTERFACE_VERSION },
        client,
        assets: { publicDir: 'public' },
        build: { id: crypto.randomUUID(), createdAt: new Date().toISOString(), tool: `bongle-editor@${BONGLE_VERSION}` },
        matchmaking: { maxPlayers: maxPlayers },
        config: opts.config,
    };
    // standalone has no server/index.js to reference or SRI; omit the entry.
    if (!standalone) {
        manifest.server = { entry: 'server/index.js', integrity: await sri(zip['server/index.js']) };
    }
    zip['bongle.json'] = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);

    progress('Zipping');
    return zipSync(zip);
}
