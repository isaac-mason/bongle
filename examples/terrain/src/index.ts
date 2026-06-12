import {
    Animation,
    AnimatorTrait,
    addChild,
    addTrait,
    BLOCK_AIR,
    block,
    blockTexture,
    CullType,
    cloneModel,
    cloneNode,
    copyVoxels,
    createNode,
    createVoxelModel,
    createVoxels,
    env,
    getTrait,
    MaterialType,
    matchmaking,
    model,
    onFrame,
    onInit,
    onJoin,
    onTick,
    prefab,
    scene,
    script,
    setBlock,
    setEnvironment,
    setPosition,
    setQuaternion,
    setEnvironmentTime,
    TransformTrait,
    trait,
    VoxelMeshTrait,
    ENVIRONMENT_OVERWORLD,
} from 'bongle';
import { blocks, models } from 'bongle/starter';
import { quat } from 'mathcat';

// ── matchmaking ─────────────────────────────────────────────────────

matchmaking({ maxPlayers: 4 });

// ── models --────────────────────────────────────────────────────────

const TestModel = model('testmodel', { src: 'assets/models/test.gltf' });

const PenguinModel = models.peng;

// play 'waddle' on every penguin instance in play mode. attached to the
// cloned model root, which is the rig parent — animator walks descendants
// and binds by node name.
const PenguinWaddleTrait = trait('penguin-waddle', {}, { persist: false });

script(PenguinWaddleTrait, 'waddle', (ctx) => {
    onInit(ctx, () => {
        const animator = getTrait(ctx.node, AnimatorTrait);
        if (!animator) return;
        const action = Animation.clip(animator, PenguinModel.animations.waddle);
        Animation.play(action);
    });
});

const PenguinModelPrefab = prefab('penguin_model', {
    type: 'nodes',
    deps: [PenguinModel],
    fn: (ctx) => {
        const rig = cloneModel(PenguinModel.scene);
        addChild(ctx.root, rig);
        addTrait(rig, AnimatorTrait);
        addTrait(rig, PenguinWaddleTrait);
    },
});

// ── scenes ──────────────────────────────────────────────────────────

const PenguinScene = scene('penguin');
const HouseScene = scene('house');

// ── prefabs ─────────────────────────────────────────────────────────

const PenguinPrefab = prefab('penguin', {
    type: 'nodes',
    deps: [PenguinScene],
    fn: (ctx) => {
        for (const child of PenguinScene.node.children) {
            addChild(ctx.root, cloneNode(child));
        }
    },
});

const HousePrefab = prefab('house', {
    type: 'voxels',
    deps: [HouseScene],
    fn: (ctx) => {
        copyVoxels(ctx.voxels, HouseScene.voxels!);
    },
});

// const LevelTrait = trait('level', {
//     level: field(0, { sync: pack.uint8(), prop: prop.number() }),
// });

// const TemplatedPenguinPrefab = prefab('conditional_penguin', {
//     scene: 'penguin',
//     template: {
//         args: prop.object({
//             level: prop.number(),
//         }),
//         apply: (ctx, { level }) => {},
//     },
// });

// ── blocks ──────────────────────────────────────────────────────────
// Stone/Dirt/Grass/Stairs/Flower/Leaves come from bongle/starter. The
// cube-block Lava + Water variants and the four lamps are example-
// specific (non-collidable cubes / unique animated textures / per-channel
// light emission) and stay declared locally.

const Stone = blocks.stone;
const Dirt = blocks.dirt;
const Grass = blocks.grass;
const StoneStairs = blocks.stoneStairs;
const Flower = blocks.mushroomRed;
const OakLeaves = blocks.oakLeaves;

// animated texture demos — cycling through different existing pngs to
// exercise the multi-frame pipeline end-to-end. semantically nonsense
// but visually proves animation works.
const LavaTex = blockTexture('lava', {
    src: [
        'assets/textures/stone_coal.png',
        'assets/textures/stone_iron.png',
        'assets/textures/stone_gold.png',
        'assets/textures/stone_diamond.png',
        'assets/textures/redstone.png',
        'assets/textures/lava.png',
    ],
    fps: 4,
});
const WaterTex = blockTexture('water', {
    src: ['assets/textures/water_1.png', 'assets/textures/water_2.png'],
    fps: 1.5,
    interpolate: true,
});

