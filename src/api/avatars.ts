// api/avatars.ts — script-facing avatar sourcing + application.
//
// `sampleAvatars` pulls an opaque batch of avatars from the `ServerDriver.avatars`
// host capability (popular / random / trending — the host owns curation and may
// change it). `applyAvatar` dresses any
// `CharacterTrait` node in one, reusing the runtime-model load path the player
// avatar pipeline uses; the rig reconciler streams it in. Use for ambient NPCs
// so they wear real, varied avatars instead of a placeholder dummy.
//
// Server-side: `applyAvatar` sets the synced `CharacterTrait.modelId`/`rigType`
// and, for runtime avatars, registers the model so Discovery replicates the URLs
// to clients — exactly the path a resolved player avatar takes.

import type { ResolvedAvatar } from 'bongle/interface';
import { RIG_TYPE_6BONE } from 'bongle/avatar/rig';
import type { ScriptContext } from '../core/scene/scripts';
import * as Resources from '../core/resources';
import { getTrait, type Node } from './scene-graph';
import { CharacterTrait, modelIdSync } from '../builtins/character';

/**
 * Pull a batch of avatars for populating NPCs. Opaque + unordered + non-stable —
 * the host owns what's in it and may return fewer than you'd like (or none).
 * Resolves to an empty array off-server (or when the host's pool is empty), so
 * callers just fall back to their default avatar. Bulk: call once and round-robin
 * the result onto your NPCs, not per-NPC.
 */
export function sampleAvatars(ctx: ScriptContext): Promise<ResolvedAvatar[]> {
    return ctx.server ? ctx.server.state.driver.avatars.sample() : Promise.resolve([]);
}

/**
 * Dress a `CharacterTrait` node in a resolved avatar. Server-side: registers the
 * model (runtime avatars replicate to clients via Discovery) and sets the synced
 * `modelId`/`rigType`; the rig reconciler mounts it once the payload lands. No-op
 * if `node` has no `CharacterTrait` or there's no runtime resources on `ctx`.
 */
export function applyAvatar(ctx: ScriptContext, node: Node, avatar: ResolvedAvatar): void {
    const resources = ctx._runtime?.resources;
    const ch = getTrait(node, CharacterTrait);
    if (!resources || !ch) return;
    if (avatar.source === 'runtime') {
        Resources.acquireRuntimeModel(resources, avatar.modelId, {
            clientUrl: avatar.clientUrl,
            serverUrl: avatar.serverUrl,
            source: 'runtime',
            hash: avatar.hash,
        });
    }
    Resources.ensureModel(resources, avatar.modelId);
    ch.modelId = avatar.modelId;
    ch.rigType = avatar.source === 'runtime' ? avatar.rigType ?? RIG_TYPE_6BONE : RIG_TYPE_6BONE;
    modelIdSync.dirty(ch);
}

/**
 * Drop the runtime refcount for an avatar model — call on NPC despawn / round
 * reset so the pool doesn't accrete. No-op for bundled models or unknown ids.
 */
export function releaseAvatar(ctx: ScriptContext, modelId: string): void {
    const resources = ctx._runtime?.resources;
    if (resources) Resources.releaseRuntimeModel(resources, modelId);
}

// A small bundled name pool so ambient NPCs read as people, not "Dummy 3".
// Wholly separate from avatar sourcing — games may use it, ignore it, or bring
// their own list.
const DISPLAY_NAMES = [
    'Ash', 'Mara', 'Quill', 'Dex', 'Niko', 'Sage', 'Bex', 'Ivo', 'Lux', 'Pim',
    'Rune', 'Wren', 'Zane', 'Cleo', 'Fox', 'Juno', 'Kai', 'Nova', 'Otis', 'Vera',
];

/** A plausible display name for an ambient NPC, drawn from a small bundled pool. */
export function randomDisplayName(): string {
    return DISPLAY_NAMES[(Math.random() * DISPLAY_NAMES.length) | 0]!;
}
