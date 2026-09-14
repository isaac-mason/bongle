import { type RenderDeviceCaps, type Renderer, type RendererBackendKind, readRendererOverride, webgpuAvailable } from './backend';

/** Creates and runs the device handshake for one backend. The dynamic `import()` is the code-split point: only the chosen backend is fetched for a session. */
async function createAndLoad(kind: RendererBackendKind): Promise<{ renderer: Renderer; caps: RenderDeviceCaps }> {
    const mod = kind === 'none' ? await import('./none') : kind === 'webgl' ? await import('./webgl') : await import('./webgpu');
    const renderer = mod.create();
    const caps = await renderer.load();
    return { renderer, caps };
}

/**
 * Selects and dynamically imports the render backend, mints its `Renderer` handle, and
 * runs the device handshake, returning a renderer ready to use plus the adapter caps
 * the client's tier detect needs.
 *
 * The host normally probes the device once and stamps the answer in as `?renderer=`, so
 * every realm it spawns agrees. With no host, falls through to `webgpuAvailable`, a bare
 * adapter check. WebGPU that fails to stand up always steps down to WebGL2 rather than
 * throwing, and reports the demotion back to the host (`ClientDriver.graphics`).
 */
export async function loadRenderBackend(): Promise<{ renderer: Renderer; caps: RenderDeviceCaps }> {
    const requested = readRendererOverride() ?? ((await webgpuAvailable()) ? 'webgpu' : 'webgl');
    // Only reachable via an explicit override; the probe above never produces it.
    if (requested === 'none') return createAndLoad('none');
    if (requested === 'webgl') return createAndLoad('webgl');
    try {
        return await createAndLoad('webgpu');
    } catch (err) {
        console.error('[render] WebGPU could not be initialised; falling back to WebGL2.', err);
        return createAndLoad('webgl');
    }
}
