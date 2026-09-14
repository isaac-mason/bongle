import type { EngineClient } from '../client/client';
import * as Net from '../client/net';
import { LOCAL_ROOM_PREFIX, setActivePlayer, stopLocalRoom } from '../client/rooms';
import type { PlayerMode } from '../core/protocol';

/** make the client's player in (`roomId`, `mode`) the active one, if it holds one. */
export function switchRoom(state: EngineClient, roomId: string, mode: PlayerMode): void {
    for (const room of state.rooms.rooms.values()) {
        if (room.roomId === roomId && room.playerMode === mode) {
            setActivePlayer(state.rooms, state.net, room.playerId);
            return;
        }
    }
}

export function joinRoom(state: EngineClient, roomId: string, mode: PlayerMode): void {
    Net.send(state.net, { type: 'join_room_as', roomId, mode });
}

export function leaveRoom(state: EngineClient, roomId: string, mode: PlayerMode): void {
    Net.send(state.net, { type: 'leave_room', roomId, mode });
}

export function stopRoom(state: EngineClient, roomId: string): void {
    if (roomId.startsWith(LOCAL_ROOM_PREFIX)) {
        // standalone play preview has no server, so stopLocalRoom leaves no active player and
        // there's no server room_left to bring the edit room back; reactivate it ourselves.
        const editRoom = [...state.rooms.rooms.values()].find((r) => r.roomMode === 'edit');
        stopLocalRoom(state, roomId);
        if (editRoom) setActivePlayer(state.rooms, state.net, editRoom.playerId);
        return;
    }
    Net.send(state.net, { type: 'stop_room', roomId });
}
