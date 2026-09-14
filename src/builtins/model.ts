import { trait } from '../core/registry';
import type { TraitType } from '../core/scene/traits';

export const ModelTrait = trait('model', {
    /** visibility for every mesh under this model, the inherited half of the pair whose local half is `MeshTrait.visible`. A renderer skips a mesh when either is false. */
    visible: true,
});

export type ModelTrait = TraitType<typeof ModelTrait>;
