// pivot-point.ts — small sphere rendered at the transform tool gizmo pivot point.
//
// always rendered on top (depthTest:false) so it's visible through geometry.
// shown whenever the transform tool is active and a selection exists.
// hidden when no selection / not in transform mode.

import { createSphereGeometry, Material, Mesh, positionClip, type Scene, vec4f } from 'gpucat';
import type { Vec3 } from 'mathcat';
import { PIVOT_DOT } from './editor-colors';

// ── material (shared, created once) ─────────────────────────────────

let _material: Material | null = null;

function getMaterial(): Material {
    if (!_material) {
        _material = new Material({
            name: 'editor-pivot-point',
            vertex: positionClip,
            fragment: vec4f(...PIVOT_DOT),
            depthTest: false,
            depthWrite: false,
        });
    }
    return _material;
}

// ── state ─────────────────────────────────────────────────────────────

export type State = {
    scene: Scene;
    mesh: Mesh;
    visible: boolean;
};

const RADIUS = 0.08;

export function create(scene: Scene): State {
    const geo = createSphereGeometry(RADIUS, 8, 6);
    const mesh = new Mesh(geo, getMaterial());
    mesh.name = 'editor-pivot-point';
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
    return { scene, mesh, visible: false };
}

export function dispose(state: State): void {
    state.scene.remove(state.mesh);
}

/**
 * update the pivot point position and visibility each frame.
 *
 * @param state    pivot point state
 * @param position world-space position to show the point (the gizmo pivot)
 * @param show     whether to show the point at all
 */
export function update(state: State, position: Vec3, show: boolean): void {
    if (show !== state.visible) {
        state.mesh.visible = show;
        state.visible = show;
    }
    if (show) {
        state.mesh.position[0] = position[0];
        state.mesh.position[1] = position[1];
        state.mesh.position[2] = position[2];
    }
}
