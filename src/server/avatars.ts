import type { Client, ResolvedAvatar } from 'bongle/interface';
import { RIG_TYPE_6BONE } from '../../avatar/rig';
import type { Avatar } from '../core/avatar/avatar';
import { acquireAvatarModel, assignAvatar } from '../core/avatar/model';
import type { PlayerId } from '../core/client';
import { BUILTIN_BASE_AVATAR_ID } from '../core/player/base-avatar';
import * as Resources from '../core/resources';
import type { ClientState } from './clients';
import type { Player, Room } from './rooms';
import type { EngineServer } from './server';

/** records the client's resolved avatar identity and kicks its payload load. Called
 *  from `onClientJoin` before player nodes are created. `resolved` is absent on the
 *  dev/edit path (no matchmaker), default to the builtin. */
export function setClientAvatar(state: EngineServer, cs: ClientState, resolved: ResolvedAvatar | undefined): void {
    // idempotent: avatar is fixed for the connection's lifetime once resolved.
    if (cs.avatar) return;
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

/** stamps the client's resolved avatar onto a newly-created Player's `CharacterTrait`. */
export function enqueuePlayer(state: EngineServer, _room: Room, player: Player): void {
    const cs = state.clients.connected.get(player.client);
    if (!cs) return;
    stampPlayerCharacter(state, cs, player.id);
}

/** the client's resolved avatar identity, or the builtin if unset (missing ClientState). */
export function clientAvatarIdentity(cs: ClientState | undefined): Avatar {
    return cs?.avatar ?? { modelId: BUILTIN_BASE_AVATAR_ID, rigType: RIG_TYPE_6BONE };
}

/** releases the client's runtime model refcount on disconnect; no-op for bundled clients. */
export function releaseClientAvatar(state: EngineServer, cs: ClientState): void {
    const modelId = cs.avatar?.modelId;
    if (modelId) Resources.releaseRuntimeModel(state.resources, modelId);
    cs.avatar = null;
}

/** swaps a connected client's avatar at runtime and re-stamps every live player node
 *  it owns. `resolved` must carry a fresh `modelId`; the same id is a reconciler no-op. */
export function reloadClientAvatar(state: EngineServer, client: Client, resolved: ResolvedAvatar): void {
    const cs = state.clients.connected.get(client);
    if (!cs) return;
    releaseClientAvatar(state, cs);
    setClientAvatar(state, cs, resolved);
    for (const player of state.rooms.players.values()) {
        if (player.client === client) stampPlayerCharacter(state, cs, player.id);
    }
}
