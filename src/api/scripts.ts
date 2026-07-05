import { WorldTrait } from '../builtins/world';
import { type ScriptDef, type ScriptFactory, type ScriptOptions, script } from '../core/scene/scripts';
import type { TraitHandle } from '../core/scene/traits';

type WorldScriptBase = typeof WorldTrait extends TraitHandle<infer B> ? B : never;

/**
 * register a **system**: scene-scoped logic hosted on the always-attached
 * `WorldTrait`, running once per scene per side. sugar for
 * `script(WorldTrait, id, factory, opts)`, and the preferred spelling.
 *
 * use for logic that operates "globally" e.g. via querying entities based on their composition with `query(ctx, [...])`
 *
 * @example
 * ```ts
 * system('character-animation', (ctx) => {
 *     if (!env.client) return;
 *     const q = query(ctx, [CharacterTrait, CharacterControllerTrait, TransformTrait]);
 *     onFrame(ctx, ({ delta }) => {
 *         for (const [ch, cc, transform] of q.matches) {
 *             // …drive bones, read camera, etc.
 *         }
 *     });
 * });
 * ```
 */
export function system(id: string, factory: ScriptFactory<WorldScriptBase>, opts?: ScriptOptions): ScriptDef {
    return script(WorldTrait, id, factory, opts);
}

export type { ClientId } from '../core/client';
export type { QueryMatch, QueryMatches } from '../core/scene/nodes';
export type {
    ClientContext,
    EditRoomState,
    FrameArgs,
    JoinArgs,
    LeaveArgs,
    PhysicsContactArgs,
    ScriptContext,
    ScriptDef,
    TickArgs,
    UpdateArgs,
} from '../core/scene/scripts';
export {
    broadcast,
    filter,
    first,
    isOwner,
    listen,
    onBlockBreak,
    onBlockBuild,
    onBlockStateChange,
    onDispose,
    onEnter,
    onExit,
    onFrame,
    onInit,
    onInput,
    onJoin,
    onLeave,
    onPhysicsBodyPairValidate,
    onPhysicsContact,
    onPostAnimate,
    onPostPhysicsStep,
    onPrePhysicsStep,
    onSwap,
    onTick,
    onUpdate,
    query,
    script,
    send,
} from '../core/scene/scripts';
