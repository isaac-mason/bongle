/**
 * the user calls config(c) at module scope; the call upserts into
 * `registry.config` under CONFIG_ID, and consumers read it via
 * `launchConfig(reg)` (defaulting to DEFAULT_CONFIG when unset).
 *
 * a game declares:
 *   - config({ standalone: true })            — client-only, no server.
 *   - config({ server: { maxPlayers: N } })   — client+server multiplayer.
 * omitting config() entirely defaults to DEFAULT_CONFIG (multiplayer,
 * maxPlayers 10), preserving the pre-existing platform behavior.
 *
 * three consumers read the launch config:
 *   1. the engine itself (engine-server), refuses onClientJoin past the cap.
 *   2. the bongle build pipeline, stamps the value into bongle.json so the
 *      platform can read it without booting the bundle.
 *   3. (future) any in-game UI / platform routing that wants to read it.
 *
 * keep the field set narrow: only launch-shaped knobs belong here. non-launch
 * game metadata (display name, icon, …) lives elsewhere.
 */

import { recordConfig } from './capture/module-scope';
import { registry, upsert } from './registry';

/** Singleton id under which the launch config lives in `registry.config`.
 *  the user only ever declares one, a second config() call from a different
 *  module triggers the registry's cross-module-ownership guard. */
export const CONFIG_ID = 'main';

/** Hard ceiling enforced both at the platform (manifest validation) and here
 *  (config() call). Bumping this is a coordinated change with
 *  apps/service/src/matchmaking. */
export const HARD_MAX_PLAYERS_PER_ROOM = 32;

/**
 * per-game launch config.
 *   - { standalone: true }             — client-only game, no server runs.
 *   - { server: { maxPlayers } }       — client+server game. `maxPlayers`
 *     caps simultaneous players in a single room; integer in
 *     [1, HARD_MAX_PLAYERS_PER_ROOM].
 */
export type Config = { standalone: true } | { server: { maxPlayers: number } };

/** Applied when the user didn't call config(), preserves the pre-existing
 *  platform behavior (multiplayer, rooms cap at 10). */
export const DEFAULT_CONFIG: Config = { server: { maxPlayers: 10 } };

/** True when the config is a client-only (standalone) game. */
export function isStandalone(c: Config): c is { standalone: true } {
    return 'standalone' in c;
}

/** The per-room player cap for a server config, or null for standalone. */
export function serverMaxPlayers(c: Config): number | null {
    return 'server' in c ? c.server.maxPlayers : null;
}

/**
 * declare per-game launch config. call once at module scope, before
 * scripts/traits/etc. only the first call wins, a second call throws so
 * conflicts don't sit hidden.
 */
export function config(c: Config): Config {
    if ('server' in c) {
        const maxPlayers = c.server.maxPlayers;
        if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > HARD_MAX_PLAYERS_PER_ROOM) {
            throw new Error(`config({ server: { maxPlayers } }): expected integer in [1, ${HARD_MAX_PLAYERS_PER_ROOM}], got ${maxPlayers}`);
        }
    }
    upsert(registry.config, CONFIG_ID, c);
    recordConfig(CONFIG_ID);
    return c;
}
