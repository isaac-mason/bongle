import { PerspectiveCamera } from 'gpucat';
import type { CameraTrait } from '../builtins/camera';
import { getWorldPosition, getWorldQuaternion, TransformTrait } from '../builtins/transform';
import { getTrait } from '../core/scene/scene-tree';

/** Default vertical fov in radians; overwritten each frame by `syncCamera` from the active CameraTrait. */
const DEFAULT_FOV = 75 * (Math.PI / 180);

/** Mints the backend's render camera. Called once in each backend's `create()`. */
export function createCamera(): PerspectiveCamera {
    return new PerspectiveCamera(DEFAULT_FOV);
}

/** Composes `camera` from the active CameraTrait and its sibling TransformTrait. Idempotent; no-op when `cameraTrait` is null. */
export function syncCamera(camera: PerspectiveCamera, cameraTrait: CameraTrait | null): void {
    if (!cameraTrait) return;
    const cameraNode = cameraTrait._node;
    const transform = getTrait(cameraNode, TransformTrait);
    if (transform) {
        const wp = getWorldPosition(transform);
        const wq = getWorldQuaternion(transform);
        camera.position[0] = wp[0]!;
        camera.position[1] = wp[1]!;
        camera.position[2] = wp[2]!;
        camera.quaternion[0] = wq[0]!;
        camera.quaternion[1] = wq[1]!;
        camera.quaternion[2] = wq[2]!;
        camera.quaternion[3] = wq[3]!;
    }

    let projDirty = false;
    if (camera.fov !== cameraTrait.fov) {
        camera.fov = cameraTrait.fov;
        projDirty = true;
    }
    if (camera.near !== cameraTrait.near) {
        camera.near = cameraTrait.near;
        projDirty = true;
    }
    if (camera.far !== cameraTrait.far) {
        camera.far = cameraTrait.far;
        projDirty = true;
    }
    if (projDirty) camera.updateProjectionMatrix();

    camera.updateWorldMatrix();
    camera.updateViewMatrix();
}

/** Ensures `camera`'s aspect matches the display size; no-op on a zero size (keeps the last aspect). */
export function bindAspect(camera: PerspectiveCamera, width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    const aspect = width / height;
    if (camera.aspect !== aspect) {
        camera.aspect = aspect;
        camera.updateProjectionMatrix();
    }
}

/** Resolves `camera` into the given room's live POV, syncing pose/fov from `cameraTrait`. Returns null when `cameraTrait` is null; aspect is bound separately via `bindAspect`. */
export function resolvePovCamera(camera: PerspectiveCamera, cameraTrait: CameraTrait | null): PerspectiveCamera | null {
    if (!cameraTrait) return null;
    syncCamera(camera, cameraTrait);
    return camera;
}
