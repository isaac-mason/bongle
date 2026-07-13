// flags for setBlock / setChunkBlock. every write settles its block-def hooks
// (onNeighbourUpdate + onNeighbourChanged — fence joins, stair shapes, etc.)
// inline; the flag only controls whether the write also fires SCRIPT observers
// (onBlockBuild/Break/StateChange).

export const SetBlockFlags = {
    /** block-def hooks: onNeighbourUpdate + onNeighbourChanged (and future
     *  def-level hooks) — settle the block's own state from its neighbourhood,
     *  e.g. fences joining, stairs shaping. */
    BLOCK_HOOKS: 1 << 0,
    /** script events: onBlockBuild / onBlockBreak / onBlockStateChange observers
     *  registered per-room by game scripts. */
    BLOCK_EVENTS: 1 << 1,

    /** gameplay write: run block-def hooks AND fire script events. */
    DEFAULT: (1 << 0) | (1 << 1),
    /** bulk-authoring write (worldgen, paste, editor brush): run block-def hooks
     *  so structure settles (fences join), but fire NO script events. */
    BULK: 1 << 0,
} as const;
