import * as Audio from '../client/audio/audio';
import type { Node } from '../core/scene/scene-tree';
import type { ScriptContext } from '../core/scene/scripts';
import type { SoundHandle } from '../core/sounds/sounds';

export type PlaybackHandle = Audio.PlaybackHandle;
export type PlayOpts = Audio.PlayOpts;
export type SpatialOpts = Audio.SpatialOpts;
export type Falloff = Audio.Falloff;

/** non-positional play, output goes straight to the room's master gain.
 *  use for UI sounds, music, and anything else that shouldn't pan. */
export function playMono(ctx: ScriptContext, sound: SoundHandle, opts?: PlayOpts): PlaybackHandle | null {
    const room = ctx.client?.room;
    if (!room) return null;
    return Audio.playMono(room.audio, sound.def.soundId, opts);
}

/** play at a fixed world-space position. position is sampled once at
 *  call time, for moving sources use `playOnNode` instead. */
export function playAt(
    ctx: ScriptContext,
    sound: SoundHandle,
    pos: readonly [number, number, number],
    opts?: SpatialOpts,
): PlaybackHandle | null {
    const room = ctx.client?.room;
    if (!room) return null;
    return Audio.playAt(room.audio, sound.def.soundId, pos, opts);
}

/** play following a scene node, panner position refreshes every frame
 *  from the node's interpolated world transform. cancels automatically
 *  when the node is removed from the scene graph. */
export function playOnNode(ctx: ScriptContext, sound: SoundHandle, node: Node, opts?: SpatialOpts): PlaybackHandle | null {
    const room = ctx.client?.room;
    if (!room) return null;
    return Audio.playOnNode(room.audio, sound.def.soundId, node, opts);
}
