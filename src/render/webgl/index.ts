// WebGL2 render backend — PHASE 1 STUB.
//
// Exists so the backend facade (`render/backend`) has a real code-split target
// for `?renderer=webgl` and the WebGPU-absent fallback. No implementation yet:
// every method throws. The real impl (attribute/data-texture instance path, CPU
// voxel cull/emit, per-room visuals) lands in later phases — see
// llm/plan-webgl2-renderer.md.
//
// `create()` returns a `Renderer` handle whose every method throws — the same
// contract the WebGPU backend fulfils, so the loader mints it uniformly. The real
// state + method bodies arrive with the implementation.

import type { Renderer } from '../backend';

const NOT_IMPLEMENTED =
    '[render/webgl] WebGL2 backend is not implemented yet (phase 1). ' +
    'Remove ?renderer=webgl, or run on a WebGPU-capable browser.';

const notImplemented = (): never => {
    throw new Error(NOT_IMPLEMENTED);
};

/** Mint the (stub) WebGL backend handle. Every method throws until the impl lands;
 *  `notImplemented` (`() => never`) satisfies any `Renderer` member signature. */
export function create(): Renderer {
    return {
        kind: 'webgl',
        load: notImplemented,
        dispose: notImplemented,
        resize: notImplemented,
        setInspectorVisible: notImplemented,
        detectPerformance: notImplemented,
        renderClock: notImplemented,
        initResources: notImplemented,
        loadResources: notImplemented,
        disposeResources: notImplemented,
        updateModelResources: notImplemented,
        removeChunkMesh: notImplemented,
        spriteResources: notImplemented,
        createRoomVisuals: notImplemented,
        disposeRoomVisuals: notImplemented,
        updateRoom: notImplemented,
        mountRoom: notImplemented,
        unmountRoom: notImplemented,
        flushRoomEnv: notImplemented,
        getRenderCamera: notImplemented,
        render: notImplemented,
        refreshBlockResources: notImplemented,
        refreshSpriteResources: notImplemented,
    };
}
