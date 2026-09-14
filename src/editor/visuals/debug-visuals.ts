import { debug, rigidBody, type World } from 'crashcat';
import { LineMaterial, LineSegmentsGeometry, Mesh, type Scene, vec4f } from 'gpucat';
import { OBJECT_LAYER_EDITOR_NODES } from '../../core/physics/physics';

const MAX_POINTS = 200_000; // 2 points per segment
const LINE_WIDTH_PX = 5;
const LINE_COLOR: [number, number, number, number] = [1.0, 0.0, 1.0, 1.0]; // magenta

export type DebugVisualsState = {
    mesh: Mesh;
    geometry: LineSegmentsGeometry;
    bodyOpts: debug.BodyOptions;
    /** scratch buffer reused each frame to concatenate per-body line segments. */
    scratch: Float32Array;
};

export function init(scene: Scene): DebugVisualsState {
    // dummy segment; MAX_POINTS pre-allocates the buffer
    const geometry = new LineSegmentsGeometry([0, 0, 0, 0, 0, 0], MAX_POINTS);
    geometry.drawRange.count = 0;

    const material = new LineMaterial({
        color: vec4f(...LINE_COLOR),
        lineWidth: LINE_WIDTH_PX,
    });

    const mesh = new Mesh(geometry, material);
    mesh.name = 'editor-debug-visuals';
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);

    return {
        mesh,
        geometry,
        bodyOpts: debug.createBodyOptions(),
        scratch: new Float32Array(MAX_POINTS * 3),
    };
}

export function update(state: DebugVisualsState, world: World, enabled: boolean): void {
    if (!enabled) {
        if (state.mesh.visible) {
            state.geometry.drawRange.count = 0;
            state.mesh.visible = false;
        }
        return;
    }

    let offset = 0;
    const cap = state.scratch.length;

    for (const b of rigidBody.iterate(world)) {
        if (b.objectLayer === OBJECT_LAYER_EDITOR_NODES) continue;
        const result = debug.body(b, state.bodyOpts);
        const v = result.vertices;
        if (offset + v.length > cap) break;
        state.scratch.set(v, offset);
        offset += v.length;
    }

    if (offset > 0) {
        state.geometry.update(state.scratch.subarray(0, offset));
        state.mesh.visible = true;
    } else {
        state.geometry.drawRange.count = 0;
        state.mesh.visible = false;
    }
}

export function dispose(state: DebugVisualsState, scene: Scene): void {
    scene.remove(state.mesh);
    state.geometry.dispose();
}
