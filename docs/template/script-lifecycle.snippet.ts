// Typechecked snippets for The programming model — script lifecycle hooks.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { log, onDispose, onFrame, onInit, onInput, onJoin, onLeave, onTick, onUpdate, script, WorldTrait } from 'bongle';

/* SNIPPET_START: lifecycle */
// every lifecycle hook a script can register, with the args each hands you.
script(WorldTrait, 'hooks', (ctx) => {
    // once, when the script attaches to a node (and again on every hot reload).
    onInit(ctx, () => log(ctx, 'init'));

    // every fixed-timestep tick (60 Hz), on both server and client. gameplay
    // simulation lives here. delta: seconds since the previous tick.
    onTick(ctx, ({ delta }) => log(ctx, 'tick', delta));

    // first thing each frame, ahead of onUpdate and onTick. client only.
    // read input and set intent here. delta: seconds since the previous frame.
    onInput(ctx, ({ delta }) => log(ctx, 'input', delta));

    // once per frame, before that frame's ticks. client only. rarely needed
    // (prefer onInput for input). delta: seconds since the previous frame.
    onUpdate(ctx, ({ delta }) => log(ctx, 'update', delta));

    // once per frame, after the ticks and interpolation. client only. use for
    // camera work and reading final visual positions. delta: as above.
    onFrame(ctx, ({ delta }) => log(ctx, 'frame', delta));

    // a client joined the room. server only. client: the joiner's id;
    // playerNode: their spawned player node (args also carry user, joinData).
    onJoin(ctx, ({ client, playerNode }) => log(ctx, 'join', client, playerNode.id));

    // a client left the room. server only.
    onLeave(ctx, ({ client, playerNode }) => log(ctx, 'leave', client, playerNode.id));

    // the script is being torn down: node removal or hot reload. release here
    // anything the script set up (timers, mounted DOM, loaded assets).
    onDispose(ctx, () => log(ctx, 'dispose'));
});
/* SNIPPET_END: lifecycle */
