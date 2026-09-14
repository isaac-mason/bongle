import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResolvedAvatar, ServerDriver } from 'bongle/interface';
import { RIG_TYPE_6BONE } from '../../avatar/rig';

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

// joined via `path` rather than `new URL(<literal>, import.meta.url)`: that exact shape is what
// Vite's URL-asset plugin matches and rewrites to a page origin, which a directory (not a
// build-time asset) can't survive.
const avatarsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'avatars');
const filePathFor = (a: SampleAvatar): string => path.join(avatarsDir, a.file);

export function createFallbackAvatarsDriver(): ServerDriver['avatars'] {
    // only advertise avatars whose bytes are actually on disk, so we never hand the engine a
    // URL that resolves to nothing; degrades to an empty batch cleanly in a prod build.
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
