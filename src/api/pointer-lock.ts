/**
 * Pointer lock (desktop mouse-look) as a derived value, not something scripts
 * grab and release. A room declares intent with `setPointerLock`; the engine
 * reconciles the actual DOM lock each frame (releasing) and on the next user
 * click (acquiring). Read the live truth with `isPointerLocked`, and free the
 * cursor for a UI panel with `releasePointer`.
 *
 * All three are safe to call on the server (no-op / false) so call sites need no
 * env guard.
 */

import { addLockRelease, reconcilePointerLock, removeLockRelease, tryAcquirePointerLock } from '../client/input';
import { env } from './env';
import type { ScriptContext } from './scripts';

/**
 * Declare whether this room wants the pointer locked for mouse-look. Persistent
 * room intent (unlike the web's one-shot `element.requestPointerLock()`). Setting
 * `true` attempts to lock right away *if* called during a user gesture (e.g. a
 * held mouse button); otherwise the lock is acquired on the next desktop click.
 * Locking never happens on touch. The player controller sets this `true` in
 * `onInit`; fly/orbit set it `false`; a top-down game opts out with `false`.
 */
export function setPointerLock(ctx: ScriptContext, wanted: boolean): void {
    if (!env.client) return;
    const input = ctx.client?.input;
    if (input) {
        input._lockWanted = wanted;
        // mark intent as declared: from here its `_lockWanted` is authoritative,
        // so a room swap into it reconciles immediately instead of holding the
        // lock waiting for a still-pending controller (see reconcilePointerLock).
        input._lockDeclared = true;
    }
    const manager = ctx.client?.state?.inputManager;
    if (!manager) return;
    if (wanted) tryAcquirePointerLock(manager);
    else reconcilePointerLock(manager);
}

/**
 * Is the pointer locked right now? Use to gate custom look/aim code AND gameplay
 * actions (fire, interact): because acquisition is async, the click that grabs
 * the lock still reads `false` here, so it's naturally swallowed and the next
 * click acts. Always `false` on touch and while any UI is holding the cursor free.
 */
export function isPointerLocked(_ctx: ScriptContext): boolean {
    if (!env.client) return false;
    return !!document.pointerLockElement;
}

/**
 * Free the cursor while an in-game panel is open (shop, settings, inventory).
 * Stacks, so nested panels are fine. Does NOT freeze gameplay input — pair with
 * `controls.enabled = false` if you also want movement to stop.
 *
 * `restore()` re-locks *synchronously*, so call it from the panel's close handler
 * (a real user gesture) for a seamless re-lock; closing without a gesture (timer,
 * network) falls back to re-locking on the next canvas click. Returns a no-op
 * handle on the server.
 */
export function releasePointer(ctx: ScriptContext): { restore(): void } {
    const manager = env.client ? ctx.client?.state?.inputManager : undefined;
    if (!manager) return { restore() {} };
    // a stable id per call so nested/overlapping panels don't clobber each other.
    const id = `release:${++releaseSeq}`;
    addLockRelease(manager, id);
    return {
        restore() {
            removeLockRelease(manager, id);
        },
    };
}

let releaseSeq = 0;
