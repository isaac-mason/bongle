/**
 * bongle:virtual-entries — serves the kit's boot entries as Vite virtual
 * modules, plus the two HTML shells the dev server serves from memory.
 *
 * Virtual ids (resolved internally to `\0virtual:bongle/<name>`):
 *
 *   virtual:bongle/edit-client
 *   virtual:bongle/edit-server     (game-env.ts imports this through the
 *                                   gameServer runner and calls boot(ctx))
 *   virtual:bongle/pipeline        (HTML script-src target for the
 *                                   puppeteer pipeline page)
 *   virtual:bongle/build-client    (lib.entry for `bongle build` client)
 *   virtual:bongle/build-server    (lib.entry for `bongle build` server)
 *   virtual:bongle/user-src        (dynamic-imported by edit/pipeline
 *                                   entries; static-imported by build
 *                                   entries; statically imports the user's
 *                                   `src/generated` + `src/index` and ends
 *                                   the HMR self-accept cascade)
 *
 * Env-set-ordering invariant: dev entries (edit-client / edit-server /
 * pipeline) call into `runtime/*.start()`, which sets `env.{client,
 * server,editor}` BEFORE awaiting `opts.userEntry()`. The userEntry thunk
 * dynamic-imports `virtual:bongle/user-src` so user code's top-level
 * `model()/block()/script()/...` declarations evaluate AFTER env is set.
 * ESM static-import hoisting can't reorder past the dynamic import.
 *
 * Build entries don't need a dynamic boundary — `play-{client,server}`
 * set env inside their `init()`, not at module top level — so the
 * build virtuals static-import user-src to keep ESM init order
 * predictable.
 *
 * HTML shells: `configureServer` adds connect middleware that intercepts
 * `/`, `/index.html`, and `/pipeline.html` and responds with inline HTML
 * passed through `server.transformIndexHtml()` (so Vite's HMR client
 * script gets injected). No on-disk index.html / pipeline.html needed
 * under bongleDir.
 *
 * Plugin is shared between dev (via the bongle() plugin array) and
 * build (added to runBuild's plugins). resolveId/load run in both
 * modes; absolute fs paths inside the user-src virtual resolve in dev
 * (Vite fs allow covers projectDir) and in build (Rollup off disk).
 * configureServer is dev-only.
 */

import path from 'node:path';
import type { Plugin } from 'vite';

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>bongle</title>
    <style>
        body { margin: 0; padding: 0; overflow: hidden; }
        canvas { width: 100vw; height: 100vh; }
    </style>
</head>
<body>
    <script type="module" src="/@id/virtual:bongle/edit-client"></script>
</body>
</html>
`;

const PIPELINE_HTML = `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>bongle pipeline</title>
</head>
<body>
    <script type="module" src="/@id/virtual:bongle/pipeline"></script>
</body>
</html>
`;

const PREFIX = 'virtual:bongle/';
const RESOLVED_PREFIX = '\0' + PREFIX;

const NAMES = new Set([
    'edit-client',
    'edit-server',
    'pipeline',
    'build-client',
    'build-server',
    'user-src',
]);

export interface VirtualEntriesOptions {
    projectDir: string;
}

export function virtualEntriesPlugin(opts: VirtualEntriesOptions): Plugin {
    const projectDir = path.resolve(opts.projectDir);
    const userSrcGenerated = path.join(projectDir, 'src', 'generated', 'index.ts');
    const userSrcIndex = path.join(projectDir, 'src', 'index.ts');

    return {
        name: 'bongle:virtual-entries',
        resolveId(id) {
            if (!id.startsWith(PREFIX)) return null;
            const name = id.slice(PREFIX.length);
            if (!NAMES.has(name)) return null;
            return RESOLVED_PREFIX + name;
        },
        load(id) {
            if (!id.startsWith(RESOLVED_PREFIX)) return null;
            const name = id.slice(RESOLVED_PREFIX.length);
            switch (name) {
                case 'edit-client':
                    return /* js */ `
import { start } from 'bongle/kit/runtime/edit-client';
await start({ userEntry: () => import('virtual:bongle/user-src') });
`;
                case 'edit-server':
                    return /* js */ `
import { start } from 'bongle/kit/runtime/edit-server';
export function boot(ctx) {
    return start({
        httpServer: ctx.httpServer,
        projectDir: ctx.projectDir,
        bongleDir: ctx.bongleDir,
        userEntry: () => import('virtual:bongle/user-src'),
    });
}
`;
                case 'pipeline':
                    return /* js */ `
import { start } from 'bongle/kit/runtime/pipeline';
await start({ userEntry: () => import('virtual:bongle/user-src') });
`;
                case 'build-client':
                    return /* js */ `
import ${JSON.stringify(userSrcGenerated)};
import ${JSON.stringify(userSrcIndex)};
export { default } from 'bongle/kit/runtime/play-client';
`;
                case 'build-server':
                    return /* js */ `
import ${JSON.stringify(userSrcGenerated)};
import ${JSON.stringify(userSrcIndex)};
export { default } from 'bongle/kit/runtime/play-server';
`;
                case 'user-src':
                    // HMR self-accept terminator. The capture-transform
                    // plugin's `hot.invalidate()` cascade walks importers;
                    // this is the topmost importer of every user-src
                    // file, so the cascade settles here with a single
                    // __kit.flush() call. No-op in build (no import.meta.hot).
                    return /* js */ `
import ${JSON.stringify(userSrcGenerated)};
import ${JSON.stringify(userSrcIndex)};
import { __kit } from 'bongle/internal';
if (import.meta.hot) {
    import.meta.hot.accept(() => { __kit.flush(); });
}
`;
            }
            return null;
        },
        configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
                const url = req.url?.split('?')[0];
                let html: string | null = null;
                if (url === '/' || url === '/index.html') html = INDEX_HTML;
                else if (url === '/pipeline.html') html = PIPELINE_HTML;
                if (html === null) return next();
                try {
                    const transformed = await server.transformIndexHtml(req.url ?? '/', html);
                    res.setHeader('Content-Type', 'text/html; charset=utf-8');
                    res.end(transformed);
                } catch (err) {
                    next(err);
                }
            });
        },
    };
}
