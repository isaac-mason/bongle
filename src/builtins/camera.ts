import { type TraitType, trait } from '../core/scene/traits';

/**
 * camera trait, plain projection data (fov/near/far) for a scene-tree node.
 * world pose lives on the sibling TransformTrait; a controller (player /
 * orbit / fly) or the editor lens owns the camera node and writes its pose
 * through TransformTrait each frame. the active camera node is `client.camera`
 * on the client state, which the renderer composes the render camera from.
 *
 * the renderer composes a per-room PerspectiveCamera each frame from
 * (camera node Transform + this trait), see `Renderer.syncRenderCamera`.
 *
 * persist: false, runtime-only; camera nodes are recreated on room spin-up and
 * never survive a scene round-trip.
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
    { persist: false },
);

/** instance type for CameraTrait */
export type CameraTrait = TraitType<typeof CameraTrait>;
