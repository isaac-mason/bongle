import { type PerspectiveCamera, unproject } from 'gpucat';
import { deltaAngle, type Spherical, spherical, type Vec3, vec3 } from 'math';
import { getVisualWorldMatrix } from '../../api/transforms';
import { TransformTrait } from '../../builtins/transform';
import type { Input, MouseKeyboardInput } from '../../client/input';
import { getCursor, isKeyDown, isModDown, isMouseDown, isMouseJustDown, isMouseJustUp } from '../../client/input';
import type { SceneTree } from '../../core/scene/scene-tree';
import { getNodeById, getTrait } from '../../core/scene/scene-tree';
import type { ScriptContext } from '../../core/scene/scripts';
import * as Selection from '../../core/scene/selection';
import type { Blocks } from '../../core/voxels/block-registry';
import { createVoxelRaycastResult, raycastVoxels } from '../../core/voxels/voxel-raycast';
import type { Voxels } from '../../core/voxels/voxels';
import type { EditRoomStoreApi } from '../edit-room-store';
import type { NodeBodies } from '../node-bodies';
import { playSelected } from '../sounds';

// angular threshold (radians) for appending a new stroke point. Independent of reach distance —
// unlike a world-space threshold, an angle doesn't need rescaling by maxDistance.
const MIN_ANGLE_DELTA = 0.003;
const SAMPLE_GRID_RES = 96; // samples across the polygon's [theta, phi] bbox

// scratch buffers (per-frame, no allocation)
const _dir: Vec3 = [0, 0, 0];
const _worldPos: Vec3 = [0, 0, 0];
const _rayResult = createVoxelRaycastResult();
const _aimNear: Vec3 = [0, 0, 0];
const _aimFar: Vec3 = [0, 0, 0];
const _aimDir: Vec3 = [0, 0, 0];
const _aimSph: Spherical = [0, 0, 0];
const _nodeSph: Spherical = [0, 0, 0];

export function clearLassoStroke(store: EditRoomStoreApi): void {
    if (store.getState().lasso !== null) {
        store.setState({ lasso: null });
    }
}

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

/** unprojects the crosshair (a free cursor when unlocked, pinned to screen centre while
 *  pointer-locked) through `camera` into a raw `[theta, phi]` aim direction (theta = azimuth,
 *  phi = polar angle from +Y; see the `spherical` module in `math`), then unwraps theta relative
 *  to `prevTheta` so a stroke traced by turning past the ±180° seam — or all the way around, any
 *  number of times — accumulates as one continuous value instead of jumping. */
function captureAimAngles(mk: MouseKeyboardInput, camera: PerspectiveCamera, prevTheta: number, out: [number, number]): void {
    const cursor = getCursor(mk);
    unproject(_aimNear, [cursor.ndcX, cursor.ndcY, 0], camera);
    unproject(_aimFar, [cursor.ndcX, cursor.ndcY, 1], camera);
    vec3.subtract(_aimDir, _aimFar, _aimNear);
    vec3.normalize(_aimDir, _aimDir);
    spherical.setFromVec3(_aimSph, _aimDir);
    out[0] = prevTheta + deltaAngle(prevTheta, _aimSph[1]);
    out[1] = _aimSph[2];
}

/** reconstructs a stroke's world-space points for preview purposes: each `[theta, phi]` unprojected
 *  out to `maxDistance` from `origin`. Using the *current* camera position (rather than one baked
 *  in at capture time) keeps the preview attached to you if you're also moving, not just turning. */
export function lassoStrokeToWorldPoints(
    points: ReadonlyArray<readonly [number, number]>,
    origin: Vec3,
    maxDistance: number,
): Array<[number, number, number]> {
    const out: Array<[number, number, number]> = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
        const [theta, phi] = points[i]!;
        spherical.toVec3(_worldPos, [maxDistance, theta, phi]);
        out[i] = [origin[0] + _worldPos[0], origin[1] + _worldPos[1], origin[2] + _worldPos[2]];
    }
    return out;
}

export function updateLassoSelect(
    store: EditRoomStoreApi,
    ctx: ScriptContext,
    input: Input,
    camera: PerspectiveCamera,
    voxels: Voxels,
    blocks: Blocks,
    nodeBodies: NodeBodies | null,
    sceneTree: SceneTree,
): void {
    const mk = input.mouseKeyboard;
    const justDown = isMouseJustDown(mk, 'left');
    const held = isMouseDown(mk, 'left');
    const justUp = isMouseJustUp(mk, 'left');
    const lasso = store.getState().lasso;

    if (justDown && !lasso) {
        const cursor = getCursor(mk);
        unproject(_aimNear, [cursor.ndcX, cursor.ndcY, 0], camera);
        unproject(_aimFar, [cursor.ndcX, cursor.ndcY, 1], camera);
        vec3.subtract(_aimDir, _aimFar, _aimNear);
        vec3.normalize(_aimDir, _aimDir);
        spherical.setFromVec3(_aimSph, _aimDir);
        store.setState({ lasso: { points: [[_aimSph[1], _aimSph[2]]] } });
        return;
    }

    if (lasso && held && !justUp) {
        const pts = lasso.points;
        const last = pts[pts.length - 1]!;
        const sample: [number, number] = [0, 0];
        captureAimAngles(mk, camera, last[0], sample);
        const dTheta = sample[0] - last[0];
        const dPhi = sample[1] - last[1];
        if (dTheta * dTheta + dPhi * dPhi >= MIN_ANGLE_DELTA * MIN_ANGLE_DELTA) {
            const nextPoints: Array<[number, number]> = new Array(pts.length + 1);
            for (let i = 0; i < pts.length; i++) nextPoints[i] = [pts[i]![0], pts[i]![1]];
            nextPoints[pts.length] = sample;
            // fresh array ref so Object.is comparisons in selectors detect the change
            store.setState({ lasso: { points: nextPoints } });
        }
        return;
    }

    if (lasso && justUp) {
        const stroke = lasso.points;
        clearLassoStroke(store);
        commitLasso(store, ctx, stroke, input, camera, voxels, blocks, nodeBodies, sceneTree);
    }
}

