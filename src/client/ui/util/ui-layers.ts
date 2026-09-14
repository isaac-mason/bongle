// z-index bands for a room viewport's overlay children, back to front; gaps leave room for new layers
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
