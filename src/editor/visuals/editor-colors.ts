// editor-colors.ts, shared color constants for editor overlay materials.
//
// all colors are [r, g, b, a] tuples ready for vec4f().

// ── selection (blue) ─────────────────────────────────────────────────

/** fill color for the committed voxel selection mesh */
export const SELECTION_FILL: [number, number, number, number] = [0.2, 0.5, 1.0, 0.05];
/** thick outline color for the committed voxel selection aabb */
export const SELECTION_OUTLINE: [number, number, number, number] = [0.3, 0.6, 1.0, 1.0];
/** thin inner-edge color for the committed voxel selection mesh */
export const SELECTION_EDGES: [number, number, number, number] = [0.5, 0.75, 1.0, 1.0];

// ── brush / hover ────────────────────────────────────────────────────
//
// the brush mesh fill + edge colors are driven by two vec4f uniforms.
// tools push colors into the edit-room store as plain rgba tuples, static
// tools point at a stable preset (`BRUSH_TINTS.red.fill`), animated tools
// allocate a fresh tuple each frame (e.g. for pulse). selection-mesh
// dirty-checks by reference: a stable preset writes the uniform once, a
// per-frame allocation writes it each frame. either pattern just works.

export type Rgba = [number, number, number, number];

/** named presets, convenient stable references for static tool intents.
 *  tools wanting custom or animated colors can synthesise rgba tuples
 *  directly and skip the palette. */
export const BRUSH_TINTS = {
    // default, used by hover preview, idle disc, additive selections.
    cyan: { fill: [0.2, 0.9, 1.0, 0.1] as Rgba, edges: [0.4, 1.0, 1.0, 1.0] as Rgba },
    // destructive, used by elevation "lower" and similar removal previews.
    red: { fill: [1.0, 0.3, 0.3, 0.12] as Rgba, edges: [1.0, 0.55, 0.55, 1.0] as Rgba },
    // neutral, used by elevation "flatten" and similar mixed-effect previews.
    amber: { fill: [1.0, 0.8, 0.25, 0.12] as Rgba, edges: [1.0, 0.9, 0.4, 1.0] as Rgba },
    // constructive (non-default), reserved for future additive intents.
    green: { fill: [0.4, 1.0, 0.45, 0.1] as Rgba, edges: [0.55, 1.0, 0.6, 1.0] as Rgba },
} as const;

/** defaults used when `EditRoomState.brushFill` / `brushEdges` are null,
 *  exported so selection-mesh and consumers share the same baseline. */
export const BRUSH_FILL_DEFAULT: Rgba = BRUSH_TINTS.cyan.fill;
export const BRUSH_EDGES_DEFAULT: Rgba = BRUSH_TINTS.cyan.edges;

/** single-block hover outline (white aabb around the hovered voxel, tint-independent). */
export const HOVER_OUTLINE: Rgba = [1.0, 1.0, 1.0, 0.9];

// ── inspect (also selection blue, matches voxel selection) ───────────

/** outline color for the inspect-tool node bounding box */
export const INSPECT_OUTLINE: [number, number, number, number] = [0.3, 0.6, 1.0, 1.0];

// ── transform pivot ──────────────────────────────────────────────────

/** color of the pivot point sphere shown when the transform tool is active */
export const PIVOT_DOT: [number, number, number, number] = [1.0, 0.85, 0.1, 1.0];
