export type ResourceManager = {
    /** the project's `resources/server/` root, baked at init. */
    resourcesDir: string;
};

export function init(opts: { resourcesDir: string }): ResourceManager {
    return { resourcesDir: opts.resourcesDir };
}

/** resolves a model bin's relative path (`ModelHandle.bin.server`) to a full path
 *  under `resourcesDir`. POSIX join, no node:path, so the browser server bundle
 *  stays node-free. */
export function resolveModelBin(state: ResourceManager, relPath: string): string {
    const base = state.resourcesDir.replace(/\/+$/, '');
    return `${base}/${relPath.replace(/^\/+/, '')}`;
}
