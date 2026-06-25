/**
 * On-screen mobile controls — joystick + button helpers that mount a
 * DOM widget on the room's `touchOverlay` and write into the room's
 * `TouchInput` state. Pair with `getJoystick(t, id)` /
 * `isTouchButtonDown(t, id)` for read-side polling.
 *
 * Both factories early-return `null` on the server so call sites can
 * write `createJoystick(ctx, ...)` unconditionally.
 */

import {
    type CreateJoystickOpts,
    type CreateTouchButtonOpts,
    createJoystickImpl,
    createTouchButtonImpl,
} from '../client/mobile-controls';
import { env } from './env';
import type { ScriptContext } from './scripts';

export type { CreateJoystickOpts, CreateTouchButtonOpts };

/**
 * Mounts a virtual joystick under the room's touch overlay. Returns a
 * disposer (call from `onDispose`). Returns `null` on the server.
 */
export function createJoystick(ctx: ScriptContext, opts: CreateJoystickOpts): { dispose(): void } | null {
    if (!env.client) return null;
    return createJoystickImpl(ctx, opts);
}

/**
 * Mounts a virtual touch button under the room's touch overlay. Returns
 * a disposer (call from `onDispose`). Returns `null` on the server.
 */
export function createTouchButton(ctx: ScriptContext, opts: CreateTouchButtonOpts): { dispose(): void } | null {
    if (!env.client) return null;
    return createTouchButtonImpl(ctx, opts);
}
