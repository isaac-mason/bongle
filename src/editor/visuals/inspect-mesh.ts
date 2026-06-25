// inspect-mesh.ts — bounding box outline for the selected node.
//
// computes the world-space AABB by walking the selected node's subtree
// directly (via unionSubtreeWorldAabb). falls back to a sphere around
// the transform position if the subtree contains no mesh geometry.

import { LineMaterial, LineSegmentsGeometry, Mesh, type Scene, vec4f } from 'gpucat';
import { type Box3, box3 } from 'mathcat';
import type { Node } from '../../core/scene/nodes';
import { getTrait } from '../../core/scene/nodes';
import { TransformTrait } from '../../builtins/transform';
import { getVisualWorldPosition } from '../../api/transforms';
import type { Resources } from '../../core/resources';
import { unionSubtreeWorldAabb } from '../node-aabb';
import { INSPECT_OUTLINE } from './editor-colors';

// ── material (shared, created once) ─────────────────────────────────

let _material: LineMaterial | null = null;

function getMaterial(): LineMaterial {
    if (!_material) {
        _material = new LineMaterial({
            color: vec4f(...INSPECT_OUTLINE),
            lineWidth: 3,
            transparent: false,
        });
        _material.depthTest = false;
        _material.depthWrite = false;
    }
    return _material;
}

// ── state ────────────────────────────────────────────────────────────

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

// ── aabb from node subtree ──────────────────────────────────────────

const _SPHERE_RADIUS = 0.5;

const _scratchSphere: Box3 = box3.create();

function getNodeAABB(node: Node, resources: Resources, out: Box3): boolean {
    if (unionSubtreeWorldAabb(node, resources, out)) return true;

    // fallback: no mesh/voxel geometry anywhere in the subtree — sphere at this node's position
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

// ── box edge segments ────────────────────────────────────────────────
//
// 12 edges of the aabb as flat [x,y,z, x,y,z, ...] for LineSegmentsGeometry.

function appendBoxSegments(b: Box3, out: number[]): void {
    const x0 = b[0],
        y0 = b[1],
        z0 = b[2],
        x1 = b[3],
        y1 = b[4],
        z1 = b[5];
    // 4 bottom, 4 top, 4 vertical edges
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

// scratch aabb
const _aabb: Box3 = box3.create();

// ── update ───────────────────────────────────────────────────────────

/**
 * call each frame to keep the inspect outline in sync with the
 * selected node(s). pass empty array to clear.
 */
export function update(state: InspectMeshState, nodes: Node[], resources: Resources): void {
    if (nodes.length === 0) {
        // clear
        if (state.mesh) {
            state.scene.remove(state.mesh);
            (state.mesh.geometry as LineSegmentsGeometry).dispose();
            state.mesh = null;
        }
        return;
    }

    // one box per selected node — a single merged box loses per-node detail
    // for multi-selection. skip the scene root since its box would enclose
    // everything else in the scene.
    const pts: number[] = [];
    for (const node of nodes) {
        if (node === node.scene?.root) continue;
        box3.set(_aabb, Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
        if (getNodeAABB(node, resources, _aabb)) appendBoxSegments(_aabb, pts);
    }

    if (pts.length === 0) {
        // no drawable nodes — hide
        if (state.mesh) state.mesh.visible = false;
        return;
    }

    const geo = new LineSegmentsGeometry(pts);

    if (state.mesh) {
        (state.mesh.geometry as LineSegmentsGeometry).dispose();
        state.mesh.geometry = geo;
        state.mesh.visible = true;
    } else {
        const mesh = new Mesh(geo, getMaterial());
        mesh.name = 'editor-inspect-mesh';
        mesh.frustumCulled = false;
        state.scene.add(mesh);
        state.mesh = mesh;
    }
}
