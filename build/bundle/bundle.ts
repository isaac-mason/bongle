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
// Bundled by shakeup — the same bundler the dev server runs, so dev and publish
// share one graph, one resolver and one set of semantics. shakeup is pure JS, so
// the browser editor and the node CLI run this identical code with no injected
// bundler and no host prep.
//
// The bundle is byte-shaped for the platform's ingest (client/index.js +
// server/index.js + bongle.json required). The server entry (PLAY_SERVER) wires
// the refactored EngineServer: node zstd, a node-fs loadResource rooted at the
// unpacked bundle, and scenes seeded from content/.

import { zipSync } from 'fflate';
import { bundle } from 'shakeup';
import { INTERFACE_VERSION } from '../../interface/index';
import type { Config } from '../../os/interface';
import { BONGLE_VERSION } from '../../src/build-info';
import { isStandalone, serverMaxPlayers } from '../../src/core/config';
import type { EnvValues } from '../env-replace';
import { type BuildFs, shakeupFs } from '../resolve';
import { createBonglePlugin } from './bongle-plugin';

type Target = 'client' | 'server';

/** virtual entry id (per build call — a fresh graph per target). */
const ENTRY_ID = '\0bongle:build-entry';

/** bumped when the bundle layout the platform expects changes. */
const BUNDLE_SCHEMA = 1;

function envFor(target: Target): EnvValues {
    return target === 'client'
        ? { client: true, server: false, editor: false, offline: false }
        : { client: false, server: true, editor: false, offline: false };
}

// ── play-* entries (the deployed client/server entry shims) ─────────────────
//
// Each default-exports the engine's own `bongle/interface` adapter after the user
// side-effect imports run. The env flags are literals after the env bake; the
// assignments stay for a reader and for a bundle run unbaked.

const PLAY_CLIENT = `
import { env } from 'bongle';
import { EngineClient, browserResourceLoader } from 'bongle/engine-client';
env.client = true; env.server = false; env.editor = false;
export default EngineClient.app({ resourceLoader: browserResourceLoader, domElement: document.body });
`;

const PLAY_SERVER = `
import { env } from 'bongle';
import { EngineServer } from 'bongle/engine-server';
// Host-neutral: no node imports. The host injects fs (project files: scenes under
// content/scenes/, model bins under resources/server/), zstd (native node:zlib or
// wasm), the driver (storage + avatars) and the outbound sink. Runs unchanged in a
// node process (deploy) or a browser worker (solo).
env.client = false; env.server = true; env.editor = false;
export default EngineServer.app('play');
`;

// Asset registrations reference their SOURCE files with `asset('./x', import.meta.url)`
// (a plain fn, not the `new URL(literal, import.meta.url)` the bundler treats as an
// emit-me asset), so nothing pulls the raw source file into the client — the model /
// sound / texture is served from the baked atlas/bin the pipeline produced, and the
// `asset()` href sits unused in the shipped registry. No stripping needed.

/** the per-target entry: side-effect-import every existing generated barrel +
 *  user src (registries populate), then the play-* adapter as default. */
