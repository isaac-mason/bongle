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
 *      on the client, engine dispatch + asset pipeline on the gameServer.
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
 *   4. **Worker re-boot.** Only the asset-pipeline worker re-boots — at the
 *      top of each orchestrator pass (`kit/pipeline/orchestrator.ts`), if
 *      the on-disk atlas hash differs from the hash the worker booted
 *      against, EngineAssetPipeline re-boots so its GPU TextureArray picks
 *      up fresh tiles before the next icon render (see concern 4 below).
 *      The main client never hits this rung — landing here is a regression.
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
 *     dispatch + asset pipeline on the gameServer).
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
 *     both `client` and `gameServer` envs when a `.scene.json` file
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
 *         off the gameServer env's `registry.scenes`) and `blueprints/*`
 *         ids ride `bongle:scene-update`/`bongle:scene-clear`. Undeclared
 *         `.scene.json` files still surface in `bongle:scene-list` for the
 *         editor inventory, but no `applyScenePayload` runs for them on
 *         the editor or gameServer side.
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
 *     causes jank. Instead the Node-side orchestrator walks
 *     `content/scenes/**` itself, diffs against its applied set, and
 *     applies scene payloads to the in-process pipeline worker directly.
 *     `fire()` here just calls a wake hook the pipeline plugin installed;
 *     no HMR channel for undeclared scenes.
 *
 *  4. **Asset pipeline.** Two coordinated halves:
 *
 *      - **Node-side.** Registers a flush handler against the gameServer
 *        env's `bongle/internal` so each settled HMR cascade runs
 *        `runAssetPipelinePass` (atlas + models + scenes + matchmaking
 *        config stashed on pipeline state, read by `build.ts` at bundle
 *        time).
 *        We piggyback on gameServer (rather than a third env) because the
 *        gameServer-local registries already hold every declarative entry
 *        the pipeline reads, and the same flush microtask coalesces engine
 *        + pipeline work.
 *
 *      - **In-process render.** The `pipeline` runnable env's runner imports
 *        `virtual:bongle/pipeline-worker` — a DOM-less EngineAssetPipeline
 *        boot entry against `virtual:bongle/user-src` — in this process.
 *        `kit/pipeline/local-pipeline.ts` creates the Dawn device + the
 *        disk/sharp `ResourceLoader` and boots it, exposing a verb surface
 *        (`bootEngine`, `applyScene`, `clearScene`, `applyRegistryChanges`,
 *        `renderBlockIcons`/`renderPrefabIcon`/`renderSceneIcon`). It makes
 *        zero rendering decisions.
 *
 *      - **Orchestrator.** Node-side
 *        (`kit/pipeline/orchestrator.ts`) holds all the policy: hash
 *        gating against the gameServer registries, scene-corpus diffing,
 *        bootId tracking, busy/queued lock. Drives the worker through the
 *        `WorkerHandle` (a direct in-process call) and is woken by the scene
 *        watcher, the Node-side pass, and atlas changes. The worker writes
 *        sharp-encoded PNGs onto `resources/client/` directly (no HTTP).
 *
 *    No cross-env await: atlas/icons race in parallel on each user-src
 *    edit. After the Node pass writes a new atlas, the live client
 *    receives `bongle:block-texture-atlas-updated` so
 *    `EngineClient.refreshBlockResources` re-pulls and remeshes; the
 *    orchestrator's next pass observes the hash drift at the top of
 *    `runOnePass` and re-boots the worker in-lock before dispatching verbs.
 */

import fs from 'node:fs';
import path from 'node:path';
import MagicString from 'magic-string';
import type { Plugin, RunnableDevEnvironment } from 'vite';
import { readArtifactHashSync } from '../cache';
import { collectAssetSources, createPipelineState, type PipelinePassTimings, runAssetPipelinePass } from '../asset-pipeline/pipeline';
import * as Orchestrator from '../pipeline/orchestrator';
import { buildSymbolTable, type SymbolTable } from './dep-ast';
import { extractConsumerDeps, resolveLocalName, type SymbolTableRegistry } from './dep-resolve';
import { virtualEntriesPlugin } from './virtual-entries';

