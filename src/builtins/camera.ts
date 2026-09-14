import { trait } from '../core/registry';
import type { TraitType } from '../core/scene/traits';

/**
 * plain projection data (fov/near/far) for a scene-tree node. World pose lives on the sibling
 * TransformTrait; a controller or the editor lens owns the camera node and writes its pose each
 * frame. The active camera node is `client.camera`, which the renderer composes the render camera
 * from. `persist: false`, runtime-only.
 */
export const CameraTrait = trait(
    'camera',
    {
        /** vertical FOV in radians. */
        fov: 75 * (Math.PI / 180),
        /** near clip plane. */
        near: 0.05,
        /** far clip plane. */
        far: 1000,
    },
    { icon: 'kit:icon:camera', persist: false },
);

export type CameraTrait = TraitType<typeof CameraTrait>;
