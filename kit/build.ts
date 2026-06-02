import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import tailwindcss from '@tailwindcss/vite';
import { build as viteBuild } from 'vite';
import { createPipelineState, type PipelineInternal, runAssetPipelinePass } from './asset-pipeline/pipeline';
import { resolveEngineRoot } from './asset-pipeline/run';
import { captureImportPlugin } from './capture-import-plugin';
import { envPlugin } from './env-plugin';
import { buildManifest } from './manifest';
import { checkContent } from './migrations';
import { ensureGeneratedStubs, resetGeneratedBarrels } from './user-entry';
import { virtualEntriesPlugin } from './vite/virtual-entries';

type Target = 'client' | 'server';

// Build entries are virtual modules served by the bongle:virtual-entries
// plugin (`virtual:bongle/build-{client,server}`). The virtual emits a
// static-import of the user's `src/generated` + `src/index` (so the capture
// registry populates before the play-{client,server} adapter's init() runs)
// then re-exports the adapter as default.
async function runBuild(projectDir: string, target: Target): Promise<void> {
    ensureGeneratedStubs(projectDir);
    const entry = `virtual:bongle/build-${target}`;
    const outDir = path.join(projectDir, 'dist', target);

    // Server: node builtins + native modules stay external. Everything
    // else inlines — engine, runtime, interface, user `generated/` and
    // `src/` — into a single self-contained `dist/<target>/index.js`,
    // so engine code and user code share one `bongle/*` instance.
    // TODO: `node:*` is also marked external on the client to silence
    // Rolldown's "Module ... has been externalized for browser
    // compatibility" warning. Root cause is api-layer modules (api/rooms,
    // api/chat, ...) statically importing their `../server/*` siblings;
    // those server modules pull in `node:fs` / `node:path` for content
    // manager etc. Branches are gated by `ctx.server` at runtime so the
    // imports are unreachable on the client, but the resolution graph
    // still includes them. Revisit if we want to stop bloating the client
    // bundle with dead server code (env-gated stub resolver, or split
    // api/server modules).
    const external: (string | RegExp)[] = [/^node:/];
    if (target === 'server') {
        external.push(/^sharp$/);
    }

    // Tailwind is client-only — it has nothing to do on the server and
    // would otherwise emit a stray CSS asset alongside `server/index.js`.
    const plugins = target === 'client'
        ? [virtualEntriesPlugin({ projectDir }), tailwindcss(), envPlugin({ client: true, server: false, editor: false, offline: false }), captureImportPlugin(projectDir)]
        : [virtualEntriesPlugin({ projectDir }), envPlugin({ client: false, server: true, editor: false, offline: false }), captureImportPlugin(projectDir)];

    // Vite's `lib` mode doesn't auto-replace `process.env.NODE_ENV` —
    // unlike its app-mode build — so React et al. ship their dev-only
    // branches (and bare `process.env.…` reads) into the bundle. The
    // client bundle is dynamic-imported into a sandboxed iframe with
    // no `process` global; the unsubstituted reads throw ReferenceError
    // at startup. Pin to "production" for both targets so the dead-code
    // branches drop out and no `process` reference survives in client
    // code.
    await viteBuild({
        root: projectDir,
        plugins,
        define: {
            'process.env.NODE_ENV': JSON.stringify('production'),
        },
        build: {
            lib: {
                // Vite 8 runs `path.resolve(root, lib.entry)` on the
                // string before handing it to Rolldown, mangling our
                // `virtual:bongle/...` id and breaking the plugin's
                // resolveId match. `rollupOptions.input` (below) takes
                // precedence and reaches Rolldown unmodified; `lib.entry`
                // is kept as a string only to satisfy Vite's internal
                // `resolveBuildOutputs` check.
                entry,
                formats: ['es'],
                // force `.js` (Vite would otherwise pick `.mjs` for `es`).
                // Bundle convention pins the entry at `<target>/index.js`.
                fileName: () => 'index.js',
            },
            outDir,
            emptyOutDir: true,
            copyPublicDir: target === 'client',
            rollupOptions: {
                input: entry,
                external,
                // Pin the side-effect-CSS asset filename to `index.css`
                // (Vite's default is `<package-name>.css`). The platform
                // manifest references it by name, so a stable filename
                // means the manifest doesn't need to encode build-time
                // choices.
                output: {
                    assetFileNames: (asset) =>
                        asset.names?.some((n) => n.endsWith('.css')) ? 'index.css' : 'assets/[name]-[hash][extname]',
                },
            },
        },
        resolve: {
            preserveSymlinks: false,
        },
        logLevel: 'warn',
    });
}

