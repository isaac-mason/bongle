// editor/realms/client/client-main.ts — the CLIENT realm, one per <iframe> window.
//
// A separate origin + document from the main editor (see editor/vite.config.ts
// for why). It's env.client here: vite compiles the engine client-env, so the
// GPU/DOM render path survives and the node-only server code is stripped.
//
// Boot handshake (parent = the main editor document):
//   1. post `client-ready` to the parent so it knows to send us a session.
//   2. receive `client-init` { files, entry } + a transferred MessagePort — the
//      frame pipe to the server worker (brokered by the parent).
//   3. rebuild a memory fs from the files, run the client bundler over the user
//      code (populating THIS realm's registry), boot EngineClient in edit mode,
//      mount the in-world edit UI, and pump the port <-> engine net each frame.
//
// Source + baked-resource edits arrive as `fs-change` messages; the bundler's
// watcher HMRs source, and resource writes trigger the matching engine refresh.

import type { ClientDriver } from '../../../interface/index';
import { createPortBridge } from '../../../build';
import { makeRunner } from '../../dev/runner';
import { exposeDevtools } from '../../devtools';
import type { Filesystem } from '../../fs';
import { openProjectFilesystem } from '../../fs-open';
import type { PortLike } from '../../../build';
import { createRemoteFilesystem } from '../../net/remote-fs';

/** wrap a transferred MessagePort as a PortLike (createRemoteFilesystem reads
 *  e.data either way; this keeps the fsrpc port structurally typed). */
function asPortLike(mp: MessagePort): PortLike {
    const p: PortLike = { onmessage: null, postMessage: (d) => mp.postMessage(d), close: () => mp.close() };
    mp.onmessage = (e) => p.onmessage?.({ data: e.data });
    return p;
}

// no host portal in the editor: matchmake is a no-op, platform verbs inert.
const driver: ClientDriver = {
    matchmake() {},
    platform: { commercialBreak: async () => {}, rewardedBreak: async () => false },
};

type InitMessage = { type: 'client-init'; projectName: string; entry?: string };
type FsChangeMessage = { type: 'fs-change'; path: string };

let booted = false;

/** Load bytes from the project fs. Baked client resources live under
 *  resources/client/<rel> (mirrors the deployed bundle layout); runtime-source
 *  avatar urls are absolute http(s) and fetched verbatim. No decodeImage — the
 *  client uses the DOM image path. */
function clientResourceLoader(fs: Filesystem) {
    return {
        loadBytes: async (url: string): Promise<Uint8Array> => {
            if (url.startsWith('http:') || url.startsWith('https:')) {
                const r = await fetch(url);
                if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
                return new Uint8Array(await r.arrayBuffer());
            }
            // builtin engine assets (sample-avatar glbs etc.) resolve to
            // file:///node_modules/bongle/dist/assets/… — read the seeded vfs file.
            if (url.startsWith('file:')) return fs.read(new URL(url).pathname.replace(/^\/+/, ''));
            return fs.read(`resources/client/${url.replace(/^\//, '')}`);
        },
    };
}

