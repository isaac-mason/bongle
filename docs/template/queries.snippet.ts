// Typechecked snippets for The programming model — queries.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { getWorldPosition, onTick, query, system, TransformTrait, trait } from 'bongle';

const EnemyTrait = trait('enemy', { hp: 100 });

/* SNIPPET_START: query */
system('enemies', (ctx) => {
    // create the live query once; it stays in sync as nodes match and unmatch
    const enemies = query(ctx, [EnemyTrait, TransformTrait]);

    onTick(ctx, () => {
        // each match is a tuple of the requested trait instances
        for (const [enemy, transform] of enemies) {
            if (enemy.hp <= 0) continue;
            const pos = getWorldPosition(transform);
            console.log(enemy.hp, pos);
        }
    });
});
/* SNIPPET_END: query */
