/**
 * kit/runtime/sample-avatars.ts — local avatar-resolution policy for the kit.
 *
 * Deployed play resolves each joining player's avatar upstream (the matchmaker
 * stamps it into the reservation, apps/game-room passes it to `onClientJoin`).
 * The kit has no matchmaker, so without this a local player always gets the
 * base placeholder and never exercises the runtime-avatar load + placeholder→
 * real swap path — hiding play-only avatar bugs from the editor.
 *
 * This is the kit's counterpart: pre-fetch the driver's sample avatars once and
 * hand `attachGameTransport` a synchronous `resolveAvatar` that yields a random
 * one per join. The engine still just receives a resolved avatar (or none) — the
 * "which avatar" decision lives here in the host, not in the engine.
 */

import type { ResolvedAvatar, ServerDriver } from 'bongle/interface';

/**
 * Pre-fetch the sample pool once and return a synchronous picker that yields a
 * random avatar per call (fresh pick, so players in a room vary), or undefined
 * when the pool is empty — in which case the engine falls back to the builtin.
 */
export async function createSampleAvatarPicker(avatars: ServerDriver['avatars']): Promise<() => ResolvedAvatar | undefined> {
    let pool: ResolvedAvatar[] = [];
    try {
        pool = await avatars.sample();
    } catch {
        // no sample pool (or it threw) → picker returns undefined.
    }
    return () => (pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : undefined);
}
