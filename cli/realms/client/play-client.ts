/// <reference types="vite/client" />
// cli/realms/client/play-client.ts — boot the browser PLAY client for
// `bongle dev`. Runs in the `client` (browser) Vite env. Sets env → evaluates user
// code → inits + loads EngineClient (mode:play, WebGPU render + DOM UI) → dials the
// server's /game WS → 60Hz frame loop pumping the engine net inbox/outbox.

import { EngineClient } from 'bongle/engine-client';
import { env } from 'bongle/env';
import { __bongle } from 'bongle/internal';
import { Channel, type ClientDriver } from 'bongle/interface';
import { BUILTIN_BASE_AVATAR_ID } from '../../../src/core/player/base-avatar';

export type StartClientOptions = {
    /** dynamic import of the user src (side-effect registers declarations). */
    userEntry: () => Promise<unknown>;
};

export async function start(opts: StartClientOptions): Promise<void> {
    // env BEFORE user code — top-level declarations may branch on it.
    env.client = true;
    env.server = false;
    env.editor = false;
    await opts.userEntry();

    // /game transport. Opened before the engine so the driver's `send` can close over
    // it; frames the server sends before load are queued by `receive` until the
    // first update.
    const ws = new WebSocket(`ws://${location.host}/game`);
    ws.binaryType = 'arraybuffer';

    // dev has no host platform: matchmake is a no-op, platform verbs inert.
    const driver: ClientDriver = {
        matchmake() {},
        // local dev has no website to navigate to; say so rather than fail silently.
        async transfer({ slug }) {
            console.warn(`[bongle] client.transfer to '${slug}': no platform in local dev, staying here`);
            return false;
        },
        platform: { commercialBreak: async () => {}, rewardedBreak: async () => false },
        // dev play: a stand-in local identity + builtin avatar (no session/account).
        user: { id: 'dev', username: 'dev', avatar: { source: 'bundled', modelId: BUILTIN_BASE_AVATAR_ID } },
        // Uint8Array<ArrayBufferLike> (may be SAB-backed) → send a plain-ArrayBuffer copy.
        send: (_channel, bytes) => ws.send(bytes.slice().buffer),
    };

    // baked client resources (atlas, model bins) are served by the dev server out
    // of the project's resources/client/ (see the serve-resources plugin);
    // runtime-source urls (http / rooted) pass through.
    const resourceLoader = {
        loadBytes: async (url: string): Promise<Uint8Array> => {
            const target = /^(https?:|\/)/.test(url) ? url : `/resources/client/${url.replace(/^\.?\//, '')}`;
            const r = await fetch(target);
            if (!r.ok) throw new Error(`fetch ${target}: ${r.status}`);
            return new Uint8Array(await r.arrayBuffer());
        },
    };

    const state = EngineClient.init({ mode: 'play', driver, resourceLoader, domElement: document.body });
    // mount the play UI (Viewport owns the canvas) BEFORE load — load's resize
    // needs the viewport element to size the renderer. Then registerFlush + the
    // initial flush AFTER load, so applyRegistryChanges sees the render tier the
    // load set up (otherwise settingsForTier reads a null tier). Mirrors the editor.
    EngineClient.mountPlayUI(state.domElement);
    await EngineClient.load(state);
    __bongle.registerFlush(() => EngineClient.applyRegistryChanges(state));
    __bongle.flush();

    ws.addEventListener('message', (e) => EngineClient.receive(state, Channel.RELIABLE, new Uint8Array(e.data as ArrayBuffer)));
    await new Promise<void>((res) => ws.addEventListener('open', () => res(), { once: true }));

    let last = performance.now();
    const frame = (now: number): void => {
        const dt = (now - last) / 1000;
        last = now;
        EngineClient.update(state, dt);
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
}
