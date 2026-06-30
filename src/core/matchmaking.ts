/**
 * core/matchmaking.ts, declarative matchmaking config.
 *
 * the user calls matchmaking({ maxPlayers }) at module scope; the call
 * upserts into `matchmakingRegistry`, and `getProjectModule()` reads it
 * into `ProjectModule.matchmaking` (defaulting if unset).
 *
 * three consumers read from ProjectModule.matchmaking:
 *   1. the engine itself (engine-server), refuses onClientJoin past the cap.
 *   2. the kit build pipeline, stamps the value into bongle.json so the
 *      platform can read it without booting the bundle.
 *   3. (future) any in-game UI that wants to display the cap.
 *
 * keep the field set narrow: only matchmaking-shaped knobs belong here.
 * non-matchmaking game metadata (display name, icon, …) lives elsewhere.
 */

import { recordMatchmaking } from './capture/module-scope';
import { registry, upsert } from './registry';

/** Singleton id under which matchmaking config lives in matchmakingRegistry.
 *  the user only ever declares one, a second matchmaking() call from a
 *  different module triggers the registry's cross-module-ownership guard. */
export const MATCHMAKING_ID = 'main';

/** Hard ceiling enforced both at the platform (manifest validation) and
 *  here (matchmaking() call). Bumping this is a coordinated change with
 *  apps/service/src/matchmaking. */
export const HARD_MAX_PLAYERS_PER_ROOM = 32;

export type MatchmakingConfig = {
    /** DepGraph dependency, see SceneHandle.dependency. */
    dependency: { registry: 'matchmaking'; id: string };
    /** Cap on simultaneous players in a single room. Must be an integer
     *  in [1, HARD_MAX_PLAYERS_PER_ROOM]. */
    maxPlayers: number;
};

/** Applied when the user didn't call matchmaking(), preserves the
 *  pre-existing platform behavior (rooms cap at 10). */
export const DEFAULT_MATCHMAKING_CONFIG: MatchmakingConfig = {
    dependency: { registry: 'matchmaking', id: MATCHMAKING_ID },
    maxPlayers: 10,
};

export type MatchmakingOptions = {
    /** Cap on simultaneous players per room. Defaults to 10. */
    maxPlayers?: number;
};

/**
 * declare per-game matchmaking config. call once at module scope, before
 * scripts/traits/etc. only the first call wins, a second call throws so
 * conflicts don't sit hidden.
 */
export function matchmaking(opts: MatchmakingOptions = {}): MatchmakingConfig {
    const maxPlayers = opts.maxPlayers ?? DEFAULT_MATCHMAKING_CONFIG.maxPlayers;
    if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > HARD_MAX_PLAYERS_PER_ROOM) {
        throw new Error(`matchmaking({ maxPlayers }): expected integer in [1, ${HARD_MAX_PLAYERS_PER_ROOM}], got ${maxPlayers}`);
    }

    const config: MatchmakingConfig = {
        dependency: { registry: 'matchmaking', id: MATCHMAKING_ID },
        maxPlayers,
    };
    upsert(registry.matchmaking, MATCHMAKING_ID, config);
    recordMatchmaking(MATCHMAKING_ID);
    return config;
}
