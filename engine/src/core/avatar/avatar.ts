// Engine-facing avatar shape — what user scripts see in `onJoin`.
//
// Distinct from the driver-layer `ResolvedAvatar` (lib/interface/server.ts),
// which carries source discriminator + per-side URLs + content hash for the
// engine's join lifecycle to acquire payload bytes. By the time game code
// runs none of that matters: the model is already registered in Resources
// and the rig is already mounted under playerNode. All scripts need is
// the rig contract (for bone-name lookups) and the model handle.
//
// `modelId` is reachable as `avatar.model.modelId` — not duplicated here.

import type { ModelHandle } from '../models/handle';

export type Avatar = {
    /** Rig contract this avatar implements, e.g. `RIG_TYPE_6BONE`. Lets
     *  game code branch on rig family before reaching for bones. */
    rigType: string;

    /** Loaded model handle — already in `Resources` and mounted under the
     *  player's `CharacterTrait`. Lookup bones via `model.nodes`, animation
     *  clips via `model.animations`. */
    model: ModelHandle;
};