// The blueprint scene source, backed by OPFS instead of the legacy dev-server
// `/__bongle/*` endpoints (which don't exist here — they'd hit the SPA fallback
// and return index.html). Scenes live at content/scenes/<id>.scene.json.
function opfsSceneSource(fs: Filesystem) {
    return {
        listScenes: async (): Promise<string[]> => {
            const entries = await fs.list('content/scenes', { recursive: true }).catch(() => []);
            return entries
                .filter((e) => e.kind === 'file' && e.path.endsWith('.scene.json'))
                .map((e) => e.path.replace(/^content\/scenes\//, '').replace(/\.scene\.json$/, ''));
        },
        readScene: async (id: string): Promise<string | null> => {
            try {
                return await fs.readText(`content/scenes/${id}.scene.json`);
            } catch {
                return null;
            }
        },
    };
}

async function boot(msg: InitMessage, gamePort: MessagePort, bundlerPort: MessagePort, fsrpcPort?: MessagePort): Promise<void> {
    // the Source seam: a host's own client shares the SAME OPFS project (same
    // origin — no snapshot); a GUEST (another browser) has no shared OPFS, so it
    // reads THROUGH to the host over the relay's fsrpc lane.
    const fs = fsrpcPort ? createRemoteFilesystem(asPortLike(fsrpcPort)) : await openProjectFilesystem(msg.projectName);
    const remote = fsrpcPort !== undefined;

    // the engine UI stylesheet (prebundled tailwind, dist/bongle.css) — inject it
    // into this iframe. The runner evals the engine JS; its `import './editor.css'`
    // was extracted at prebundle time, so nothing loads it here otherwise.
    try {
        const style = document.createElement('style');
        style.textContent = await fs.readText('node_modules/bongle/dist/bongle.css');
        document.head.appendChild(style);
    } catch (err) {
        console.warn('[client] engine stylesheet missing', err);
    }

    // SPIKE (World C cold-start, task #13): time booting on bongle SOURCE — the
    // runner transforms + evals the engine's ~363 modules + deps in-browser vs
    // the old ~10 prebundled chunks. Numbers land in the client iframe console.
    const spikeT0 = performance.now();
    const spikeMark = (label: string) => console.log(`[spike] ${label}: ${(performance.now() - spikeT0).toFixed(0)}ms`);

    // evaluate the user code via a ModuleRunner bridged to the ONE host
    // DevServer (host transforms; this realm evaluates → its own client
    // registry, which the renderer reads).
    const runner = makeRunner(createPortBridge(bundlerPort));
    // set the runtime env flags on the shared `env` object BEFORE user code /
    // engine eval — mirrors the cli realm entry (edit-client.ts). Compile-time
    // replaceEnv covers literal reads, but runtime/destructured reads fall through
    // to env.js's false defaults, so the editor (env.editor) stays off without this.
    const { env } = await runner.import('bongle/env');
    env.client = true;
    env.server = false;
    env.editor = true;
    await runner.import(msg.entry ?? 'src/index.ts');
    // baked barrel — patches model handles with their bin paths (see server-worker).
    await runner.import('src/generated/models.ts');
    // engine from the SAME runner instance the user code registered into.
    // engine-client wraps its api under `export * as EngineClient`; engine-editor
    // exports its api flat, so its module namespace IS the api.
    const { EngineClient } = await runner.import('bongle/engine-client');
    const EngineEditor = await runner.import('bongle/engine-editor');
    const { __bongle } = await runner.import('bongle/internal');
    spikeMark('engine modules transformed + evaluated');

    const state = EngineClient.init({
        mode: 'edit',
        driver,
        resourceLoader: clientResourceLoader(fs),
        domElement: document.body,
    });

    // registers the EditorScript + commands and mounts the in-world edit UI —
    // must run before load()'s clearPendingChanges sweep. The scene source lets
    // the editor's blueprint sync read scenes from OPFS (no dev-server here).
    await EngineEditor.setup(state, { sceneSource: opfsSceneSource(fs) });
    await EngineClient.load(state);
    spikeMark('client realm booted (cold-start total)');

    __bongle.registerFlush(() => {
        EngineClient.applyRegistryChanges(state);
    });
    __bongle.flush();

    // DevTools automation surface for this client realm: `bongle` in the iframe's
    // console context (fs + the live EngineClient state / api).
    exposeDevtools('client', { fs, state, client: EngineClient, editor: EngineEditor, bongle: __bongle, runner });

    // game transport: inbound frames from the server worker → engine inbox.
    gamePort.onmessage = (e: MessageEvent) => {
        const data = e.data;
        state.net.inbox.push(data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array));
    };

    // frame loop: advance, then drain the outbox onto the game port.
    let last = performance.now();
    const frame = (now: number) => {
        const dt = (now - last) / 1000;
        last = now;
        EngineClient.update(state, dt);
        for (const bytes of state.net.outbox) gamePort.postMessage(bytes);
        state.net.outbox.length = 0;
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    // react to a changed path: re-read the matching scene / baked resource. The
    // bytes are already reachable (OPFS shared for a host, fetched-on-demand for a
    // guest's remote fs); a baked-asset write carries no registry change, so the
    // flush path won't propagate it — refresh the resource directly.
    const applyFsChange = (path: string) => {
        if (path.startsWith('content/scenes/')) {
            EngineEditor.refreshBlueprints();
            EngineEditor.reloadBlueprint(path.replace(/^content\/scenes\//, '').replace(/\.scene\.json$/, ''));
            return;
        }
        if (!path.startsWith('resources/client/')) return;
        if (path.includes('sprite')) EngineClient.refreshSpriteResources(state).catch(console.error);
        else if (path.includes('audio')) EngineClient.refreshAudioResources(state).catch(console.error);
        else EngineClient.refreshBlockResources(state).catch(console.error);
    };

    if (remote) {
        // a guest has no shared OPFS + no parent signalling it — the host pushes
        // its change stream over the fsrpc lane, surfaced as remote-fs watch.
        fs.watch((changes) => {
            for (const c of changes) if (c.type !== 'deleted') applyFsChange(c.path);
        });
    } else {
        // the host's own iframe: the parent signals writes (OPFS has no
        // cross-context events).
        self.addEventListener('message', (e: MessageEvent) => {
            const m = e.data as FsChangeMessage;
            if (m?.type === 'fs-change') applyFsChange(m.path);
        });
    }
}

self.addEventListener('message', (e: MessageEvent) => {
    const msg = e.data as InitMessage;
    if (msg?.type !== 'client-init' || booted) return;
    booted = true;
    // e.ports[0] = game transport (to the server worker), e.ports[1] = bundler
    // transport (to the host DevServer), e.ports[2] = OPTIONAL fsrpc transport —
    // present only for a guest (remote read-through fs); absent for a host's own
    // iframe (shared OPFS).
    const [gamePort, bundlerPort, fsrpcPort] = e.ports;
    if (!gamePort || !bundlerPort) throw new Error('client-init needs game + bundler ports');
    void boot(msg, gamePort, bundlerPort, fsrpcPort).catch((err) => {
        // surface boot failures to the parent for the client window's log.
        window.parent.postMessage({ type: 'client-error', message: (err as Error).message }, '*');
        console.error(err);
    });
});

// tell the parent we're ready to receive a session.
window.parent.postMessage({ type: 'client-ready' }, '*');
