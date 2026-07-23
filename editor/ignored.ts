// editor/ignored.ts — the editor's fixed set of non-source dirs: engine seeds
// (node_modules, where seedEngineDist unzips bongle/mathcat/…) and bake outputs
// (dist, resources). These are grayed + default-collapsed in the file tree and
// excluded from folder sync. A concrete list, not a parsed .gitignore — the
// generated dirs are known and stable, so there's nothing to discover at runtime.

export const IGNORED_DIRS = ['node_modules', 'dist', 'resources'] as const;

const IGNORED = new Set<string>(IGNORED_DIRS);

// Meta files the editor manages (seeded), not user source: grayed in the tree +
// read-only, like the ignored dirs. `.gitignore` is auto-seeded for a folder-sync'd
// disk copy (see main.tsx).
const IGNORED_FILES = new Set<string>(['.gitignore']);

/** is this path inside (or equal to) an ignored dir, or an ignored meta file? Matches
 *  an ignored segment at any depth, so a nested node_modules stays ignored too. */
export function isIgnored(path: string): boolean {
    for (const seg of path.split('/')) if (IGNORED.has(seg)) return true;
    return IGNORED_FILES.has(path.split('/').pop() ?? path);
}
