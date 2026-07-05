/**
 * kit/runtime/play-client.ts — prod client adapter.
 *
 * Default-exports the `bongle/interface` client adapter that the
 * platform host (or `bongle start`'s local host) calls. The
 * `virtual:bongle/build-client` virtual entry (served by
 * `kit/vite/virtual-entries.ts`) does the user-entry side-effect imports
 * (`src/generated` + `src/index`) at module load time, THEN re-exports
 * this adapter. Env is flipped inside `init()` rather than at module
 * load — matches the prod build's established ordering.
 */

import { env } from 'bongle';
import { client } from 'bongle/interface';
import { EngineClient, browserResourceLoader } from 'bongle/engine-client';

export default client({
    init: (driver) => {
        env.client = true;
        env.server = false;
        env.editor = false;
        return EngineClient.init({ mode: 'play', driver, resourceLoader: browserResourceLoader, domElement: document.body });
    },
    load: async (state) => {
        // Mount the play-mode React UI shell before load() — the
        // Viewport component owns the canvas, and load()'s resize
        // callback needs viewportElement set to size the renderer.
        // EngineClient.init appends state.domElement to document.body,
        // so the container is in the document by this point.
        EngineClient.mountPlayUI(state.domElement);
        await EngineClient.load(state);
    },
    update: (state, dt) => EngineClient.update(state, dt),
    dispose: (state) => EngineClient.dispose(state),
    getInbox: (state) => state.net.inbox,
    getOutbox: (state) => state.net.outbox,
    clearOutbox: (state) => { state.net.outbox.length = 0; },
});
