// per-frame cull cost.
// run: labs visibility

import { bench, group } from '@pmndrs/labs';
import { mat4, type Vec3 } from 'math';
import { box3 } from 'math/shapes';
import { setPosition, TransformTrait } from '../src/builtins/transform';
import { addChild, addTrait, createNode, createSceneTree } from '../src/core/scene/scene-tree';
import type { CullState } from '../src/render/visibility/visibility';
import * as Visibility from '../src/render/visibility/visibility';

/* ── fixture helpers ── */

/** deterministic PRNG so every arm sees the same layout. */
function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/** a camera-shaped object: `Visibility.update` reads only these four fields. */
function makeCamera(eye: Vec3, target: Vec3, aspect = 16 / 9, fov = Math.PI / 3) {
    const projectionMatrix = mat4.create();
    mat4.perspectiveZO(projectionMatrix, fov, aspect, 0.1, 2000);
    const world = mat4.create();
    mat4.targetTo(world, eye, target, [0, 1, 0]);
    const matrixWorldInverse = mat4.create();
    mat4.invert(matrixWorldInverse, world);
    return {
        position: eye,
        projectionMatrix,
        matrixWorldInverse,
        coordinateSystem: 0, // CoordinateSystem.WEBGPU
    } as unknown as Parameters<typeof Visibility.update>[1];
}

type Fixture = {
    visibility: Visibility.Visibility;
    transforms: TransformTrait[];
    culls: CullState[];
};

function buildScene(count: number, spread: number, clusterSize = 0): Fixture {
    const sceneTree = createSceneTree();
    const visibility = Visibility.init();
    const random = rng(0x9e3779b9);
    const transforms: TransformTrait[] = [];
    const culls: CullState[] = [];
    const localBox = box3.create();
    box3.set(localBox, -0.5, -0.5, -0.5, 0.5, 0.5, 0.5);

    let clusterX = 0;
    let clusterY = 0;
    let clusterZ = 0;
    for (let i = 0; i < count; i++) {
        if (clusterSize > 0 && i % clusterSize === 0) {
            clusterX = (random() - 0.5) * spread;
            clusterY = (random() - 0.5) * spread * 0.25;
            clusterZ = (random() - 0.5) * spread;
        }
        const node = createNode({ name: `c${i}` });
        addChild(sceneTree.root, node);
        const transform = addTrait(node, TransformTrait);
        if (clusterSize > 0) {
            transform.position[0] = clusterX + (random() - 0.5) * 8;
            transform.position[1] = clusterY + (random() - 0.5) * 8;
            transform.position[2] = clusterZ + (random() - 0.5) * 8;
        } else {
            transform.position[0] = (random() - 0.5) * spread;
            transform.position[1] = (random() - 0.5) * spread * 0.25;
            transform.position[2] = (random() - 0.5) * spread;
        }
        transforms.push(transform);
        culls.push(Visibility.add(visibility, localBox, transform));
    }
    return { visibility, transforms, culls };
}

/** nudge the first `moving` transforms, the way a tick of physics would. */
function makeMover(f: Fixture, moving: number): () => void {
    const step: Vec3 = [0, 0, 0];
    let phase = 0;
    return () => {
        phase += 0.01;
        const dx = Math.sin(phase) * 0.35;
        for (let i = 0; i < moving; i++) {
            const t = f.transforms[i]!;
            step[0] = t.position[0] + dx;
            step[1] = t.position[1];
            step[2] = t.position[2];
            setPosition(t, step);
        }
    };
}

/* ── steady state: nothing moves ── */

group('visibility: steady state, all static @vis @steady', () => {
    for (const count of [500, 2000, 10000]) {
        bench(`update, ${count} static entries`, function* () {
            const f = buildScene(count, 400, 8);
            const camera = makeCamera([0, 40, 220], [0, 0, 0]);
            // one warm pass so `wasVisible` and the tree are settled.
            Visibility.update(f.visibility, camera, 256);
            yield () => {
                Visibility.update(f.visibility, camera, 256);
                return f.culls[0]!.visible;
            };
        }).gc(true);
    }
});

/* ── movement: refit + dbvt reinsert ── */

