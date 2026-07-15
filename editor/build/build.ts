// editor/build/build.ts — the in-browser PROD build (Option A).
//
// Mirrors what `lib/kit/build.ts` produced, but runs entirely in the browser via
// @rolldown/browser's bundler (its wasm lives in a library-managed worker, so
// this orchestrates on the main thread). Two env-DCE'd bundles over a per-target
// entry (the existing generated barrels + src/index + a kit-shape play-* adapter)
// → client/index.js + server/index.js; baked resources copied in; a bongle.json
// manifest (schema 1, sha384 SRI, matchmaking) written; the tree zipped.
//
// The bundle is byte-shaped for the platform's ingest (client/index.js +
// server/index.js + bongle.json required). The server bundle isn't yet
// runtime-wired to the refactored EngineServer (deferred play-infra touch) — it
// builds with kit's play-server shape, enough to prove + persist the artifact.

import { rolldown } from '@rolldown/browser';
import { zipSync } from 'fflate';
import { INTERFACE_VERSION } from '../../interface/index';
import type { EnvValues } from '../../plugin';
import { ensureProcessShim } from '../bundler/runner';
import { bundleWorkers, createVfsPlugin } from '../bundler/vfs-plugin';
import type { Filesystem } from '../fs';

type Target = 'client' | 'server';

/** virtual entry id (per build call — a fresh rolldown graph per target). */
const ENTRY_ID = '\0bongle:build-entry';

/** bumped when the bundle layout the platform expects changes (mirrors kit). */
const BUNDLE_SCHEMA = 1;

function envFor(target: Target): EnvValues {
    return target === 'client'
        ? { client: true, server: false, editor: false, offline: false }
        : { client: false, server: true, editor: false, offline: false };
}

