import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * Minimal capture-transform for production builds: every user-src `.ts`/`.tsx`
 * gets a top-of-file `import { __kit } from 'bongle/internal'` so the
 * asset-pipeline codegen barrels (`src/generated/{scenes,models,sounds}.ts`)
 * can call `__kit.registerScene(...)` etc. as bare free variables.
 *
 * The dev `bongle()` plugin (kit/src/vite/plugin.ts) injects the same
 * import plus `__kit.push/pop` + `import.meta.hot.accept` for HMR; here we
 * only need the import — production has no module-scope reload to track.
 */
export function captureImportPlugin(projectDir: string): Plugin {
    const userSrcDir = path.join(path.resolve(projectDir), 'src') + path.sep;
    return {
        name: 'bongle:capture-import',
        transform(code, id) {
            const filePath = id.split('?')[0]!;
            if (!filePath.startsWith(userSrcDir)) return null;
            if (!/\.tsx?$/.test(filePath)) return null;
            return { code: `import { __kit } from 'bongle/internal';\n${code}`, map: null };
        },
    };
}
