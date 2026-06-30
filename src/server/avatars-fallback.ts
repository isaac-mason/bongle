// avatars-fallback.ts, the dev/edit/offline `ServerDriver.avatars` impl.
//
// `ServerDriver.avatars` is required, like `storage`: a deployed host sources
// real avatars from its backend (the HTTP driver, published avatars on R2),
// and kit dev / editor / offline supply this fallback. It mirrors how the
// platform sources them: each is a `runtime` avatar served as a plain `.glb`
// the engine fetches and parses via `gltfUnpack`, NOT a bundled `model()`.
// That keeps dev on the exact same runtime-avatar path as prod and needs no
// per-game codegen/baking of the engine's example avatars.
//
// The bytes live in the engine's `lib/avatars/<name>/<name>.glb`. The client
// fetches them from the dev host at `SAMPLE_AVATAR_ROUTE_PREFIX` (the kit's
// Vite middleware in edit, the node static server in `bongle start`); the
// server reads the same files straight off disk via its absolute `serverUrl`.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResolvedAvatar, ServerDriver } from 'bongle/interface';
import { RIG_TYPE_6BONE } from '../core/avatar/rig';

/** Request-path prefix the dev hosts serve the sample-avatar `.glb`s from.
 *  The client's `clientUrl` is `${prefix}<slug>.glb`, same-origin. */
export const SAMPLE_AVATAR_ROUTE_PREFIX = '/__bongle/avatars/';

type SampleAvatar = { modelId: string; slug: string; file: string };

// The engine's example avatars, 6-bone humanoids under lib/avatars/. `file` is
// relative to that dir; `slug` is the public URL segment.
const SAMPLE_AVATARS: SampleAvatar[] = [
    { modelId: 'avatar:boy', slug: 'boy', file: 'boy/boy.glb' },
    { modelId: 'avatar:girl', slug: 'girl', file: 'girl/girl.glb' },
    { modelId: 'avatar:penguin', slug: 'penguin', file: 'blindfoldedpenguin/blindfoldedpenguin.glb' },
    { modelId: 'avatar:pigeon', slug: 'pigeon', file: 'pigeon/pigeon.glb' },
];

// Server-only: resolved at runtime against the module's on-disk location so we
// can read the engine's example `.glb`s off disk. It's a directory, not a file,
// so there's no build-time asset for Vite to emit, tell it to leave it as-is.
const avatarsDir = fileURLToPath(new URL(/* @vite-ignore */ '../../avatars/', import.meta.url));
const filePathFor = (a: SampleAvatar): string => path.join(avatarsDir, a.file);

export function createFallbackAvatarsDriver(): ServerDriver['avatars'] {
    // Only advertise avatars whose bytes are actually on disk, present in the
    // source tree during dev, absent from a prod build (where the platform's own
    // HTTP driver replaces this anyway). So we never hand the engine a URL that
    // resolves to nothing, and the driver degrades to an empty batch cleanly.
    const batch: ResolvedAvatar[] = SAMPLE_AVATARS.filter((a) => existsSync(filePathFor(a))).map((a) => ({
        source: 'runtime' as const,
        modelId: a.modelId,
        clientUrl: `${SAMPLE_AVATAR_ROUTE_PREFIX}${a.slug}.glb`,
        serverUrl: filePathFor(a),
        rigType: RIG_TYPE_6BONE,
    }));
    return { sample: async () => batch };
}

/**
 * Resolve a `${SAMPLE_AVATAR_ROUTE_PREFIX}<slug>.glb` request path to the `.glb`
 * on disk, or null if it isn't a known sample avatar (or its bytes are missing).
 * The dev hosts call this to stream the bytes the client fetches.
 */
export function resolveSampleAvatarFile(pathname: string): string | null {
    if (!pathname.startsWith(SAMPLE_AVATAR_ROUTE_PREFIX)) return null;
    const slug = pathname.slice(SAMPLE_AVATAR_ROUTE_PREFIX.length).replace(/\.glb$/, '');
    const avatar = SAMPLE_AVATARS.find((a) => a.slug === slug);
    if (!avatar) return null;
    const fp = filePathFor(avatar);
    return existsSync(fp) ? fp : null;
}
