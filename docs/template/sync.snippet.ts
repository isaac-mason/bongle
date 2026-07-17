// Typechecked snippets for Multiplayer — sync rate and authority.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { dirty, pack, sync, trait } from 'bongle';

const PlayerStateTrait = trait('player-state', { score: 0, aimX: 0 });

/* SNIPPET_START: sync */
// `score` is server-authoritative (the default) and emitted on every change.
sync(PlayerStateTrait, 'score', {
    schema: pack.uint32(),
    pack: (t) => t.score,
    unpack: (value, t) => {
        t.score = value;
    },
});

// `aimX` is written by the node's owning client (authority: 'owner'), and marked
// dirty on a distance threshold so it only re-emits once it has moved 0.1 units.
sync(PlayerStateTrait, 'aimX', {
    schema: pack.float32(),
    pack: (t) => t.aimX,
    unpack: (value, t) => {
        t.aimX = value;
    },
    authority: 'owner',
    dirty: dirty.distance(0.1),
});
/* SNIPPET_END: sync */
