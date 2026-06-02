// Node-side artifact-cache helpers.
//
// Convention: each generated artifact has a sidecar JSON (e.g.
// resources/client/voxels-atlas.json) that carries a `hash` field over
// its inputs. A rebuild is gated by `readArtifactHashSync(sidecar) ===
// computedHash`. The artifact JSON IS the cache marker — no separate
// cache file. Cold-start wipes simply delete the artifact files.
//
// Browser-side tasks use the matching `fetchManifestHash` helper in
// engine/src/offline-renderer/cache.ts; same convention, different
// runtime.

import * as fs from 'node:fs';

/** Read the `hash` field from an artifact's sidecar JSON. Returns null
 *  if the file is missing, unreadable, or has no string hash field. */
export function readArtifactHashSync(filePath: string): string | null {
    try {
        if (!fs.existsSync(filePath)) return null;
        const json = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { hash?: unknown };
        return typeof json.hash === 'string' ? json.hash : null;
    } catch {
        return null;
    }
}
