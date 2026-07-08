import type { JsonValue } from 'bongle/interface';
import { WorldTrait } from '../builtins/world';
import {
    EDITOR_JOIN_KEY,
    type EditorPlayData,
    type ScriptDef,
    type ScriptFactory,
    type ScriptOptions,
    script,
} from '../core/scene/scripts';
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
export type { QueryMatch, QueryMatches } from '../core/scene/scene-tree';
export type {
    ClientContext,
    EditorPlayData,
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

/**
 * read the editor viewpoint from join data, if this session was launched via
 * the editor "play" button. returns `null` for normal joins (the key is
 * absent), so a game can fall back to its usual spawn. games use this to offer
 * "play from here" during development.
 */
export function editorPlayData(joinData: Record<string, JsonValue>): EditorPlayData | null {
    const raw = joinData[EDITOR_JOIN_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const d = raw as Record<string, JsonValue>;
    if (!Array.isArray(d.position) || d.position.length < 3) return null;
    if (!Array.isArray(d.quaternion) || d.quaternion.length < 4) return null;
    return {
        position: [Number(d.position[0]), Number(d.position[1]), Number(d.position[2])],
        quaternion: [Number(d.quaternion[0]), Number(d.quaternion[1]), Number(d.quaternion[2]), Number(d.quaternion[3])],
    };
}
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
