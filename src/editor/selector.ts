import { CastRayStatus, createAllCastRayCollector, createDefaultCastRaySettings, castRay as queryCastRay } from 'crashcat';
import type { Vec3 } from 'math';
import type { Physics } from '../core/physics/physics';
import type { Node, SceneTree } from '../core/scene/scene-tree';
import { getNodeById } from '../core/scene/scene-tree';
import { createVoxelRaycastResult, raycastVoxels } from '../core/voxels/voxel-raycast';
import type { Voxels } from '../core/voxels/voxels';
import type { NodeBodies } from './node-bodies';
import { nodeIdForBody } from './node-bodies';

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

const _voxelResult = createVoxelRaycastResult();
const _origin: Vec3 = [0, 0, 0];
const _direction: Vec3 = [0, 0, 0];
const _rayCollector = createAllCastRayCollector();
const _raySettings = createDefaultCastRaySettings();

/** returns all hits sorted nearest-first; callers are responsible for any further filtering (player exclusion etc). */
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
