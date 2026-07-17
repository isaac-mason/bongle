// cli/dev/serve-resources.ts — serve the project's baked client resources
// (resources/client/**: atlases, model bins, icons) at /resources/client/*. The
// play client's resourceLoader fetches them from there. Vite's root is the shell
// dir, so these live outside it — this middleware bridges to the project.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';
import { contentType } from '../../build';

export function serveResources(opts: { projectDir: string }): Plugin {
    const clientDir = path.join(path.resolve(opts.projectDir), 'resources', 'client');
    return {
        name: 'bongle:serve-resources',
        configureServer(server) {
            server.middlewares.use('/resources/client', (req, res, next) => {
                const rel = decodeURIComponent((req.url ?? '/').split('?')[0].replace(/^\/+/, ''));
                const file = path.join(clientDir, rel);
                if (!file.startsWith(clientDir)) return next(); // path-traversal guard
                stat(file).then(
                    (s) => {
                        if (!s.isFile()) return next();
                        res.setHeader('Content-Type', contentType(file));
                        res.setHeader('Cache-Control', 'no-store');
                        createReadStream(file).pipe(res);
                    },
                    () => next(),
                );
            });
        },
    };
}
