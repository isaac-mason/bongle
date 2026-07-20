import {
    addChild,
    addTrait,
    cloneModel,
    control,
    type createNode,
    asset,
    env,
    getTrait,
    model,
    onInit,
    onJoin,
    onTick,
    prop,
    RigidBodyTrait,
    script,
    setBlock,
    setPosition,
    TransformTrait,
    trait,
} from 'bongle';
import { blocks } from 'bongle/kit';

const stoneKey = blocks.stone.defaultKey();

// ── models ──────────────────────────────────────────────────────────

const SphereModel = model('sphere', { src: asset('../assets/models/sphere.gltf', import.meta.url) });

// ── terrain ─────────────────────────────────────────────────────────

const TerrainTrait = trait('terrain');

script(TerrainTrait, 'generate', (ctx) => {
    if (!env.server) return;

    const voxels = ctx.voxels;
    const HALF = 60;

    onInit(ctx, () => {
        for (let x = -HALF; x <= HALF; x++) {
            for (let z = -HALF; z <= HALF; z++) {
                setBlock(voxels, x, 0, z, stoneKey);
            }
        }
    });
});

// ── example ─────────────────────────────────────────────────────────

const ExampleTrait = trait('example', {
    /** how many spheres are alive */
    n: 100,
    /** ticks between successive respawns (one sphere per fire) */
    respawnIntervalTicks: 30,
});

control(ExampleTrait, 'n', {
    label: 'Sphere count',
    schema: prop.number(),
    get: (t) => t.n,
    set: (t, v) => {
        t.n = Math.max(0, Math.floor(v));
    },
});

control(ExampleTrait, 'respawnIntervalTicks', {
    label: 'Ticks between respawns',
    schema: prop.number(),
    get: (t) => t.respawnIntervalTicks,
    set: (t, v) => {
        t.respawnIntervalTicks = Math.max(1, Math.floor(v));
    },
});

script(ExampleTrait, 'pool', (ctx) => {
    if (!env.server) return;

    const SPAWN_Y = 15;
    const SPAWN_JITTER = 2;
    const SPHERE_RADIUS = 0.2;

    type Pooled = {
        node: ReturnType<typeof createNode>;
        transform: TransformTrait;
    };
    const pool: Pooled[] = [];
    let cursor = 0;
    let tickAccum = 0;

    const randJitter = () => (Math.random() - 0.5) * SPAWN_JITTER;

    const dropAt = (transform: TransformTrait, i: number) => {
        setPosition(transform, [randJitter(), SPAWN_Y + (i % 16) * 0.6, randJitter()]);
    };

    const spawnOne = (i: number): Pooled => {
        const node = cloneModel(SphereModel.scene);
        node.name = `sphere-${i}`;
        node.persist = false;

        const transform = addTrait(node, TransformTrait);
        dropAt(transform, i);

        const rb = addTrait(node, RigidBodyTrait);
        rb.def = {
            shape: { type: 'sphere', radius: SPHERE_RADIUS },
            restitution: 0.3,
            friction: 0.5,
        };
        rb.prediction = true;

        addChild(ctx.node, node);

        return { node, transform };
    };

    onTick(ctx, () => {
        const target = ctx.trait.n;

        while (pool.length < target) {
            pool.push(spawnOne(pool.length));
        }

        if (pool.length === 0) return;

        // round-robin: every `respawnIntervalTicks` ticks, teleport one sphere
        // back to the drop point. velocities are auto-zeroed by physics.ts
        // when it detects the transform was moved externally.
        tickAccum++;
        if (tickAccum >= ctx.trait.respawnIntervalTicks) {
            tickAccum = 0;
            cursor = (cursor + 1) % pool.length;
            dropAt(pool[cursor]!.transform, cursor);
        }
    });
});

// ── gameplay ────────────────────────────────────────────────────────

const GameplayTrait = trait('gameplay');

script(GameplayTrait, 'session', (ctx) => {
    if (!env.server) return;

    onJoin(ctx, ({ playerNode }) => {
        const transform = getTrait(playerNode, TransformTrait)!;
        setPosition(transform, [0, 5, 0]);
    });
});
