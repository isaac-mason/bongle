// lasso select tool.
//
// drag left-click to draw a freeform polygon in screen space. on release
// the polygon is "cast" into the world: a uniform NDC sample grid is
// clipped to the polygon, each interior sample shoots a ray, and the
// hit voxel (plus `depth-1` voxels behind it along the ray direction)
// goes into the selection. nodes are added when their body centre
// projects inside the polygon and is in front of the camera. respects
// selectTarget (all/voxels/nodes) and selectionBehavior (replace/add;
// shift forces add) just like box / magic select.
//
// per-frame state lives on store.lasso = { points }. UI selectors read
// these points directly to render the in-progress SVG overlay; we
// re-assign the lasso object (fresh ref) on every appended point so
// `Object.is` comparisons in selectors detect the change.

import type { PerspectiveCamera } from 'gpucat';
import { mat4, type Vec3, vec3 } from 'mathcat';
import { getVisualWorldMatrix } from '../../api/transforms';
import { TransformTrait } from '../../builtins/transform';
import type { Input } from '../../client/input';
import { isKeyDown } from '../../client/input';
import type { Nodes } from '../../core/scene/nodes';
import { getNodeById, getTrait } from '../../core/scene/nodes';
import * as Selection from '../../core/scene/selection';
import type { BlockRegistry } from '../../core/voxels/block-registry';
import { createVoxelRaycastResult, raycastVoxels } from '../../core/voxels/voxel-raycast';
import type { Voxels } from '../../core/voxels/voxels';
import type { EditRoomStoreApi } from '../edit-room-store';
import type { NodeBodies } from '../node-bodies';
import type { PointerState } from '../pointer-state';
import { pointerHeld, pointerJustDown, pointerJustUp } from '../pointer-state';

const MIN_NDC_DELTA = 0.004; // ~ a few pixels at typical resolutions
const SAMPLE_GRID_RES = 96; // samples across the polygon's NDC bbox

// scratch buffers (per-frame, no allocation)
const _origin: Vec3 = [0, 0, 0];
const _far: Vec3 = [0, 0, 0];
const _dir: Vec3 = [0, 0, 0];
const _ndc: Vec3 = [0, 0, 0];
const _worldPos: Vec3 = [0, 0, 0];
const _vp = mat4.create();
const _rayResult = createVoxelRaycastResult();

export function clearLassoStroke(store: EditRoomStoreApi): void {
    if (store.getState().lasso !== null) {
        store.setState({ lasso: null });
    }
}

// ── polygon helpers ────────────────────────────────────────────────

function pointInPolygon(pts: ReadonlyArray<readonly [number, number]>, x: number, y: number): boolean {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i]!;
        const [xj, yj] = pts[j]!;
        const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

// project world point to NDC. returns false when behind camera. fills _ndc.
function projectWorldToNdc(_camera: PerspectiveCamera, w: Vec3): boolean {
    // detect behind-camera via clip-space w before perspective divide
    const m = _vp;
    const clipW = m[3]! * w[0] + m[7]! * w[1] + m[11]! * w[2] + m[15]!;
    if (clipW <= 0) return false;
    vec3.transformMat4(_ndc, w, m);
    return true;
}

// ── per-frame update ───────────────────────────────────────────────

export function updateLassoSelect(
    store: EditRoomStoreApi,
    pointer: PointerState,
    input: Input,
    camera: PerspectiveCamera,
    voxels: Voxels,
    blocks: BlockRegistry,
    nodeBodies: NodeBodies | null,
    nodes: Nodes,
): void {
    const justDown = pointerJustDown(pointer, input);
    const held = pointerHeld(pointer, input);
    const justUp = pointerJustUp(pointer, input);
    const lasso = store.getState().lasso;

    // ── start a new stroke ─────────────────────────────────────────
    if (justDown && !lasso) {
        store.setState({
            lasso: { points: [[pointer.ndcX, pointer.ndcY]] },
        });
        return;
    }

    // ── extend in-progress stroke ──────────────────────────────────
    if (lasso && held && !justUp) {
        const pts = lasso.points;
        const last = pts[pts.length - 1]!;
        const dx = pointer.ndcX - last[0];
        const dy = pointer.ndcY - last[1];
        if (dx * dx + dy * dy >= MIN_NDC_DELTA * MIN_NDC_DELTA) {
            const nextPoints: Array<[number, number]> = new Array(pts.length + 1);
            for (let i = 0; i < pts.length; i++) nextPoints[i] = [pts[i]![0], pts[i]![1]];
            nextPoints[pts.length] = [pointer.ndcX, pointer.ndcY];
            store.setState({ lasso: { points: nextPoints } });
        }
        return;
    }

    // ── commit on release ──────────────────────────────────────────
    // a sub-3-point stroke (i.e. a click) produces a zero-area polygon,
    // both branches naturally find nothing inside it, so under 'replace'
    // it clears the selection and under 'add' it's a no-op.
    if (lasso && justUp) {
        const stroke = lasso.points;
        clearLassoStroke(store);
        commitLasso(store, stroke, input, camera, voxels, blocks, nodeBodies, nodes);
    }
}

// ── commit ─────────────────────────────────────────────────────────

