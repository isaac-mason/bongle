// Typechecked snippets for Avatars.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import {
    addChild,
    addTrait,
    assignAvatar,
    CharacterTrait,
    createNode,
    env,
    loadAvatar,
    onInit,
    randomDisplayName,
    sampleAvatars,
    system,
    TransformTrait,
} from 'bongle';

/* SNIPPET_START: spawn-npc */
// spawn an NPC and give it a platform avatar. server-only.
system('spawn-npc', (ctx) => {
    if (!env.server) return;

    async function spawnNpc() {
        const avatars = await sampleAvatars(ctx);
        if (avatars.length === 0) return; // none available; fall back to a default

        const npc = createNode({ name: randomDisplayName() });
        addTrait(npc, TransformTrait);
        addTrait(npc, CharacterTrait);
        addChild(ctx.node, npc);

        // load, then point the node's CharacterTrait at the model
        const { modelId, rigType } = loadAvatar(ctx, avatars[0]!);
        assignAvatar(npc, modelId, rigType);
    }

    onInit(ctx, () => {
        void spawnNpc();
    });
});
/* SNIPPET_END: spawn-npc */
