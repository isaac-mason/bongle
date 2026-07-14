// editor/sync/policy.ts — which project paths the folder-sync manages, declared
// by role. Everything NOT excluded here is two-way synced source. Kept separate
// from the file tree's display-ignore (editor/ignored.ts): the tree grays
// node_modules/dist/resources but still SHOWS src/generated; sync, by contrast,
// must also leave src/generated alone.
//
//   node_modules   vendored engine seeds (seedEngineDist) — segment, any depth
//   dist           bake output
//   resources      bake output
//   src/generated  generated barrels, regenerated at boot/bake — prefix
//
// "unmanaged" means the sync neither publishes it to disk nor imports it from
// disk, AND an import mirror never deletes it. So a folder imported without these
// keeps them, and a folder published from the editor stays clean of derived files.

import { IGNORED_DIRS } from '../ignored';

// editor-owned generated content that lives under a synced source dir, so the
// segment-based IGNORED_DIRS can't catch it — matched by path prefix instead.
const OWNED_PREFIXES = ['src/generated'] as const;

const IGNORED = new Set<string>(IGNORED_DIRS);

/** does the folder-sync own this path (publish + import + delete)? False for
 *  vendored / baked / generated paths, which it leaves untouched. */
export function syncManaged(path: string): boolean {
    for (const seg of path.split('/')) if (IGNORED.has(seg)) return false;
    for (const p of OWNED_PREFIXES) if (path === p || path.startsWith(`${p}/`)) return false;
    return true;
}
