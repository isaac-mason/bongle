/// <reference types="vite/client" />
// cli/dev/vite/runtime/edit-client.ts — the browser EDIT client for `bongle dev`.
// Runs the game client in mode:'edit' — the in-game scene + voxel editing tools
// (EngineEditor.setup mounts the edit UI). Your IDE is the code editor; this is the
// in-game editor. Served by the Vite `client` env; dials the edit server over /game.
//
// (Play-from-source lives in play-client.ts, reserved for `bongle start`/preview.)

import { EngineClient } from 'bongle/engine-client';
import * as EngineEditor from 'bongle/engine-editor';
import { env } from 'bongle/env';
import { __kit } from 'bongle/internal';
import type { ClientDriver } from 'bongle/interface';

export type StartClientOptions = {
    userEntry: () => Promise<unknown>;
};

export async function start(opts: StartClientOptions): Promise<void> {
    env.client = true;
    env.server = false;
    env.editor = true;
    await opts.userEntry();

    const driver: ClientDriver = {
        matchmake() {},
        platform: { commercialBreak: async () => {}, rewardedBreak: async () => false },
    };
    const resourceLoader = {
        loadBytes: async (url: string): Promise<Uint8Array> => {
            const target = /^(https?:|\/)/.test(url) ? url : `/resources/client/${url.replace(/^\.?\//, '')}`;
            const r = await fetch(target);
            if (!r.ok) throw new Error(`fetch ${target}: ${r.status}`);
            return new Uint8Array(await r.arrayBuffer());
        },
    };
    // the editor lists/reads scene files over HTTP from the dev server (writes flow
    // through the engine's scene protocol to the server's disk persist).
    const sceneSource: EngineEditor.SceneSource = {
        listScenes: async () => {
            const r = await fetch('/__bongle/scenes');
            return r.ok ? ((await r.json()) as string[]) : [];
        },
        readScene: async (id) => {
            const r = await fetch(`/__bongle/scenes/${encodeURIComponent(id)}`);
            return r.ok ? await r.text() : null;
        },
    };

    const state = EngineClient.init({ mode: 'edit', driver, resourceLoader, domElement: document.body });
    // EngineEditor.setup registers the editor client + mounts the in-world edit UI —
    // BEFORE load() (its clearPendingChanges sweep). Then flush AFTER load so the
    // registry apply sees the render tier load set up. Resources are already baked
    // (startup child-bake), so no pipeline-ready gate is needed.
    await EngineEditor.setup(state, { sceneSource });
    await EngineClient.load(state);
    __kit.registerFlush(() => EngineClient.applyRegistryChanges(state));
    __kit.flush();

    // scene HMR: a .scene.json edit on disk → live update in the running world.
    if (import.meta.hot) {
        import.meta.hot.on('bongle:scene-update', (msg: { id: string; scene: string }) => {
            const file = JSON.parse(msg.scene);
            EngineClient.applyScenePayload(state, msg.id, { nodes: file.nodes, voxels: file.chunks ? { chunks: file.chunks } : null });
        });
        import.meta.hot.on('bongle:scene-clear', (msg: { id: string }) => EngineClient.clearScene(state, msg.id));
    }

    const ws = new WebSocket(`ws://${location.host}/game`);
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', (e) => state.net.inbox.push(new Uint8Array(e.data as ArrayBuffer)));
    await new Promise<void>((res) => ws.addEventListener('open', () => res(), { once: true }));

    let last = performance.now();
    const frame = (now: number): void => {
        const dt = (now - last) / 1000;
        last = now;
        EngineClient.update(state, dt);
        for (const bytes of state.net.outbox) ws.send(bytes.slice().buffer);
        state.net.outbox.length = 0;
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
}
