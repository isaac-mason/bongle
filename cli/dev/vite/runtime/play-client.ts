/// <reference types="vite/client" />
// cli/dev/vite/runtime/play-client.ts — boot the browser PLAY client for
// `bongle dev`. Runs in the `client` (browser) Vite env. Sets env → evaluates user
// code → inits + loads EngineClient (mode:play, WebGPU render + DOM UI) → dials the
// server's /game WS → 60Hz frame loop pumping the engine net inbox/outbox.

import { EngineClient } from 'bongle/engine-client';
import { env } from 'bongle/env';
import { __kit } from 'bongle/internal';
import type { ClientDriver } from 'bongle/interface';

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

    // dev has no host portal: matchmake is a no-op, platform verbs inert.
    const driver: ClientDriver = {
        matchmake() {},
        platform: { commercialBreak: async () => {}, rewardedBreak: async () => false },
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
    __kit.registerFlush(() => EngineClient.applyRegistryChanges(state));
    __kit.flush();

    // /game transport: inbound server frames → engine inbox; the frame loop
    // advances then drains the outbox onto the socket.
    const ws = new WebSocket(`ws://${location.host}/game`);
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', (e) => state.net.inbox.push(new Uint8Array(e.data as ArrayBuffer)));
    await new Promise<void>((res) => ws.addEventListener('open', () => res(), { once: true }));

    let last = performance.now();
    const frame = (now: number): void => {
        const dt = (now - last) / 1000;
        last = now;
        EngineClient.update(state, dt);
        // Uint8Array<ArrayBufferLike> (may be SAB-backed) → send a plain-ArrayBuffer copy.
        for (const bytes of state.net.outbox) ws.send(bytes.slice().buffer);
        state.net.outbox.length = 0;
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
}