// ── kit-shape play-* adapters (editor-owned; kit is being retired) ──────────
//
// Same shape kit's runtime/play-{client,server}.ts emit: a `bongle/interface`
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
    load: async (state) => { EngineClient.mountPlayUI(state.domElement); await EngineClient.load(state); },
    update: (state, dt) => EngineClient.update(state, dt),
    dispose: (state) => EngineClient.dispose(state),
    getInbox: (state) => state.net.inbox,
    getOutbox: (state) => state.net.outbox,
    clearOutbox: (state) => { state.net.outbox.length = 0; },
});
`;

const PLAY_SERVER = `
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { env } from 'bongle';
import { server } from 'bongle/interface';
import { EngineServer } from 'bongle/engine-server';
const here = path.dirname(fileURLToPath(import.meta.url));
export default server({
    init: (opts) => {
        env.client = false; env.server = true; env.editor = false;
        return EngineServer.init({ mode: 'play', contentDir: path.join(here, 'content'), resourcesDir: path.join(here, 'resources'), options: opts.options, driver: opts.driver });
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

// `new URL('./x.{ogg,png,glb,…}', import.meta.url)` for already-baked binary
// assets: in a bundle these inline as base64 (~1.5MB of starter audio/models
// alone), though the runtime only ever loads them from the atlases/bins. Strip
// to "" — sound()/model()/texture registration ignore an empty src (mirrors
// kit's stripBinaryAssetUrlsPlugin). bongle now ships SOURCE, so these live in
// the graph (they were resolved to dist/assets at prebundle before). Client
// only; server has no asset URLs.
const BINARY_URL = /new URL\(['"][^'"]*\.(ogg|mp3|wav|flac|glb|gltf|png|jpe?g|webp)['"]\s*,\s*import\.meta\.url\)/g;

/** the per-target entry: side-effect-import every existing generated barrel +
 *  user src (registries populate), then the play-* adapter as default. */
async function entrySource(fs: Filesystem, target: Target): Promise<string> {
    const generated = (await fs.list('src/generated', { recursive: true }).catch(() => []))
        .filter((e) => e.kind === 'file' && e.path.endsWith('.ts'))
        .map((e) => e.path)
        .sort();
    const imports = [...generated, 'src/index.ts'].map((p) => `import ${JSON.stringify(`/${p}`)};`).join('\n');
    return `${imports}\n${target === 'client' ? PLAY_CLIENT : PLAY_SERVER}`;
}

// vfs resolution + load + env-bake is the shared createVfsPlugin (vfs-plugin.ts,
// resolve.ts-backed). build.ts only supplies the per-target specifics: the
// virtual play entry, the sharp external (server), and the build-time transforms
// (asset-URL strip on the client + __kit injection for user src barrels).
function buildVfsPlugin(fs: Filesystem, target: Target, entry: string, workers: Map<string, string>) {
    return createVfsPlugin(fs, {
        env: envFor(target),
        entry: { id: ENTRY_ID, code: entry },
        external: (source) => target === 'server' && source === 'sharp',
        workers,
        transformExtra: (code, id) => {
            let out = target === 'client' ? code.replace(BINARY_URL, '""') : code;
            // user src (incl. generated barrels) needs `__kit` as a free var — the
            // barrels call __kit.registerScene/… (mirrors kit's capture-import).
            if (id.startsWith('src/') && /\.tsx?$/.test(id)) out = `import { __kit } from 'bongle/internal';\n${out}`;
            return out;
        },
    });
}

// ── build a single target → { fileName: bytes } ─────────────────────────────

async function buildTarget(fs: Filesystem, target: Target, workers: Map<string, string>): Promise<Record<string, Uint8Array>> {
    ensureProcessShim(); // @rolldown/browser reads `process` in bindingifyInputOptions
    const entry = await entrySource(fs, target);
    const bundle = await rolldown({
        input: { index: ENTRY_ID },
        plugins: [buildVfsPlugin(fs, target, entry, workers)],
        external: [/^node:/, ...(target === 'server' ? [/^sharp$/] : [])],
        // NODE_ENV is already build-defined into the prebundled engine dist (where
        // React lives); user + play-shell code don't read process.env, so no define.
        platform: target === 'server' ? 'node' : 'browser',
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
        minify: true,
    });
    await bundle.close();

    const enc = new TextEncoder();
    const files: Record<string, Uint8Array> = {};
    for (const o of output) {
        files[o.fileName] = o.type === 'chunk' ? enc.encode(o.code) : typeof o.source === 'string' ? enc.encode(o.source) : o.source;
    }
    return files;
}

// ── manifest (sha384 SRI, mirrors kit/manifest.ts) ──────────────────────────

async function sri(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-384', bytes as unknown as BufferSource));
    let bin = '';
    for (const b of digest) bin += String.fromCharCode(b);
    return `sha384-${btoa(bin)}`;
}

async function bongleVersion(fs: Filesystem): Promise<string> {
    try {
        const pkg = JSON.parse(await fs.readText('node_modules/bongle/package.json')) as { version?: string };
        return pkg.version ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

/** copy an OPFS subtree into the zip map under `dest/`, stripping `srcDir/`. */
async function copyTree(fs: Filesystem, srcDir: string, zip: Record<string, Uint8Array>, dest: string): Promise<void> {
    for (const e of await fs.list(srcDir, { recursive: true }).catch(() => [])) {
        if (e.kind !== 'file') continue;
        const rel = e.path.slice(srcDir.length + 1);
        zip[`${dest}/${rel}`] = await fs.read(e.path);
    }
}

export type BuildOptions = {
    /** matchmaking.maxPlayers for the manifest. The build can't evaluate user
     *  code to read the registry, so the caller supplies it (the pipeline realm
     *  reports it — see stores/build-meta). */
    maxPlayers: number;
    /** phase label callback for the progress UI. */
    onProgress?: (label: string) => void;
};

/** build the whole bundle → zip bytes (client/ + server/ + bongle.json). */
export async function buildBundle(fs: Filesystem, opts: BuildOptions): Promise<Uint8Array> {
    const progress = opts.onProgress ?? (() => {});
    // workers first: `?worker` entries (mesh worker) bundle standalone BEFORE the
    // main build — a nested @rolldown/browser build from inside a plugin hook
    // deadlocks on main-thread Atomics.wait. They're client-side compute.
    progress('Bundling workers');
    const workers = await bundleWorkers(fs, envFor('client'));
    progress('Bundling client + server');
    const [clientFiles, serverFiles] = await Promise.all([buildTarget(fs, 'client', workers), buildTarget(fs, 'server', workers)]);

    const zip: Record<string, Uint8Array> = {};
    for (const [name, bytes] of Object.entries(clientFiles)) zip[`client/${name}`] = bytes;
    for (const [name, bytes] of Object.entries(serverFiles)) zip[`server/${name}`] = bytes;

    // engine UI css was extracted at prebundle time (dist/bongle.css) rather than
    // re-emitted by this bundle, so ship it as client/index.css for the deployed
    // client's styled UI (mirrors kit's client/index.css).
    let clientCss: Uint8Array | undefined;
    try {
        clientCss = await fs.read('node_modules/bongle/dist/bongle.css');
        zip['client/index.css'] = clientCss;
    } catch {
        /* no engine css seeded */
    }

    // baked outputs (the pipeline already produced these) + authored content +
    // the project's static public/ dir (kit's copyPublicDir → client root).
    progress('Copying baked resources');
    await copyTree(fs, 'resources/client', zip, 'client');
    await copyTree(fs, 'resources/server', zip, 'server/resources');
    await copyTree(fs, 'content', zip, 'server/content');
    await copyTree(fs, 'public', zip, 'client');

    progress('Writing manifest');
    const version = await bongleVersion(fs);
    const client: Record<string, unknown> = { entry: 'client/index.js', integrity: await sri(zip['client/index.js']) };
    if (clientCss) client.styles = { entry: 'client/index.css', integrity: await sri(clientCss) };
    const manifest = {
        schema: BUNDLE_SCHEMA,
        engine: { bongle: version, interface: INTERFACE_VERSION },
        client,
        server: { entry: 'server/index.js', integrity: await sri(zip['server/index.js']) },
        assets: { publicDir: 'public' },
        build: { id: crypto.randomUUID(), createdAt: new Date().toISOString(), tool: `bongle-editor@${version}` },
        matchmaking: { maxPlayers: opts.maxPlayers },
    };
    zip['bongle.json'] = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);

    progress('Zipping');
    return zipSync(zip);
}

/** build + trigger a browser download of bundle.zip. Returns the zip size in bytes. */
export async function downloadBundle(fs: Filesystem, opts: BuildOptions): Promise<number> {
    const zip = await buildBundle(fs, opts);
    const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bundle.zip';
    a.click();
    URL.revokeObjectURL(url);
    return zip.length;
}
