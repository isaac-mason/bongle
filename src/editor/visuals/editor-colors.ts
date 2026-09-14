// all colors are [r, g, b, a] tuples ready for vec4f().

/** fill color for the committed voxel selection mesh */
export const SELECTION_FILL: [number, number, number, number] = [0.2, 0.5, 1.0, 0.05];
/** thick outline color for the committed voxel selection aabb */
export const SELECTION_OUTLINE: [number, number, number, number] = [0.3, 0.6, 1.0, 1.0];
/** thin inner-edge color for the committed voxel selection mesh */
export const SELECTION_EDGES: [number, number, number, number] = [0.5, 0.75, 1.0, 1.0];

// brush fill/edge colors are driven by two vec4f uniforms; tools push a
// stable preset reference (static) or a fresh tuple per frame (animated),
// and selection-mesh dirty-checks by reference either way.

export type Rgba = [number, number, number, number];

/** named presets, stable references for static tool intents. */
export const BRUSH_TINTS = {
    // hover preview, idle disc, additive selections.
    cyan: { fill: [0.2, 0.9, 1.0, 0.1] as Rgba, edges: [0.4, 1.0, 1.0, 1.0] as Rgba },
    // elevation "lower" and similar removal previews.
    red: { fill: [1.0, 0.3, 0.3, 0.12] as Rgba, edges: [1.0, 0.55, 0.55, 1.0] as Rgba },
    // elevation "flatten" and similar mixed-effect previews.
    amber: { fill: [1.0, 0.8, 0.25, 0.12] as Rgba, edges: [1.0, 0.9, 0.4, 1.0] as Rgba },
    // reserved for future additive intents.
    green: { fill: [0.4, 1.0, 0.45, 0.1] as Rgba, edges: [0.55, 1.0, 0.6, 1.0] as Rgba },
} as const;

/** defaults used when `EditRoomState.brushFill` / `brushEdges` are null. */
export const BRUSH_FILL_DEFAULT: Rgba = BRUSH_TINTS.cyan.fill;
export const BRUSH_EDGES_DEFAULT: Rgba = BRUSH_TINTS.cyan.edges;

/** single-block hover outline (white aabb around the hovered voxel). */
export const HOVER_OUTLINE: Rgba = [1.0, 1.0, 1.0, 0.9];

/** outline color for the inspect-tool node bounding box */
export const INSPECT_OUTLINE: [number, number, number, number] = [0.3, 0.6, 1.0, 1.0];

/** shape-field outlines: every selected node, the active one, and the hovered one as a preview. */
export const SHAPE_OUTLINE_SELECTED: Rgba = [0.3, 0.6, 1.0, 0.7];
export const SHAPE_OUTLINE_ACTIVE: Rgba = [1.0, 0.85, 0.1, 1.0];
export const SHAPE_OUTLINE_HOVER: Rgba = [1.0, 1.0, 1.0, 0.35];

/** color of the pivot point sphere shown when the transform tool is active */
export const PIVOT_DOT: [number, number, number, number] = [1.0, 0.85, 0.1, 1.0];
