// CanvasTrait — bring-your-own-pixels: an OffscreenCanvas painted into a
// textured 3D quad. No DOM, no `drawElement`. User scripts grab a 2D
// context off `trait.canvas` and paint whatever they want.
//
// Persist-only — no replication. Client-only `canvas`. Picking is a
// userland concern (raycast the quad, translate hit to UV).
//
// No `control()` — code-only trait.
//
// See `client/dom-ui.ts` for the visuals layer.

import { env } from '../api/env';
import { type TraitType, trait } from '../core/scene/traits';

export type CanvasMode = 'world' | 'billboard' | 'y-billboard';

export const CanvasTrait = trait('canvas', {
    width: 256,
    height: 128,

    /** world units per canvas pixel. */
    worldScale: 1 / 256,

    mode: 'billboard' as CanvasMode,

    center: true,

    /**
     * User flips to `true` after painting. Engine consumes the flag and
     * re-uploads the texture on next render. Defaults `true` so the first
     * frame always uploads.
     */
    needsUpdate: true,

    /**
     * Bumped by user code after changing static config (size, mode) so
     * the visuals layer can re-apply / recreate as needed.
     */
    _version: 0,

    /**
     * The offscreen canvas user scripts paint into. Created up-front per
     * instance on the client at the default size; `null` on the server.
     * Resized in place when the trait's `width`/`height` change (`_version`
     * bump). User scripts get a 2D context off this and call
     * `trait.needsUpdate = true` to flag a re-upload.
     */
    canvas: (() => (env.client ? new OffscreenCanvas(256, 128) : null)) as () => OffscreenCanvas | null,
});

export type CanvasTrait = TraitType<typeof CanvasTrait>;
