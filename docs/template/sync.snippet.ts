// Typechecked snippets for Multiplayer — sync rate and authority.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { pack, rate, sync, trait } from 'bongle';

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

// `aimX` is written by the node's owning client (authority: 'owner') and capped to
// 20 sends/sec; byte-diff (the default) keeps it off the wire while the value holds.
sync(PlayerStateTrait, 'aimX', {
    schema: pack.float32(),
    pack: (t) => t.aimX,
    unpack: (value, t) => {
        t.aimX = value;
    },
    authority: 'owner',
    rate: rate.hz(20),
});
/* SNIPPET_END: sync */