const Lava = block('lava', {
    model: () => ({ type: 'cube', textures: { all: { texture: LavaTex } } }),
    collision: false,
});

const Water = block('water', {
    model: () => ({ type: 'cube', textures: { all: { texture: WaterTex } } }),
    cull: CullType.SELF,
    material: MaterialType.TRANSLUCENT,
    collision: false,
});

// ── light-emitting blocks ───────────────────────────────────────────

const Glowstone = block('glowstone', {
    model: () => ({ type: 'cube', textures: { all: { texture: WaterTex } } }),
    lightEmission: [15, 12, 8],
    emissive: true,
});

const RedLamp = block('red_lamp', {
    model: () => ({ type: 'cube', textures: { all: { texture: WaterTex } } }),
    lightEmission: [15, 2, 0],
    emissive: true,
});

const BlueLamp = block('blue_lamp', {
    model: () => ({ type: 'cube', textures: { all: { texture: WaterTex } } }),
    lightEmission: [0, 2, 15],
    emissive: true,
});

const GreenLamp = block('green_lamp', {
    model: () => ({ type: 'cube', textures: { all: { texture: WaterTex } } }),
    lightEmission: [2, 15, 2],
    emissive: true,
});

// ── voxel terrain (server-authoritative) ────────────────────────────

// light toggle box constants
const showcaseX = 2;
const showcaseZ = 2;
const boxX = showcaseX + 14;
const boxZ = showcaseZ + 1;
const boxY = 10;
const boxW = 5;
const boxD = 5;
const boxH = 4;
const ceilingY = boxY + boxH;

// pre-compute keys once
const stoneKey = Stone.defaultKey();
const dirtKey = Dirt.defaultKey();
const grassKey = Grass.defaultKey();
const flowerKey = Flower.defaultKey();
const leavesKey = OakLeaves.defaultKey();
const lavaKey = Lava.defaultKey();
const waterKey = Water.defaultKey();
const glowstoneKey = Glowstone.defaultKey();
const redLampKey = RedLamp.defaultKey();
const blueLampKey = BlueLamp.defaultKey();
const greenLampKey = GreenLamp.defaultKey();

const GameplayTrait = trait('gameplay');

script(
    GameplayTrait,
    'session',
    (ctx) => {
        if (env.client) {
            setEnvironmentTime(ctx, 18);
            setEnvironment(ctx, ENVIRONMENT_OVERWORLD);

            onInit(ctx, () => {
                // build a 3x3 grass cube voxel model
                const voxels = createVoxels(ctx.blocks);
                for (let x = 0; x < 3; x++)
                    for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) setBlock(voxels, x, y, z, grassKey);
                const voxelModel = createVoxelModel(voxels);

                // create a client-only node with transform + voxel model trait
                const node = createNode({ name: 'spinning-grass', persist: false });
                const transform = addTrait(node, TransformTrait);
                setPosition(transform, [0, 30, 0]);

                addTrait(node, VoxelMeshTrait, { model: voxelModel });

                // spin
                onFrame(ctx, (args) => {
                    quat.rotateY(transform.quaternion, transform.quaternion, args.delta * 1.5);
                    setQuaternion(transform, transform.quaternion);
                });
            });
        }

        if (!env.server) return;
        if (ctx.mode === 'edit') return;

        let ceilingOn = false;
        let timeSinceToggle = 0;

        onJoin(ctx, ({ client, playerNode }) => {
            console.log('player joined!', client);

            const transform = getTrait(playerNode, TransformTrait)!;
            setPosition(transform, [5, 20, 5]);
        });

        onTick(ctx, (args) => {
            timeSinceToggle += args.delta;
            if (timeSinceToggle < 1.0) return;
            timeSinceToggle -= 1.0;
            ceilingOn = !ceilingOn;
            const newKey = ceilingOn ? stoneKey : BLOCK_AIR;

            for (let dz = 0; dz < boxD; dz++) {
                for (let dx = 0; dx < boxW; dx++) {
                    setBlock(ctx.voxels, boxX + dx, ceilingY, boxZ + dz, newKey);
                }
            }
        });
    },
    { editor: true },
);
