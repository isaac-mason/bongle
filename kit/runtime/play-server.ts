/**
 * kit/runtime/play-server.ts — prod server adapter.
 *
 * Default-exports the `bongle/interface` server adapter that the
 * platform host (or `bongle start`'s local host) calls. The
 * `virtual:bongle/build-server` virtual entry (served by
 * `kit/vite/virtual-entries.ts`) does the user-entry side-effect imports
 * (`src/generated` + `src/index`) at module load time, THEN re-exports
 * this adapter. Env is flipped inside `init()` rather than at module
 * load — matches the prod build's established ordering.
 *
 * content/ + resources/ are copied into dist/server/ next to index.js by
 * the build (see kit/build.ts). Resolve them via import.meta.url so the
 * engine never falls back to process.cwd(). Vite inlines this module
 * into `dist/server/index.js` so import.meta.url evaluates to the bundle
 * entry's URL at runtime.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { env } from 'bongle';
import { server } from 'bongle/interface';
import { EngineServer } from 'bongle/engine-server';

const here = path.dirname(fileURLToPath(import.meta.url));
const contentDir = path.join(here, 'content');
const resourcesDir = path.join(here, 'resources');

export default server({
    init: (opts) => {
        env.client = false;
        env.server = true;
        env.editor = false;
        return EngineServer.init({ mode: 'play', contentDir, resourcesDir, options: opts.options, driver: opts.driver });
    },
    load: async (state) => {
        await EngineServer.load(state);
    },
    update: (state, dt) => EngineServer.update(state, dt),
    dispose: (state) => EngineServer.dispose(state),
    onClientJoin: (state, client, user, joinData) => EngineServer.onClientJoin(state, client, user, joinData),
    onClientLeave: (state, client) => EngineServer.onClientLeave(state, client),
    getInbox: (state) => state.net.inbox,
    getOutbox: (state) => state.net.outbox,
    clearOutbox: (state) => { state.net.outbox.clear(); },
});
