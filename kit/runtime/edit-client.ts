/// <reference types="vite/client" />
/**
 * kit/runtime/edit-client.ts — browser entry for the editor in dev mode.
 *
 * Loaded by the `<script>` tag in `<project>/.bongle/index.html` via the
 * `virtual:bongle/edit-client` virtual module (served by
 * `kit/vite/virtual-entries.ts`). The virtual passes a `userEntry` thunk
 * that dynamic-imports `virtual:bongle/user-src` — which itself side-effect
 * imports the project's `src/generated` + `src/index`.
 *
 * Flow:
 *  1. Set env flags BEFORE awaiting user-entry. Top-level user-code
 *     declarations may branch on env.
 *  2. Await `opts.userEntry()`.
 *  3. EngineClient.init.
 *  4. EngineEditor.setup — runs BEFORE load so EditorScript + commands
 *     land in the registry before load()'s clearPendingChanges sweep.
 *  5. Ready-poll loader. The bongle:pipeline plugin runs the Node-side
 *     asset pipeline lazily on first HMR cascade, so a cold dev server
 *     can hand the editor a missing voxels-atlas.json and break load().
 *     Poll /__bongle/ready and show a minimal loader until first pass
 *     settles. Edit-only — prod / play don't ship this.
 *  6. EngineClient.load, mount domElement, register flush handler.
 *  7. scene-HMR + atlas-update + sprite-atlas-update listeners.
 *  8. WS to /game on same origin (works over cloudflared too).
 *  9. RAF frame loop.
 */

import { env } from 'bongle';
import { EngineClient, browserResourceLoader } from 'bongle/engine-client';
import * as EngineEditor from 'bongle/engine-editor';
import { __kit } from 'bongle/internal';

export type StartOptions = {
    userEntry: () => Promise<unknown>;
};

/**
 * Order-preserving latency hold for the WS frames in/out of the editor.
 * WS is reliable and in-order, so each frame's release time is clamped to
 * never precede the previous one's — this simulates delay, never reordering
 * or loss. Frames always flow through the queue; when latency sim is off the
 * delay is 0, so they release on the next drain (and any backlog flushes in
 * order as the configured rtt winds down).
 */
type DelayQueue = {
    queue: { releaseAt: number; bytes: Uint8Array }[];
    lastReleaseAt: number;
};

const createDelayQueue = (): DelayQueue => ({ queue: [], lastReleaseAt: 0 });

function enqueue(q: DelayQueue, bytes: Uint8Array, now: number, delayMs: number) {
    const releaseAt = Math.max(now + delayMs, q.lastReleaseAt);
    q.lastReleaseAt = releaseAt;
    q.queue.push({ releaseAt, bytes });
}

function drain(q: DelayQueue, now: number, sink: (bytes: Uint8Array) => void) {
    while (q.queue.length > 0 && q.queue[0].releaseAt <= now) {
        sink(q.queue.shift()!.bytes);
    }
}

/** Per-direction hold in ms — half the configured round-trip, or 0 when off. */
function simHalfRttMs(): number {
    const s = EngineEditor.useEditor.getState();
    return s.netSimEnabled ? s.netSimRttMs / 2 : 0;
}

export async function start(opts: StartOptions) {
    env.client = true;
    env.server = false;
    env.editor = true;

    await opts.userEntry();

    const state = EngineClient.init({
        mode: 'edit',
        driver: {
            matchmake() {},
            platform: { commercialBreak: async () => {}, rewardedBreak: async () => false },
        },
        resourceLoader: browserResourceLoader,
    });

    // EditorScript + commands land in the registry before load()'s
    // clearPendingChanges sweep.
    await EngineEditor.setup(state);

    // Editor-dev pipeline gate. Wait for the first Node-side asset
    // pipeline pass before calling load() — otherwise voxels-atlas.json
    // may not exist yet and load() fails.
    {
        const loader = document.createElement('div');
        loader.style.cssText = 'position:fixed;inset:0;background:#fff;display:flex;align-items:center;justify-content:center;font-family:system-ui;font-size:13px;color:#000;z-index:99999';
        loader.innerHTML = '<div style="border:1px solid #000;padding:0.75rem 1rem"><div data-status>Starting…</div></div>';
        document.body.appendChild(loader);
        const statusEl = loader.querySelector('[data-status]');
        while (true) {
            try {
                const r = await fetch('/__bongle/ready');
                const j = await r.json() as { ready: boolean; status: string | null };
                if (j.ready) break;
                if (statusEl && j.status) statusEl.textContent = j.status;
            } catch {}
            await new Promise((r) => setTimeout(r, 200));
        }
        loader.remove();
    }

    await EngineClient.load(state);

    __kit.registerFlush(() => EngineClient.applyRegistryChanges(state));

    if (import.meta.hot) {
        import.meta.hot.on('bongle:scene-update', (msg: { id: string; scene: string }) => {
            const file = JSON.parse(msg.scene);
            const voxels = file.chunks ? { chunks: file.chunks } : null;
            EngineClient.applyScenePayload(state, msg.id, { nodes: file.nodes, voxels });
        });
        import.meta.hot.on('bongle:scene-clear', (msg: { id: string }) => {
            EngineClient.clearScene(state, msg.id);
        });
        // Plugin emits after a Node-side atlas pass writes fresh
        // voxels-atlas.{png,json}. No registry change rides on a PNG edit,
        // so the regular applyRegistryChanges block branch never fires —
        // this listener is the only path that propagates image edits into
        // the live client.
        import.meta.hot.on('bongle:block-texture-atlas-updated', () => {
            EngineClient.refreshBlockResources(state).catch((err) => {
                console.error('[bongle] refreshBlockResources failed:', err);
            });
        });
        // Sibling of the voxel-atlas event for the sprite atlas.
        import.meta.hot.on('bongle:sprite-atlas-updated', () => {
            EngineClient.refreshSpriteResources(state).catch((err) => {
                console.error('[bongle] refreshSpriteResources failed:', err);
            });
        });
        // Sibling for the audio manifest/atlas — a sound source-file edit
        // re-bakes the atlas but carries no registry change, so this is the
        // only path that reloads the decoded buffers in the live client.
        import.meta.hot.on('bongle:audio-atlas-updated', () => {
            EngineClient.refreshAudioResources(state).catch((err) => {
                console.error('[bongle] refreshAudioResources failed:', err);
            });
        });
    }

    // Same origin as the page; the bongle:pipeline plugin in the same
    // process only claims /game upgrades, so other paths still hit Vite's
    // HMR ws. Using location.host (not a hardcoded port) lets this work
    // over a cloudflared tunnel too.
    const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/game';
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    // server→client (inbound) and client→server (outbound) hold queues, used
    // by the latency simulator. Held inbound frames are released into the
    // engine inbox at the top of the frame, before update(); held outbound
    // frames are released onto the socket after update().
    const inbound = createDelayQueue();
    const outbound = createDelayQueue();
    ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') return;
        enqueue(inbound, new Uint8Array(ev.data as ArrayBuffer), performance.now(), simHalfRttMs());
    };

    let last = performance.now();
    const frame = (now: number) => {
        const dt = (now - last) / 1000;
        last = now;
        drain(inbound, now, (bytes) => state.net.inbox.push(bytes));
        EngineClient.update(state, dt);
        for (const msg of state.net.outbox) enqueue(outbound, msg, now, simHalfRttMs());
        state.net.outbox.length = 0;
        drain(outbound, now, (bytes) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(bytes);
        });
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
}
