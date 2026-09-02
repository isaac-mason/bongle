// The `none` render backend: satisfies the `Renderer` contract and draws nothing.
//
// Selected with `?renderer=null`, alongside `webgpu` and `webgl`. The client is
// unchanged — simulation, netcode, scripts, physics and voxel decode all run
// exactly as they do under a drawing backend, because everything the wire
// depends on sits upstream of `updateFrame`/`render` (see engine-client's frame
// loop, which reaches the renderer only after `resolveRoomCamera`).
//
// Why it exists: load generation. A headless bot needs a faithful client on the
// network and no pixels at all, and running a software rasteriser to achieve
// that makes the cost an accident of the GL stack rather than something we
// chose. This makes "no render work" an explicit contract, identical on every
// machine and stable across browser versions.
//
// Not a fallback. `loadRenderBackend` never selects it on its own; only an
// explicit override does, so a real player can never land here and stare at a
// blank canvas.

import type { DeviceLostInfo } from 'gpucat';
import type { RenderDeviceCaps, Renderer } from './backend';
import * as RenderCamera from './camera';
import * as Time from './time';

const kind = 'none' as const;

/** WebGL2's guaranteed floor (2048² texels × 16 B), the same derivation the
 *  WebGL backend uses when it can't read a context. Real numbers matter because
 *  `Performance.detect` builds its arena limits from them; these keep the
 *  resolved tier in the same territory a low-end device would land in, so a bot
 *  streams like a modest real client rather than an outlier. */
const MAX_ARENA_BYTES = 2048 * 2048 * 16;

export function create(): Renderer {
    const camera = RenderCamera.createCamera();
    const time = Time.init();
    // Never mounted, never drawn into. The client mounts `canvas` into its
    // viewport, so it has to be a real element.
    const canvas = document.createElement('canvas');
    let onDeviceLost: ((info: DeviceLostInfo) => void) | null = null;

    return {
        kind,
        camera,
        time,
        canvas,

        get onDeviceLost() {
            return onDeviceLost;
        },
        set onDeviceLost(cb) {
            // Kept so the client's assignment lands somewhere real; nothing here
            // owns a device, so it can never fire.
            onDeviceLost = cb;
        },

        load: async (): Promise<RenderDeviceCaps> => {
            // Say so, loudly and once. A player who ends up here sees a black
            // screen with no other explanation, and this backend is reachable
            // only by explicit request, so it should always be accounted for.
            console.warn('[render] backend=none — simulation runs, nothing is drawn');
            return {
                maxStorageBufferBindingSize: MAX_ARENA_BYTES,
                maxBufferSize: MAX_ARENA_BYTES,
                maxComputeWorkgroupsPerDimension: 0,
                adapterInfo: { vendor: 'bongle', architecture: '', description: 'none backend' },
            };
        },

        dispose: () => {},
        resize: () => {},
        setInspectorVisible: () => {},

        initResources: () => {},
        loadResources: async () => {},
        disposeResources: () => {},

        // The two that would do the work. `updateFrame` is where meshing, model
        // and sprite visuals live, so skipping it is the entire saving.
        updateFrame: () => {},
        render: () => {},

        // Nothing was built, so nothing can have changed.
        refreshBlockResources: async () => false,
        refreshSpriteResources: async () => false,
    };
}
