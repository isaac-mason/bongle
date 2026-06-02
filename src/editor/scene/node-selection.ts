/**
 * Origin-based node selection helper.
 *
 * Given a `Selection` bitmap, recompute `sel.nodes` so it contains exactly the
 * nodes whose visual origin sits inside the selected voxels. Used by the
 * shape-selection chat commands, the region-modification commands (so nodes
 * follow voxel transforms), and box-select.
 *
 * Approach: broadphase-narrow against the selection's AABB, then per-candidate
 * point-in-selection check on the floor of the world-space origin. Exact
 * shape-vs-AABB intersection is intentionally skipped — origin-point-in-set
 * is the contract; it tracks voxel selection exactly across all shape kinds.
 */
import { broadphase, type BodyVisitor, type RigidBody } from 'crashcat';
import type { Box3 } from 'mathcat';
import { TransformTrait } from '../../builtins/transform';
import { getVisualWorldMatrix } from '../../api/transforms';
import type { Physics } from '../../core/physics/physics';
import { getNodeById, getTrait } from '../../core/scene/nodes';
import type { ScriptContext } from '../../core/scene/scripts';
import * as Selection from '../../core/scene/selection';
import type { NodeBodies } from '../node-bodies';
import { nodeIdForBody } from '../node-bodies';

const _queryBox: Box3 = [0, 0, 0, 0, 0, 0];

const _collector = {
    shouldExit: false,
    nodeBodies: null as NodeBodies | null,
    nodeIds: [] as number[],
    visit(body: RigidBody): void {
        const nb = _collector.nodeBodies;
        if (!nb) return;
        const nid = nodeIdForBody(nb, body.id);
        if (nid !== undefined) _collector.nodeIds.push(nid);
    },
    reset(nb: NodeBodies): void {
        _collector.shouldExit = false;
        _collector.nodeBodies = nb;
        _collector.nodeIds.length = 0;
    },
} satisfies BodyVisitor & { nodeBodies: NodeBodies | null; nodeIds: number[]; reset(nb: NodeBodies): void };

/**
 * Replace `sel.nodes` with the set of nodes whose visual world origin (floored
 * to a voxel) is set in `sel.chunks`. No-op for `sel.chunks` themselves.
 *
 * Pass `null` for physics/nodeBodies to clear nodes (e.g. when running on the
 * server or before bodies are registered).
 */
export function rebuildNodeSelection(
    sel: Selection.Selection,
    ctx: ScriptContext,
    physics: Physics | null,
    nodeBodies: NodeBodies | null,
): void {
    sel.nodes.clear();
    if (!physics || !nodeBodies) return;

    const b = Selection.bounds(sel);
    if (!b) return;

    // +1 on the max so the AABB encloses voxel-aligned corners (matches the
    // existing convention in commitBoxSelect).
    _queryBox[0] = b.min[0];
    _queryBox[1] = b.min[1];
    _queryBox[2] = b.min[2];
    _queryBox[3] = b.max[0] + 1;
    _queryBox[4] = b.max[1] + 1;
    _queryBox[5] = b.max[2] + 1;

    _collector.reset(nodeBodies);
    broadphase.intersectAABB(physics.rigid.world, _queryBox, nodeBodies.queryFilter, _collector);

    for (const nid of _collector.nodeIds) {
        const node = getNodeById(ctx.nodes, nid);
        if (!node) continue;
        const transform = getTrait(node, TransformTrait);
        if (!transform) continue;
        const wm = getVisualWorldMatrix(transform);
        const wx = Math.floor(wm[12]!);
        const wy = Math.floor(wm[13]!);
        const wz = Math.floor(wm[14]!);
        if (Selection.has(sel, wx, wy, wz)) sel.nodes.add(nid);
    }
}
