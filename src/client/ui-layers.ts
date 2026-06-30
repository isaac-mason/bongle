// ui-layers, z-index bands for the absolutely-positioned children of a
// room's `viewport`.
//
// Every overlay (the html-trait layer, mobile touch controls, the
// crosshair, the debug panel, a game's screen HUD) is an
// `position:absolute` sibling under `viewport`. Without an explicit
// z-index their paint order falls back to DOM insertion order, fragile,
// and broken outright by the html-trait layer: it assigns its
// world-anchored panels (nameplates, speech bubbles) per-frame
// depth-sorted z-indices up to ~16.7M (see `builtins/html` zIndexRange).
// With no z-index of its own the layer is not a stacking context, so
// those huge values leak into the viewport's context and paint over the
// HUD.
//
// Giving each layer an explicit z-index here fixes both problems at once:
// paint order is declared rather than DOM-order-dependent, and assigning
// the html layer a z-index makes it a stacking context that *contains*
// its internal depth-sorted values, so nameplates sort among themselves
// but never escape above the HUD.
//
// Listed low → high (back → front). Gaps leave room to slot new layers
// in without renumbering.
export const UILayer = {
    /** Html/canvas-trait panels anchored to a 3D node: nameplates, bubbles. */
    worldOverlay: 100,
    /** Aiming reticle / crosshair, above world labels, below the HUD. */
    crosshair: 200,
    /** Screen-space game HUD: health/xp bars, leaderboard, stat panels. */
    hud: 300,
    /** Mobile touch controls (virtual sticks / buttons). */
    touch: 400,
    /** Debug panel / inspector, always on top. */
    debug: 500,
} as const;
