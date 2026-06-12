/**
 * Server-side avatar wiring. The avatar a player renders with is
 * resolved upstream — the matchmaker resolves it at allocation time and
 * stamps it into the join reservation, so it arrives synchronously at
 * `onClientJoin` (the dev/edit path has no matchmaker → builtin). This
 * module records that identity on the ClientState and writes it onto
 * each of the client's Players' `CharacterTrait`.
 *
 * Because identity (`modelId` + `rigType`) is known at join, the trait
 * is stamped before `onJoin` fires — game scripts see the right avatar
 * immediately, and `JoinArgs` carries it. The model *payload* still
 * loads asynchronously: for runtime avatars we acquire + ensure the
 * bytes into Resources here, and the `WorldTrait` reconciler in
 * `character.ts` mounts the rig once they land. Bundled avatars (the
 * builtin) are codegen-hydrated already.
 */

import type { ResolvedAvatar } from 'bongle/interface';
import { RIG_TYPE_6BONE } from 'bongle/avatar/rig';
import type { Avatar } from '../core/avatar/avatar';
import type { PlayerId } from '../core/client';
import { BUILTIN_BASE_AVATAR_ID } from '../core/player/base-avatar';
import { CharacterTrait, modelIdSync } from '../builtins/character';
import { getTrait } from '../api/scene-graph';
import * as Resources from '../core/resources';
import type { ClientState } from './clients';
import type { EngineServer } from './engine-server';
import type { Player, Room } from './rooms';

/**
 * Record the client's resolved avatar identity and kick its payload
 * load. Called from `onClientJoin` BEFORE the client's player nodes are
 * created, so `enqueuePlayer` stamps the trait synchronously and
 * `onJoin` observes the right `modelId` / `rigType`. `resolved` is
 * absent on the dev/edit path (no matchmaker) — default to the engine
 * builtin.
 */
export function setClientAvatar(
    state: EngineServer,
    cs: ClientState,
    resolved: ResolvedAvatar | undefined,
): void {
    // Idempotent — the avatar is fixed for the connection (resolved once
    // by the matchmaker). Guards against a re-entered onClientJoin
    // double-acquiring the runtime model and leaking a refcount.
    if (cs.avatar) return;
    if (resolved && resolved.source === 'runtime') {
        // Runtime model — acquire + ensure the bytes so the reconciler
        // can mount the rig once they land. Identity is known now; the
        // payload streams in behind it.
        Resources.acquireRuntimeModel(state.resources, resolved.modelId, {
            clientUrl: resolved.clientUrl,
            serverUrl: resolved.serverUrl,
            source: 'runtime',
            hash: resolved.hash,
        });
        Resources.ensureModel(state.resources, resolved.modelId);
        cs.avatar = { modelId: resolved.modelId, rigType: resolved.rigType ?? RIG_TYPE_6BONE };
        return;
    }
    // bundled / absent — the builtin (or a bundled model) is already in
    // Resources via codegen; ensureModel keeps the payload path uniform
    // (no-op once ready). rigType is the builtin's canonical 6bone.
    const modelId = resolved?.modelId ?? BUILTIN_BASE_AVATAR_ID;
    Resources.ensureModel(state.resources, modelId);
    cs.avatar = { modelId, rigType: RIG_TYPE_6BONE };
}

function stampPlayerCharacter(state: EngineServer, cs: ClientState, playerId: PlayerId): void {
    const avatar = cs.avatar;
    if (!avatar) return;
    const player = state.rooms.players.get(playerId);
    if (!player) return;
    const room = state.rooms.rooms.get(player.roomId);
    if (!room) return;
    const playerNode = room.playerNodes.get(playerId);
    if (!playerNode) return;
    const ch = getTrait(playerNode, CharacterTrait);
    if (!ch) return;
    ch.modelId = avatar.modelId;
    ch.rigType = avatar.rigType;
    modelIdSync.dirty(ch);
}

/**
 * Stamp the client's resolved avatar onto a newly-created Player's
 * `CharacterTrait`. The identity is set on the ClientState at join, so
 * this is always synchronous — no waiting on a load.
 */
export function enqueuePlayer(state: EngineServer, _room: Room, player: Player): void {
    const cs = state.clients.connected.get(player.client);
    if (!cs) return;
    stampPlayerCharacter(state, cs, player.id);
}

/**
 * The client's resolved avatar identity, or the builtin if (defensively)
 * unset — `setClientAvatar` always sets it before any player node is
 * created, so the fallback only guards a missing ClientState. Used to
 * populate `JoinArgs` for onJoin.
 */
export function clientAvatarIdentity(cs: ClientState | undefined): Avatar {
    return cs?.avatar ?? { modelId: BUILTIN_BASE_AVATAR_ID, rigType: RIG_TYPE_6BONE };
}

/**
 * Release the client's runtime model refcount on disconnect. No-op for
 * bundled / unresolved clients — `releaseRuntimeModel` filters bundled
 * entries internally.
 */
export function releaseClientAvatar(state: EngineServer, cs: ClientState): void {
    const modelId = cs.avatar?.modelId;
    if (modelId) Resources.releaseRuntimeModel(state.resources, modelId);
    cs.avatar = null;
}
