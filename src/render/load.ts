// Render backend loader.
//
// The client calls `loadRenderBackend()` and programs against the returned
// `RenderBackendModule` contract — it never names the concrete `render/webgpu` /
// `render/webgl` modules or the selection logic. The dynamic `import()` is the
// code-split point: only the chosen backend is fetched/parsed for a session.

import { type RenderBackendModule, selectBackend } from './backend';
import type { Renderer } from './webgpu';

/**
 * Select + dynamically import the render backend (WebGPU, or the WebGL stub),
 * returning its contract object. Phase 1: WebGPU is the only real backend, so the
 * state handle is its `Renderer`; the WebGL stub satisfies the same contract.
 */
export async function loadRenderBackend(): Promise<RenderBackendModule<Renderer>> {
    const mod = selectBackend() === 'webgl' ? await import('./webgl') : await import('./webgpu');
    return mod.backend;
}
