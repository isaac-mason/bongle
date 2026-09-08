/// <reference types="vite/client" />
// cli/realms/client/play-client.ts, the browser PLAY client for `bongle dev`. Runs in
// the `client` (browser) Vite env: sets env, evaluates user code, drives the engine's
// own ClientApp (the same one a deployed bundle exports) over the dev server's /game
// socket, with the registry watched for HMR.

import { EngineClient } from 'bongle/engine-client';
import { env } from 'bongle/env';
import { Channel } from 'bongle/interface';
import { devUser, frameLoop, inertPlatform, transferNotWired } from '../../../build';
import { BUILTIN_BASE_AVATAR_ID } from '../../../src/core/player/base-avatar';
import { dialGame, httpResourceLoader, opened } from './dev-host';

export type StartClientOptions = {
    /** dynamic import of the user src (side-effect registers declarations). */
    userEntry: () => Promise<unknown>;
};

export async function start(opts: StartClientOptions): Promise<void> {
    // env BEFORE user code: top-level declarations may branch on it.
    env.client = true;
    env.server = false;
    env.editor = false;
    await opts.userEntry();

    const ws = dialGame();
    const app = EngineClient.app({ resourceLoader: httpResourceLoader, domElement: document.body });
    const state = app.init({
        matchmake() {},
        transfer: transferNotWired('no platform in local dev'),
        platform: inertPlatform,
        user: devUser({ source: 'bundled', modelId: BUILTIN_BASE_AVATAR_ID }),
        // Uint8Array<ArrayBufferLike> (may be SAB-backed): send a plain-ArrayBuffer copy.
        send: (_channel, bytes) => ws.send(bytes.slice().buffer),
    });
    ws.addEventListener('message', (e) => app.receive(state, Channel.RELIABLE, new Uint8Array(e.data as ArrayBuffer)));
    await app.load(state);
    // AFTER load, so the first apply sees the render tier the load set up.
    EngineClient.watchRegistry(state);
    await opened(ws);

    frameLoop((dt) => app.update(state, dt));
}
