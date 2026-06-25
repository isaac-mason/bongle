// grid-visuals.ts — simple ground-plane grid using line segments.
//
// draws a fixed grid on the Y=0 plane with minor (1-unit) and major (10-unit)
// lines, plus colored axis lines (red=X, blue=Z).

import { LineMaterial, LineSegments, LineSegmentsGeometry, type Scene, vec4f } from 'gpucat';

// ── state ──────────────────────────────────────────────────────────

export type GridVisualsState = {
    minorLines: LineSegments;
    majorLines: LineSegments;
    xAxisLines: LineSegments;
    zAxisLines: LineSegments;
};

// ── helpers ────────────────────────────────────────────────────────

function buildGridPoints(halfSize: number, spacing: number, skip?: number): number[] {
    const points: number[] = [];
    for (let i = -halfSize; i <= halfSize; i += spacing) {
        // skip lines that belong to a coarser grid (or axis)
        if (skip !== undefined && i % skip === 0) continue;

        // line along X (constant Z = i)
        points.push(-halfSize, 0, i, halfSize, 0, i);
        // line along Z (constant X = i)
        points.push(i, 0, -halfSize, i, 0, halfSize);
    }
    return points;
}

// ── init ───────────────────────────────────────────────────────────

export function init(scene: Scene): GridVisualsState {
    const halfSize = 500;
    const minorHalfSize = 50; // minor lines only near origin

    // minor grid: every 1 unit, skip multiples of 10
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
    scene.add(minorLines);

    // major grid: every 10 units, skip axis (0)
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
    scene.add(majorLines);

    // axis lines: x=red, z=blue
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
    scene.add(xAxisLines);

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
    scene.add(zAxisLines);

    return { minorLines, majorLines, xAxisLines, zAxisLines };
}

// ── update ─────────────────────────────────────────────────────────

export function update(state: GridVisualsState, enabled: boolean): void {
    state.minorLines.visible = enabled;
    state.majorLines.visible = enabled;
    state.xAxisLines.visible = enabled;
    state.zAxisLines.visible = enabled;
}

// ── dispose ────────────────────────────────────────────────────────

export function dispose(state: GridVisualsState, scene: Scene): void {
    scene.remove(state.minorLines);
    scene.remove(state.majorLines);
    scene.remove(state.xAxisLines);
    scene.remove(state.zAxisLines);
}
