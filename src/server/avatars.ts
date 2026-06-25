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

import { RIG_TYPE_6BONE } from 'bongle/avatar/rig';
import type { ResolvedAvatar } from 'bongle/interface';
import type { Avatar } from '../core/avatar/avatar';
import { acquireAvatarModel, assignAvatar } from '../core/avatar/model';
import type { PlayerId } from '../core/client';
import { BUILTIN_BASE_AVATAR_ID } from '../core/player/base-avatar';
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
export function setClientAvatar(state: EngineServer, cs: ClientState, resolved: ResolvedAvatar | undefined): void {
    // Idempotent — the avatar is fixed for the connection (resolved once
    // by the matchmaker). Guards against a re-entered onClientJoin
    // double-acquiring the runtime model and leaking a refcount.
    if (cs.avatar) return;
    // Absent (dev/edit — no matchmaker) ⇒ the builtin. `acquireAvatarModel`
    // handles both arms: +1 refcount + ensure for runtime, ensure-only for
    // bundled/builtin. The payload streams in behind the now-known identity.
    const avatar: ResolvedAvatar = resolved ?? { source: 'bundled', modelId: BUILTIN_BASE_AVATAR_ID };
    cs.avatar = acquireAvatarModel(state.resources, avatar);
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
    assignAvatar(playerNode, avatar.modelId, avatar.rigType);
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
