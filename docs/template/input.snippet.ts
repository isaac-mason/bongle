// Typechecked snippets for Players & input.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import { createTouchButton, isKeyDown, isTouchButtonDown, isTouchPrimary, onDispose, onInput, system } from 'bongle';

/* SNIPPET_START: read-input */
// onInput runs first each frame, so read input and set intent here
system('read-input', (ctx) => {
    onInput(ctx, () => {
        if (!ctx.client) return;
        const mouseKeyboard = ctx.client.input.mouseKeyboard;
        const forward = isKeyDown(mouseKeyboard, 'KeyW');
        const back = isKeyDown(mouseKeyboard, 'KeyS');
        if (forward !== back) {
            // drive movement, aim a weapon, etc.
        }
    });
});
/* SNIPPET_END: read-input */

/* SNIPPET_START: touch */
// a PlayerControllerTrait already auto-mounts a move joystick and jump button on
// touch devices. mount game-specific controls yourself, gated on isTouchPrimary so
// tablets and touch laptops get them too, not just small phone screens.
system('touch-controls', (ctx) => {
    if (!ctx.client || !isTouchPrimary(ctx)) return;

    // createTouchButton mounts under the room's touch overlay and returns a
    // disposer (it no-ops and returns null on the server).
    const fireButton = createTouchButton(ctx, {
        id: 'fire',
        right: 24,
        bottom: 24,
        width: 96,
        height: 96,
        label: 'Fire',
        look: true, // dragging the button also rotates the camera, so it doubles as an aim surface
    });

    onInput(ctx, () => {
        const touch = ctx.client?.input.touch;
        if (touch && isTouchButtonDown(touch, 'fire')) {
            // set fire intent for this frame
        }
    });

    onDispose(ctx, () => fireButton?.dispose());
});
/* SNIPPET_END: touch */
