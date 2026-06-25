// HtmlTrait — DOM overlay anchored to a 3D node.
//
// The engine creates one <div> per trait instance and positions it each
// frame from the node's world transform. User scripts mutate `element`
// imperatively (innerHTML, appendChild, listeners). Persist-only — no
// replication. Server-side `element` stays null; user scripts must gate
// on `ctx.env.client`.
//
// No `control()` — code-only trait, no editor inspector surface. Set
// fields directly from scripts and bump `_version` if the visuals layer
// needs to re-apply config.
//
// See `client/dom-ui.ts` for the visuals layer.

import { env } from '../api/env';
import { type TraitType, trait } from '../core/scene/traits';

export type HtmlMode = 'screen' | 'world' | 'billboard' | 'y-billboard';

export const HtmlTrait = trait('html', {
    /**
     * Layout mode.
     * - `screen`   — project node world position to screen-space; div sits
     *                at its natural CSS size, optionally scaled by
     *                `distanceFactor`. No 3D rotation, no perspective.
     * - `world`    — full 3D `matrix3d`. Follows node rotation and
     *                perspective-foreshortens.
     * - `billboard` — 3D `matrix3d` with rotation cancelled; always faces
     *                the camera.
     * - `y-billboard` — yaws around world-Y to face the camera; pitch level.
     */
    mode: 'screen' as HtmlMode,

    /** anchor at the panel center vs its top-left. */
    center: true,

    /**
     * `screen`-mode only. `null` = constant CSS-pixel size; otherwise the
     * panel is scaled by `distanceFactor / cameraDistance`. Drei's default.
     */
    distanceFactor: null as number | null,

    /** 3D-mode only. world units per CSS pixel. */
    worldScale: 1 / 256,

    /** Toggle CSS `pointer-events` on the panel root. */
    pointerEvents: true,

    /**
     * Drei-style projected-depth → z-index mapping. Overlapping panels
     * sort correctly without DOM reordering.
     */
    zIndexRange: () => [16777271, 0] as [number, number],

    /**
     * Bumped by user code after changing static config (size, mode, etc)
     * so the visuals layer can re-apply on the next frame.
     */
    _version: 0,

    /**
     * The panel's `<div>`. Created up-front per instance on the client,
     * `null` on the server. User scripts mutate this freely (innerHTML,
     * appendChild, listeners). The visuals layer mounts it under the
     * room's overlay container on first sight.
     */
    element: (() => (env.client ? document.createElement('div') : null)) as () => HTMLDivElement | null,
});

export type HtmlTrait = TraitType<typeof HtmlTrait>;
