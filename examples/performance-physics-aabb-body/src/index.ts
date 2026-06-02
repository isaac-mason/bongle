import {
    AabbBodyTrait,
    addChild,
    addTrait,
    CharacterControllerTrait,
    CharacterTrait,
    cloneModel,
    configureFloodFillLighting,
    control,
    type createNode,
    env,
    getTrait,
    model,
    onInit,
    onJoin,
    onTick,
    PlayerControllerTrait,
    prop,
    script,
    setBlock,
    setPosition,
    TransformTrait,
    trait,
} from 'bongle';
import { blocks } from 'bongle/starter';

const stoneKey = blocks.stone.defaultKey();

// ── models ──────────────────────────────────────────────────────────

const SphereModel = model('sphere', { src: 'assets/models/sphere.gltf' });

// ── terrain ─────────────────────────────────────────────────────────

const TerrainTrait = trait('terrain');

script(TerrainTrait, 'generate', (ctx) => {
    if (!env.server) return;

    const voxels = ctx.voxels;
    const HALF = 60;

    onInit(ctx, () => {
        configureFloodFillLighting(ctx, { enabled: false });
        for (let x = -HALF; x <= HALF; x++) {
            for (let z = -HALF; z <= HALF; z++) {
                setBlock(voxels, x, 0, z, stoneKey);
            }
        }
    });
});

// ── example ─────────────────────────────────────────────────────────

const ExampleTrait = trait('example', {
    /** how many bodies are alive */
    n: 300,
    /** ticks between successive respawns (one body per fire) */
    respawnIntervalTicks: 30,
});

control(ExampleTrait, 'n', {
    label: 'Body count',
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
    const SPAWN_LATERAL_V = 4;

    type Pooled = {
        node: ReturnType<typeof createNode>;
        transform: TransformTrait;
        body: AabbBodyTrait;
    };
    const pool: Pooled[] = [];
    let cursor = 0;
    let tickAccum = 0;

    const randJitter = () => (Math.random() - 0.5) * SPAWN_JITTER;
    const randVel = () => (Math.random() - 0.5) * SPAWN_LATERAL_V;

    // teleport pose + initial velocity. setting `t.linearVelocity` in the same
    // tick as the position change tells physics.ts to apply it after the
    // teleport-zero — random scatter keeps the pile from collapsing into
    // a single stack and makes broadphase work meaningful.
    const dropAt = (p: Pooled, i: number) => {
        setPosition(p.transform, [randJitter(), SPAWN_Y + (i % 16) * 0.6, randJitter()]);
        p.body.linearVelocity = [randVel(), 0, randVel()];
    };

    const spawnOne = (i: number): Pooled => {
        const node = cloneModel(SphereModel.scene);
        node.name = `sphere-${i}`;
        node.persist = false;

        const transform = getTrait(node, TransformTrait)!;
        const body = addTrait(node, AabbBodyTrait);
        body.halfExtents = [0.2, 0.2, 0.2];
        body.restitution = 0.5;
        body.friction = 0.5;
        body.prediction = true;

        const pooled: Pooled = { node, transform, body };
        dropAt(pooled, i);

        addChild(ctx.node, node);

        return pooled;
    };

    onTick(ctx, () => {
        const target = ctx.trait.n;

        while (pool.length < target) {
            pool.push(spawnOne(pool.length));
        }

        if (pool.length === 0) return;

        // round-robin: every `respawnIntervalTicks` ticks, teleport one sphere
        // back to the drop point with a fresh random lateral velocity.
        tickAccum++;
        if (tickAccum >= ctx.trait.respawnIntervalTicks) {
            tickAccum = 0;
            cursor = (cursor + 1) % pool.length;
            dropAt(pool[cursor]!, cursor);
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

        addTrait(playerNode, CharacterControllerTrait);

        addTrait(playerNode, CharacterTrait);
        addTrait(playerNode, PlayerControllerTrait);
    });
});
