// Artifact-cache helpers.
//
// Convention: each generated artifact has a sidecar JSON (e.g.
// resources/client/voxels-atlas.json) that carries a `hash` field over
// its inputs. A rebuild is gated by `readArtifactHash(fs, sidecar) ===
// computedHash`. The artifact JSON IS the cache marker, no separate
// cache file. Cold-start wipes simply delete the artifact files.

import type { Filesystem } from '../filesystem';

/** Read the `hash` field from an artifact's sidecar JSON (project-relative
 *  path). Returns null if the file is missing, unreadable, or has no
 *  string hash field. */
export async function readArtifactHash(fs: Filesystem, filePath: string): Promise<string | null> {
    try {
        const json = JSON.parse(await fs.readText(filePath)) as { hash?: unknown };
        return typeof json.hash === 'string' ? json.hash : null;
    } catch {
        return null;
    }
}
