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

