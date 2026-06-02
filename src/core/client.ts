/** numeric id assigned to a connected client. 0 = unassigned. */
export type ClientId = number;

/**
 * numeric id for a Player — one per (client, room, mode). Server
 * allocates positive ids; client-only "local" rooms allocate negative
 * ids. The two ranges never collide because local PlayerIds never
 * cross the wire.
 */
export type PlayerId = number;
