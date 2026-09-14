import type { Config } from '../../os/interface';

export type { Config };

/** Singleton id under which the config lives in `registry.config`.
 *  the user only ever declares one, a second config() call from a different
 *  module triggers the registry's cross-module-ownership guard. */
export const CONFIG_ID = 'main';

/** Hard ceiling enforced both at the platform (manifest validation) and here
 *  (config() call). Bumping this is a coordinated change with
 *  apps/service/src/matchmaking. */
export const HARD_MAX_PLAYERS_PER_ROOM = 32;

/** default per-room player cap for a server game that doesn't specify one
 *  (and for a game that omits config() entirely). */
export const DEFAULT_MAX_PLAYERS = 32;

/** the sim loop's rate when a game doesn't pick one. `EngineServer.start` paces on it,
 *  and the send-path rate gate converts a sync's `rate.hz(...)` into a tick interval
 *  against the room's actual rate. */
export const DEFAULT_TICK_RATE = 60;

/** floor on `tickRate`. Not lower because the remote-transform chase clamps an
 *  observed send interval to twice `TRANSFORM_SEND_HZ`'s (66.7ms): below ~15Hz
 *  keyframes arrive slower than a remote entity can ease between them, so every
 *  remote pose finishes its ease and then sits frozen until the next one lands. */
export const MIN_TICK_RATE = 15;

/** ceiling on `tickRate`. The client's own sim loop runs at 60, so a faster server
 *  buys nothing a game can observe and costs a room's worth of CPU per extra tick. */
export const MAX_TICK_RATE = 60;

/**
 * per-game config. a single axis, `server`: omitted is a client+server game
 * with the default room cap; `{ server: false }` is client-only (no server
 * runs); `{ server: { maxPlayers } }` caps simultaneous players in a single
 * room, integer in [1, HARD_MAX_PLAYERS_PER_ROOM].
 */
// Config is defined at the editor-OS boundary (bongle/os, imported above);
// the engine re-exports it rather than redeclaring.

/** Applied when the user didn't call config(); preserves the pre-existing
 *  platform behavior (multiplayer, rooms cap at DEFAULT_MAX_PLAYERS). */
export const DEFAULT_CONFIG: Config = { server: { maxPlayers: DEFAULT_MAX_PLAYERS } };

/** True when the game is client-only (`server: false`). */
export function isStandalone(c: Config): boolean {
    return c.server === false;
}

/** The per-room player cap for a server game, or null for a client-only game. */
export function serverMaxPlayers(c: Config): number | null {
    if (c.server === false) return null;
    return c.server?.maxPlayers ?? DEFAULT_MAX_PLAYERS;
}

/** The sim loop's rate for a server game, or null for a client-only game (which runs
 *  no server loop; its client ticks at its own fixed rate regardless). */
export function serverTickRate(c: Config): number | null {
    if (c.server === false) return null;
    return c.server?.tickRate ?? DEFAULT_TICK_RATE;
}
