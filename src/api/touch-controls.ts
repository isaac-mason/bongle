/**
 * On-screen mobile controls, joystick + button helpers that mount a
 * DOM widget on the room's `touchOverlay` and write into the room's
 * `TouchInput` state. Pair with `getJoystick(t, id)` /
 * `isTouchButtonDown(t, id)` for read-side polling.
 *
 * Both factories early-return `null` on the server so call sites can
 * write `createTouchJoystick(ctx, ...)` unconditionally.
 */

import {
    type CreateTouchButtonOpts,
    type CreateTouchJoystickOpts,
    createTouchButtonImpl,
    createTouchJoystickImpl,
} from '../client/touch-controls';
import { env } from '../env';
import type { ScriptContext } from './scripts';

export type { CreateTouchJoystickOpts, CreateTouchButtonOpts };

/**
 * Mounts a virtual joystick under the room's touch overlay. Returns a
 * disposer (call from `onDispose`). Returns `null` on the server.
 */
export function createTouchJoystick(ctx: ScriptContext, opts: CreateTouchJoystickOpts): { dispose(): void } | null {
    if (!env.client) return null;
    return createTouchJoystickImpl(ctx, opts);
}

/**
 * Mounts a virtual touch button under the room's touch overlay. Returns
 * a disposer (call from `onDispose`). Returns `null` on the server.
 */
export function createTouchButton(ctx: ScriptContext, opts: CreateTouchButtonOpts): { dispose(): void } | null {
    if (!env.client) return null;
    return createTouchButtonImpl(ctx, opts);
}
