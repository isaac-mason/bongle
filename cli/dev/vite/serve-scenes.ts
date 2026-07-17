// cli/dev/vite/serve-scenes.ts — serve the project's scene files to the in-game
// editor's SceneSource: GET /__bongle/scenes → id list; GET /__bongle/scenes/<id>
// → raw JSON. Read-only; scene WRITES flow through the engine's scene protocol to
// the edit server's disk persist (edit-server.ts).

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

const SCENE_EXT = '.scene.json';

export function serveScenes(opts: { projectDir: string }): Plugin {
    const scenesDir = path.join(path.resolve(opts.projectDir), 'content', 'scenes');
    const listScenes = async (): Promise<string[]> => {
        const out: string[] = [];
        const walk = async (dir: string, prefix: string): Promise<void> => {
            for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
                if (e.isDirectory()) await walk(path.join(dir, e.name), `${prefix}${e.name}/`);
                else if (e.name.endsWith(SCENE_EXT)) out.push(`${prefix}${e.name.slice(0, -SCENE_EXT.length)}`);
            }
        };
        await walk(scenesDir, '');
        return out;
    };
    return {
        name: 'bongle:serve-scenes',
        configureServer(server) {
            server.middlewares.use('/__bongle/scenes', (req, res, next) => {
                const rest = decodeURIComponent((req.url ?? '/').split('?')[0].replace(/^\/+/, ''));
                if (!rest) {
                    listScenes().then((ids) => {
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify(ids));
                    }, next);
                    return;
                }
                const file = path.join(scenesDir, `${rest}${SCENE_EXT}`);
                if (!file.startsWith(scenesDir)) return next();
                readFile(file, 'utf8').then(
                    (content) => {
                        res.setHeader('Content-Type', 'application/json');
                        res.end(content);
                    },
                    () => {
                        res.statusCode = 404;
                        res.end('not found');
                    },
                );
            });
        },
    };
}
