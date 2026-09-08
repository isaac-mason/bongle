/// <reference types="vite/client" />
// cli/realms/client/edit-client.ts, the browser EDIT client for `bongle dev`. Runs the
// game client in mode:'edit' with the editor mounted on it (the in-project scene +
// voxel editing tools; your IDE is the code editor). Served by the Vite `client` env;
// dials the edit server over /game through the debug pane's latency sim.
//
// (Play-from-source lives in play-client.ts, reserved for `bongle start`/preview.)

import { EngineClient } from 'bongle/engine-client';
import * as EngineClientEditor from 'bongle/engine-client-editor';
import { env } from 'bongle/env';
import { Channel } from 'bongle/interface';
import { devUser, editorNetSim, frameLoop, inertPlatform, transferNotWired } from '../../../build';
import { BUILTIN_BASE_AVATAR_ID } from '../../../src/core/player/base-avatar';
import { dialGame, httpResourceLoader, httpSceneSource, opened } from './dev-host';

export type StartClientOptions = {
    userEntry: () => Promise<unknown>;
};

export async function start(opts: StartClientOptions): Promise<void> {
    env.client = true;
    env.server = false;
    env.editor = true;
    await opts.userEntry();
    // the baked barrel patches model handles with their bin paths (mirrors the
    // editor realm importing src/generated/models.ts). Without it, `model()`
    // handles keep their cold-start placeholder and render as placeholder nodes.
    // @ts-expect-error a Vite resolve.alias (<projectDir>/src/generated/models.ts), not resolvable by tsgo.
    await import('bongle-project-models');

    const ws = dialGame();
    const netSim = editorNetSim<ArrayBuffer>(EngineClientEditor.useEditor, {
        deliverInbound: (bytes) => EngineClient.receive(state, Channel.RELIABLE, bytes),
        deliverOutbound: (buf) => ws.send(buf),
    });
    const state = EngineClient.init({
        mode: 'edit',
        driver: {
            matchmake() {},
            // the editor is not a play page: a transfer would open the target elsewhere.
            transfer: transferNotWired('not wired in the editor yet'),
            platform: inertPlatform,
            user: devUser({ source: 'bundled', modelId: BUILTIN_BASE_AVATAR_ID }),
            // outbound frames go through the net-sim delay line before the socket; the
            // engine only calls this from inside update. SAB-backed views get copied.
            send: (_channel, bytes) => netSim.send(bytes.slice().buffer, performance.now()),
        },
        resourceLoader: httpResourceLoader,
        domElement: document.body,
    });
    ws.addEventListener('message', (e) => netSim.receive(new Uint8Array(e.data as ArrayBuffer), performance.now()));

    // the editor mounts BEFORE load (its clearPendingChanges sweep); the registry is
    // watched AFTER, so the first apply sees the render tier. Resources are already
    // baked (the startup child-bake), so no pipeline-ready gate is needed.
    EngineClientEditor.setup(state, { sceneSource: httpSceneSource });
    await EngineClient.load(state);
    EngineClient.watchRegistry(state);
    installSceneHmr(state);
    await opened(ws);

    frameLoop((dt, now) => {
        netSim.pump(now); // release due inbound before update reads it
        EngineClient.update(state, dt);
        netSim.pump(now); // flush just-queued outbound that's due (immediate when disabled)
    });
}

/** scene HMR: a .scene.json edit on disk becomes a live update in the running world. */
function installSceneHmr(state: ReturnType<typeof EngineClient.init>): void {
    if (!import.meta.hot) return;
    import.meta.hot.on('bongle:scene-update', (msg: { id: string; scene: string }) => {
        const file = JSON.parse(msg.scene);
        EngineClient.applyScenePayload(state, msg.id, {
            nodes: file.nodes,
            voxels: file.chunks ? { chunks: file.chunks } : null,
        });
    });
    import.meta.hot.on('bongle:scene-clear', (msg: { id: string }) => EngineClient.clearScene(state, msg.id));
}
