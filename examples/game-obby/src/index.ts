import {
    addTrait,
    CharacterControllerTrait,
    ENVIRONMENT_OVERWORLD,
    env,
    getTrait,
    matchmaking,
    onJoin,
    PlayerControllerTrait,
    script,
    setEnvironment,
    setEnvironmentTime,
    setPosition,
    TransformTrait,
    use,
    WorldTrait,
} from 'bongle';
import { blocks } from "bongle/starter";

use(blocks);

matchmaking({ maxPlayers: 32 });

script(WorldTrait, 'environment', (ctx) => {
    setEnvironment(ctx, ENVIRONMENT_OVERWORLD);
    setEnvironmentTime(ctx, 14);
});

script(WorldTrait, 'setup', (ctx) => {
    if (!env.server) return;

    onJoin(ctx, ({ client, playerNode }) => {
        const transform = getTrait(playerNode, TransformTrait)!;
        setPosition(transform, [8.5, 2, 8.5]);

        addTrait(playerNode, CharacterControllerTrait);
        addTrait(playerNode, PlayerControllerTrait);
    });
});
