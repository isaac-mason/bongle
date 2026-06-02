/**
 * Server-side avatar lifecycle. Owns per-client resolve + load and
 * writes the resolved `modelId` / `rigType` directly onto each of the
 * client's Players' `CharacterTrait` exactly once.
 *
 * Lives at the Client level — one resolve per connection, cached on
 * ClientState. A single client with multiple Players (e.g. editor +
 * play views of the same room) gets one resolve and N trait writes,
 * one per Player.
 *
 * Trait writes are pure data assignment: this module writes
 * `t.modelId` + `t.rigType` and marks `modelIdSync` dirty. The
 * `WorldTrait` reconciler in `character.ts` picks up the change next
 * frame and converges `state.modelId` toward it (mounting the rig).
 */

import type { PlayerId } from '../core/client';
import { RIG_TYPE_6BONE } from 'bongle/avatar/rig';
import { CharacterTrait, modelIdSync } from '../builtins/character';
import { getTrait } from '../api/scene-graph';
import * as Resources from '../core/resources';
import type { ClientState } from './clients';
import type { EngineServer } from './engine-server';
import type { Player, Room } from './rooms';

/**
 * Kick the avatar resolve for a client. Idempotent — re-entry is a
 * no-op once started. Called from `onClientJoin` after `Clients.onJoin`
 * stamps identity, so `cs.user.id` is the resolve key. Runtime models
 * are acquired+ensured here; bundled models are already in Resources
 * via codegen and just need the handle lookup.
 */
export function kickResolve(state: EngineServer, cs: ClientState): void {
    if (cs.avatarResolveStarted) return;
    cs.avatarResolveStarted = true;
    void runResolve(state, cs).catch((err) => {
        console.warn(`[engine-server] avatars.resolve failed for ${cs.user.id}:`, err);
    });
}

async function runResolve(state: EngineServer, cs: ClientState): Promise<void> {
    const resolved = await state.driver.avatars.resolve(cs.user.id);
    if (resolved.source === 'runtime') {
        Resources.acquireRuntimeModel(state.resources, resolved.modelId, {
            clientUrl: resolved.clientUrl,
            serverUrl: resolved.serverUrl,
            source: 'runtime',
            hash: resolved.hash,
        });
        Resources.ensureModel(state.resources, resolved.modelId);
    } else {
        // bundled — handle is already present via codegen; still call
        // ensureModel so the payload path is uniform (no-op once ready).
        Resources.ensureModel(state.resources, resolved.modelId);
    }
    // Stash the modelId + rigType so the per-tick drain knows what to
    // wait on. The handle field is filled in once the model lands.
    cs._pendingResolved = {
        modelId: resolved.modelId,
        rigType: (resolved.source === 'runtime' && resolved.rigType) || RIG_TYPE_6BONE,
    };
    state.pendingAvatarClients.add(cs);
}

/**
 * Per-tick drain. For each client whose resolve has landed but whose
 * model isn't yet in Resources, poll `hasModel`; once true, cache the
 * Avatar on ClientState and stamp the resolved `modelId` / `rigType`
 * onto each waiting Player's `CharacterTrait`. The world-script
 * reconciler picks the assignment up next frame.
 */
export function drainPending(state: EngineServer): void {
    if (state.pendingAvatarClients.size === 0) return;
    const done: ClientState[] = [];
    for (const cs of state.pendingAvatarClients) {
        const pending = cs._pendingResolved;
        if (!pending) {
            done.push(cs);
            continue;
        }
        if (!Resources.hasModel(state.resources, pending.modelId)) continue;
        const handle = Resources.modelHandle(state.resources, pending.modelId);
        if (!handle) continue;
        cs.avatar = { rigType: pending.rigType, model: handle };
        cs._pendingResolved = undefined;
        done.push(cs);

        for (const playerId of cs.avatarPendingPlayers) {
            stampPlayerCharacter(state, cs, playerId);
        }
        cs.avatarPendingPlayers.clear();
    }
    for (const cs of done) state.pendingAvatarClients.delete(cs);
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
    ch.modelId = avatar.model.modelId;
    ch.rigType = avatar.rigType;
    modelIdSync.dirty(ch);
}

/**
 * Notify the avatar subsystem that a new Player has been created.
 * Stamps the resolved avatar onto the player's `CharacterTrait`
 * immediately if it's already loaded; otherwise records the player as
 * waiting and the drain will stamp when the load lands.
 */
export function enqueuePlayer(state: EngineServer, room: Room, player: Player): void {
    const cs = state.clients.connected.get(player.client);
    if (!cs) return;
    if (cs.avatar) {
        stampPlayerCharacter(state, cs, player.id);
        return;
    }
    cs.avatarPendingPlayers.add(player.id);
}

/** Drop a Player from any pending-fire set it might be in. */
export function dequeuePlayer(state: EngineServer, playerId: PlayerId): void {
    const player = state.rooms.players.get(playerId);
    if (!player) return;
    const cs = state.clients.connected.get(player.client);
    if (!cs) return;
    cs.avatarPendingPlayers.delete(playerId);
}

/**
 * Release the client's runtime model refcount on disconnect. No-op for
 * bundled or unresolved clients — `releaseRuntimeModel` filters bundled
 * entries internally.
 */
export function releaseClientAvatar(state: EngineServer, cs: ClientState): void {
    state.pendingAvatarClients.delete(cs);
    const modelId = cs.avatar?.model.modelId ?? cs._pendingResolved?.modelId;
    if (modelId) Resources.releaseRuntimeModel(state.resources, modelId);
    cs.avatar = null;
    cs._pendingResolved = undefined;
    cs.avatarPendingPlayers.clear();
}
