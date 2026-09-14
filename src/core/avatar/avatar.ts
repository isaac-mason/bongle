export type Avatar = {
    /** Resolved model id, registered with `Resources`, written onto the
     *  player's `CharacterTrait.modelId`. */
    modelId: string;

    /** Rig contract this avatar implements, e.g. `RIG_TYPE_6BONE`. Lets
     *  game code branch on rig family before reaching for bones. */
    rigType: string;
};
