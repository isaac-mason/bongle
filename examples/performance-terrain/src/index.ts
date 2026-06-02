import {
    addTrait,
    env,
    getTrait,
    matchmaking,
    onInit,
    onJoin,
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

// ── terrain ─────────────────────────────────────────────────────────

const TerrainTrait = trait('terrain');

script(TerrainTrait, 'generate', (ctx) => {
    if (!env.server) return;

    const voxels = ctx.voxels;

    const SIZE = 200;

    onInit(ctx, () => {
        for (let x = -SIZE; x <= SIZE; x++) {
            for (let z = -SIZE; z <= SIZE; z++) {
                const h0 = Math.sin(x * 0.05) * Math.cos(z * 0.07) * 4;
                const h1 = Math.sin(x * 0.13 + 1.7) * Math.sin(z * 0.11 + 0.9) * 2;
                const h = Math.floor(5 + h0 + h1);

                for (let y = -10; y < h; y++) {
                    setBlock(voxels, x, y, z, stoneKey);
                }
            }
        }
    });
});

// ── gameplay ───────────────────────────────────────────────────────

const GameplayTrait = trait('gameplay');

script(
    GameplayTrait,
    'session',
    (ctx) => {
        if (!env.server) return;

        onJoin(ctx, ({ playerNode }) => {
            const transform = getTrait(playerNode, TransformTrait)!;
            setPosition(transform, [5, 20, 5]);

            addTrait(playerNode, CharacterControllerTrait);

            addTrait(playerNode, CharacterTrait);
            addTrait(playerNode, PlayerControllerTrait);
        });
    },
    { editor: true },
);
