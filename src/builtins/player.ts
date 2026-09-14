import { sync, trait } from '../core/registry';
import { pack } from '../core/scene/pack';
import { dirty } from '../core/scene/sync/sync-rate';
import type { TraitType } from '../core/scene/traits';

/**
 * marks a node as the in-scene body of a specific Player, one (client, room, mode) view.
 * `persist: false`, player nodes are ephemeral, created at Player join time.
 *
 * playerId/client/userId/username are server-set runtime state, replicated as explicit-dirty
 * syncs. server code that mutates them must call `<field>Sync.dirty(t)`.
 */
export const PlayerTrait = trait(
    'player',
    {
        /** server-allocated Player id. */
        playerId: 0,
        /** the client id that owns the Player. */
        client: -1,
        /** stable authenticated user id (matchmaker / auth-session derived). */
        userId: '',
        /** display name for the user. */
        username: '',
        /**
         * voxel chunk stream radius in chunks; the server's Discovery flush iterates a sphere of this
         * radius around the player's chunk coord. Owner-authoritative: clamped to a mode-dependent
         * range on the server. Eviction radius is `streamRadius + RETENTION_MARGIN` (discovery.ts).
         */
        viewRadius: 8,
    },
    { icon: 'kit:icon:player', persist: false },
);

export type PlayerTrait = TraitType<typeof PlayerTrait>;

export const playerIdSync = sync(PlayerTrait, 'playerId', {
    schema: pack.uint32(),
    pack: (t) => t.playerId,
    unpack: (v, t) => {
        t.playerId = v;
    },
    dirty: dirty.explicit(),
});

export const clientSync = sync(PlayerTrait, 'client', {
    schema: pack.int32(),
    pack: (t) => t.client,
    unpack: (v, t) => {
        t.client = v;
    },
    dirty: dirty.explicit(),
});

export const userIdSync = sync(PlayerTrait, 'userId', {
    schema: pack.string(),
    pack: (t) => t.userId,
    unpack: (v, t) => {
        t.userId = v;
    },
    dirty: dirty.explicit(),
});

export const usernameSync = sync(PlayerTrait, 'username', {
    schema: pack.string(),
    pack: (t) => t.username,
    unpack: (v, t) => {
        t.username = v;
    },
    dirty: dirty.explicit(),
});

export const viewRadiusSync = sync(PlayerTrait, 'viewRadius', {
    schema: pack.uint32(),
    pack: (t) => t.viewRadius,
    unpack: (v, t) => {
        t.viewRadius = v;
    },
    dirty: dirty.explicit(),
    authority: 'owner',
});
