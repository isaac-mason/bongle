// chunk-bounds-visuals.ts, wireframe boxes around every loaded voxel chunk.
//
// debug overlay toggled by the editor's "show chunk boundaries" checkbox.
// rebuilds the segment list only when the chunk set changes (size delta) or
// when the toggle flips on.

import { LineMaterial, LineSegments, LineSegmentsGeometry, type Scene, vec4f } from 'gpucat';

import { CHUNK_SIZE, type Voxels } from '../../core/voxels/voxels';

export type ChunkBoundsVisualsState = {
    lines: LineSegments;
    geometry: LineSegmentsGeometry;
    lastChunkCount: number;
    lastEnabled: boolean;
};

function pushBoxEdges(out: number[], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    // bottom face (y0)
    out.push(x0, y0, z0, x1, y0, z0);
    out.push(x1, y0, z0, x1, y0, z1);
    out.push(x1, y0, z1, x0, y0, z1);
    out.push(x0, y0, z1, x0, y0, z0);
    // top face (y1)
    out.push(x0, y1, z0, x1, y1, z0);
    out.push(x1, y1, z0, x1, y1, z1);
    out.push(x1, y1, z1, x0, y1, z1);
    out.push(x0, y1, z1, x0, y1, z0);
    // verticals
    out.push(x0, y0, z0, x0, y1, z0);
    out.push(x1, y0, z0, x1, y1, z0);
    out.push(x1, y0, z1, x1, y1, z1);
    out.push(x0, y0, z1, x0, y1, z1);
}

function buildPoints(voxels: Voxels): number[] {
    const pts: number[] = [];
    for (const chunk of voxels.chunks.values()) {
        const x0 = chunk.wx;
        const y0 = chunk.wy;
        const z0 = chunk.wz;
        pushBoxEdges(pts, x0, y0, z0, x0 + CHUNK_SIZE, y0 + CHUNK_SIZE, z0 + CHUNK_SIZE);
    }
    return pts;
}

export function init(scene: Scene): ChunkBoundsVisualsState {
    // placeholder geometry: a single degenerate segment outside the world.
    // real points are written by update() the first time the toggle goes on.
    const placeholder = [0, 0, 0, 0, 0, 0];
    const geometry = new LineSegmentsGeometry(placeholder);
    const material = new LineMaterial({
        color: vec4f(1, 0.5, 0.5, 1),
        lineWidth: 3,
    });
    const lines = new LineSegments(geometry, material);
    lines.name = 'editor-chunk-bounds';
    lines.frustumCulled = false;
    lines.visible = false;
    scene.add(lines);

    return { lines, geometry, lastChunkCount: -1, lastEnabled: false };
}

export function update(state: ChunkBoundsVisualsState, voxels: Voxels, enabled: boolean): void {
    state.lines.visible = enabled;
    if (!enabled) {
        state.lastEnabled = false;
        return;
    }

    const count = voxels.chunks.size;
    const turningOn = !state.lastEnabled;
    if (count === state.lastChunkCount && !turningOn) {
        state.lastEnabled = true;
        return;
    }

    if (count === 0) {
        // hide entirely, LineSegmentsGeometry requires ≥1 segment to update.
        state.lines.visible = false;
        state.lastChunkCount = 0;
        state.lastEnabled = true;
        return;
    }

    const pts = buildPoints(voxels);
    state.geometry.update(pts);
    state.lastChunkCount = count;
    state.lastEnabled = true;
}

export function dispose(state: ChunkBoundsVisualsState, scene: Scene): void {
    scene.remove(state.lines);
}
