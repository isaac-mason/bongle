import { PerspectiveCamera } from 'gpucat';
import { box3, mat4 } from 'mathcat';
import { describe, expect, it } from 'vitest';
import { TransformTrait } from '../builtins/transform';
import { setPosition } from '../builtins/transform';
import { addChild, addTrait, createNode, createSceneGraph } from '../core/scene/nodes';
import * as Visibility from './visibility';

function makeCamera(): PerspectiveCamera {
    const cam = new PerspectiveCamera(Math.PI / 3, 1, 0.1, 100);
    // lookAt produces a view matrix directly (world → camera).
    mat4.lookAt(cam.matrixWorldInverse, [0, 0, 10], [0, 0, 0], [0, 1, 0]);
    return cam;
}

/** create a transformed node, register a unit-box cull entry for it with the
 *  culler, and return the entry so the test can read `cull.visible`. */
function spawn(
    sgRoot: ReturnType<typeof createSceneGraph>['root'],
    visibility: Visibility.Visibility,
    pos: [number, number, number],
) {
    const n = createNode({ name: 'thing' });
    addChild(sgRoot, n);
    const t = addTrait(n, TransformTrait);
    setPosition(t, pos);
    const cull = Visibility.add(visibility, box3.set(box3.create(), -0.5, -0.5, -0.5, 0.5, 0.5, 0.5), t);
    return { node: n, transform: t, cull };
}

describe('Visibility', () => {
    it('marks in-frustum entries visible, out-of-frustum entries invisible', () => {
        const sg = createSceneGraph();
        const visibility = Visibility.init();
        const inFront = spawn(sg.root, visibility, [0, 0, 0]);
        const offToSide = spawn(sg.root, visibility, [200, 0, 0]);

        Visibility.update(visibility, makeCamera(), Infinity);

        expect(inFront.cull.visible).toBe(true);
        expect(offToSide.cull.visible).toBe(false);
    });

    it('refreshes the DBVT leaf when transform._version bumps past the fat-aabb margin', () => {
        const sg = createSceneGraph();
        const visibility = Visibility.init();
        const a = spawn(sg.root, visibility, [0, 0, 0]);
        const camera = makeCamera();

        Visibility.update(visibility, camera, Infinity);
        expect(a.cull.visible).toBe(true);

        // teleport far out of frustum (setPosition marks dirty + bumps version)
        setPosition(a.transform, [200, 0, 0]);

        Visibility.update(visibility, camera, Infinity);
        expect(a.cull.visible).toBe(false);
    });

    it('drops a leaf on unregister so it stops being culled', () => {
        const sg = createSceneGraph();
        const visibility = Visibility.init();
        const a = spawn(sg.root, visibility, [0, 0, 0]);

        Visibility.update(visibility, makeCamera(), Infinity);
        expect(a.cull.visible).toBe(true);

        Visibility.remove(visibility, a.cull);
        expect(a.cull.leaf).toBe(-1);

        // the entry no longer participates; its visible bit is left as-is and
        // the culler must not touch it (no throw on the freed leaf).
        a.cull.visible = true;
        Visibility.update(visibility, makeCamera(), Infinity);
        expect(a.cull.visible).toBe(true);
    });

    it('distance-culls past viewRadius, with hysteresis across the margin', () => {
        const sg = createSceneGraph();
        const visibility = Visibility.init();
        // camera at world-space [0,0,30] looking toward origin. lookAt
        // only fills the view matrix; position is read separately by the
        // distance cull, so set it explicitly to match.
        const camera = makeCamera();
        camera.position = [0, 0, 30];
        mat4.lookAt(camera.matrixWorldInverse, [0, 0, 30], [0, 0, 0], [0, 1, 0]);
        // leaf at origin — distance 30 from camera.
        const a = spawn(sg.root, visibility, [0, 0, 0]);

        // generous radius — well inside inner sphere.
        Visibility.update(visibility, camera, 50);
        expect(a.cull.visible).toBe(true);

        // radius 20 → outer = 36, dist 30 ≤ 36 → hysteresis keeps it visible.
        Visibility.update(visibility, camera, 20);
        expect(a.cull.visible).toBe(true);

        // steady state in the hysteresis band: still visible next frame.
        Visibility.update(visibility, camera, 20);
        expect(a.cull.visible).toBe(true);

        // collapse the outer band below leaf distance: radius 10 → outer
        // 26 < 30 → reject regardless of prev-visible.
        Visibility.update(visibility, camera, 10);
        expect(a.cull.visible).toBe(false);

        // once invisible, a fresh leaf needs to be inside *inner* to come
        // back. radius 20 → inner 20 < 30 → still rejected.
        Visibility.update(visibility, camera, 20);
        expect(a.cull.visible).toBe(false);

        // radius 35 → inner 35 ≥ 30 → visible again.
        Visibility.update(visibility, camera, 35);
        expect(a.cull.visible).toBe(true);
    });

    it('registering an empty box returns an unregistered, visible handle', () => {
        const sg = createSceneGraph();
        const visibility = Visibility.init();
        const n = createNode({ name: 'empty' });
        const t = addTrait(n, TransformTrait);
        addChild(sg.root, n);

        // empty box (renderer has no geometry yet) → no leaf assigned.
        const cull = Visibility.add(visibility, box3.create(), t);
        expect(cull.leaf).toBe(-1);

        Visibility.update(visibility, makeCamera(), Infinity);

        // default visible stays true (server / pre-seed contexts treat as visible)
        expect(cull.leaf).toBe(-1);
        expect(cull.visible).toBe(true);
    });
});
