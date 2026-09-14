import { type TraitType } from '../core/scene/traits';
import { trait } from '../core/registry';

/**
 * client-only override for the room's audio listener pose source. By default the audio runtime
 * reads listener position + orientation from the client's `pov` node's TransformTrait. Attach this
 * trait to a different node to decouple hearing from the camera pose; the first node carrying an
 * active `AudioListenerTrait` wins, the POV node is only a fallback. `persist: false`, this is a
 * runtime routing concern. Disable temporarily via `active: false` rather than removing the trait.
 */
export const AudioListenerTrait = trait('audio-listener', { active: true }, { persist: false });

export type AudioListenerTrait = TraitType<typeof AudioListenerTrait>;
