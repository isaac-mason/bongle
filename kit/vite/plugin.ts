/**
 * bongle() Vite plugin — the runtime side of granular engine HMR.
 *
 * HMR escalation ladder
 * ---------------------
 * A user-module edit climbs these rungs only as far as needed; the design
 * goal is for everything to land at rung 3 — `[vite] full reload` never
 * fires for the main client in normal operation (see plan in
 * `lib/poc-vite-server-hmr/PLAN.md`).
 *
 *   1. **Module patch.** The user file re-evaluates. Declarative APIs
 *      (`block()`, `trait()`, `model()`, …) re-`upsert` into the typed
 *      registries; `__kit.reload` decides `patch`; the self-accept
 *      callback (see concern 1 below) falls through. No cascade.
 *
 *   2. **Importer cascade.** Shape changed — a trait/script registration
 *      was added, removed, or its slot layout moved. The accept callback
 *      calls `hot.invalidate()`; Vite walks one hop up to importers; each
 *      importer re-evaluates and self-decides locally with the same diff.
 *      Cascade terminates when every importer in the chain decides patch.
 *
 *   3. **Registry dispatch.** Once the cascade settles, `__kit.flush()`'s
 *      microtask drains each env's registered handler — engine dispatch
 *      on the client, engine dispatch + asset pipeline on the server.
 *      `applyRegistryChanges*` (engine/src/{client,server}/registry-dispatch.ts)
 *      walks each registry's `pendingChanges` and reacts wholesale per
 *      branch. The most invasive branches:
 *        - **traits** → `applyTraitSwap` rebuilds every script instance
 *          on every node in every room; `onSwap` preserves opt-in state.
 *        - **blockTextures** that change the atlas → per-room
 *          `VoxelVisuals` + `VoxelMeshVisuals` dispose + re-init, all
 *          chunks remesh; engine-global `VoxelResources` rebuilds.
 *        - **scenes** → `populateScene` rebuilds the scene graph in place;
 *          `SceneHandle` identity is preserved so user closures stay valid.
 *        - **prefabs** → `markPrefabAnchorsDirty` only in edit rooms; play
 *          rooms preserve live instances across the edit.
 *      Rooms, connections, GPU device, and play-mode state survive rung 3.
 *
 *   4. **Pipeline (re-)render.** `AssetPipeline.run` (concern 4) boots its
 *      render engine once (lazily, on the first icon render) and re-renders
 *      only the icons whose hashes moved. Atlas-bytes changes do NOT re-boot
 *      it: `applyRegistryChanges` re-reads the atlas in place
 *      (`VoxelResources.refresh`), same as the live client. The main client
 *      never boots an engine here.
 *
 * Four concerns, one plugin factory:
 *
 *  1. **Capture transform.** Every user-src `.ts`/`.tsx` gets a top-of-file
 *     `__kit.push(import.meta.url)` and bottom-of-file `__kit.pop(prev)`
 *     injected (`__kit` is imported from `bongle/internal`). While the
 *     module body evaluates, `owningModule()` returns its url so
 *     `upsert()` calls in declarative APIs (`block()`, `trait()`, …) can
 *     stamp each handle with its owning module. Bottom-of-file
 *     `import.meta.hot.accept(cb)` consults `__kit.reload` and calls
 *     `hot.invalidate()` when shape changed — cascading to importers,
 *     each of which self-decides locally. This self-accept IS the HMR
 *     boundary: Vite's default walk on src/ changes terminates here
 *     instead of falling back to fullReload. The accept callback also
 *     calls `__kit.flush()`, scheduling a microtask drain that runs each
 *     env's registered flush handler (engine dispatch on the client; engine
 *     dispatch + asset pipeline on the server).
 *
 *     No try/finally — Vite-preserved top-level exports must stay
 *     statement-position. `__kit.pop` is unconditional after the user
 *     body; a throw on the way down skips it but the next push for the
 *     same id rotates the snapshot, so the stack self-heals.
 *
 *  2. **Serve `resources/client/*`.** Atlas, icons, model bins live there
 *     and the asset pipeline rewrites them at dev-time. Vite's `publicDir`
 *     snapshots at startup, so post-startup writes never serve. We mount
 *     a live FS-read middleware at the URL root. Watching is suppressed
 *     in dev.ts's `server.watch.ignored`.
 *
 *  3. **Scene content transport.** Watches `<projectDir>/content/scenes/`
 *     and fans `bongle:scene-update` / `bongle:scene-clear` HMR events to
 *     both `client` and `server` envs when a `.scene.json` file
 *     changes on disk. Both runtimes route the payload through their own
 *     `Content.populateScene`. File watching lives in one place (the
 *     plugin), both sides react symmetrically, and the wire protocol
 *     carries the raw scene file as a single string. A `GET
 *     /__bongle/scene/:id` endpoint covers cold-cache initial reads from
 *     the client's registry-dispatch when a new `scene()` declaration
 *     appears mid-session before the watcher has emitted for that id.
 *
 *     Two gates sit in front of the fan-out, both inside `fire()`:
 *       - **channel membership** — only `scene()`-declared ids (live read
 *         off the server env's `registry.scenes`) and `blueprints/*`
 *         ids ride `bongle:scene-update`/`bongle:scene-clear`. Undeclared
 *         `.scene.json` files still surface in `bongle:scene-list` for the
 *         editor inventory, but no `applyScenePayload` runs for them on
 *         the editor or server side.
 *       - **content-diff** — `fs.watch` fires for non-content events
 *         (atime updates, atomic-rename two-step saves); the plugin
 *         remembers the last-sent bytes per id and skips the wire when
 *         the file's content is unchanged. Without this the engine
 *         re-`populateScene`s its own already-current state on every
 *         spurious watcher wake.
 *
 *     The asset pipeline runs out-of-band: scene-icon rendering needs
 *     every authored scene including undeclared ones, but flooding the
 *     editor channel with big undeclared-scene payloads on each edit
 *     causes jank. Instead `AssetPipeline.run` walks `content/scenes/**`
 *     itself, diffs against its applied set, and applies scene payloads to
 *     its own render engine directly. `fire()` here just calls a wake hook
 *     the pipeline plugin installed; no HMR channel for undeclared scenes.
 *
 *  4. **Asset pipeline.** The one `AssetPipeline` (the engine, behind
 *     `engine-asset-pipeline`) runs inside the server runner — the same graph
 *     as EngineServer, sharing the registries. This plugin is its dev driver:
 *     it `init`s it once, registers a flush handler that `run`s it on each
 *     settled HMR cascade (under a coalescing lock), and also `run`s it when
 *     the scene/asset watchers fire. `run` bakes (atlas + models + scenes +
 *     audio + sprites; matchmaking config returned for `build.ts`) then renders
 *     the dirty icons — all revision/hash-gated — and writes sharp-encoded PNGs
 *     onto `resources/client/` directly. We piggyback on the server graph (not
 *     a third env) because its registries already hold every declarative entry
 *     the pipeline reads.
 *
 *     The plugin forwards each `RunResult` to the live client:
 *     `bongle:block-texture-atlas-updated` / `bongle:sprite-atlas-updated`
 *     (→ in-place `refreshBlockResources` / `SpriteResources.refresh`, no
 *     reboot) and `bongle:icons-ready` per written icon (→ editor re-fetches
 *     the thumbnail).
 */

