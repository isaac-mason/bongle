import { type d, LineMaterial, LineSegmentsGeometry, Mesh, type Scene, type Node as ShaderNode } from 'gpucat';
import { type Box3, box3 } from 'math/shapes';
import { getVisualWorldPosition } from '../../api/transforms';
import { TransformTrait } from '../../builtins/transform';
import type { Resources } from '../../core/resources';
import type { Node } from '../../core/scene/scene-tree';
import { getTrait } from '../../core/scene/scene-tree';
import type { TimeResources } from '../../render/time';
import { unionSubtreeWorldAabb } from '../node-aabb';
import { INSPECT_OUTLINE } from './editor-colors';
import { rainbowLineColor } from './rainbow';

let _material: LineMaterial | null = null;

function getMaterial(elapsedTime: ShaderNode<d.f32>): LineMaterial {
    if (!_material) {
        _material = new LineMaterial({
            color: rainbowLineColor(elapsedTime, INSPECT_OUTLINE[3]),
            lineWidth: 3,
            transparent: false,
        });
        _material.depthTest = false;
        _material.depthWrite = false;
    }
    return _material;
}

export type InspectMeshState = {
    scene: Scene;
    mesh: Mesh | null;
};

export function init(scene: Scene): InspectMeshState {
    return { scene, mesh: null };
}

export function dispose(state: InspectMeshState): void {
    if (state.mesh) {
        state.scene.remove(state.mesh);
        (state.mesh.geometry as LineSegmentsGeometry).dispose();
        state.mesh = null;
    }
}

const _SPHERE_RADIUS = 0.5;

const _scratchSphere: Box3 = box3.create();

function getNodeAABB(node: Node, resources: Resources, out: Box3): boolean {
    if (unionSubtreeWorldAabb(node, resources, out)) return true;

    // no mesh/voxel geometry anywhere in the subtree, fall back to a sphere at the node's position
    const transform = getTrait(node, TransformTrait);
    if (transform) {
        const p = getVisualWorldPosition(transform);
        const r = _SPHERE_RADIUS;
        box3.set(_scratchSphere, p[0] - r, p[1] - r, p[2] - r, p[0] + r, p[1] + r, p[2] + r);
        box3.union(out, out, _scratchSphere);
        return true;
    }
    return false;
}

// 12 edges of the aabb as flat [x,y,z, x,y,z, ...] for LineSegmentsGeometry.
function appendBoxSegments(b: Box3, out: number[]): void {
    const x0 = b[0],
        y0 = b[1],
        z0 = b[2],
        x1 = b[3],
        y1 = b[4],
        z1 = b[5];
    out.push(
        // bottom face
        x0,
        y0,
        z0,
        x1,
        y0,
        z0,
        x1,
        y0,
        z0,
        x1,
        y0,
        z1,
        x1,
        y0,
        z1,
        x0,
        y0,
        z1,
        x0,
        y0,
        z1,
        x0,
        y0,
        z0,
        // top face
        x0,
        y1,
        z0,
        x1,
        y1,
        z0,
        x1,
        y1,
        z0,
        x1,
        y1,
        z1,
        x1,
        y1,
        z1,
        x0,
        y1,
        z1,
        x0,
        y1,
        z1,
        x0,
        y1,
        z0,
        // verticals
        x0,
        y0,
        z0,
        x0,
        y1,
        z0,
        x1,
        y0,
        z0,
        x1,
        y1,
        z0,
        x1,
        y0,
        z1,
        x1,
        y1,
        z1,
        x0,
        y0,
        z1,
        x0,
        y1,
        z1,
    );
}

const _aabb: Box3 = box3.create();

/** call each frame to keep the inspect outline in sync with the selected node(s); pass an empty array to clear. */
export function update(state: InspectMeshState, nodes: Node[], resources: Resources, time: TimeResources): void {
    if (nodes.length === 0) {
        if (state.mesh) {
            state.scene.remove(state.mesh);
            (state.mesh.geometry as LineSegmentsGeometry).dispose();
            state.mesh = null;
        }
        return;
    }

    // one box per selected node; skip the scene root since its box would enclose everything else in the scene.
    const pts: number[] = [];
    for (const node of nodes) {
        if (node === node.scene?.root) continue;
        box3.set(_aabb, Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
        if (getNodeAABB(node, resources, _aabb)) appendBoxSegments(_aabb, pts);
    }

    if (pts.length === 0) {
        if (state.mesh) state.mesh.visible = false;
        return;
    }

    const geo = new LineSegmentsGeometry(pts);

    if (state.mesh) {
        (state.mesh.geometry as LineSegmentsGeometry).dispose();
        state.mesh.geometry = geo;
        state.mesh.visible = true;
    } else {
        const mesh = new Mesh(geo, getMaterial(time.elapsedTime));
        mesh.name = 'editor-inspect-mesh';
        mesh.frustumCulled = false;
        state.scene.add(mesh);
        state.mesh = mesh;
    }
}
