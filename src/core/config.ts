/**
 * the user calls config(c) at module scope; the call upserts into
 * `registry.config` under CONFIG_ID, and consumers read it via
 * `resolveConfig(reg)` (defaulting to DEFAULT_CONFIG when unset).
 *
 * a game declares:
 *   - config({ server: false })               — client-only, no server.
 *   - config({ server: { maxPlayers: N } })   — client+server multiplayer.
 * omitting `server` (or config() entirely) defaults to DEFAULT_CONFIG
 * (multiplayer, maxPlayers 32), preserving the pre-existing platform behavior.
 *
 * three consumers read the config:
 *   1. the engine itself (engine-server), refuses onClientJoin past the cap.
 *   2. the bongle build pipeline, stamps the value into bongle.json so the
 *      platform can read it without booting the bundle.
 *   3. (future) any in-game UI / platform routing that wants to read it.
 *
 * keep the field set narrow: only infrastructure knobs belong here. presentational
 * game metadata (display name, icon, …) lives elsewhere.
 */

import type { Config } from '../../os/interface';
import { recordConfig } from './capture/module-scope';
import { declare, registry } from './registry';

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
 * per-game config. a single axis, `server`:
 *   - omitted                          — client+server game, default room cap.
 *   - { server: false }                — client-only game, no server runs.
 *   - { server: { maxPlayers } }       — client+server game. `maxPlayers`
 *     caps simultaneous players in a single room; integer in
 *     [1, HARD_MAX_PLAYERS_PER_ROOM].
 */
// Config is DEFINED at the editor-OS boundary (bongle/os, imported above) — one
// stability-guaranteed, additive-only shape, since it crosses the pin boundary
// (the pipeline service reports it) and stamps the bundle manifest. The engine
// re-exports it rather than redeclaring: one definition, no drift possible.

/** Applied when the user didn't call config(), preserves the pre-existing
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

/**
 * declare per-game config. call once at module scope, before
 * scripts/traits/etc. only the first call wins, a second call throws so
 * conflicts don't sit hidden.
 */
export function config(c: Config): Config {
    // truthy narrows away `false` and `undefined`, leaving the { maxPlayers } arm.
    const server = c.server;
    if (server) {
        const maxPlayers = server.maxPlayers;
        if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > HARD_MAX_PLAYERS_PER_ROOM) {
            throw new Error(
                `config({ server: { maxPlayers } }): expected integer in [1, ${HARD_MAX_PLAYERS_PER_ROOM}], got ${maxPlayers}`,
            );
        }
    }
    // The payload is the CALLER'S OWN object, so unlike every other kind there is
    // nothing for the engine to mint an identity for — `config()` hands `c` straight
    // back. It still goes through `declare` so the singleton is stored, hashed and
    // change-detected exactly like the rest; the handle is bookkeeping nobody reads.
    declare(
        registry.config,
        CONFIG_ID,
        () => c,
        (def) => ({ id: CONFIG_ID, dependency: { registry: 'config' as const, id: CONFIG_ID }, def }),
    );
    recordConfig(CONFIG_ID);
    return c;
}
