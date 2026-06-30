import { pack } from '../core/scene/pack';
import { sync, type TraitType, trait } from '../core/scene/traits';

/**
 * player trait. marks a node as the in-scene body of a specific Player,
 * one (client, room, mode) view. persist: false, player nodes are
 * ephemeral, created at Player join time.
 *
 * playerId/client/userId/username are server-set runtime state. they're
 * replicated as 'dirty' syncs (no editor exposure, no auto byte-diff).
 * server code that mutates them must call <field>Sync.dirty(t).
 */
export const PlayerTrait = trait(
    'player',
    {
        /** server-allocated Player id. set by the server at runtime. */
        playerId: 0,
        /** the client id that owns the Player. set by the server at runtime. */
        client: -1,
        /** stable authenticated user id (matchmaker / auth-session derived). */
        userId: '',
        /** display name for the user. */
        username: '',
        /** voxel chunk stream radius in chunks. server's Discovery flush iterates a
         *  sphere of this radius around the player's chunk coord. server-set per
         *  room mode at createPlayerNode time (small for play, large for edit).
         *  the eviction radius is `viewRadius + KEEP_HYSTERESIS` (discovery.ts). */
        viewRadius: 8,
    },
    { persist: false },
);

/** instance type for PlayerTrait */
export type PlayerTrait = TraitType<typeof PlayerTrait>;

export const playerIdSync = sync(PlayerTrait, 'playerId', {
    schema: pack.uint32(),
    pack: (t) => t.playerId,
    unpack: (v, t) => {
        t.playerId = v;
    },
    rate: 'dirty',
});

export const clientSync = sync(PlayerTrait, 'client', {
    schema: pack.int32(),
    pack: (t) => t.client,
    unpack: (v, t) => {
        t.client = v;
    },
    rate: 'dirty',
});

export const userIdSync = sync(PlayerTrait, 'userId', {
    schema: pack.string(),
    pack: (t) => t.userId,
    unpack: (v, t) => {
        t.userId = v;
    },
    rate: 'dirty',
});

export const usernameSync = sync(PlayerTrait, 'username', {
    schema: pack.string(),
    pack: (t) => t.username,
    unpack: (v, t) => {
        t.username = v;
    },
    rate: 'dirty',
});

export const viewRadiusSync = sync(PlayerTrait, 'viewRadius', {
    schema: pack.uint32(),
    pack: (t) => t.viewRadius,
    unpack: (v, t) => {
        t.viewRadius = v;
    },
    rate: 'dirty',
    authority: 'owner',
});
