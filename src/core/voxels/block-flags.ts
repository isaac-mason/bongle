// flags for setBlock — control which hook passes fire inline before the
// call returns. modelled after Minecraft's Constants.BlockFlags.
//
// gameplay defaults to settling the op inline (NOTIFY_NEIGHBOURS | FIRE_EVENTS)
// so a place-then-read sees coherent state. bulk paths (editor commands,
// worldgen, prefab paste) pass BULK and drain explicitly at the end.

export const SetBlockFlags = {
    /** fire onNeighbourUpdate on the cell + its 6 neighbours, inline. */
    NOTIFY_NEIGHBOURS: 1 << 0,
    /** fire onBlockBuild/Break/StateChange observers and intrinsic
     *  onNeighbourChanged on the 6 neighbours, inline. */
    FIRE_EVENTS: 1 << 1,

    /** gameplay default — settle this op inline. */
    DEFAULT: (1 << 0) | (1 << 1),
    /** bulk default — append-only; caller drains via
     *  runNeighbourRecompute / runBlockEventHooks. */
    BULK: 0,
} as const;
