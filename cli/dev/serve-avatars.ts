// cli/dev/serve-avatars.ts — serve the engine's sample-avatar .glb files at
// /__bongle/avatars/<slug>.glb. The fallback avatars driver (edit-server) hands the
// client those same-origin URLs; this middleware resolves them to the real files in
// lib/avatars (resolveSampleAvatarFile guards the route prefix itself).

import { createReadStream } from 'node:fs';
import type { Plugin } from 'vite';
import { resolveSampleAvatarFile } from '../../src/server/avatars-fallback';

export function serveAvatars(): Plugin {
    return {
        name: 'bongle:serve-avatars',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const file = resolveSampleAvatarFile((req.url ?? '/').split('?')[0]);
                if (!file) return next();
                res.setHeader('Content-Type', 'model/gltf-binary');
                res.setHeader('Cache-Control', 'no-store');
                createReadStream(file).pipe(res);
            });
        },
    };
}
