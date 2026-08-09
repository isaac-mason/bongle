// The render camera: one gpucat PerspectiveCamera per backend, minted in the
// backend's `create()` and exposed as `Renderer.camera`. It's a stable object
// (created once, matrices updated in place) — the pass binds it, the client resolves
// it per-frame for cull, the editor reads it. Resolution is pure gpucat camera math
// (pose from a CameraTrait node, aspect from the viewport) — no device state — so it
// lives here in backend-shared `common`; consumers get a plain Camera, never reach
// through the backend for camera behaviour.

import { PerspectiveCamera } from 'gpucat';
import type { CameraTrait } from '../builtins/camera';
import { getWorldPosition, getWorldQuaternion, TransformTrait } from '../builtins/transform';
import { getTrait } from '../core/scene/scene-tree';

/** default vertical fov (radians); overwritten each frame by `syncCamera` from the
 *  active CameraTrait. */
const DEFAULT_FOV = 75 * (Math.PI / 180);

/** Mint the backend's render camera. Called once in each backend's `create()`. */
export function createCamera(): PerspectiveCamera {
    return new PerspectiveCamera(DEFAULT_FOV);
}

/**
 * Compose `camera` from the active CameraTrait (and its sibling TransformTrait):
 * pose from the camera node's world transform; fov/near/far from the trait.
 * Projection rebuilds only on change. Idempotent — safe to call repeatedly per
 * frame. No-op when `cameraTrait` is null (no active POV).
 */
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

/** Ensure `camera`'s aspect matches the display size. Projection rebuilds only on
 *  change; no-op on a zero size (keeps the last aspect). Aspect is a global property
 *  of the single shared display surface (one room renders at a time), so the client
 *  binds it once per frame from the viewport size rather than per camera-resolve. */
export function bindAspect(camera: PerspectiveCamera, width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    const aspect = width / height;
    if (camera.aspect !== aspect) {
        camera.aspect = aspect;
        camera.updateProjectionMatrix();
    }
}

/**
 * Resolve `camera` into the given room's live POV: sync pose/fov from `cameraTrait`,
 * return `camera`. Returns null when `cameraTrait` is null (no active POV) — the
 * camera is left untouched. Aspect is bound separately/globally via `bindAspect`.
 * Used by the client's per-frame cull + the editor tools + the backend's active-room drive.
 */
export function resolvePovCamera(
    camera: PerspectiveCamera,
    cameraTrait: CameraTrait | null,
): PerspectiveCamera | null {
    if (!cameraTrait) return null;
    syncCamera(camera, cameraTrait);
    return camera;
}
