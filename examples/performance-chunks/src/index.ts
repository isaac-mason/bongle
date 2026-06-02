import {
    addTrait,
    BLOCK_AIR,
    control,
    env,
    getBlockKey,
    getTrait,
    matchmaking,
    onInit,
    onJoin,
    onTick,
    prop,
    script,
    setBlock,
    setPosition,
    TransformTrait,
    trait,
    CharacterControllerTrait,
    CharacterTrait,
    PlayerControllerTrait,
} from 'bongle';
import { blocks } from 'bongle/starter';

// ── matchmaking ─────────────────────────────────────────────────────

matchmaking({ maxPlayers: 4 });

const stoneKey = blocks.stone.defaultKey();

// ── ground (flat baseline so the player has somewhere to stand) ─────

const GroundTrait = trait('ground', {
    /** half-extent of the floor slab (final width is 2*half+1) */
    half: 64,
});

script(GroundTrait, 'generate', (ctx) => {
    if (!env.server) return;

    onInit(ctx, () => {
        const half = ctx.trait.half;
        for (let x = -half; x <= half; x++) {
            for (let z = -half; z <= half; z++) {
                setBlock(ctx.voxels, x, 0, z, stoneKey);
            }
        }
    });
});

// ── storm: random toggles spread across many chunks every tick ──────

const StormTrait = trait('storm', {
    /** how many voxel toggles per tick (flips air ↔ stone) */
    togglesPerTick: 200,
    /** half-extent on X/Z of the toggle volume (chunk = 16, so this covers many chunks) */
    half: 64,
    /** number of vertical layers above the floor that toggles can land on */
    height: 16,
});

control(StormTrait, 'togglesPerTick', {
    label: 'Toggles per tick',
    schema: prop.number(),
    get: (t) => t.togglesPerTick,
    set: (t, v) => {
        t.togglesPerTick = Math.max(0, Math.floor(v));
    },
});

control(StormTrait, 'half', {
    label: 'Area half-extent (XZ)',
    schema: prop.number(),
    get: (t) => t.half,
    set: (t, v) => {
        t.half = Math.max(1, Math.floor(v));
    },
});

control(StormTrait, 'height', {
    label: 'Vertical layers',
    schema: prop.number(),
    get: (t) => t.height,
    set: (t, v) => {
        t.height = Math.max(1, Math.floor(v));
    },
});

script(StormTrait, 'tick', (ctx) => {
    if (!env.server) return;

    onTick(ctx, () => {
        const k = ctx.trait.togglesPerTick;
        if (k <= 0) return;

        const half = ctx.trait.half;
        const span = half * 2 + 1;
        const height = ctx.trait.height;
        const baseY = 1; // first layer above the ground slab

        for (let i = 0; i < k; i++) {
            const x = -half + Math.floor(Math.random() * span);
            const z = -half + Math.floor(Math.random() * span);
            const y = baseY + Math.floor(Math.random() * height);

            const current = getBlockKey(ctx.voxels, x, y, z);
            setBlock(ctx.voxels, x, y, z, current === BLOCK_AIR ? stoneKey : BLOCK_AIR);
        }
    });
});

// ── gameplay ────────────────────────────────────────────────────────

const GameplayTrait = trait('gameplay');

script(GameplayTrait, 'session', (ctx) => {
    if (!env.server) return;

    onJoin(ctx, ({ playerNode }) => {
        const transform = getTrait(playerNode, TransformTrait)!;
        setPosition(transform, [0, 30, 0]);

        addTrait(playerNode, CharacterControllerTrait);

        addTrait(playerNode, CharacterTrait);
        addTrait(playerNode, PlayerControllerTrait);
    });
});
