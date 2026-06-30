import type { PerspectiveCamera } from 'gpucat';
import * as Rooms from '../client/rooms';
import type { Node } from '../core/scene/nodes';
import { getTrait } from '../core/scene/nodes';
import type { ScriptContext } from '../core/scene/scripts';
import { type TraitType, trait } from '../core/scene/traits';

/**
 * camera trait, plain projection data (fov/near/far) for a scene-tree node.
 * world pose lives on the sibling TransformTrait; a controller (player /
 * orbit / fly) creates the camera node, owns this trait, and writes pose
 * through TransformTrait each frame.
 *
 * the renderer composes a per-room PerspectiveCamera each frame from
 * (camera node Transform + this trait), see `Renderer.syncRenderCamera`.
 *
 * persist: false, runtime-only; the camera node is recreated on every
 * controller spin-up and never survives a scene round-trip.
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

/**
 * pointer attached to the POV node, references the CameraTrait the
 * renderer should compose the active render camera from. Controllers
 * (builtin or DIY) add this on init and set `camera` to the trait on
 * whichever node they want the renderer to see; clear / detach on dispose.
 *
 * the CameraTrait reference reaches the camera node via the standard `_node`
 * back-ref, so the renderer also gets to the sibling TransformTrait through
 * the same handle.
 *
 * persist: false, runtime-only wiring.
 */
export const CameraRefTrait = trait(
    'camera-ref',
    {
        /** the CameraTrait to render through. undefined while no controller is active. */
        camera: undefined as CameraTrait | undefined,
    },
    { persist: false },
);

/** instance type for CameraRefTrait */
export type CameraRefTrait = TraitType<typeof CameraRefTrait>;

/**
 * resolve the active POV node's render camera from a script ctx. on the
 * client this returns the per-room renderer-owned PerspectiveCamera, freshly
 * synced from the active CameraTrait + camera-node Transform. returns null
 * on the server, when no room is wired, or when no controller has spun up
 * its camera node yet.
 */
export function getPovCamera(ctx: ScriptContext): PerspectiveCamera | null {
    const room = ctx.client?.room;
    if (!room) return null;
    return Rooms.getPovCamera(room);
}

/**
 * resolve the camera this script's node drives, CameraRefTrait on `ctx.node`
 * if present (the standard wiring; POV-eligible nodes get it pre-installed
 * at room init and the editor lens points its own at a private camera),
 * falling back to the room's default camera. returns both the CameraTrait
 * (projection) and its node (sibling TransformTrait lives there). only
 * valid in client scripts (relies on `ctx.client`).
 */
export function resolveCamera(ctx: ScriptContext): { camera: CameraTrait; node: Node } {
    const ref = getTrait(ctx.node, CameraRefTrait);
    const cam = ref?.camera ?? getTrait(ctx.client!.camera, CameraTrait)!;
    return { camera: cam, node: cam._node! };
}
