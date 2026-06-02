import { PerspectiveCamera } from 'gpucat';
import { mat4 } from 'mathcat';
import { describe, expect, it } from 'vitest';
import { BoundsTrait } from '../builtins/bounds';
import { TransformTrait } from '../builtins/transform';
import { addChild, addTrait, createNode, createSceneGraph } from '../core/scene/nodes';
import { setPosition } from '../builtins/transform';
import * as Visibility from './visibility';

function makeCamera(): PerspectiveCamera {
    const cam = new PerspectiveCamera(Math.PI / 3, 1, 0.1, 100);
    // lookAt produces a view matrix directly (world → camera).
    mat4.lookAt(cam.matrixWorldInverse, [0, 0, 10], [0, 0, 0], [0, 1, 0]);
    return cam;
}

function spawn(sgRoot: ReturnType<typeof createSceneGraph>['root'], pos: [number, number, number]) {
    const n = createNode({ name: 'thing' });
    addChild(sgRoot, n);
    const t = addTrait(n, TransformTrait);
    setPosition(t, pos);
    const b = addTrait(n, BoundsTrait, {
        aabbLocal: [-0.5, -0.5, -0.5, 0.5, 0.5, 0.5],
        _seedAabb: [-0.5, -0.5, -0.5, 0.5, 0.5, 0.5],
        _version: 1,
    });
    return { node: n, transform: t, bounds: b };
}

describe('Visibility', () => {
    it('marks in-frustum traits visible, out-of-frustum traits invisible', () => {
        const sg = createSceneGraph();
        const visibility = Visibility.init(sg);
        const inFront = spawn(sg.root, [0, 0, 0]);
        const offToSide = spawn(sg.root, [200, 0, 0]);

        Visibility.update(visibility, makeCamera(), Infinity);

        expect(inFront.bounds.visible).toBe(true);
        expect(offToSide.bounds.visible).toBe(false);
    });

    it('refreshes the DBVT leaf when transform._version bumps past the fat-aabb margin', () => {
        const sg = createSceneGraph();
        const visibility = Visibility.init(sg);
        const a = spawn(sg.root, [0, 0, 0]);
        const camera = makeCamera();

        Visibility.update(visibility, camera, Infinity);
        expect(a.bounds.visible).toBe(true);

        // teleport far out of frustum (setPosition marks dirty + bumps version)
        setPosition(a.transform, [200, 0, 0]);

        Visibility.update(visibility, camera, Infinity);
        expect(a.bounds.visible).toBe(false);
    });

    it('distance-culls past viewRadius, with hysteresis across the margin', () => {
        const sg = createSceneGraph();
        const visibility = Visibility.init(sg);
        // camera at world-space [0,0,30] looking toward origin. lookAt
        // only fills the view matrix; position is read separately by the
        // distance cull, so set it explicitly to match.
        const camera = makeCamera();
        camera.position = [0, 0, 30];
        mat4.lookAt(camera.matrixWorldInverse, [0, 0, 30], [0, 0, 0], [0, 1, 0]);
        // leaf at origin — distance 30 from camera.
        const a = spawn(sg.root, [0, 0, 0]);

        // generous radius — well inside inner sphere.
        Visibility.update(visibility, camera, 50);
        expect(a.bounds.visible).toBe(true);

        // shrink radius so leaf is past inner (10) but inside outer
        // (10 + 16 = 26)? 30 > 26 — past outer. So expect culled even
        // though prev-visible. Use radius 20 instead: outer = 36, dist
        // 30 ≤ 36 → hysteresis keeps it visible.
        Visibility.update(visibility, camera, 20);
        expect(a.bounds.visible).toBe(true);

        // steady state in the hysteresis band: still visible next frame.
        Visibility.update(visibility, camera, 20);
        expect(a.bounds.visible).toBe(true);

        // collapse the outer band below leaf distance: radius 10 → outer
        // 26 < 30 → reject regardless of prev-visible.
        Visibility.update(visibility, camera, 10);
        expect(a.bounds.visible).toBe(false);

        // once invisible, a fresh leaf needs to be inside *inner* to come
        // back. radius 20 → inner 20 < 30 → still rejected.
        Visibility.update(visibility, camera, 20);
        expect(a.bounds.visible).toBe(false);

        // radius 35 → inner 35 ≥ 30 → visible again.
        Visibility.update(visibility, camera, 35);
        expect(a.bounds.visible).toBe(true);
    });

    it('skips registration when aabbLocal is empty (producer not yet seeded)', () => {
        const sg = createSceneGraph();
        const visibility = Visibility.init(sg);
        const n = createNode({ name: 'empty' });
        addTrait(n, TransformTrait);
        const bounds = addTrait(n, BoundsTrait); // defaults to empty box3 + visible:true
        addChild(sg.root, n);

        Visibility.update(visibility, makeCamera(), Infinity);

        // not registered, _visLeaf stays -1
        expect(bounds._visLeaf).toBe(-1);
        // default visible stays true (server / pre-seed contexts treat as visible)
        expect(bounds.visible).toBe(true);
    });
});
