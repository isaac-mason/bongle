import {
    block,
    BLOCK_AIR,
    control,
    env,
    getBlock,
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
} from 'bongle';
import { blocks, blockTextures } from 'bongle/kit';

// Stone comes from the kit pack. The rgb emitters are example-local because
// they only exist to drive the lighting stress demo.
const RedEmitter = block('emitter_r', {
    model: () => ({ type: 'cube', textures: { all: { texture: blockTextures.stone } } }),
    lightEmission: [15, 0, 0],
});

const GreenEmitter = block('emitter_g', {
    model: () => ({ type: 'cube', textures: { all: { texture: blockTextures.stone } } }),
    lightEmission: [0, 15, 0],
});

const BlueEmitter = block('emitter_b', {
    model: () => ({ type: 'cube', textures: { all: { texture: blockTextures.stone } } }),
    lightEmission: [0, 0, 15],
});

const stoneKey = blocks.stone.defaultKey();
const emitterKeys = [RedEmitter.defaultKey(), GreenEmitter.defaultKey(), BlueEmitter.defaultKey()];

const LightingTrait = trait('lighting', {
    /** ticks between emitter swaps */
    emitterInterval: 6,
    /** ticks between ceiling-block toggles */
    ceilingInterval: 12,
    /** interior X/Z extent (box is 2*half+1 wide) */
    half: 16,
    /** interior height (block columns) */
    height: 30,
});

control(LightingTrait, 'emitterInterval', {
    label: 'Emitter swap interval (ticks)',
    schema: prop.number(),
    get: (t) => t.emitterInterval,
    set: (t, v) => {
        t.emitterInterval = Math.max(1, Math.floor(v));
    },
});

control(LightingTrait, 'ceilingInterval', {
    label: 'Ceiling toggle interval (ticks)',
    schema: prop.number(),
    get: (t) => t.ceilingInterval,
    set: (t, v) => {
        t.ceilingInterval = Math.max(1, Math.floor(v));
    },
});

script(LightingTrait, 'cycle', (ctx) => {
    if (!env.server) return;

    const voxels = ctx.voxels;

    // Interior dimensions, resolved at onInit so editor changes apply on the next room start.
    let half = ctx.trait.half;
    let height = ctx.trait.height;
    const floorY = 0;
    let ceilingY = floorY + 1 + height;

    // Emitter cycle: a fixed grid of "lamp slots" inside the room. Each tick
    // step toggles the slot at the cursor, placing a colored emitter and
    // clearing it back to air on the second visit. r/g/b cycle by index.
    const emitterSlots: Array<[number, number, number]> = [];
    let emitterCursor = 0;
    let emitterTick = 0;

    // Ceiling cycle: every slot in the ceiling, toggled in and out to let sky in.
    const ceilingSlots: Array<[number, number, number]> = [];
    let ceilingCursor = 0;
    let ceilingTick = 0;

    const buildBox = () => {
        const min = -half;
        const max = half;
        // floor + ceiling (full slabs)
        for (let x = min; x <= max; x++) {
            for (let z = min; z <= max; z++) {
                setBlock(voxels, x, floorY, z, stoneKey);
                setBlock(voxels, x, ceilingY, z, stoneKey);
            }
        }
        // 4 walls
        for (let y = floorY + 1; y < ceilingY; y++) {
            for (let i = min; i <= max; i++) {
                setBlock(voxels, i, y, min, stoneKey);
                setBlock(voxels, i, y, max, stoneKey);
                setBlock(voxels, min, y, i, stoneKey);
                setBlock(voxels, max, y, i, stoneKey);
            }
        }

        // emitter slots: every 4 blocks across the floor, one block above floor
        emitterSlots.length = 0;
        for (let x = min + 2; x < max; x += 4) {
            for (let z = min + 2; z < max; z += 4) {
                emitterSlots.push([x, floorY + 1, z]);
            }
        }

        // ceiling slots: every interior column
        ceilingSlots.length = 0;
        for (let x = min + 1; x < max; x++) {
            for (let z = min + 1; z < max; z++) {
                ceilingSlots.push([x, ceilingY, z]);
            }
        }
    };

    onInit(ctx, () => {
        half = ctx.trait.half;
        height = ctx.trait.height;
        ceilingY = floorY + 1 + height;
        buildBox();
    });

    onTick(ctx, () => {
        if (emitterSlots.length === 0 || ceilingSlots.length === 0) return;

        emitterTick++;
        if (emitterTick >= ctx.trait.emitterInterval) {
            emitterTick = 0;
            const [x, y, z] = emitterSlots[emitterCursor]!;
            const current = getBlock(voxels, x, y, z);
            if (current === BLOCK_AIR) {
                const color = emitterKeys[emitterCursor % emitterKeys.length]!;
                setBlock(voxels, x, y, z, color);
            } else {
                setBlock(voxels, x, y, z, BLOCK_AIR);
            }
            emitterCursor = (emitterCursor + 1) % emitterSlots.length;
        }

        ceilingTick++;
        if (ceilingTick >= ctx.trait.ceilingInterval) {
            ceilingTick = 0;
            const [x, y, z] = ceilingSlots[ceilingCursor]!;
            const current = getBlock(voxels, x, y, z);
            if (current === stoneKey) {
                setBlock(voxels, x, y, z, BLOCK_AIR);
            } else {
                setBlock(voxels, x, y, z, stoneKey);
            }
            ceilingCursor = (ceilingCursor + 1) % ceilingSlots.length;
        }
    });
});

const GameplayTrait = trait('gameplay');

script(GameplayTrait, 'session', (ctx) => {
    if (!env.server) return;

    onJoin(ctx, ({ playerNode }) => {
        const transform = getTrait(playerNode, TransformTrait)!;
        setPosition(transform, [0, 5, 0]);
    });
});
