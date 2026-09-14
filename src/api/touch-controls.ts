import {
    type CreateTouchButtonOpts,
    type CreateTouchJoystickOpts,
    createTouchButtonImpl,
    createTouchJoystickImpl,
} from '../client/touch-controls';
import { env } from '../env';
import type { ScriptContext } from './scripts';

export type { CreateTouchButtonOpts, CreateTouchJoystickOpts };

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
