// Backend-neutral render-camera helpers. These compose the engine-global
// pipeline's persistent PerspectiveCamera from the active CameraTrait and keep
// its aspect in sync with the viewport. They touch only gpucat camera math and
// the pipeline handle — no WebGPU/WebGL device state — so both backends share
// them (the pipeline graph itself is backend-neutral in gpucat).

import type { CanvasTarget } from 'gpucat';
import type { CameraTrait } from '../../builtins/camera';
import { getWorldPosition, getWorldQuaternion, TransformTrait } from '../../builtins/transform';
import { getTrait } from '../../core/scene/scene-tree';
import type { EngineRenderPipeline } from './pipeline';

/**
 * compose the pipeline's persistent render camera from the active CameraTrait
 * (and its sibling TransformTrait). pose comes from the camera node's world
 * transform; fov/near/far come from CameraTrait. projection rebuilds only on
 * change. idempotent, safe to call multiple times per frame.
 *
 * no-op when cameraTrait is null (no active POV).
 */
export function syncRenderCamera(pipeline: EngineRenderPipeline, cameraTrait: CameraTrait | null): void {
    if (!cameraTrait) return;
    const cameraNode = cameraTrait._node;
    const transform = getTrait(cameraNode, TransformTrait);
    const out = pipeline.camera;
    if (transform) {
        const wp = getWorldPosition(transform);
        const wq = getWorldQuaternion(transform);
        out.position[0] = wp[0]!;
        out.position[1] = wp[1]!;
        out.position[2] = wp[2]!;
        out.quaternion[0] = wq[0]!;
        out.quaternion[1] = wq[1]!;
        out.quaternion[2] = wq[2]!;
        out.quaternion[3] = wq[3]!;
    }

    let projDirty = false;
    if (out.fov !== cameraTrait.fov) {
        out.fov = cameraTrait.fov;
        projDirty = true;
    }
    if (out.near !== cameraTrait.near) {
        out.near = cameraTrait.near;
        projDirty = true;
    }
    if (out.far !== cameraTrait.far) {
        out.far = cameraTrait.far;
        projDirty = true;
    }
    if (projDirty) out.updateProjectionMatrix();

    out.updateWorldMatrix();
    out.updateViewMatrix();
}

/**
 * ensure pipeline.camera's aspect matches the viewport. called per frame
 * after syncRenderCamera. projection rebuilds only on change.
 */
export function bindRenderCamera(pipeline: EngineRenderPipeline, canvasTarget: CanvasTarget): void {
    const { width, height } = canvasTarget.getSize();
    if (width <= 0 || height <= 0) return;
    const aspect = width / height;
    const camera = pipeline.camera;
    if (camera.aspect !== aspect) {
        camera.aspect = aspect;
        camera.updateProjectionMatrix();
    }
}
