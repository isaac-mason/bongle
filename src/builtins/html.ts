import { trait } from '../core/registry';
import type { TraitType } from '../core/scene/traits';
import { env } from '../env';

export type HtmlMode = 'screen' | 'world' | 'billboard' | 'y-billboard';

export const HtmlTrait = trait(
    'html',
    {
        /**
         * Layout mode:
         * - `screen`, project node world position to screen-space; div sits at its natural CSS size, optionally scaled by `distanceFactor`.
         * - `world`, full 3D `matrix3d`, follows node rotation and perspective-foreshortens.
         * - `billboard`, 3D `matrix3d` with rotation cancelled, always faces the camera.
         * - `y-billboard`, yaws around world-Y to face the camera, pitch level.
         */
        mode: 'screen' as HtmlMode,

        /** anchor at the panel center vs its top-left. */
        center: true,

        /** `screen`-mode only. `null` = constant CSS-pixel size; otherwise scaled by `distanceFactor / cameraDistance`. */
        distanceFactor: null as number | null,

        /** 3D-mode only. World units per CSS pixel. */
        worldScale: 1 / 256,

        /** toggle CSS `pointer-events` on the panel root. */
        pointerEvents: true,

        /** projected-depth to z-index mapping so overlapping panels sort correctly without DOM reordering. */
        zIndexRange: () => [16777271, 0] as [number, number],

        /** bumped by user code after changing static config so the visuals layer can re-apply on the next frame. */
        _version: 0,

        /** the panel's `<div>`. Created up-front per instance on the client, `null` on the server. */
        element: (() => (env.client ? document.createElement('div') : null)) as () => HTMLDivElement | null,
    },
    { icon: 'kit:icon:canvas' },
);

export type HtmlTrait = TraitType<typeof HtmlTrait>;
