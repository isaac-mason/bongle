// Typechecked snippets for The programming model — queries.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { Ancestor, getWorldPosition, Not, Optional, onTick, query, system, TransformTrait, trait, Up } from 'bongle';

const EnemyTrait = trait('enemy', { hp: 100 });
const DeadTrait = trait('dead', {});
const ShieldTrait = trait('shield', { hp: 50 });
const TeamTrait = trait('team', { colour: 'red' });
const SquadTrait = trait('squad', { name: 'alpha' });

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

/* SNIPPET_START: conditions */
system('nearby-enemies', (ctx) => {
    // a bare handle means With(). the rest are explicit terms.
    const targets = query(ctx, [
        EnemyTrait, // must have it, yields the instance
        Not(DeadTrait), // must NOT have it, yields nothing
        Optional(ShieldTrait), // may have it, yields the instance or null
        Up(TeamTrait), // nearest TeamTrait on this node or above
        Optional(Ancestor(SquadTrait)), // strictly above, and allowed to be absent
    ]);

    onTick(ctx, () => {
        for (const [enemy, shield, team, squad] of targets) {
            //          ^ EnemyTrait
            //                 ^ ShieldTrait | null
            //                         ^ TeamTrait
            //                               ^ SquadTrait | null
            console.log(enemy.hp, shield?.hp ?? 0, team.colour, squad?.name);
        }
    });
});
/* SNIPPET_END: conditions */
