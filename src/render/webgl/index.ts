// WebGL2 render backend — PHASE 1 STUB.
//
// Exists so the backend facade (`render/backend`) has a real code-split target
// for `?renderer=webgl` and the WebGPU-absent fallback. No implementation yet:
// every method throws. The real impl (attribute/data-texture instance path, CPU
// voxel cull/emit, per-room visuals) lands in later phases — see
// llm/plan-webgl2-renderer.md.
//
// One typed `backend` object; the annotation IS the contract check. Its state
// type is a throwaway (`any`) while every method throws — the real state type
// arrives with the implementation.

import type { RenderBackendModule } from '../backend';

const NOT_IMPLEMENTED =
    '[render/webgl] WebGL2 backend is not implemented yet (phase 1). ' +
    'Remove ?renderer=webgl, or run on a WebGPU-capable browser.';

const notImplemented = (): never => {
    throw new Error(NOT_IMPLEMENTED);
};

// `any` state: the stub is unused (every method throws) and names no real state
// type; the concrete state arrives with the WebGL impl.
export const backend: RenderBackendModule<any> = {
    kind: 'webgl',
    init: notImplemented,
    load: notImplemented,
    dispose: notImplemented,
    resize: notImplemented,
    setInspectorVisible: notImplemented,
    initResources: notImplemented,
    loadResources: notImplemented,
    disposeResources: notImplemented,
    createRoomVisuals: notImplemented,
    disposeRoomVisuals: notImplemented,
    updateRoom: notImplemented,
    mountRoom: notImplemented,
    unmountRoom: notImplemented,
    render: notImplemented,
    refreshBlockResources: notImplemented,
    refreshSpriteResources: notImplemented,
};
