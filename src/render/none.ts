import type { DeviceLostInfo } from 'gpucat';
import type { RenderDeviceCaps, Renderer } from './backend';
import * as RenderCamera from './camera';
import * as Time from './time';

const kind = 'none' as const;

/** WebGL2's guaranteed floor (2048^2 texels x 16 B); keeps a bot's resolved performance tier in the same territory as a modest real client. */
const MAX_ARENA_BYTES = 2048 * 2048 * 16;

export function create(): Renderer {
    const camera = RenderCamera.createCamera();
    const time = Time.init();
    // Never mounted or drawn into, but the client mounts `canvas` into its viewport regardless.
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
            // Nothing here owns a device, so this can never fire.
            onDeviceLost = cb;
        },

        load: async (): Promise<RenderDeviceCaps> => {
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
        atlases: () => ({ voxel: null, sprite: null }),

        updateFrame: () => {},
        render: () => {},
        voxelWorldDrawable: () => true,

        refreshBlockResources: async () => false,
        refreshSpriteResources: async () => false,
    };
}