async function entrySource(fs: BuildFs, target: Target): Promise<string> {
    const generated = (await fs.list('src/generated').catch(() => []))
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
function buildTargetPlugin(fs: BuildFs, target: Target, entry: string) {
    return createBonglePlugin(fs, {
        env: envFor(target),
        entry: { id: ENTRY_ID, code: entry },
        external: (source) => target === 'server' && source === 'sharp',
    });
}

// ── build a single target → { fileName: bytes } ─────────────────────────────

async function buildTarget(
    fs: BuildFs,
    target: Target,
    progress: (label: string) => void = () => {},
): Promise<Record<string, Uint8Array>> {
    const entry = await entrySource(fs, target);
    progress(`Bundling ${target}`);
    const r = await bundle({
        input: { index: ENTRY_ID },
        fs: shakeupFs(fs),
        plugins: [buildTargetPlugin(fs, target, entry)],
        external: (s) => s.startsWith('node:') || (target === 'server' && s === 'sharp'),
        // A prod bundle is production. Without this, npm packages that branch on
        // process.env.NODE_ENV (react/react-dom/scheduler pick their build that way)
        // fold nothing and ship BOTH copies -- and on the browser target the read
        // itself throws, since `process` does not exist there.
        define: { 'process.env.NODE_ENV': '"production"' },
        // server is host-neutral: it runs in a node process (deploy) AND a browser
        // worker (solo/editor), injecting node/browser capabilities per host.
        platform: target === 'server' ? 'neutral' : 'browser',
        // `neutral` deliberately empties mainFields (esbuild's rule), which makes a legacy
        // package carrying only `main` and no `exports` unresolvable — gpucat/packcat
        // are exactly that. Neutral stays right for CONDITIONS (this bundle runs in node AND
        // in a browser worker, so neither the node nor the browser condition applies); the
        // entry fields still want the ordinary ESM-then-legacy fallback.
        ...(target === 'server' ? { resolve: { mainFields: ['module', 'main'] } } : {}),
        output: {
            entryFileNames: 'index.js',
            chunkFileNames: 'assets/[name]-[hash].js',
            assetFileNames: 'assets/[name]-[hash][extname]',
            // the server must be one self-contained file: the solo host blob-imports
            // server/index.js, and a blob URL can't resolve relative ./assets chunks.
            // (Practically the server graph has no runtime dynamic imports, so this is a
            // guarantee, not a reshape.) Deploy is unaffected — node imports it from disk.
            inlineDynamicImports: target === 'server',
            minify: true,
        },
    });
    if (r.errors.length > 0) throw new Error(`[bongle] ${target} bundle failed:\n${r.errors.join('\n')}`);
    // An unresolved import is not cosmetic: shakeup externalizes it (rollup's rule), so the
    // bundle ships a bare specifier nothing can resolve and the game dies at load with
    // ERR_MODULE_NOT_FOUND. Only `errors` used to be read, so this shipped silently.
    const unresolved = r.warnings.filter((w) => w.includes('could not be resolved'));
    if (unresolved.length > 0) {
        throw new Error(`[bongle] ${target} bundle has unresolved imports:\n${unresolved.join('\n')}`);
    }
    for (const w of r.warnings) progress(`warning: ${w}`);

    const enc = new TextEncoder();
    const files: Record<string, Uint8Array> = {};
    for (const c of r.chunks) files[c.fileName] = enc.encode(c.code);
    for (const a of r.assets ?? []) {
        files[a.fileName] = typeof a.source === 'string' ? enc.encode(a.source) : (a.source as Uint8Array);
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
    for (const e of await fs.list(srcDir).catch(() => [])) {
        if (e.kind !== 'file') continue;
        const rel = e.path.slice(srcDir.length + 1);
        zip[`${dest}/${rel}`] = await fs.read(e.path);
    }
}

export type BuildOptions = {
    /** the project's launch config for the manifest, in the boundary shape
     *  (Config — the pipeline app / node bake reports it; the build can't
     *  evaluate user code to read the registry). Drives the `config` manifest
     *  key, the compat `matchmaking.maxPlayers`, and whether the server target
     *  is built at all (standalone omits it). */
    config: Config;
    /** phase label callback for the progress UI. */
    onProgress?: (label: string) => void;
};

/** build the whole bundle → zip bytes (client/ + server/ + bongle.json). */
export async function buildBundle(fs: BuildFs, opts: BuildOptions): Promise<Uint8Array> {
    const progress = opts.onProgress ?? (() => {});
    // a standalone game is client-only: no server bundle, no server resources,
    // no content copy, no manifest `server` entry (the "no double chunks" win).
    const standalone = isStandalone(opts.config);
    // `?worker` entries are bundled inline by the plugin's load hook now (shakeup is
    // reentrant), so there is no pre-pass — and no reason to serialize the targets.
    const [clientFiles, serverFiles] = await Promise.all([
        buildTarget(fs, 'client', progress),
        standalone ? Promise.resolve({} as Record<string, Uint8Array>) : buildTarget(fs, 'server', progress),
    ]);

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
