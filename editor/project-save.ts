// editor/project-save.ts — export/import a project's SOURCE SET as a zip.
//
// A "project save" is the project's authored source, NOT its derived outputs. It's
// the same source contract the platform persists (later, over postMessage) and
// the input to a build. Everything the pipeline bakes or the editor seeds is
// reconstructable, so it's excluded: node_modules (seeded engine dist + libs),
// dist (build output), .bongle / tmp (transient), src/generated + resources
// (pipeline bake outputs). Mirrors a project's .gitignore.
//
// Zipped with STORE (level 0): saves are mostly already-compressed assets, so
// deflate buys ~nothing for real time (measured elsewhere: ratio ~0.98).

import { unzipSync, zipSync } from 'fflate';
import type { Filesystem, FsPath } from './fs';

/** derived/reconstructable trees excluded from a save (dir prefixes). */
const DERIVED = ['node_modules', 'dist', '.bongle', 'tmp', 'src/generated', 'resources'];

/** editor-managed meta files excluded from a save (auto-seeded, not authored source). */
const DERIVED_FILES = new Set(['.gitignore']);

/** true when `path` is a derived output, not authored source. */
function isDerived(path: FsPath): boolean {
    if (DERIVED_FILES.has(path)) return true;
    return DERIVED.some((d) => path === d || path.startsWith(`${d}/`));
}

/** true when `path` is authored source (belongs in a project save). */
export function isSourcePath(path: FsPath): boolean {
    return !isDerived(path);
}

/** Server-enforced per-save cap (mirrors the project_version.size_bytes CHECK). */
export const SAVE_MAX_BYTES = 20 * 1024 * 1024;
/** Warn threshold (~80% of the cap) — surfaced before the hard limit. */
export const SAVE_WARN_BYTES = 16 * 1024 * 1024;

/** Estimate a save's zip size WITHOUT zipping. Saves use STORE (level 0), so the
 *  zip is ≈ Σ(source-file bytes) + minor per-entry overhead — summing the
 *  source-set file sizes off the fs listing (no reads) is a good-enough gauge for
 *  the size indicator + the on-save guard. */
export async function saveSizeBytes(fs: Filesystem): Promise<number> {
    const files = await fs.list('', { recursive: true });
    let total = 0;
    for (const f of files) {
        if (f.kind !== 'file' || isDerived(f.path)) continue;
        total += f.size;
    }
    return total;
}

/** zip the project's source set (derived trees excluded). */
export async function exportProjectSave(fs: Filesystem): Promise<Uint8Array> {
    const files = await fs.list('', { recursive: true });
    const entries: Record<string, Uint8Array> = {};
    for (const f of files) {
        if (f.kind !== 'file' || isDerived(f.path)) continue;
        entries[f.path] = await fs.read(f.path);
    }
    return zipSync(entries, { level: 0 });
}

/** replace the project's source with a save's contents. Clears the current
 *  source + bake caches (keeps node_modules — the seeded engine dist is
 *  re-seed-skipped on reload), then writes the save's files. The caller reloads
 *  so every realm reboots against the new source (re-seed skips, re-bake runs). */
export async function importProjectSave(fs: Filesystem, zip: Uint8Array): Promise<void> {
    const incoming = unzipSync(zip);

    // wipe existing project files EXCEPT the seeded engine dist under
    // node_modules (fetching + unzipping it again would be wasteful; the content-
    // hash seed marker there stays valid). Derived bake outputs are cleared so a
    // different project's stale atlas/barrel can't linger.
    for (const f of await fs.list('', { recursive: true })) {
        if (f.kind !== 'file' || f.path.startsWith('node_modules/')) continue;
        await fs.remove(f.path);
    }

    for (const [path, bytes] of Object.entries(incoming)) {
        if (path.endsWith('/') || isDerived(path)) continue; // dir entry / stray derived
        await fs.write(path, bytes);
    }
}

// ── browser glue (download / pick-a-file) ───────────────────────────

/** the project's package.json `name`, for the save filename (falls back). */
async function projectName(fs: Filesystem): Promise<string> {
    try {
        const pkg = JSON.parse(await fs.readText('package.json')) as { name?: string };
        if (pkg.name) return pkg.name;
    } catch {
        /* no/invalid package.json */
    }
    return 'project-save';
}

/** trigger a browser download of some bytes. */
function downloadBytes(bytes: Uint8Array, name: string, type = 'application/octet-stream'): void {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
}

/** build the save zip and trigger a browser download. */
export async function downloadProjectSave(fs: Filesystem): Promise<void> {
    downloadBytes(await exportProjectSave(fs), `${await projectName(fs)}.zip`, 'application/zip');
}

/** the deepest directory that is an ancestor of every selected path, so a zip of
 *  the selection keeps each item's own name — a folder unzips to that folder, and
 *  siblings root at their shared dir. '' means the project root. */
function commonBase(paths: string[]): string {
    const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
    let base = dirOf(paths[0]);
    for (const p of paths.slice(1)) {
        const dir = dirOf(p);
        while (base && dir !== base && !dir.startsWith(`${base}/`)) {
            base = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
        }
    }
    return base;
}

/** download a file-tree selection to the user's computer. A single file downloads
 *  as itself; anything else (several items, or a folder) downloads as a .zip that
 *  preserves the structure, rooted at the selection's common directory. */
export async function downloadPaths(fs: Filesystem, paths: FsPath[]): Promise<void> {
    if (paths.length === 0) return;

    // expand any directories to their files.
    const files: string[] = [];
    for (const p of paths) {
        const stat = await fs.stat(p);
        if (stat?.kind === 'dir') {
            for (const e of await fs.list(p, { recursive: true })) if (e.kind === 'file') files.push(e.path);
        } else if (stat?.kind === 'file') {
            files.push(p);
        }
    }
    if (files.length === 0) return;

    // a single plain file → download it directly, no zip wrapper.
    if (paths.length === 1 && files[0] === paths[0]) {
        downloadBytes(await fs.read(files[0]), files[0].split('/').pop() ?? 'file');
        return;
    }

    const base = commonBase(paths);
    const entries: Record<string, Uint8Array> = {};
    for (const f of files) entries[base ? f.slice(base.length + 1) : f] = await fs.read(f);
    const name = paths.length === 1 ? (paths[0].split('/').pop() ?? 'selection') : 'selection';
    downloadBytes(zipSync(entries, { level: 0 }), `${name}.zip`, 'application/zip');
}

/** prompt for a .zip, import it over the project, then reload the editor. */
export function pickAndImportProjectSave(fs: Filesystem): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        await importProjectSave(fs, new Uint8Array(await file.arrayBuffer()));
        location.reload();
    };
    input.click();
}