group('visibility: fraction moving @vis @moving', () => {
    const count = 2000;
    for (const [label, moving] of [
        ['0%', 0],
        ['5%', 100],
        ['50%', 1000],
        ['100%', 2000],
    ] as const) {
        bench(`move ${label} of ${count} then update`, function* () {
            const f = buildScene(count, 400, 8);
            const camera = makeCamera([0, 40, 220], [0, 0, 0]);
            const move = makeMover(f, moving);
            Visibility.update(f.visibility, camera, 256);
            yield () => {
                move();
                Visibility.update(f.visibility, camera, 256);
                return f.culls[0]!.visible;
            };
        }).gc(true);
    }

    // the same movement WITHOUT the cull, so the arms above can be read net of
    // the transform writes they include.
    for (const [label, moving] of [
        ['5%', 100],
        ['100%', 2000],
    ] as const) {
        bench(`move ${label} of ${count}, no update`, function* () {
            const f = buildScene(count, 400, 8);
            const move = makeMover(f, moving);
            yield () => {
                move();
                return f.transforms[0]!._version;
            };
        }).gc(true);
    }
});

/* ── frustum selectivity ── */

group('visibility: how much is on screen @vis @frustum', () => {
    const count = 5000;
    for (const [label, camera] of [
        // inside the cloud looking at a slice of it
        ['~narrow fov, inside', makeCamera([0, 20, 0], [0, 20, -1], 16 / 9, Math.PI / 6)],
        ['~default fov, inside', makeCamera([0, 20, 0], [0, 20, -1], 16 / 9, Math.PI / 3)],
        // far outside looking back: nearly everything is in the frustum
        ['everything in view', makeCamera([0, 200, 900], [0, 0, 0], 16 / 9, Math.PI / 3)],
        // pointed away: nothing survives the near planes
        ['nothing in view', makeCamera([0, 200, 900], [0, 400, 1800], 16 / 9, Math.PI / 3)],
    ] as const) {
        bench(`update ${count} entries, ${label}`, function* () {
            const f = buildScene(count, 400, 8);
            Visibility.update(f.visibility, camera, 4096);
            yield () => {
                Visibility.update(f.visibility, camera, 4096);
                return f.culls[0]!.visible;
            };
        }).gc(true);
    }
});

/* ── distance cull ── */

group('visibility: view radius @vis @radius', () => {
    const count = 5000;
    for (const radius of [64, 256, 4096]) {
        bench(`update ${count} entries, radius ${radius}`, function* () {
            const f = buildScene(count, 800, 8);
            const camera = makeCamera([0, 40, 0], [0, 30, -1]);
            Visibility.update(f.visibility, camera, radius);
            yield () => {
                Visibility.update(f.visibility, camera, radius);
                return f.culls[0]!.visible;
            };
        }).gc(true);
    }
});

/* ── tree quality: clustered vs uniform ── */

group('visibility: leaf distribution @vis @shape', () => {
    const count = 5000;
    for (const [label, clusterSize] of [
        ['uniform', 0],
        ['clusters of 8', 8],
        ['clusters of 64', 64],
    ] as const) {
        bench(`update ${count} entries, ${label}`, function* () {
            const f = buildScene(count, 400, clusterSize);
            const camera = makeCamera([0, 40, 220], [0, 0, 0]);
            Visibility.update(f.visibility, camera, 256);
            yield () => {
                Visibility.update(f.visibility, camera, 256);
                return f.culls[0]!.visible;
            };
        }).gc(true);
    }
});

/* ── churn: spawn / despawn ── */

group('visibility: add + remove @vis @churn', () => {
    const localBox = box3.create();
    box3.set(localBox, -0.5, -0.5, -0.5, 0.5, 0.5, 0.5);

    for (const count of [500, 5000]) {
        bench(`add+remove 1 entry, ${count} present`, function* () {
            const f = buildScene(count, 400, 8);
            const spare = f.transforms[0]!;
            yield () => {
                const cull = Visibility.add(f.visibility, localBox, spare);
                Visibility.remove(f.visibility, cull);
                return cull.leaf;
            };
        }).gc(true);
    }

    bench('add+remove 64 entries, 5000 present', function* () {
        const f = buildScene(5000, 400, 8);
        const spare = f.transforms[0]!;
        const batch: CullState[] = [];
        yield () => {
            for (let i = 0; i < 64; i++) batch.push(Visibility.add(f.visibility, localBox, spare));
            for (let i = 0; i < 64; i++) Visibility.remove(f.visibility, batch[i]!);
            batch.length = 0;
            return f.visibility.entries.length;
        };
    }).gc(true);
});

/* ── bulk build ── */

group('visibility: bulk insert @vis @build', () => {
    for (const count of [1000, 10000]) {
        bench(`insert ${count} leaves into an empty tree`, function* () {
            // transforms built once; only the inserts are measured.
            const f = buildScene(count, 400, 8);
            const boxes = f.culls.map((c) => c.aabb);
            yield () => {
                const visibility = Visibility.init();
                for (let i = 0; i < count; i++) Visibility.add(visibility, boxes[i]!, f.transforms[i]!);
                return visibility.tree.nodes.length;
            };
        }).gc(true);
    }
});
