import { LineMaterial, LineSegments, LineSegmentsGeometry, Object3D, vec4f } from 'gpucat';

/** always drawn on top: depth testing is off and renderOrder pushes it after the world's normal
 *  pass, so it reads as a screen overlay rather than a 3D object the world can occlude. The stroke
 *  is reconstructed out at a fixed reach distance (see lasso-select.ts's lassoStrokeToWorldPoints)
 *  and routinely ends up past nearer geometry, so unlike selection-mesh.ts's outlines it has no
 *  "behind the wall" state worth distinguishing. */
export type LassoVisualsState = {
    /** this module's own group; the caller parents it and never touches what's inside. */
    root: Object3D;
    geometry: LineSegmentsGeometry | null;
    stroke: LineSegments | null;
};

const LASSO_COLOR = vec4f(0.38, 0.65, 0.98, 1) as any;
// screen-space pixels, not world units: the stroke can reach out to `lassoOptions.maxDistance`
// (hundreds of units), where any reasonable world-space width would be sub-pixel and invisible.
const LASSO_WIDTH = 3;

export function init(parent: Object3D): LassoVisualsState {
    const root = new Object3D();
    root.name = 'editor-lasso';
    parent.add(root);
    return { root, geometry: null, stroke: null };
}

function segmentsFromStroke(points: ReadonlyArray<readonly [number, number, number]>): number[] {
    const pts: number[] = new Array((points.length - 1) * 6);
    let i = 0;
    for (let p = 0; p < points.length - 1; p++) {
        const [ax, ay, az] = points[p]!;
        const [bx, by, bz] = points[p + 1]!;
        pts[i++] = ax;
        pts[i++] = ay;
        pts[i++] = az;
        pts[i++] = bx;
        pts[i++] = by;
        pts[i++] = bz;
    }
    return pts;
}

/** removes the stroke mesh (a null/short `points`) or rebuilds its geometry from the current stroke. */
export function update(state: LassoVisualsState, points: ReadonlyArray<readonly [number, number, number]> | null): void {
    if (!points || points.length < 2) {
        if (state.stroke) {
            state.stroke.removeFromParent();
            state.geometry!.dispose();
            state.stroke = null;
            state.geometry = null;
        }
        return;
    }

    const geometry = new LineSegmentsGeometry(segmentsFromStroke(points));
    if (state.stroke && state.geometry) {
        state.geometry.dispose();
        state.geometry = geometry;
        state.stroke.geometry = geometry;
    } else {
        const material = new LineMaterial({ color: LASSO_COLOR, lineWidth: LASSO_WIDTH });
        material.depthTest = false;
        material.depthWrite = false;
        const stroke = new LineSegments(geometry, material);
        stroke.name = 'editor-lasso-stroke';
        stroke.frustumCulled = false;
        stroke.renderOrder = Infinity;
        state.root.add(stroke);
        state.geometry = geometry;
        state.stroke = stroke;
    }
}

export function dispose(state: LassoVisualsState): void {
    state.root.removeFromParent();
    state.geometry?.dispose();
}
