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

import { type Plugin, rolldown } from '@rolldown/browser';
import { zipSync } from 'fflate';
import { INTERFACE_VERSION } from '../../interface/index';
import { type EnvValues, replaceEnv } from '../../plugin';
import { ensureProcessShim } from '../bundler/runner';
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

// `new URL('./x.{ogg,glb,…}', import.meta.url)` for already-baked binary assets:
// in a bundle these inline as base64 (~1.5MB of starter audio/models alone),
// though the runtime only ever loads them from the atlases/bins. Strip to "" —
// sound()/model() ignore an empty src, keeping registration intact (mirrors
// kit's stripBinaryAssetUrlsPlugin). Client only; server has no asset URLs.
const BINARY_URL = /new URL\(['"][^'"]*\.(ogg|mp3|wav|flac|glb|gltf)['"]\s*,\s*import\.meta\.url\)/g;

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

// ── vfs resolution (rolldown reads the project + seeded engine dist from OPFS) ─

function posixJoin(dir: string, rel: string): string {
    const out: string[] = [];
    for (const p of `${dir}/${rel}`.split('/')) {
        if (p === '' || p === '.') continue;
        if (p === '..') out.pop();
        else out.push(p);
    }
    return out.join('/');
}

async function withExt(fs: Filesystem, id: string): Promise<string> {
    for (const cand of [id, `${id}.ts`, `${id}.tsx`, `${id}.js`, `${id}/index.ts`, `${id}/index.js`]) {
        if (await fs.exists(cand)) return cand;
    }
    return id; // let load() throw a clear "missing" error
}

type PkgJson = { main?: string; module?: string; exports?: unknown };

/** resolve a bare specifier to a seeded node_modules package via package.json. */
async function resolvePackage(fs: Filesystem, spec: string): Promise<string | null> {
    const scoped = spec.startsWith('@');
    const parts = spec.split('/');
    const pkg = scoped ? `${parts[0]}/${parts[1]}` : parts[0];
    const subParts = scoped ? parts.slice(2) : parts.slice(1);
    const sub = subParts.length ? `./${subParts.join('/')}` : '.';
    let json: PkgJson;
    try {
        json = JSON.parse(await fs.readText(`node_modules/${pkg}/package.json`)) as PkgJson;
    } catch {
        return null;
    }
    const pick = (cond: unknown): string | null => {
        if (typeof cond === 'string') return cond;
        if (cond && typeof cond === 'object') {
            const c = cond as Record<string, unknown>;
            return (c.import ?? c.default ?? c.module ?? c.require ?? null) as string | null;
        }
        return null;
    };
    let target: string | null = null;
    if (json.exports && typeof json.exports === 'object') {
        const map = json.exports as Record<string, unknown>;
        const entry = sub in map ? map[sub] : sub === '.' ? map : undefined;
        target = entry === undefined ? null : pick(entry);
    } else if (typeof json.exports === 'string') {
        target = sub === '.' ? json.exports : null;
    } else if (sub === '.') {
        target = json.module ?? json.main ?? './index.js';
    } else {
        target = sub;
    }
    if (!target) return null;
    return withExt(fs, `node_modules/${pkg}/${target.replace(/^\.\//, '')}`);
}

/** map a specifier to a vfs module id, or null (→ rolldown default / error). */
async function resolveVfs(fs: Filesystem, source: string, importer: string | undefined): Promise<string | null> {
    if (source === 'bongle' || source.startsWith('bongle/')) {
        const sub = source === 'bongle' ? 'index' : source.slice('bongle/'.length);
        return withExt(fs, `node_modules/bongle/dist/${sub}`);
    }
    if (source.startsWith('.')) {
        const base = importer ? importer.replace(/[?#].*$/, '') : '';
        const dir = base.slice(0, base.lastIndexOf('/'));
        return withExt(fs, posixJoin(dir, source));
    }
    // root-absolute id (the entry's `/src/...` imports, or a resolved id echoed back)
    if (source.startsWith('/')) return withExt(fs, source.replace(/^\/+/, ''));
    // bare: a seeded first-party package (mathcat/…), else treat as vfs-root path
    const pkg = await resolvePackage(fs, source);
    if (pkg) return pkg;
    return withExt(fs, source);
}

function vfsPlugin(fs: Filesystem, target: Target, entry: string): Plugin {
    const env = envFor(target);
    return {
        name: 'bongle:vfs-build',
        async resolveId(source, importer) {
            if (source === ENTRY_ID) return ENTRY_ID;
            if (source.startsWith('node:')) return { id: source, external: true };
            if (target === 'server' && source === 'sharp') return { id: source, external: true };
            return await resolveVfs(fs, source, importer);
        },
        async load(id) {
            if (id === ENTRY_ID) return { code: entry, moduleType: 'js' };
            return await fs.readText(id);
        },
        transform(code, id) {
            if (id === ENTRY_ID) return null;
            let out = replaceEnv(code, env);
            if (target === 'client') out = out.replace(BINARY_URL, '""');
            // user src (incl. generated barrels) needs `__kit` as a free var — the
            // barrels call __kit.registerScene/… (mirrors kit's capture-import).
            if (id.startsWith('src/') && /\.tsx?$/.test(id)) out = `import { __kit } from 'bongle/internal';\n${out}`;
            return out === code ? null : out;
        },
    };
}

// ── build a single target → { fileName: bytes } ─────────────────────────────

async function buildTarget(fs: Filesystem, target: Target): Promise<Record<string, Uint8Array>> {
    ensureProcessShim(); // @rolldown/browser reads `process` in bindingifyInputOptions
    const entry = await entrySource(fs, target);
    const bundle = await rolldown({
        input: { index: ENTRY_ID },
        plugins: [vfsPlugin(fs, target, entry)],
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
    progress('Bundling client + server');
    const [clientFiles, serverFiles] = await Promise.all([buildTarget(fs, 'client'), buildTarget(fs, 'server')]);

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
