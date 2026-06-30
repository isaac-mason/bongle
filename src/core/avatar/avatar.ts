// Engine-facing avatar identity, the resolved avatar recorded on a
// client at join time.
//
// Distinct from the driver-layer `ResolvedAvatar` (lib/interface/server.ts),
// which also carries the per-side payload URLs + content hash the join
// lifecycle needs to acquire the model bytes. By the time this identity
// is recorded the payload is already being loaded into Resources and the
// `CharacterTrait` reconciler mounts the rig once it lands; all that
// remains here is the model id and its rig contract.

export type Avatar = {
    /** Resolved model id, registered with `Resources`, written onto the
     *  player's `CharacterTrait.modelId`. */
    modelId: string;

    /** Rig contract this avatar implements, e.g. `RIG_TYPE_6BONE`. Lets
     *  game code branch on rig family before reaching for bones. */
    rigType: string;
};
