// editor/client/client-main.ts — the CLIENT realm, one per <iframe> window.
//
// A separate origin + document from the main editor (see client/vite.config.ts
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

import type { ClientDriver } from '../../interface/index';
import { createPortBridge } from '../bundler/port-bridge';
import { makeRunner } from '../bundler/runner';
import { exposeDevtools } from '../devtools';
import type { Filesystem } from '../fs';
import { openOpfsFilesystem } from '../fs-opfs';

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

async function boot(msg: InitMessage, gamePort: MessagePort, bundlerPort: MessagePort): Promise<void> {
    // open the SAME OPFS project the main doc uses (same origin) — baked
    // resources the pipeline wrote are visible directly; no snapshot.
    const fs = await openOpfsFilesystem(msg.projectName);

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

    // evaluate the user code via a ModuleRunner bridged to the ONE host
    // DevServer (host transforms; this realm evaluates → its own client
    // registry, which the renderer reads).
    const runner = makeRunner(createPortBridge(bundlerPort));
    // set the runtime env flags on the shared `env` object BEFORE user code /
    // engine eval — mirrors the kit entry (edit-client.ts). Compile-time
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
    const { __kit } = await runner.import('bongle/internal');

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

    __kit.registerFlush(() => {
        EngineClient.applyRegistryChanges(state);
    });
    __kit.flush();

    // DevTools automation surface for this client realm: `bongle` in the iframe's
    // console context (fs + the live EngineClient state / api).
    exposeDevtools('client', { fs, state, client: EngineClient, editor: EngineEditor, kit: __kit, runner });

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

    // incremental fs updates from the parent: HMR source, refresh baked assets.
    self.addEventListener('message', (e: MessageEvent) => {
        const m = e.data as FsChangeMessage;
        if (m?.type !== 'fs-change') return;
        // a scene file changed on disk → re-list (handles added/removed
        // blueprints) and re-read the specific scene (handles edits to one).
        if (m.path.startsWith('content/scenes/')) {
            EngineEditor.refreshBlueprints();
            EngineEditor.reloadBlueprint(m.path.replace(/^content\/scenes\//, '').replace(/\.scene\.json$/, ''));
            return;
        }
        // OPFS is shared — the new bytes are already here. A baked-asset write
        // carries no registry change, so the flush path won't propagate it;
        // refresh the matching resource directly (re-reads OPFS).
        if (!m.path.startsWith('resources/client/')) return;
        if (m.path.includes('sprite')) EngineClient.refreshSpriteResources(state).catch(console.error);
        else if (m.path.includes('audio')) EngineClient.refreshAudioResources(state).catch(console.error);
        else EngineClient.refreshBlockResources(state).catch(console.error);
    });
}

self.addEventListener('message', (e: MessageEvent) => {
    const msg = e.data as InitMessage;
    if (msg?.type !== 'client-init' || booted) return;
    booted = true;
    // e.ports[0] = game transport (to the server worker), e.ports[1] = bundler
    // transport (to the host DevServer).
    const [gamePort, bundlerPort] = e.ports;
    if (!gamePort || !bundlerPort) throw new Error('client-init needs game + bundler ports');
    void boot(msg, gamePort, bundlerPort).catch((err) => {
        // surface boot failures to the parent for the client window's log.
        window.parent.postMessage({ type: 'client-error', message: (err as Error).message }, '*');
        console.error(err);
    });
});

// tell the parent we're ready to receive a session.
window.parent.postMessage({ type: 'client-ready' }, '*');