/**
 * Prod-build adapter for runAssetPipelinePass. Imports the user module
 * in-process (bun's native TS loader handles `.ts` directly) so its
 * declarative APIs upsert into the typed registries, then hands the
 * shared pipeline pass the same registries the dev plugin handler uses.
 *
 * Returns the matchmaking config seen during evaluation — used by the
 * caller to seed the bundle manifest.
 */
async function runAssetPipelineInProcess(opts: {
    projectDir: string;
    bongleDir: string;
    engineRoot: string;
}): Promise<{ matchmaking: { maxPlayers: number } }> {
    // Physics module's evaluation registers built-in physics resources;
    // historically imported first by the asset-pipeline subprocess entry,
    // preserve the ordering here.
    await import(path.join(opts.engineRoot, 'src/core/physics/physics.ts'));

    // Evaluate the user module — `block()`, `model()`, `matchmaking()`, …
    // upsert into the typed registries in bongle/internal. Imports the
    // user source directly off disk; no generated wrapper file.
    await import(path.join(opts.projectDir, 'src', 'generated', 'index.ts'));
    await import(path.join(opts.projectDir, 'src', 'index.ts'));

    const internal = (await import('bongle/internal')) as unknown as PipelineInternal;
    const state = createPipelineState();
    await runAssetPipelinePass(internal, { projectDir: opts.projectDir, mode: 'play', cache: false }, state);
    return { matchmaking: state.matchmakingConfig ?? { maxPlayers: 10 } };
}

/** Read a package's resolved version from its `package.json`. Resolved
 *  relative to this source file so it works regardless of how the
 *  consuming project invokes us.  */
function readPackageVersion(pkgPath: string): string {
    const require = createRequire(import.meta.url);
    const pkg = require(pkgPath) as { version?: string };
    return pkg.version ?? '0.0.0';
}

/** Zip the bundle tree under `distDir` into `outFile`. Adds `client/`,
 *  `server/`, and `bongle.json` explicitly so the zip never includes
 *  itself (it lives at `distDir/bundle.zip`). */
function zipBundle(distDir: string, outFile: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(outFile);
        const archive = archiver('zip', { zlib: { level: 9 } });
        out.on('close', () => resolve());
        out.on('error', reject);
        archive.on('error', reject);
        archive.pipe(out);
        archive.directory(path.join(distDir, 'client'), 'client');
        archive.directory(path.join(distDir, 'server'), 'server');
        archive.file(path.join(distDir, 'bongle.json'), { name: 'bongle.json' });
        archive.finalize();
    });
}

