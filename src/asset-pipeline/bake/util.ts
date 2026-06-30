// shared codegen util, skip writes when content is byte-identical to
// avoid pointless vite HMR cascades. compares existing file bytes against
// the new content before touching the disk.
//
// matters most for the `src/generated/*.ts` barrels: every write triggers
// an HMR update in both the client + server environments, and on cold
// start the pipeline emits all barrels even when nothing relevant changed
// (e.g. user-entry shim wiped them, pipeline regenerates identical bytes).
// byte-comparison short-circuits the cascade.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** resolve a registered asset's `src` field to an absolute disk path.
 *  registration APIs (sound, model, blockTexture) normalize `new URL(...)`
 *  args to `.href`, so we see either a `file://...` href (engine builtins
 *  + 3rd-party deps that ship assets alongside their modules) or a plain
 *  project-root-relative path. `file://` → fileURLToPath gives a real fs
 *  path the asset tools (ffmpeg, sharp, gltf loader) can open. anything
 *  else is treated as project-root-relative. */
export function resolveSrcToAbsPath(src: string, projectDir: string): string {
    if (src.startsWith('file://')) return fileURLToPath(src);
    return path.resolve(projectDir, src);
}

/** write `content` to `filePath` only if it differs from what's there.
 *  returns true if a write happened, false if the file was already
 *  byte-identical. assumes parent dir exists (callers handle mkdir). */
export function writeFileIfChanged(filePath: string, content: string | Uint8Array): boolean {
    const next = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
    try {
        const existing = fs.readFileSync(filePath);
        if (existing.equals(next)) return false;
    } catch {
        // missing file, fall through to write.
    }
    fs.writeFileSync(filePath, next);
    return true;
}
