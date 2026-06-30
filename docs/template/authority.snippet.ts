// Typechecked snippets for Multiplayer — mixing authority on one entity.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { addChild, addTrait, createNode, env, onJoin, pack, script, sync, trait, WorldTrait } from 'bongle';

/* SNIPPET_START: mixed-authority */
const InventoryTrait = trait('inventory', { coins: 0 });

// `coins` replicates from the server: authority defaults to 'server', so clients
// see it but cannot write it, even on a node their own player owns.
sync(InventoryTrait, 'coins', {
    schema: pack.uint32(),
    pack: (t) => t.coins,
    unpack: (value, t) => {
        t.coins = value;
    },
});

script(WorldTrait, 'inventories', (ctx) => {
    if (!env.server) return;

    onJoin(ctx, ({ playerNode }) => {
        // the player node is owned by its client, which drives its movement. attach a
        // server-owned child for state the server must control: a node you create has
        // no owner, so the server is authoritative over everything on it.
        const inventory = createNode({ name: 'inventory' });
        addTrait(inventory, InventoryTrait);
        addChild(playerNode, inventory);
    });
});
/* SNIPPET_END: mixed-authority */