function commitLasso(
    store: EditRoomStoreApi,
    ctx: ScriptContext,
    polygon: ReadonlyArray<readonly [number, number]>,
    input: Input,
    camera: PerspectiveCamera,
    voxels: Voxels,
    blocks: Blocks,
    nodeBodies: NodeBodies | null,
    sceneTree: SceneTree,
): void {
    const s = store.getState();
    const { selectionBehavior, selectTarget, lassoOptions } = s;
    const mk = input.mouseKeyboard;
    // cmd/ctrl is an alternate add-to-selection modifier, same as shift.
    const addHeld = isKeyDown(mk, 'ShiftLeft') || isKeyDown(mk, 'ShiftRight') || isModDown(mk);
    const effective = addHeld ? 'add' : selectionBehavior;
    const depth = Math.max(1, Math.floor(lassoOptions.depth));
    const maxDistance = Math.max(1, Math.floor(lassoOptions.maxDistance));
    // a single fixed origin for the whole enclosed test: since the polygon lives in angle-space
    // now, not any one camera's frustum, containment is resolved once, from here, regardless of
    // how far the stroke turned to get there.
    const origin = camera.position;

    const next = effective === 'add' ? Selection.clone(s.selection) : Selection.create();

    // sub-3-point stroke (a click): both branches below no-op on it, so 'replace' clears the
    // selection and 'add' leaves it untouched, same as a normal empty-result lasso.
    if (polygon.length >= 3) {
        // polygon bbox in [theta, phi]
        let minT = Infinity,
            minP = Infinity,
            maxT = -Infinity,
            maxP = -Infinity;
        for (const [t, p] of polygon) {
            if (t < minT) minT = t;
            if (p < minP) minP = p;
            if (t > maxT) maxT = t;
            if (p > maxP) maxP = p;
        }

        if (selectTarget !== 'nodes') {
            // adaptive grid step, denser for tight strokes, capped at SAMPLE_GRID_RES
            const spanT = Math.max(maxT - minT, 1e-6);
            const spanP = Math.max(maxP - minP, 1e-6);
            const stepT = spanT / SAMPLE_GRID_RES;
            const stepP = spanP / SAMPLE_GRID_RES;
            const seen = new Set<string>(); // dedupe voxels across samples

            for (let sy = 0; sy <= SAMPLE_GRID_RES; sy++) {
                const phi = minP + sy * stepP;
                for (let sx = 0; sx <= SAMPLE_GRID_RES; sx++) {
                    const theta = minT + sx * stepT;
                    if (!pointInPolygon(polygon, theta, phi)) continue;

                    spherical.toVec3(_dir, [1, theta, phi]);

                    raycastVoxels(
                        _rayResult,
                        voxels,
                        blocks,
                        origin[0],
                        origin[1],
                        origin[2],
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

        if (selectTarget !== 'voxels' && nodeBodies) {
            // candidate directions are unwrapped relative to the stroke's own first point, so they
            // land in the same phase as the polygon regardless of how far the stroke turned.
            const refTheta = polygon[0]![0];
            for (const nodeId of nodeBodies.nodeToBody.keys()) {
                const node = getNodeById(sceneTree, nodeId);
                if (!node) continue;
                const transform = getTrait(node, TransformTrait);
                if (!transform) continue;
                const wm = getVisualWorldMatrix(transform);
                _worldPos[0] = wm[12]! - origin[0];
                _worldPos[1] = wm[13]! - origin[1];
                _worldPos[2] = wm[14]! - origin[2];
                const distSq = _worldPos[0] * _worldPos[0] + _worldPos[1] * _worldPos[1] + _worldPos[2] * _worldPos[2];
                if (distSq < 1e-12) continue; // a node effectively at the origin has no direction
                vec3.normalize(_worldPos, _worldPos);
                spherical.setFromVec3(_nodeSph, _worldPos);
                const theta = refTheta + deltaAngle(refTheta, _nodeSph[1]);
                const phi = _nodeSph[2];
                if (theta < minT || theta > maxT || phi < minP || phi > maxP) continue;
                if (pointInPolygon(polygon, theta, phi)) {
                    Selection.addNode(next, nodeId);
                }
            }
        }
    }

    store.getState().replaceSelection(next);
    playSelected(ctx, effective === 'add');
}
