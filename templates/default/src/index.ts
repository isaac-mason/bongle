import {
    addTrait,
    CharacterControllerTrait,
    CharacterTrait,
    env,
    getTrait,
    matchmaking,
    onInit,
    onJoin,
    PlayerControllerTrait,
    script,
    setBlock,
    setPosition,
    trait,
    TransformTrait,
    use,
} from 'bongle';
import { blocks } from 'bongle/starter';

use(blocks);

matchmaking({ maxPlayers: 4 });

const GameplayTrait = trait('gameplay');

script(GameplayTrait, 'session', (ctx) => {
    if (!env.server) return;

    onInit(ctx, () => {
        const size = 8;
        for (let x = -size; x <= size; x++) {
            for (let z = -size; z <= size; z++) {
                setBlock(ctx.voxels, x, 0, z, blocks.grass.defaultKey());
            }
        }
    });

    onJoin(ctx, ({ playerNode }) => {
        const transform = getTrait(playerNode, TransformTrait)!;
        setPosition(transform, [0, 4, 0]);

        addTrait(playerNode, CharacterControllerTrait);
        addTrait(playerNode, CharacterTrait);
        addTrait(playerNode, PlayerControllerTrait);
    });
});
