// Render backend loader.
//
// The client calls `loadRenderBackend()` and programs against the returned
// `Renderer` handle — it never names the concrete `render/webgpu` / `render/webgl`
// modules or the selection logic. The dynamic `import()` is the code-split point:
// only the chosen backend is fetched/parsed for a session.

import { type Renderer, selectBackend } from './backend';

/**
 * Select + dynamically import the render backend (WebGPU or WebGL2) and mint its
 * `Renderer` handle via `create()`. Both are full backends behind one contract;
 * `selectBackend()` prefers WebGPU and falls back to WebGL2.
 */
export async function loadRenderBackend(): Promise<Renderer> {
    const mod = selectBackend() === 'webgl' ? await import('./webgl') : await import('./webgpu');
    return mod.create();
}