let resolveIconsRendered: () => void = () => {};
/** Resolves once the persistent pipeline page has finished its first full
 *  render+emit cycle on cold start — every block/scene/prefab icon is on
 *  disk and the headless page is warm. The dev CLI awaits this before the
 *  ready banner so "started!" reflects the whole pipeline, not just the dev
 *  server being up. Resolved (never rejected) even on a launch/render fault,
 *  so a pipeline failure can't wedge the banner. One-shot per process. */
export const iconsRendered: Promise<void> = new Promise((resolve) => {
    resolveIconsRendered = resolve;
});

export interface BongleOptions {
    /** absolute path to the project root (the dir containing `src/`, `resources/`). */
    projectDir: string;
    /** absolute path to .bongle/ — used by the pipeline handler for cache paths + sidecar writes. */
    bongleDir: string;
}

export function bongle(opts: BongleOptions): Plugin[] {
    const projectDir = path.resolve(opts.projectDir);
    const bongleDir = path.resolve(opts.bongleDir);
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
    // .scene.json change; the pipeline plugin assigns it once its
    // orchestrator state is ready. Default no-op so early scene events
    // before pipeline init are dropped silently — the orchestrator's
    // first pass walks the corpus from disk anyway.
    let notifyOrchestratorOfSceneChange: () => void = () => {};

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
                            deps.length
                                ? deps.map((d) => `${d.dep.registry}:${d.dep.id}`).join('+')
                                : '∅';
                        const summary = table.consumers
                            .map((c) => {
                                if (c.kind === 'prefab') {
                                    const deps = c.fnNode
                                        ? extractConsumerDeps(c.fnNode, table, symbolTables)
                                        : [];
                                    return `prefab:${c.id}=[${fmtDeps(deps)}]`;
                                }
                                const trait = resolveLocalName(table, c.traitLocalName, symbolTables);
                                const traitStr = trait ? `${trait.registry}:${trait.id}` : '?';
                                const deps = c.factoryNode
                                    ? extractConsumerDeps(c.factoryNode, table, symbolTables)
                                    : [];
                                return `script:${c.traitLocalName}@${traitStr}=[${fmtDeps(deps)}]`;
                            })
                            .join(', ');
                        console.log(
                            `[depgraph-ast] ${path.relative(projectDir, filePath)} — ${summary}`,
                        );
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

                // live reference to the gameServer env's scene registry. read
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
                const gameServerEnv = server.environments.gameServer as RunnableDevEnvironment | undefined;
                let isSceneDeclared: (id: string) => boolean = () => false;
                if (gameServerEnv) {
                    const internal = (await gameServerEnv.runner.import(
                        'bongle/internal',
                    )) as typeof import('bongle/internal');
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
                    if (
                        next.length === currentList.length
                        && next.every((v, i) => v === currentList[i])
                    ) {
                        return;
                    }
                    currentList = next;
                    currentSet = new Set(next);
                    server.environments.client?.hot.send('bongle:scene-list', { scenes: currentList });
                    server.environments.gameServer?.hot.send('bongle:scene-list', { scenes: currentList });
                };

                recomputeSceneList();

                const fire = (id: string) => {
                    pending.delete(id);

                    // channel membership: only declared scenes + blueprints
                    // reach the editor + gameServer's `bongle:scene-update`
                    // listeners. The pipeline page is driven Node-side by
                    // the orchestrator (kit/pipeline/orchestrator.ts), which
                    // walks content/scenes/** itself — no HMR channel for
                    // undeclared scenes.
                    const inChannel = id.startsWith(BLUEPRINT_PREFIX) || isSceneDeclared(id);
                    const clientHot = server.environments.client?.hot;
                    const gameServerHot = server.environments.gameServer?.hot;
                    const scene = readScene(id);

                    if (scene === null) {
                        lastFired.delete(id);
                        if (inChannel) {
                            clientHot?.send('bongle:scene-clear', { id });
                            gameServerHot?.send('bongle:scene-clear', { id });
                        }
                        if (currentSet.has(id)) recomputeSceneList();
                        notifyOrchestratorOfSceneChange();
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
                        gameServerHot?.send('bongle:scene-update', event);
                    }

                    notifyOrchestratorOfSceneChange();
                };

                const schedule = (id: string) => {
                    const prev = pending.get(id);
                    if (prev) clearTimeout(prev);
                    pending.set(id, setTimeout(() => fire(id), DEBOUNCE_MS));
                };

                // recursive watch: blueprint files and any other nested
                // organization (content/scenes/blueprints/foo.scene.json)
                // need the same HMR treatment as top-level scenes.
                // recursive is supported on darwin + win; on linux it falls
                // back to non-recursive, which our usage tolerates because
                // the editor's "save blueprint" path is invoked through the
                // same content/scenes/ writer and lands here as a file event.
                fs.watch(scenesDir, { recursive: true }, (_event, filename) => {
                    if (!filename || !filename.endsWith(SCENE_EXT)) return;
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
            // Pipeline: three pieces in one plugin.
            //
            //  • Node-side `runAssetPipelinePass` runs as a flush handler on
            //    the gameServer env's bongle/internal: every settled HMR
            //    cascade emits atlas + models + scenes (and stashes
            //    matchmaking config on pipeline state).
            //    Cheap on no-op edits (each builder hash-gates internally).
            //
            //  • The in-process pipeline worker (`kit/pipeline/local-pipeline.ts`)
            //    runs EngineAssetPipeline in the `pipeline` runnable env's
            //    runner — a dumb verb surface that makes no rendering decisions.
            //
            //  • The Node-side orchestrator (`kit/pipeline/orchestrator.ts`)
            //    drives the worker through its `WorkerHandle`: hash-gates against
            //    the gameServer registries, diffs the scene corpus against
            //    its applied set, and sequences boot/apply/render verbs.
            //    Woken by the scene watcher, the Node-side pass, and atlas
            //    changes.
            //
            // No cross-env await — atlas and icons race in parallel on each
            // edit. After an atlas change the orchestrator re-boots the
            // worker (fresh GPU TextureArray on the next render) and the
            // plugin emits `bongle:block-texture-atlas-updated` to the live
            // editor client (refreshBlockResources + remesh).
            name: 'bongle:pipeline',
            async configureServer(server) {
                const gameServerEnv = server.environments.gameServer as RunnableDevEnvironment | undefined;
                if (!gameServerEnv) {
                    console.warn('[bongle:pipeline] gameServer env missing; skipping pipeline registration');
                    return;
                }

                // Register the Node-side pass as a flush handler on the
                // gameServer env's bongle/internal. __kit.registerFlush is
                // env-scoped — this fires on the gameServer's HMR cascade,
                // sharing the microtask with EngineServer.applyRegistryChanges.
                //
                // Typed against the live `bongle/internal` namespace export —
                // new registries land here automatically when added to the
                // engine's internal.ts barrel, no shadowed `unknown` field to
                // forget to update. The runtime shape is identical to the
                // type because `env.runner.import` returns the module exports.
                const internal = (await gameServerEnv.runner.import('bongle/internal')) as typeof import('bongle/internal');
                const pipelineInternal: Parameters<typeof runAssetPipelinePass>[0] = internal;

                // Per-dev-session pipeline state: tracks each registry's last
                // processed revision so subsequent no-op flushes short-circuit
                // before touching disk. Critical for breaking the
                // pipeline-write → fs-event → HMR → flush feedback loop on
                // user-source edits that don't actually change pipeline inputs
                // (e.g. editing a script body).
                const pipelineState = createPipelineState();

                // Union of project-rooted source paths the pipeline reads
                // (gltf/png/ogg/...). Refreshed after every pass so newly
                // declared `model()` / `sound()` / etc. entries enter the
                // watch set as soon as the pipeline observes them. Used by
                // the `server.watcher` hook below to decide whether a file
                // event warrants a forced re-pass.
                let assetSrcs: Set<string> = new Set();

                // Editor-load gate. The editor client polls /__bongle/ready
                // before calling EngineClient.load(); we hold it until the
                // first *full* pipeline run is done — not just the asset pass
                // (atlas/barrels on disk) but the headless page's first
                // render+emit of every icon — so the editor loads into a fully
                // warm pipeline instead of a flash of missing thumbnails.
                // `firstPipelineRunComplete` mirrors the iconsRendered promise
                // into a pollable flag; it resolves even on a pipeline fault,
                // so a broken render never wedges the editor. `pipelineStatus`
                // is a coarse human-readable label for the loader UI.
                let firstPipelineRunComplete = false;
                let pipelineStatus: string | null = 'Starting…';
                void iconsRendered.then(() => {
                    firstPipelineRunComplete = true;
                    pipelineStatus = null;
                });

                // Cold-start phase timings, logged once the page is warm so we
                // can see where the first run's wall-clock goes. The phases are
                // sequential on the critical path: the launch microtask awaits
                // the asset pass before booting the page. `firstAssetPassMs` is
                // stamped by the first runNodePass; launch + render are timed
                // at the page. `firstAssetTimings` breaks the asset bucket down
                // per builder (draw/atlas/models/...) for the warm summary.
                let firstAssetPassMs: number | null = null;
                let firstAssetTimings: PipelinePassTimings | null = null;

                // Resolves once the first asset-pipeline pass has written the
                // generated barrels (src/generated/*.ts). The pipeline boot
                // awaits this so the runner imports the real barrels up
                // front, instead of loading the stale/empty ones on disk and
                // then taking the first pass's HMR cascade mid-render. That
                // cascade is what races the icon /emit fetches (→
                // net::ERR_ABORTED) and forces a redundant bootId-driven
                // re-boot on every cold start. Gated on full-pass settle
                // (a superset — barrels and bins are emitted together per
                // builder, so there's no cheaper codegen-only seam).
                let markGeneratedBarrelsReady: () => void = () => {};
                const generatedBarrelsReady = new Promise<void>((resolve) => {
                    markGeneratedBarrelsReady = resolve;
                });

                // Orchestrator state — holds the worker handle, applied scene
                // hashes, last rendered artifact hashes, and the worker's
                // bootId. Initialized after the worker boots (below); until
                // then `orchestrator` is null and
                // wake hooks no-op.
                let orchestrator: Orchestrator.State | null = null;
                const scheduleOrchestrator = () => {
                    if (orchestrator) void Orchestrator.scheduleRender(orchestrator);
                };
                notifyOrchestratorOfSceneChange = scheduleOrchestrator;

                let nodePassRunning = false;
                let nodePassQueued = false;
                let nextPassForceAll = false;
                const runNodePass = async (forceAll = false) => {
                    if (forceAll) nextPassForceAll = true;
                    if (nodePassRunning) {
                        nodePassQueued = true;
                        return;
                    }
                    nodePassRunning = true;
                    const passStart = performance.now();
                    try {
                        do {
                            nodePassQueued = false;
                            const passForceAll = nextPassForceAll;
                            nextPassForceAll = false;
                            const atlasJsonPath = path.join(resourcesDir, 'voxels-atlas.json');
                            const spriteAtlasJsonPath = path.join(resourcesDir, 'sprites-atlas.json');
                            const prevAtlasHash = readArtifactHashSync(atlasJsonPath);
                            const prevSpriteAtlasHash = readArtifactHashSync(spriteAtlasJsonPath);
                            pipelineStatus = 'Building assets…';
                            try {
                                const timings = await runAssetPipelinePass(
                                    pipelineInternal,
                                    { projectDir, mode: 'edit', cache: true },
                                    pipelineState,
                                    { forceAll: passForceAll },
                                );
                                if (firstAssetTimings === null && Object.keys(timings).length > 0) {
                                    firstAssetTimings = timings;
                                }
                            } catch (err) {
                                console.error('[bongle:pipeline] node-side pass failed:', err);
                            }
                            // Refresh the watched-asset set off the
                            // post-pass registries — new declarations are
                            // now in scope, removed ones drop out.
                            assetSrcs = collectAssetSources(pipelineInternal, projectDir);
                            const newAtlasHash = readArtifactHashSync(atlasJsonPath);
                            const newSpriteAtlasHash = readArtifactHashSync(spriteAtlasJsonPath);
                            // Atlas changed → tell the live editor client
                            // so EngineClient.refreshBlockResources re-pulls
                            // the atlas + remeshes voxels. The worker picks up
                            // the change via the orchestrator's at-the-top
                            // re-boot check (step 2 of runOnePass); the
                            // scheduleOrchestrator() call below kicks that
                            // pass off after the pipeline pass settles.
                            if (newAtlasHash && newAtlasHash !== prevAtlasHash) {
                                server.environments.client?.hot.send('bongle:block-texture-atlas-updated', { hash: newAtlasHash });
                            }
                            // Sprite atlas — drives SpriteResources.refresh
                            // on the live client. Fires whether the change
                            // came from a registry add/remove or from an
                            // image-file edit (sprite-atlas.ts's hash mixes
                            // both).
                            if (newSpriteAtlasHash && newSpriteAtlasHash !== prevSpriteAtlasHash) {
                                server.environments.client?.hot.send('bongle:sprite-atlas-updated', { hash: newSpriteAtlasHash });
                            }
                        } while (nodePassQueued);
                    } finally {
                        nodePassRunning = false;
                        if (firstAssetPassMs === null) firstAssetPassMs = performance.now() - passStart;
                        // Asset pass settled. The editor-load gate also waits
                        // for the first icon render (firstPipelineRunComplete),
                        // so surface that phase until iconsRendered clears it.
                        pipelineStatus = firstPipelineRunComplete ? null : 'Rendering icons…';
                        markGeneratedBarrelsReady();
                    }
                    // Wake the orchestrator after each settled pass —
                    // covers the case where the pass produced no atlas
                    // change but other registry-driven inputs (prefab/
                    // scene/model edits) need an icon re-render.
                    scheduleOrchestrator();
                };

                internal.__kit.registerFlush(runNodePass);

                // GET /__bongle/ready — editor client polls this before
                // EngineClient.load(). `ready` flips true only once the first
                // full pipeline run is done (asset pass + the headless page's
                // first icon render+emit), so the editor loads into a warm
                // pipeline. Always returns 200.
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
                        void runNodePass(true);
                    }, ASSET_DEBOUNCE_MS);
                };
                server.watcher.on('change', onAssetChange);
                server.watcher.on('add', onAssetChange);
                server.watcher.on('unlink', onAssetChange);

                // Bring up the in-process Node asset pipeline once the generated
                // barrels exist (the pipeline runner imports them up front). Runs
                // in this process via the `pipeline` runnable env — no puppeteer,
                // no fork. The first pass is kicked + awaited so the CLI holds its
                // ready banner until every icon is warm (iconsRendered).
                queueMicrotask(async () => {
                    try {
                        await generatedBarrelsReady;
                        const { initLocalPipeline } = await import('../pipeline/local-pipeline');
                        const bootStart = performance.now();
                        const handle = await initLocalPipeline(server, projectDir);
                        orchestrator = Orchestrator.init(handle, pipelineInternal, projectDir);
                        const bootMs = performance.now() - bootStart;
                        const renderStart = performance.now();
                        await Orchestrator.scheduleRender(orchestrator);
                        const renderMs = performance.now() - renderStart;
                        const assetMs = firstAssetPassMs ?? 0;
                        console.log(
                            `[bongle] pipeline warm in ${(assetMs + bootMs + renderMs).toFixed(0)}ms ` +
                                `(assets ${assetMs.toFixed(0)}ms, boot ${bootMs.toFixed(0)}ms, ` +
                                `first render ${renderMs.toFixed(0)}ms)`,
                        );
                        // Asset bucket per builder (concurrent, so overlapping —
                        // longest pole first), so it's clear what dominates the
                        // asset phase: draw bake, atlases, models, etc.
                        if (firstAssetTimings) {
                            const breakdown = Object.entries(firstAssetTimings)
                                .sort((a, b) => b[1] - a[1])
                                .map(([label, ms]) => `${label} ${ms.toFixed(0)}ms`)
                                .join(', ');
                            if (breakdown) console.log(`[bongle]   assets: ${breakdown}`);
                        }
                    } catch (err) {
                        console.error('[bongle:pipeline] pipeline init failed:', err);
                    } finally {
                        resolveIconsRendered();
                    }
                });
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
                                ext === '.json' ? 'application/json'
                                : ext === '.png' ? 'image/png'
                                : ext === '.bin' ? 'application/octet-stream'
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
function wrapConsumerCalls(
    code: string,
    table: SymbolTable,
    registry: SymbolTableRegistry,
): string | null {
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
