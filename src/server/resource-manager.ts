// server/resource-manager.ts, disk i/o for generated non-code resources.
//
// today: model bins (the asset pipeline emits per-id `.server.bin` files
// that the engine streams at runtime). future: any other generated
// non-code asset that needs server-side resolution lives here.
//
// the kit wrapper bakes the absolute `resourcesDir` at build/dev time
// (via `import.meta.url`-relative resolution); engine internals never
// touch cwd. `ModelHandle.bin.server` stores a path relative to
// `resourcesDir`, and `resolveModelBin` joins them.

import path from 'node:path';

export type ResourceManager = {
    /** absolute path to the project's `resources/server/` root, baked at init. */
    resourcesDir: string;
};

export function init(opts: { resourcesDir: string }): ResourceManager {
    return { resourcesDir: opts.resourcesDir };
}

/**
 * resolve a model bin's relative path (as stored in
 * `ModelHandle.bin.server`) to an absolute filesystem path.
 */
export function resolveModelBin(state: ResourceManager, relPath: string): string {
    return path.join(state.resourcesDir, relPath);
}
