import { type TraitType } from '../core/scene/traits';
import { trait } from '../core/registry';
import { env } from '../env';

export type CanvasMode = 'world' | 'billboard' | 'y-billboard';

export const CanvasTrait = trait('canvas', {
    width: 256,
    height: 128,

    /** world units per canvas pixel. */
    worldScale: 1 / 256,

    mode: 'billboard' as CanvasMode,

    center: true,

    /** user flips to `true` after painting; the engine consumes the flag and re-uploads the texture on next render. */
    needsUpdate: true,

    /** bumped by user code after changing static config so the visuals layer can re-apply or recreate as needed. */
    _version: 0,

    /** offscreen canvas user scripts paint into; created up-front per instance on the client, `null` on the server. */
    canvas: (() => (env.client ? new OffscreenCanvas(256, 128) : null)) as () => OffscreenCanvas | null,
});

export type CanvasTrait = TraitType<typeof CanvasTrait>;
