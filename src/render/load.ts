// Render backend loader.
//
// The client calls `loadRenderBackend()` and programs against the returned
// `Renderer` handle — it never names the concrete `render/webgpu` / `render/webgl`
// modules or the selection logic. The dynamic `import()` is the code-split point:
// only the chosen backend is fetched/parsed for a session.

import { type Renderer, type RenderDeviceCaps, type RendererBackendKind, readRendererOverride } from './backend';

/** create + run the device handshake for one backend. */
async function createAndLoad(kind: RendererBackendKind): Promise<{ renderer: Renderer; caps: RenderDeviceCaps }> {
    const mod = kind === 'webgl' ? await import('./webgl') : await import('./webgpu');
    const renderer = mod.create();
    const caps = await renderer.load();
    return { renderer, caps };
}

/**
 * Can WebGPU actually stand up here? `navigator.gpu` only means the API is exposed;
 * the adapter still fails to materialize on a blocklisted GPU, with hardware accel
 * off, or in a headless/VM context. We make the SAME bare `requestAdapter()` the
 * WebGPU backend makes at init (gpucat passes no adapter options, and requests a
 * device with only adapter-advertised features + default limits — which can't fail
 * once the adapter exists), so a null here reliably predicts its init failure. Probe
 * up front rather than build a doomed renderer and catch the throw.
 */
async function webgpuAvailable(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.gpu) return false;
    try {
        return (await navigator.gpu.requestAdapter()) !== null;
    } catch {
        return false; // requestAdapter itself can throw in locked-down embeddings
    }
}

/**
 * Select + dynamically import the render backend, mint its `Renderer` handle, and
 * run the device handshake — returning a renderer that's ready to use plus the
 * adapter caps the client's tier detect needs.
 *
 * Prefer WebGPU when its adapter actually comes up (`webgpuAvailable` probes it),
 * else WebGL2 — the universal floor. A `?renderer=` override forces the backend and
 * skips the probe (QA wants the exact backend, and a forced WebGPU that can't init
 * should fail loudly, not silently downgrade). The `try/catch` is a backstop for the
 * pathological "adapter probed OK but the device request then loses the race" case;
 * the probe means it essentially never fires.
 */
export async function loadRenderBackend(): Promise<{ renderer: Renderer; caps: RenderDeviceCaps }> {
    const override = readRendererOverride();
    if (override) return createAndLoad(override);

    if (!(await webgpuAvailable())) return createAndLoad('webgl');
    try {
        return await createAndLoad('webgpu');
    } catch (err) {
        console.warn('[render] WebGPU device init failed after adapter probe; falling back to WebGL2.', err);
        return createAndLoad('webgl');
    }
}
