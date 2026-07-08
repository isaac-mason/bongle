// selector.ts, scene raycast for the inspect tool.
//
// casts a ray against all raycaster-able things in a scene and returns
// all hits sorted by distance. consumers filter by type.
//
// node hits use the crashcat broadphase (editor node bodies layer) for
// efficient spatial queries instead of iterating all nodes manually.
// voxel hits still use the DDA voxel raycast.

import { CastRayStatus, createAllCastRayCollector, createDefaultCastRaySettings, castRay as queryCastRay } from 'crashcat';
import type { Vec3 } from 'mathcat';
import type { Physics } from '../core/physics/physics';
import type { Node, SceneTree } from '../core/scene/scene-tree';
import { getNodeById } from '../core/scene/scene-tree';
import { createVoxelRaycastResult, raycastVoxels } from '../core/voxels/voxel-raycast';
import type { Voxels } from '../core/voxels/voxels';
import type { NodeBodies } from './node-bodies';
import { nodeIdForBody } from './node-bodies';

// ── hit types ───────────────────────────────────────────────────────

export type VoxelHit = {
    kind: 'voxel';
    distance: number;
    px: number;
    py: number;
    pz: number;
    nx: number;
    ny: number;
    nz: number;
    voxelX: number;
    voxelY: number;
    voxelZ: number;
    stateId: number;
    hitIndex: number;
};

export type NodeHit = {
    kind: 'node';
    node: Node;
    distance: number;
    px: number;
    py: number;
    pz: number;
};

export type SelectorHit = VoxelHit | NodeHit;

// ── scratch allocations ─────────────────────────────────────────────

const _voxelResult = createVoxelRaycastResult();
const _origin: Vec3 = [0, 0, 0];
const _direction: Vec3 = [0, 0, 0];
const _rayCollector = createAllCastRayCollector();
const _raySettings = createDefaultCastRaySettings();

// ── castRay ──────────────────────────────────────────────────────────

/**
 * cast a ray through the scene and return all hits sorted nearest-first.
 * node hits come from the crashcat broadphase (editor node bodies layer).
 * voxel hits come from the DDA voxel raycast.
 * callers are responsible for any further filtering (player exclusion etc).
 */
export function castRay(
    physics: Physics,
    nodeBodies: NodeBodies,
    sceneTree: SceneTree,
    voxels: Voxels,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
): SelectorHit[] {
    const hits: SelectorHit[] = [];

    // ── voxel raycast ────────────────────────────────────────────────
    const vr = _voxelResult;
    raycastVoxels(vr, voxels, voxels.registry, ox, oy, oz, dx, dy, dz, maxDist, 0);
    if (vr.hit && vr.distance <= maxDist) {
        hits.push({
            kind: 'voxel',
            distance: vr.distance,
            px: vr.px,
            py: vr.py,
            pz: vr.pz,
            nx: vr.nx,
            ny: vr.ny,
            nz: vr.nz,
            voxelX: vr.voxelX,
            voxelY: vr.voxelY,
            voxelZ: vr.voxelZ,
            stateId: vr.stateId,
            hitIndex: vr.hitIndex,
        });
    }

    // ── node raycast via crashcat broadphase ─────────────────────────
    _origin[0] = ox;
    _origin[1] = oy;
    _origin[2] = oz;
    _direction[0] = dx;
    _direction[1] = dy;
    _direction[2] = dz;
    _rayCollector.reset();

    queryCastRay(physics.rigid.world, _rayCollector, _raySettings, _origin, _direction, maxDist, nodeBodies.queryFilter);

    for (const hit of _rayCollector.hits) {
        if (hit.status !== CastRayStatus.COLLIDING) continue;

        const nid = nodeIdForBody(nodeBodies, hit.bodyIdB);
        if (nid === undefined) continue;

        const node = getNodeById(sceneTree, nid);
        if (!node) continue;

        const dist = hit.fraction * maxDist;
        hits.push({
            kind: 'node',
            node,
            distance: dist,
            px: ox + dx * dist,
            py: oy + dy * dist,
            pz: oz + dz * dist,
        });
    }

    hits.sort((a, b) => a.distance - b.distance);
    return hits;
}
