// cli/dev/vite/virtual-entries.ts — serves the node-env boot modules as Vite
// virtuals. start.ts imports these through each env's runner and calls boot(ctx):
//   virtual:bongle/edit-server → runtime/edit-server (EngineServer + /game WS)
//   virtual:bongle/pipeline    → runtime/pipeline (data bake on flush)
// Each virtual wires a userEntry that dynamic-imports the project src (so user
// declarations evaluate after env is set). The client boots from the real shell.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const EDIT_SERVER = fileURLToPath(new URL('./runtime/edit-server.ts', import.meta.url));
const PIPELINE = fileURLToPath(new URL('./runtime/pipeline.ts', import.meta.url));

export function virtualEntries(opts: { projectDir: string }): Plugin {
    const projectDir = path.resolve(opts.projectDir);
    const userSrc = path.join(projectDir, 'src', 'index.ts');
    const userEntryExpr = `() => import(${JSON.stringify(userSrc)})`;

    const modules: Record<string, string> = {
        'virtual:bongle/edit-server': `import { start } from ${JSON.stringify(EDIT_SERVER)};
export function boot(ctx) {
    return start({ httpServer: ctx.httpServer, projectDir: ${JSON.stringify(projectDir)}, userEntry: ${userEntryExpr} });
}`,
        'virtual:bongle/pipeline': `import { start } from ${JSON.stringify(PIPELINE)};
export function boot(ctx) {
    return start({ projectDir: ${JSON.stringify(projectDir)}, userEntry: ${userEntryExpr}, onBaked: ctx.onBaked });
}`,
    };

    return {
        name: 'bongle:virtual-entries',
        resolveId(id) {
            return id in modules ? `\0${id}` : null;
        },
        load(id) {
            return id.startsWith('\0virtual:bongle/') ? (modules[id.slice(1)] ?? null) : null;
        },
    };
}
