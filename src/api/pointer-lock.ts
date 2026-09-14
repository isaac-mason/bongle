import { addLockRelease, reconcilePointerLock, removeLockRelease, tryAcquirePointerLock } from '../client/input';
import { env } from '../env';
import type { ScriptContext } from './scripts';

/**
 * Declare whether this room wants the pointer locked for mouse-look. Persistent
 * intent, unlike the web's one-shot `element.requestPointerLock()`. Setting `true`
 * locks immediately if called during a user gesture, otherwise on the next
 * desktop click. Never locks on touch.
 */
export function setPointerLock(ctx: ScriptContext, wanted: boolean): void {
    if (!env.client) return;
    const input = ctx.client?.input;
    if (input) {
        input._lockWanted = wanted;
        // once declared, `_lockWanted` is authoritative so a room swap reconciles
        // immediately instead of waiting on a still-pending controller
        input._lockDeclared = true;
    }
    const manager = ctx.client?.state?.inputManager;
    if (!manager) return;
    if (wanted) tryAcquirePointerLock(manager);
    else reconcilePointerLock(manager);
}

/**
 * Is the pointer locked right now? Acquisition is async, so the click that
 * grabs the lock still reads `false`, naturally swallowing that click. Always
 * `false` on touch and while any UI holds the cursor free.
 */
export function isPointerLocked(_ctx: ScriptContext): boolean {
    if (!env.client) return false;
    return !!document.pointerLockElement;
}

/**
 * Free the cursor while an in-game panel is open. Stacks, so nested panels
 * are fine. Does not freeze gameplay input, pair with `controls.enabled =
 * false` if movement should also stop.
 *
 * `restore()` re-locks synchronously; call it from the panel's close handler
 * for a seamless re-lock, or it falls back to re-locking on the next click.
 */
export function releasePointer(ctx: ScriptContext): { restore(): void } {
    const manager = env.client ? ctx.client?.state?.inputManager : undefined;
    if (!manager) return { restore() {} };
    const id = `release:${++releaseSeq}`;
    addLockRelease(manager, id);
    return {
        restore() {
            removeLockRelease(manager, id);
        },
    };
}

let releaseSeq = 0;