function commitLasso(
    store: EditRoomStoreApi,
    polygon: ReadonlyArray<readonly [number, number]>,
    input: Input,
    camera: PerspectiveCamera,
    voxels: Voxels,
    blocks: BlockRegistry,
    nodeBodies: NodeBodies | null,
    nodes: Nodes,
): void {
    const s = store.getState();
    const { selectionBehavior, selectTarget, lassoOptions } = s;
    const mk = input.mouseKeyboard;
    const shiftHeld = isKeyDown(mk, 'ShiftLeft') || isKeyDown(mk, 'ShiftRight');
    const effective = shiftHeld ? 'add' : selectionBehavior;
    const depth = Math.max(1, Math.floor(lassoOptions.depth));
    const maxDistance = Math.max(1, Math.floor(lassoOptions.maxDistance));

    rebuildUnprojectCache(camera);

    const next = effective === 'add' ? Selection.clone(s.selection) : Selection.create();

    // ── voxels ────────────────────────────────────────────────────
    if (selectTarget !== 'nodes') {
        // polygon AABB in NDC
        let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity;
        for (const [x, y] of polygon) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
        // clip to viewport
        if (minX < -1) minX = -1;
        if (minY < -1) minY = -1;
        if (maxX > 1) maxX = 1;
        if (maxY > 1) maxY = 1;

        // adaptive grid step, denser for tight strokes, capped at SAMPLE_GRID_RES
        const spanX = Math.max(maxX - minX, 1e-6);
        const spanY = Math.max(maxY - minY, 1e-6);
        const stepX = spanX / SAMPLE_GRID_RES;
        const stepY = spanY / SAMPLE_GRID_RES;
        const seen = new Set<string>(); // dedupe voxels across samples

        for (let sy = 0; sy <= SAMPLE_GRID_RES; sy++) {
            const ny = minY + sy * stepY;
            for (let sx = 0; sx <= SAMPLE_GRID_RES; sx++) {
                const nx = minX + sx * stepX;
                if (!pointInPolygon(polygon, nx, ny)) continue;

                unprojectNdc(nx, ny, 0, _origin);
                unprojectNdc(nx, ny, 1, _far);
                vec3.subtract(_dir, _far, _origin);
                vec3.normalize(_dir, _dir);

                raycastVoxels(
                    _rayResult,
                    voxels,
                    blocks,
                    _origin[0],
                    _origin[1],
                    _origin[2],
                    _dir[0],
                    _dir[1],
                    _dir[2],
                    maxDistance,
                    0,
                );
                if (!_rayResult.hit) continue;

                const vx0 = _rayResult.voxelX;
                const vy0 = _rayResult.voxelY;
                const vz0 = _rayResult.voxelZ;
                // dominant ray axis dictates the "behind" stepping direction so the
                // depth slab grows into the voxel rather than across it.
                const adx = Math.abs(_dir[0]);
                const ady = Math.abs(_dir[1]);
                const adz = Math.abs(_dir[2]);
                let sxd = 0,
                    syd = 0,
                    szd = 0;
                if (adx >= ady && adx >= adz) sxd = _dir[0] >= 0 ? 1 : -1;
                else if (ady >= adz) syd = _dir[1] >= 0 ? 1 : -1;
                else szd = _dir[2] >= 0 ? 1 : -1;

                for (let d = 0; d < depth; d++) {
                    const vx = vx0 + sxd * d;
                    const vy = vy0 + syd * d;
                    const vz = vz0 + szd * d;
                    const key = `${vx},${vy},${vz}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    Selection.set(next, vx, vy, vz);
                }
            }
        }
    }

    // ── nodes ─────────────────────────────────────────────────────
    if (selectTarget !== 'voxels' && nodeBodies) {
        // rebuild view-proj for projection
        mat4.multiply(_vp, camera.projectionMatrix, camera.matrixWorldInverse);

        for (const nodeId of nodeBodies.nodeToBody.keys()) {
            const node = getNodeById(nodes, nodeId);
            if (!node) continue;
            const transform = getTrait(node, TransformTrait);
            if (!transform) continue;
            const wm = getVisualWorldMatrix(transform);
            _worldPos[0] = wm[12]!;
            _worldPos[1] = wm[13]!;
            _worldPos[2] = wm[14]!;
            if (!projectWorldToNdc(camera, _worldPos)) continue;
            if (_ndc[0] < -1 || _ndc[0] > 1 || _ndc[1] < -1 || _ndc[1] > 1) continue;
            if (pointInPolygon(polygon, _ndc[0], _ndc[1])) {
                Selection.addNode(next, nodeId);
            }
        }
    }

    store.setState({ selection: next });
}

// inline NDC → world unprojection. caller must call rebuildUnprojectCache
// once per commit to refresh against the active camera.
const _invVp = mat4.create();

function rebuildUnprojectCache(camera: PerspectiveCamera): void {
    mat4.multiply(_invVp, camera.projectionMatrix, camera.matrixWorldInverse);
    mat4.invert(_invVp, _invVp);
}

const _unprojScratch: Vec3 = [0, 0, 0];
function unprojectNdc(x: number, y: number, z: number, out: Vec3): void {
    _unprojScratch[0] = x;
    _unprojScratch[1] = y;
    _unprojScratch[2] = z;
    vec3.transformMat4(out, _unprojScratch, _invVp);
}
