// editor/game-save.ts — export/import a project's SOURCE SET as a zip.
//
// A "game save" is the project's authored source, NOT its derived outputs. It's
// the same source contract the platform persists (later, over postMessage) and
// the input to a build. Everything the pipeline bakes or the editor seeds is
// reconstructable, so it's excluded: node_modules (seeded engine dist + libs),
// dist (build output), .bongle / tmp (transient), src/generated + resources
// (pipeline bake outputs). Mirrors a game project's .gitignore.
//
// Zipped with STORE (level 0): saves are mostly already-compressed assets, so
// deflate buys ~nothing for real time (measured elsewhere: ratio ~0.98).

import { unzipSync, zipSync } from 'fflate';
import type { Filesystem, FsPath } from './fs';

/** derived/reconstructable trees excluded from a save (dir prefixes). */
const DERIVED = ['node_modules', 'dist', '.bongle', 'tmp', 'src/generated', 'resources'];

/** true when `path` is a derived output, not authored source. */
function isDerived(path: FsPath): boolean {
    return DERIVED.some((d) => path === d || path.startsWith(`${d}/`));
}

/** true when `path` is authored source (belongs in a game save). */
export function isSourcePath(path: FsPath): boolean {
    return !isDerived(path);
}

/** zip the project's source set (derived trees excluded). */
export async function exportGameSave(fs: Filesystem): Promise<Uint8Array> {
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
export async function importGameSave(fs: Filesystem, zip: Uint8Array): Promise<void> {
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
    return 'game-save';
}

/** build the save zip and trigger a browser download. */
export async function downloadGameSave(fs: Filesystem): Promise<void> {
    const zip = await exportGameSave(fs);
    const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${await projectName(fs)}.zip`;
    a.click();
    URL.revokeObjectURL(url);
}

/** prompt for a .zip, import it over the project, then reload the editor. */
export function pickAndImportGameSave(fs: Filesystem): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        await importGameSave(fs, new Uint8Array(await file.arrayBuffer()));
        location.reload();
    };
    input.click();
}
