import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve the absolute path to the `bongle` package root from a project dir.
 * Follows the node_modules/bongle symlink to the real engine directory.
 *
 * Used by `kit/src/build.ts` to pass an absolute path to the in-process asset
 * pipeline so the physics module's side-effect import resolves regardless of
 * cwd. The dev orchestrator does not need this, Vite resolves engine sources
 * through the server env's runner, and the asset-pipeline flush handler
 * (mounted in `kit/src/vite/plugin.ts`) reads everything from registries.
 */
export function resolveEngineRoot(projectDir: string): string {
    const bongleLink = path.join(projectDir, 'node_modules', 'bongle');
    return fs.realpathSync(bongleLink);
}
