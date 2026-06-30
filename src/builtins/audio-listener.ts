import { type TraitType, trait } from '../core/scene/traits';

/**
 * Client-only override hook for the room's audio listener pose source.
 *
 * By default the audio runtime (`client/audio/audio.ts`) reads listener
 * position + orientation from `room.pov.node`'s TransformTrait, the
 * same node the renderer derives the active camera from. That's the
 * right pick for first-person and most third-person cameras, where the
 * "ears" and the "eyes" sit at the same node.
 *
 * Attach this trait to a different node when you want to decouple them,
 * e.g. a third-person camera that orbits the player but should hear
 * the world from the player's head, not from the camera's pose. The
 * first node carrying an active `AudioListenerTrait` wins; the POV
 * node is only consulted as a fallback.
 *
 * `persist: false` because this is a runtime camera/audio routing
 * concern, not part of the saved scene. Disable temporarily by flipping
 * `active: false` rather than removing + re-adding the trait.
 */
export const AudioListenerTrait = trait('audio-listener', { active: true }, { persist: false });

/** instance type for AudioListenerTrait */
export type AudioListenerTrait = TraitType<typeof AudioListenerTrait>;
