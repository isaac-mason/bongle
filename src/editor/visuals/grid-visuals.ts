import { LineMaterial, LineSegments, LineSegmentsGeometry, Object3D, vec4f } from 'gpucat';

export type GridVisualsState = {
    /** this module's own group; the caller parents it and never touches what's inside. */
    root: Object3D;
    minorLines: LineSegments;
    majorLines: LineSegments;
    xAxisLines: LineSegments;
    zAxisLines: LineSegments;
};

function buildGridPoints(halfSize: number, spacing: number, skip?: number): number[] {
    const points: number[] = [];
    for (let i = -halfSize; i <= halfSize; i += spacing) {
        // skip lines belonging to a coarser grid (or the axis)
        if (skip !== undefined && i % skip === 0) continue;
        points.push(-halfSize, 0, i, halfSize, 0, i);
        points.push(i, 0, -halfSize, i, 0, halfSize);
    }
    return points;
}

export function init(parent: Object3D): GridVisualsState {
    const root = new Object3D();
    root.name = 'editor-grid';
    parent.add(root);

    const halfSize = 500;
    const minorHalfSize = 50; // minor lines only near origin

    const minorPts = buildGridPoints(minorHalfSize, 1, 10);
    const minorGeo = new LineSegmentsGeometry(minorPts);
    const minorMat = new LineMaterial({
        color: vec4f(0.3, 0.3, 0.3, 1) as any,
        lineWidth: 0.02,
        worldUnits: true,
    });
    const minorLines = new LineSegments(minorGeo, minorMat);
    minorLines.name = 'editor-grid-minor';
    minorLines.frustumCulled = false;
    minorLines.visible = false;
    root.add(minorLines);

    const majorPts: number[] = [];
    for (let i = -halfSize; i <= halfSize; i += 10) {
        if (i === 0) continue; // axis drawn separately
        majorPts.push(-halfSize, 0, i, halfSize, 0, i);
        majorPts.push(i, 0, -halfSize, i, 0, halfSize);
    }
    const majorGeo = new LineSegmentsGeometry(majorPts);
    const majorMat = new LineMaterial({
        color: vec4f(0.45, 0.45, 0.45, 1) as any,
        lineWidth: 0.03,
        worldUnits: true,
    });
    const majorLines = new LineSegments(majorGeo, majorMat);
    majorLines.name = 'editor-grid-major';
    majorLines.frustumCulled = false;
    majorLines.visible = false;
    root.add(majorLines);

    const xAxisGeo = new LineSegmentsGeometry([-halfSize, 0, 0, halfSize, 0, 0]);
    const xAxisMat = new LineMaterial({
        color: vec4f(0.8, 0.2, 0.2, 1) as any,
        lineWidth: 0.05,
        worldUnits: true,
    });
    const xAxisLines = new LineSegments(xAxisGeo, xAxisMat);
    xAxisLines.name = 'editor-grid-axis-x';
    xAxisLines.frustumCulled = false;
    xAxisLines.visible = false;
    root.add(xAxisLines);

    const zAxisGeo = new LineSegmentsGeometry([0, 0, -halfSize, 0, 0, halfSize]);
    const zAxisMat = new LineMaterial({
        color: vec4f(0.2, 0.2, 0.8, 1) as any,
        lineWidth: 0.05,
        worldUnits: true,
    });
    const zAxisLines = new LineSegments(zAxisGeo, zAxisMat);
    zAxisLines.name = 'editor-grid-axis-z';
    zAxisLines.frustumCulled = false;
    zAxisLines.visible = false;
    root.add(zAxisLines);

    return { root, minorLines, majorLines, xAxisLines, zAxisLines };
}

export function update(state: GridVisualsState, enabled: boolean): void {
    state.minorLines.visible = enabled;
    state.majorLines.visible = enabled;
    state.xAxisLines.visible = enabled;
    state.zAxisLines.visible = enabled;
}

export function dispose(state: GridVisualsState): void {
    state.root.removeFromParent();
}
