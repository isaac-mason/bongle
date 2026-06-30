// api/avatars.ts, script-facing avatar API: source, load, assign, release.
//
//   - sampleAvatars, pull an opaque batch from the `ServerDriver.avatars` host capability
//   - loadAvatar, acquire + ensure a resolved avatar's model; +1 refcount (runtime; bundled = ensure-only)
//   - assignAvatar, point a node's CharacterTrait at an already-loaded model (no refcount)
//   - releaseAvatar, drop the refcount; bytes freed only when the last holder releases
//
// `loadAvatar` MUST precede `assignAvatar` for runtime avatars: acquire registers
// the resource entry that ensure + the rig reconciler need (bundled entries are
// codegen-hydrated, so they can be assigned directly). Every `loadAvatar` balances
// with exactly one `releaseAvatar` per holder; the shared per-modelId refcount means
// a player and an NPC on the same avatar = one load, freed only when both release.
//
// The load/assign internals live in core/avatar/model and are shared with the engine
// player-join path (server/avatars); this module is the script-facing surface.

import { RIG_TYPE_6BONE } from 'bongle/avatar/rig';
import type { ResolvedAvatar } from 'bongle/interface';
import { acquireAvatarModel } from '../core/avatar/model';
import * as Resources from '../core/resources';
import type { ScriptContext } from '../core/scene/scripts';

// `assignAvatar` is shared with the engine player path, so it lives in core; surface
// it here as part of the script-facing API.
export { assignAvatar } from '../core/avatar/model';

/**
 * Pull a batch of avatars for populating NPCs. Opaque + unordered + non-stable,
 * the host owns what's in it and may return fewer than you'd like (or none).
 * Resolves to an empty array off-server (or when the host's pool is empty), so
 * callers just fall back to their default avatar. Bulk: call once and round-robin
 * the result onto your NPCs, not per-NPC.
 */
export function sampleAvatars(ctx: ScriptContext): Promise<ResolvedAvatar[]> {
    return ctx.server ? ctx.server.state.driver.avatars.sample() : Promise.resolve([]);
}

/**
 * Load a resolved avatar's model (acquire + ensure) and bump its refcount (runtime;
 * bundled = ensure-only). Returns `{ modelId, rigType }` to hand to `assignAvatar`.
 * Balance each call with one `releaseAvatar`. Must precede `assignAvatar` for runtime
 * avatars (acquire registers the entry the reconciler loads from).
 */
export function loadAvatar(ctx: ScriptContext, avatar: ResolvedAvatar): { modelId: string; rigType: string } {
    const resources = ctx._runtime?.resources;
    if (!resources) {
        // No runtime resources (degenerate context), return identity so a bundled
        // assign still works; runtime payloads simply won't load here.
        const rigType = avatar.source === 'runtime' ? (avatar.rigType ?? RIG_TYPE_6BONE) : RIG_TYPE_6BONE;
        return { modelId: avatar.modelId, rigType };
    }
    return acquireAvatarModel(resources, avatar);
}

/**
 * Drop the runtime refcount for an avatar model, call on NPC despawn / round
 * reset so the pool doesn't accrete. No-op for bundled models or unknown ids.
 */
export function releaseAvatar(ctx: ScriptContext, modelId: string): void {
    const resources = ctx._runtime?.resources;
    if (resources) Resources.releaseRuntimeModel(resources, modelId);
}

// A small bundled name pool so ambient NPCs read as people, not "Dummy 3".
// Wholly separate from avatar sourcing, games may use it, ignore it, or bring
// their own list.
const DISPLAY_NAMES = [
    'Ash',
    'Mara',
    'Quill',
    'Dex',
    'Niko',
    'Sage',
    'Bex',
    'Ivo',
    'Lux',
    'Pim',
    'Rune',
    'Wren',
    'Zane',
    'Cleo',
    'Fox',
    'Juno',
    'Kai',
    'Nova',
    'Otis',
    'Vera',
];

/** A plausible display name for an ambient NPC, drawn from a small bundled pool. */
export function randomDisplayName(): string {
    return DISPLAY_NAMES[(Math.random() * DISPLAY_NAMES.length) | 0]!;
}