import fs from 'node:fs';
import path from 'node:path';
import MagicString from 'magic-string';
import type { Plugin, RunnableDevEnvironment } from 'vite';
import { buildSymbolTable, type SymbolTable } from './dep-ast';
import { extractConsumerDeps, resolveLocalName, type SymbolTableRegistry } from './dep-resolve';
import { virtualEntriesPlugin } from './virtual-entries';

let resolveIconsRendered: () => void = () => {};
/** Resolves once the pipeline has finished its first full run on cold start —
 *  every block/scene/prefab icon is on disk and the render engine is warm.
 *  The dev CLI awaits this before the
 *  ready banner so "started!" reflects the whole pipeline, not just the dev
 *  server being up. Resolved (never rejected) even on a launch/render fault,
 *  so a pipeline failure can't wedge the banner. One-shot per process. */
export const iconsRendered: Promise<void> = new Promise((resolve) => {
    resolveIconsRendered = resolve;
});

export interface BongleOptions {
    /** absolute path to the project root (the dir containing `src/`, `resources/`). */
    projectDir: string;
}

export function bongle(opts: BongleOptions): Plugin[] {
    const projectDir = path.resolve(opts.projectDir);
    const userSrcDir = path.join(projectDir, 'src') + path.sep;
    const resourcesDir = path.join(projectDir, 'resources', 'client');

    // Per-module symbol table, keyed by Rollup's normalised module id
    // (query string stripped). The capture transform populates this on
    // every transform; the cross-module resolver walks re-export chains
    // across it; the consumer-call wrap reads from it to find producer
    // refs in `prefab()`/`script()` bodies. Stale entries on rename or
    // delete linger until the next dev-session restart.
    const symbolTables: SymbolTableRegistry = new Map<string, SymbolTable>();

    // Cross-plugin wake hook: the scene watcher calls this on any
    // .scene.json change; the pipeline plugin assigns it once the pipeline is
    // inited. Default no-op so early scene events before that are dropped
    // silently — the pipeline's first run walks the corpus from disk anyway.
    let notifyPipelineOfSceneChange: () => void = () => {};

    return [
        virtualEntriesPlugin({ projectDir }),
        {
            name: 'bongle:capture-transform',
            async transform(code, id) {
                // strip query string (vite appends ?v=N, ?t=, etc.)
                const filePath = id.split('?')[0]!;
                if (!filePath.startsWith(userSrcDir)) return null;
                if (!/\.tsx?$/.test(filePath)) return null;

                // Parse the user module and build its symbol table; the
                // table feeds both the cross-module resolver (re-export
                // chains in dep-resolve.ts) and the consumer-call wrap
                // below. Failures swallowed: a parse error in user code
                // mustn't break the capture transform.
                try {
                    const ast = this.parse(code) as unknown as import('estree').Program;
                    const table = buildSymbolTable(ast, filePath);

                    // Pre-resolve every import/re-export source spec to a
                    // normalised module id so the cross-module resolver
                    // never has to call `this.resolve()` itself. Unresolved
                    // specs (externals, missing files) drop silently — the
                    // resolver treats absent entries as opaque dead-ends,
                    // which is the right behaviour for `'bongle'` and for
                    // any genuinely broken import.
                    const specs = new Set<string>();
                    for (const binding of table.bindings.values()) {
                        if (
                            binding.kind === 'import-named' ||
                            binding.kind === 'import-default' ||
                            binding.kind === 'import-namespace'
                        ) {
                            specs.add(binding.source);
                        }
                    }
                    for (const exp of table.exports.values()) {
                        if (exp.kind === 'reexport-named' || exp.kind === 'reexport-namespace') {
                            specs.add(exp.source);
                        }
                    }
                    for (const spec of table.starReexports) specs.add(spec);
                    await Promise.all(
                        [...specs].map(async (spec) => {
                            try {
                                const resolved = await this.resolve(spec, id);
                                if (resolved?.id) {
                                    table.resolvedSources.set(spec, resolved.id.split('?')[0]!);
                                }
                            } catch {
                                // unresolved → leave absent; resolver treats as opaque
                            }
                        }),
                    );

                    symbolTables.set(filePath, table);

                    // Inject `__kit.deps(...)` around eligible
                    // `prefab()`/`script()` calls; see `wrapConsumerCalls`.
                    const rewritten = wrapConsumerCalls(code, table, symbolTables);
                    if (rewritten !== null) code = rewritten;

                    if (process.env.BONGLE_DEPGRAPH_AST_DEBUG && table.consumers.length > 0) {
                        const fmtDeps = (deps: Array<{ dep: { registry: string; id: string } }>) =>
                            deps.length ? deps.map((d) => `${d.dep.registry}:${d.dep.id}`).join('+') : '∅';
                        const summary = table.consumers
                            .map((c) => {
                                if (c.kind === 'prefab') {
                                    const deps = c.fnNode ? extractConsumerDeps(c.fnNode, table, symbolTables) : [];
                                    return `prefab:${c.id}=[${fmtDeps(deps)}]`;
                                }
                                const trait = resolveLocalName(table, c.traitLocalName, symbolTables);
                                const traitStr = trait ? `${trait.registry}:${trait.id}` : '?';
                                const deps = c.factoryNode ? extractConsumerDeps(c.factoryNode, table, symbolTables) : [];
                                return `script:${c.traitLocalName}@${traitStr}=[${fmtDeps(deps)}]`;
                            })
                            .join(', ');
                        console.log(`[depgraph-ast] ${path.relative(projectDir, filePath)} — ${summary}`);
                    }
                } catch (err) {
                    console.warn(
                        `[depgraph-ast] parse failed for ${path.relative(projectDir, filePath)}:`,
                        (err as Error).message,
                    );
                }

                // imports must stay at top of module; declare the prev-slot
                // and run the push before any user statement so `upsert()`
                // calls inside the body see the correct owningModule().
                const prelude = /* ts */ `import { __kit } from 'bongle/internal';
const __kit_prev = __kit.push(import.meta.url);
`;

                // self-accept: re-evaluating this module records a fresh
                // snapshot via the new __kit.push; the cb then asks the
                // engine whether shape changed. on 'invalidate', Vite
                // cascades to importers (each is also self-accepting and
                // makes its own decision). either way, __kit.flush()
                // schedules a microtask-debounced drain — a cascade of
                // accepts coalesces to one applyRegistryChanges call.
                const postlude = /* ts */ `
;__kit.pop(__kit_prev);
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    if (__kit.reload(import.meta.url) === 'invalidate') {
      import.meta.hot.invalidate();
    }
    __kit.flush();
  });
}
`;

                return { code: prelude + code + postlude, map: null };
            },
        },

        {
            // scenes watcher → HMR fan-out. This plugin is the sole
            // live-edit signal for scene content: it watches
            // `<projectDir>/content/scenes/**/*.scene.json` recursively and
            // emits one debounced event per scene id to both envs. Scene ids
            // are the path relative to `content/scenes/` with `.scene.json`
            // stripped (e.g. `blueprints/foo`). The dev server's own watcher
            // excludes `content/**` (see config.ts → server.watch.ignored),
            // so we run an independent `fs.watch` here scoped to the scenes dir.
            //
            // Every `.scene.json` on disk is surfaced — the editor's scenes
            // tab needs to list/open/rename/delete files the project hasn't
            // `scene()`-declared yet. Filtering to declared ids is the asset
            // pipeline's job (it controls what gets bundled into prod), not
            // this watcher's.
            name: 'bongle:scenes',
            async configureServer(server) {
                const scenesDir = path.join(projectDir, 'content', 'scenes');
                fs.mkdirSync(scenesDir, { recursive: true });

                const SCENE_EXT = '.scene.json';
                const BLUEPRINT_PREFIX = 'blueprints/';

                // live reference to the server env's scene registry. read
                // by fire() to gate the HMR fan-out: only ids that are either
                // (a) `scene()`-declared by user code or (b) blueprints (by id
                // prefix) ride this channel. anything else is an undeclared
                // `.scene.json` sitting on disk — the editor inventory still
                // sees it via `bongle:scene-list`, but no runtime listener
                // would consume an `applyScenePayload` for it.
                //
                // importing `bongle/internal` here is cheap: it just exports
                // singleton registries and doesn't depend on user code. the
                // `registry.scenes.byId` Map mutates live as user code
                // evaluates, so `has(id)` reads fresh on every fire — new
                // `scene(id)` calls added via HMR pass the gate as soon as
                // the kit module re-evaluates.
                const serverEnv = server.environments.server as RunnableDevEnvironment | undefined;
                let isSceneDeclared: (id: string) => boolean = () => false;
                if (serverEnv) {
                    const internal = (await serverEnv.runner.import('bongle/internal')) as typeof import('bongle/internal');
                    isSceneDeclared = (id) => internal.registry.scenes.byId.has(id);
                }

                // ids may contain `/` (nested dirs under content/scenes/).
                // path.join is fine on both posix and win as long as the id
                // segments arrived as `/`-joined strings.
                const readScene = (id: string): string | null => {
                    try {
                        return fs.readFileSync(path.join(scenesDir, id + SCENE_EXT), 'utf-8');
                    } catch {
                        return null;
                    }
                };

                // atomic write replacers (editors, our own CAS writer) can
                // emit multiple events per save. coalesce by id so each
                // save produces one HMR event.
                const pending = new Map<string, ReturnType<typeof setTimeout>>();
                const DEBOUNCE_MS = 50;

                // current scene id list — kept in sync with disk; diffed on
                // every fire() so `bongle:scene-list` emits only when
                // membership actually moves. cold-cache initial list goes
                // out via `/__bongle/scenes`.
                let currentList: string[] = [];
                let currentSet = new Set<string>();

                // last sent content per id, used by fire() to skip the wire
                // when bytes didn't change. fs.watch fires for non-content
                // events on macOS (atime updates, atomic-rename two-step
                // saves) and the engine's `applyScenePayload` re-populates
                // scene state — without this guard the runtime clobbers
                // its own in-memory state on every spurious watcher wake.
                const lastFired = new Map<string, string>();

                const walkSceneIds = (current: string, out: string[]): void => {
                    for (const ent of fs.readdirSync(current, { withFileTypes: true })) {
                        const full = path.join(current, ent.name);
                        if (ent.isDirectory()) walkSceneIds(full, out);
                        else if (ent.isFile() && ent.name.endsWith(SCENE_EXT)) {
                            const rel = path.relative(scenesDir, full).split(path.sep).join('/');
                            out.push(rel.slice(0, -SCENE_EXT.length));
                        }
                    }
                };

                const recomputeSceneList = (): void => {
                    const next: string[] = [];
                    if (fs.existsSync(scenesDir)) walkSceneIds(scenesDir, next);
                    next.sort();
                    if (next.length === currentList.length && next.every((v, i) => v === currentList[i])) {
                        return;
                    }
                    currentList = next;
                    currentSet = new Set(next);
                    server.environments.client?.hot.send('bongle:scene-list', { scenes: currentList });
                    server.environments.server?.hot.send('bongle:scene-list', { scenes: currentList });
                };

                recomputeSceneList();

                const fire = (id: string) => {
                    pending.delete(id);

                    // channel membership: only declared scenes + blueprints
                    // reach the editor + server's `bongle:scene-update`
                    // listeners. The pipeline (AssetPipeline.run) walks
                    // content/scenes/** itself — no HMR channel for
                    // undeclared scenes.
                    const inChannel = id.startsWith(BLUEPRINT_PREFIX) || isSceneDeclared(id);
                    const clientHot = server.environments.client?.hot;
                    const serverHot = server.environments.server?.hot;
                    const scene = readScene(id);

                    if (scene === null) {
                        lastFired.delete(id);
                        if (inChannel) {
                            clientHot?.send('bongle:scene-clear', { id });
                            serverHot?.send('bongle:scene-clear', { id });
                        }
                        if (currentSet.has(id)) recomputeSceneList();
                        notifyPipelineOfSceneChange();
                        return;
                    }

                    if (!currentSet.has(id)) recomputeSceneList();

                    // content-diff dedup against fs.watch's spurious wakes
                    // (atime updates, atomic-rename two-step saves).
                    if (lastFired.get(id) === scene) return;
                    lastFired.set(id, scene);

                    if (inChannel) {
                        const event = { id, scene };
                        clientHot?.send('bongle:scene-update', event);
                        serverHot?.send('bongle:scene-update', event);
                    }

                    notifyPipelineOfSceneChange();
                };

                const schedule = (id: string) => {
                    const prev = pending.get(id);
                    if (prev) clearTimeout(prev);
                    pending.set(
                        id,
                        setTimeout(() => fire(id), DEBOUNCE_MS),
                    );
                };

                // recursive watch: blueprint files and any other nested
                // organization (content/scenes/blueprints/foo.scene.json)
                // need the same HMR treatment as top-level scenes.
                // recursive is supported on darwin + win; on linux it falls
                // back to non-recursive, which our usage tolerates because
                // the editor's "save blueprint" path is invoked through the
                // same content/scenes/ writer and lands here as a file event.
                fs.watch(scenesDir, { recursive: true }, (_event, filename) => {
                    if (!filename?.endsWith(SCENE_EXT)) return;
                    const rel = filename.split(path.sep).join('/');
                    schedule(rel.slice(0, -SCENE_EXT.length));
                });

                // cold-cache initial read. used by:
                //   • client/registry-dispatch when a new `scene()`
                //     declaration appears mid-session before the watcher
                //     has emitted for that id
                //   • the editor at boot to backfill existing scenes on disk
                //     (the file watcher only fires for live edits, never
                //     for files that already existed at startup)
                // returns the same shape as the HMR event payload.
                server.middlewares.use((req, res, next) => {
                    const url = req.url ?? '';
                    const path0 = url.split('?')[0]!;

                    // GET /__bongle/scenes — current scene id list for
                    // cold-cache boot in the editor (HMR doesn't replay
                    // past events on new connections).
                    if (path0 === '/__bongle/scenes') {
                        res.setHeader('Content-Type', 'application/json');
                        res.setHeader('Cache-Control', 'no-cache');
                        res.end(JSON.stringify({ scenes: currentList }));
                        return;
                    }

                    // ids may contain `/` (nested dirs). match everything
                    // after `/scene/` up to the query string.
                    const match = /^\/__bongle\/scene\/([^?]+)/.exec(path0);
                    if (!match) return next();
                    const id = decodeURIComponent(match[1]!);
                    const scene = readScene(id);
                    if (scene === null) {
                        res.statusCode = 404;
                        res.end();
                        return;
                    }
                    res.setHeader('Content-Type', 'application/json');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.end(JSON.stringify({ id, scene }));
                });
            },
        },

        {
            // Asset pipeline — the dev driver for the one `AssetPipeline`.
            //
            // `AssetPipeline` (the engine, behind `engine-asset-pipeline`) runs
            // inside the server env runner — the same graph as EngineServer,
            // sharing the registries. This plugin owns the dev wiring: it inits
            // the pipeline once, runs it on each settled HMR flush and on
            // scene/asset file changes (under a coalescing lock), and forwards
            // the `RunResult` to the live editor client. Reachable only on the
            // edit path — play bundles never import it, so sharp/skia/gltf/Dawn
            // stay out.
            //
            // After a run: atlas/sprite-atlas changes → the client refreshes in
            // place (refreshBlockResources / SpriteResources.refresh); written
            // icons → the editor re-fetches the thumbnails.
            name: 'bongle:pipeline',
            async configureServer(server) {
                const serverEnv = server.environments.server as RunnableDevEnvironment | undefined;
                if (!serverEnv) {
                    console.warn('[bongle:pipeline] server env missing; skipping pipeline registration');
                    return;
                }

                // Pull __kit + AssetPipeline through the server runner so the
                // pipeline binds to the SAME registry instances user code
                // upserts into (the runner graph's singletons, not the main
                // Node graph's). init() only captures the registry reference,
                // so calling it here — before user code has evaluated — is fine.
                const internal = (await serverEnv.runner.import('bongle/internal')) as typeof import('bongle/internal');
                const { AssetPipeline } = (await serverEnv.runner.import(
                    'bongle/engine-asset-pipeline',
                )) as typeof import('bongle/engine-asset-pipeline');
                const pipeline = AssetPipeline.init({ projectDir, mode: 'edit', cache: true, renderIcons: true });

                // Project-rooted source paths the pipeline reads (gltf/png/ogg).
                // Refreshed after every run so freshly-declared model()/sound()
                // entries enter the watch set; the watcher below forces a pass
                // when one of these files changes (registry revs don't move).
                let assetSrcs: Set<string> = new Set();

                // Editor-load gate + status label. /__bongle/ready holds the
                // editor's load() until the first run settles, so it loads into a
                // warm pipeline instead of a flash of missing thumbnails.
                // `openReadyGate` flips both and resolves `iconsRendered` (the
                // CLI's ready signal) exactly once — on the first run's settle, or
                // the timeout guard below — so a fault never wedges the editor.
                // Passing `warm` logs the cold-start banner: total wall-clock plus
                // the per-builder breakdown (concurrent, overlapping — longest
                // pole first; empty on a no-op first run).
                let firstPipelineRunComplete = false;
                let pipelineStatus: string | null = 'Starting…';
                let firstRunTimer: ReturnType<typeof setTimeout> | null = null;
                const openReadyGate = (warm?: { ms: number; timings: Record<string, number> }) => {
                    if (firstPipelineRunComplete) return;
                    firstPipelineRunComplete = true;
                    pipelineStatus = null;
                    if (firstRunTimer) clearTimeout(firstRunTimer);
                    if (warm) {
                        console.log(`[bongle] pipeline warm in ${warm.ms.toFixed(0)}ms`);
                        const breakdown = Object.entries(warm.timings)
                            .sort((a, b) => b[1] - a[1])
                            .map(([label, ms]) => `${label} ${ms.toFixed(0)}ms`)
                            .join(', ');
                        if (breakdown) console.log(`[bongle]   assets: ${breakdown}`);
                    }
                    resolveIconsRendered();
                };

                // Forward a settled run's outputs to the browser env: atlas/sprite
                // refreshes and per-icon thumbnail re-fetches. No client env (e.g.
                // headless) → nothing to do.
                const forwardToClient = (result: Awaited<ReturnType<typeof AssetPipeline.run>>) => {
                    const clientHot = server.environments.client?.hot;
                    if (!clientHot) return;
                    // Atlas moved → client refreshBlockResources + remesh.
                    if (result.atlasChanged) clientHot.send('bongle:block-texture-atlas-updated', { hash: result.atlasHash });
                    // Sprite atlas → SpriteResources.refresh on the client.
                    if (result.spriteAtlasChanged)
                        clientHot.send('bongle:sprite-atlas-updated', { hash: result.spriteAtlasHash });
                    // Audio manifest/atlas → Audio.refreshResources on the client.
                    if (result.audioAtlasChanged) clientHot.send('bongle:audio-atlas-updated', { hash: result.audioAtlasHash });
                    // Each written icon → editor re-fetches the thumbnail.
                    for (const icon of result.iconsWritten)
                        clientHot.send('bongle:icons-ready', { kind: icon.kind, id: icon.id });
                };

                // One driver: coalesces concurrent triggers into a run plus at
                // most one tail run. Pure gating lives inside AssetPipeline.run;
                // this owns the lock, the watch-set refresh, forwarding the
                // RunResult to the browser, and opening the editor-load gate.
                let busy = false;
                let queued = false;
                let queuedForceAll = false;
                const runPipeline = async (forceAll = false) => {
                    if (forceAll) queuedForceAll = true;
                    if (busy) {
                        queued = true;
                        return;
                    }
                    busy = true;
                    const passStart = performance.now();
                    try {
                        do {
                            queued = false;
                            const passForceAll = queuedForceAll;
                            queuedForceAll = false;
                            pipelineStatus = 'Building assets…';
                            let result: Awaited<ReturnType<typeof AssetPipeline.run>>;
                            try {
                                result = await AssetPipeline.run(pipeline, { forceAll: passForceAll });
                            } catch (err) {
                                console.error('[bongle:pipeline] pass failed:', err);
                                continue;
                            }
                            // New declarations are now in scope; removed ones drop out.
                            assetSrcs = AssetPipeline.assetSources(pipeline);
                            forwardToClient(result);
                            // First successful run → log the warm banner + open the
                            // gate. (The gate also opens in `finally`, silently, so
                            // a fault still releases the editor.)
                            if (!firstPipelineRunComplete) {
                                openReadyGate({ ms: performance.now() - passStart, timings: result.timings });
                            }
                        } while (queued);
                    } finally {
                        busy = false;
                        openReadyGate();
                    }
                };

                // Scene-watcher wake + the settled HMR flush both drive one run.
                notifyPipelineOfSceneChange = () => {
                    void runPipeline();
                };
                internal.__kit.registerFlush(() => {
                    void runPipeline();
                });

                // GET /__bongle/ready — editor client polls this before
                // EngineClient.load(). `ready` flips true only once the first
                // full pipeline run is done (bake + first icon render), so the
                // editor loads into a warm pipeline. Always returns 200.
                server.middlewares.use('/__bongle/ready', (req, res) => {
                    if (req.method !== 'GET') {
                        res.statusCode = 405;
                        res.end();
                        return;
                    }
                    res.setHeader('Content-Type', 'application/json');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.end(JSON.stringify({ ready: firstPipelineRunComplete, status: pipelineStatus }));
                });

                // External-asset watcher. Registry revisions only move on
                // user-source HMR — replacing a .gltf / .png / .ogg on
                // disk leaves them untouched, so without this the pipeline
                // never re-runs and stale cached bins keep serving. We
                // piggyback on Vite's existing chokidar (already covers
                // projectDir minus node_modules + the `server.watch.ignored`
                // dirs) and filter to the set of paths the pipeline is
                // actually reading. The filter is reset after every pass
                // so freshly-declared srcs enter immediately.
                const ASSET_DEBOUNCE_MS = 50;
                let assetDebounce: ReturnType<typeof setTimeout> | null = null;
                const onAssetChange = (file: string) => {
                    if (!assetSrcs.has(file)) return;
                    if (assetDebounce) clearTimeout(assetDebounce);
                    assetDebounce = setTimeout(() => {
                        assetDebounce = null;
                        void runPipeline(true);
                    }, ASSET_DEBOUNCE_MS);
                };
                server.watcher.on('change', onAssetChange);
                server.watcher.on('add', onAssetChange);
                server.watcher.on('unlink', onAssetChange);

                // Cold-start guard. The first run is driven by edit-server's boot
                // `__kit.flush()`, not kicked here, and we don't `await` it inline
                // (it can't happen until edit-server boots, after this
                // configureServer returns — awaiting would deadlock startup). The
                // warm banner + gate open from `runPipeline` on the first settle.
                // An edit-server boot *throw* already surfaces at `initGameEnv`;
                // this guard covers the other failure mode — a first run that
                // never returns (a wedged GPU/IO await, which `runPipeline`'s
                // try/finally can't unblock) — by opening the gate anyway so the
                // CLI/editor don't hang forever.
                const FIRST_RUN_TIMEOUT_MS = 60_000;
                firstRunTimer = setTimeout(() => {
                    console.error(
                        `[bongle:pipeline] first run did not complete within ${FIRST_RUN_TIMEOUT_MS / 1000}s — ` +
                            'opening the editor anyway (icons may be missing).',
                    );
                    openReadyGate();
                }, FIRST_RUN_TIMEOUT_MS);
            },
        },

        {
            // serve resources/client/* (atlas, icons, model bins) live off
            // disk at the url root. vite's publicDir snapshots at startup
            // and would miss post-startup pipeline writes; watching the dir
            // would fullReload on every write. Live FS reads sidestep both.
            name: 'bongle:serve-resources',
            configureServer(server) {
                server.middlewares.use((req, res, next) => {
                    const url = req.url ?? '/';
                    const rel = url.split('?')[0]!.replace(/^\//, '');
                    if (!rel) return next();
                    const filePath = path.join(resourcesDir, rel);
                    if (!filePath.startsWith(resourcesDir)) return next();
                    fs.stat(filePath, (err, stat) => {
                        if (err || !stat.isFile()) return next();
                        fs.readFile(filePath, (readErr, data) => {
                            if (readErr) {
                                res.statusCode = 404;
                                res.end();
                                return;
                            }
                            const ext = path.extname(filePath);
                            const ct =
                                ext === '.json'
                                    ? 'application/json'
                                    : ext === '.png'
                                      ? 'image/png'
                                      : ext === '.bin'
                                        ? 'application/octet-stream'
                                        : 'application/octet-stream';
                            res.setHeader('Content-Type', ct);
                            res.setHeader('Cache-Control', 'no-cache');
                            res.end(data);
                        });
                    });
                });
            },
        },
    ];
}

/**
 * Wrap every `prefab(...)` / `script(...)` call whose body closes over
 * producer identifiers with `__kit.deps(call, [refs])`. Returns the
 * rewritten source, or `null` when no wrap was needed.
 *
 * The runtime helper (`__kit.deps` in `bongle/internal`) reads
 * `handle.dependency` off the call's return value and unions the refs
 * into the existing DepGraph dep set — leaving any user-supplied
 * `deps:` field that the factory body already wired untouched. Wrap
 * preserves the call's return value so `export const X = prefab(...)`
 * assignments still work.
 *
 * Any producer handle (with `dependency`) is eligible — scenes, models,
 * blocks, traits, commands, prefabs.
 *
 * Skip cases:
 *   - Consumer has no fn / factory to scan.
 *   - Body contains no resolvable producer refs.
 */
function wrapConsumerCalls(code: string, table: SymbolTable, registry: SymbolTableRegistry): string | null {
    let ms: MagicString | null = null;
    for (const consumer of table.consumers) {
        const bodyNode = consumer.kind === 'prefab' ? consumer.fnNode : consumer.factoryNode;
        if (!bodyNode) continue;

        const all = extractConsumerDeps(bodyNode, table, registry);
        if (all.length === 0) continue;

        const names = all.map((d) => d.localName).join(', ');
        ms ??= new MagicString(code);
        ms.appendLeft(consumer.callStart, '__kit.deps(');
        ms.appendRight(consumer.callEnd, `, [${names}])`);
    }
    return ms ? ms.toString() : null;
}
