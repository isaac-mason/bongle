import { createSphereGeometry, Material, Mesh, positionClip, type Scene, vec4f } from 'gpucat';
import type { Vec3 } from 'math';
import { PIVOT_DOT } from './editor-colors';

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

/** show / hide the point, for callers that gate the whole editor view. */
export function setVisible(state: State, visible: boolean): void {
    if (visible === state.visible) return;
    state.mesh.visible = visible;
    state.visible = visible;
}

/** update the pivot point position and visibility each frame. */
export function update(state: State, position: Vec3, show: boolean): void {
    setVisible(state, show);
    if (show) {
        state.mesh.position[0] = position[0];
        state.mesh.position[1] = position[1];
        state.mesh.position[2] = position[2];
    }
}