export async function build(projectDir: string) {
    const resolvedProjectDir = path.resolve(projectDir);

    if (!fs.existsSync(resolvedProjectDir)) {
        console.error(`Project directory does not exist: ${resolvedProjectDir}`);
        process.exit(1);
    }

    const bongleDir = path.join(resolvedProjectDir, '.bongle');
    fs.mkdirSync(bongleDir, { recursive: true });

    // Refuse to build if any content file is behind the latest schema.
    // Migration is an explicit user action via `bongle migrate`; the
    // runtime in lib/src/* assumes content is at latest.
    const behind = checkContent(resolvedProjectDir);
    if (behind.length > 0) {
        console.error(`[bongle] content out of date (${behind.length} file(s)):`);
        for (const m of behind) {
            console.error(`  ${path.relative(resolvedProjectDir, m.file)}: v${m.from} → v${m.to}`);
        }
        console.error('run `bongle migrate` to update.');
        process.exit(1);
    }

    console.log(`[bongle] building ${resolvedProjectDir}`);

    const start = performance.now();

    // Asset pipeline runs in-process before the final bundle. Bun's native
    // TS loader evaluates the user's src/generated + src/index directly;
    // `block()`/`model()`/`matchmaking()` calls upsert into the typed
    // registries exposed via `bongle/internal`. We then read those
    // registries directly to build the partial ProjectModule view atlas
    // + models need. Same shape as the bongle:pipeline plugin handler
    // the dev server runs (kit/vite/plugin.ts), minus the env-runner —
    // we're already in the same process as the registries here.
    const engineRoot = resolveEngineRoot(resolvedProjectDir);
    ensureGeneratedStubs(resolvedProjectDir);
    // Same chicken-and-egg as dev: a stale sub-barrel from a previous
    // run could reference a removed kit api and fail the import before
    // the pipeline gets a chance to regenerate it.
    resetGeneratedBarrels(resolvedProjectDir);

    console.log('[bongle] running asset pipeline...');
    const { matchmaking } = await runAssetPipelineInProcess({
        projectDir: resolvedProjectDir,
        bongleDir,
        engineRoot,
    });

    console.log('[bongle] bundling...');
    await Promise.all([runBuild(resolvedProjectDir, 'client'), runBuild(resolvedProjectDir, 'server')]);

    // Three-way artifact split, all resolved next to the bundle entries
    // via `import.meta.url` at runtime (no cwd dependency):
    //   content/         (authored data — scenes today) → dist/server/content/
    //   resources/server (generated server bins)        → dist/server/resources/
    //   resources/client (generated client assets)      → dist/client/
    const projectContentDir = path.join(resolvedProjectDir, 'content');
    const projectResourcesServerDir = path.join(resolvedProjectDir, 'resources', 'server');
    const projectResourcesClientDir = path.join(resolvedProjectDir, 'resources', 'client');
    const distDir = path.join(resolvedProjectDir, 'dist');
    if (fs.existsSync(projectContentDir)) {
        fs.cpSync(projectContentDir, path.join(distDir, 'server', 'content'), { recursive: true });
    }
    if (fs.existsSync(projectResourcesServerDir)) {
        fs.cpSync(projectResourcesServerDir, path.join(distDir, 'server', 'resources'), { recursive: true });
    }
    if (fs.existsSync(projectResourcesClientDir)) {
        fs.cpSync(projectResourcesClientDir, path.join(distDir, 'client'), { recursive: true });
    }

    // Full bundle manifest — written AFTER both targets emit so we can
    // hash the final entry files. game-room reads this at boot (entries
    // + integrity verify). Bundle is identity-free; deploy-time tooling
    // supplies the destination game.
    // Vite emits `client/index.css` only when the bundle pulled in any
    // CSS — pass through to the manifest builder so it can record the
    // sibling. Server has no CSS path; client may not either.
    const clientStylesPath = path.join(distDir, 'client', 'index.css');

    // matchmaking is observed during runAssetPipelineInProcess above
    // (the only step that imports user code, and so can see a
    // matchmaking() call). Defaults to DEFAULT_MATCHMAKING_CONFIG when
    // the user didn't declare one. Threaded through the call's return value.
    const manifest = buildManifest({
        clientEntry: path.join(distDir, 'client', 'index.js'),
        clientStyles: fs.existsSync(clientStylesPath) ? clientStylesPath : undefined,
        serverEntry: path.join(distDir, 'server', 'index.js'),
        bongleVersion: readPackageVersion('bongle/package.json'),
        interfaceVersion: "0.0.1",
        matchmaking,
    });
    fs.writeFileSync(path.join(distDir, 'bongle.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    // Bundle the dist/ tree into a single zip the platform CLI can upload.
    const bundleZip = path.join(distDir, 'bundle.zip');
    if (fs.existsSync(bundleZip)) fs.unlinkSync(bundleZip);
    await zipBundle(distDir, bundleZip);

    const elapsed = (performance.now() - start).toFixed(0);
    console.log(`[bongle] build complete in ${elapsed}ms`);
    console.log(`[bongle]   dist/bongle.json`);
    console.log(`[bongle]   dist/client/index.js`);
    console.log(`[bongle]   dist/server/index.js`);
    if (fs.existsSync(projectContentDir)) console.log(`[bongle]   dist/server/content/`);
    if (fs.existsSync(projectResourcesServerDir)) console.log(`[bongle]   dist/server/resources/`);
    console.log(`[bongle]   dist/bundle.zip`);
}
