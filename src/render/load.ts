// Render backend loader.
//
// The client calls `loadRenderBackend()` and programs against the returned
// `Renderer` handle — it never names the concrete `render/webgpu` / `render/webgl`
// modules or the selection logic. The dynamic `import()` is the code-split point:
// only the chosen backend is fetched/parsed for a session.
//
// Selection is mostly not decided here. The host that embeds this client probes the
// device and hands the answer down; see `loadRenderBackend` below for the full
// precedence and for why the fallback is loud rather than fatal.

import { type RenderDeviceCaps, type Renderer, type RendererBackendKind, readRendererOverride, webgpuAvailable } from './backend';

/** create + run the device handshake for one backend. */
async function createAndLoad(kind: RendererBackendKind): Promise<{ renderer: Renderer; caps: RenderDeviceCaps }> {
    const mod =
        kind === 'none'
            ? await import('./none')
            : kind === 'webgl'
              ? await import('./webgl')
              : await import('./webgpu');
    const renderer = mod.create();
    const caps = await renderer.load();
    return { renderer, caps };
}

/**
 * Select + dynamically import the render backend, mint its `Renderer` handle, and
 * run the device handshake — returning a renderer that's ready to use plus the
 * adapter caps the client's tier detect needs.
 *
 * The backend normally comes from the host: it probes the device once (by actually
 * rendering on it) and stamps the answer in as `?renderer=`, so every realm it
 * spawns — this client, the editor's windows, the icon-bake worker — agrees. Only a
 * realm with no host to tell it (the node bake, a client booted straight off disk,
 * tests) falls through to `webgpuAvailable`, a bare adapter check that is a much
 * weaker signal and is why the host does the real work.
 *
 * WebGPU that can't be stood up always steps down to WebGL2 rather than throwing,
 * whether it was chosen here or handed in. A player is never better off with a dead
 * canvas than a working WebGL2 one, and the loud `console.error` plus the demotion
 * the client reports back to the host (`ClientDriver.graphics`) is what makes the
 * fallback visible — to whoever forced the backend, and to the host, which starts
 * on WebGL2 next time instead of rediscovering this every load.
 */
export async function loadRenderBackend(): Promise<{ renderer: Renderer; caps: RenderDeviceCaps }> {
    const requested = readRendererOverride() ?? ((await webgpuAvailable()) ? 'webgpu' : 'webgl');
    // Only ever reached via an explicit override — the probe above can't produce
    // it — so a real player never lands on a backend that draws nothing.
    if (requested === 'none') return createAndLoad('none');
    if (requested === 'webgl') return createAndLoad('webgl');
    try {
        return await createAndLoad('webgpu');
    } catch (err) {
        console.error('[render] WebGPU could not be initialised; falling back to WebGL2.', err);
        return createAndLoad('webgl');
    }
}
