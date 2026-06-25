/**
 * Script-facing audio playback API.
 *
 * Three play primitives — mono (non-positional), at (fixed world pos),
 * onNode (follows a node). Same surface covers atlas-backed and
 * `long: true` sounds; the runtime owns the transport choice via
 * `audio-manifest.json`.
 *
 * Server-safe: every entrypoint returns `null` when `ctx.client?.room` is
 * unset (server side or pre-room state). Scripts that ship under both
 * realms can call these unconditionally without an env.client gate.
 *
 * Implementation forwards into the per-room `Audio` coordinator
 * (`client/audio/audio.ts`). PlaybackHandle is the only thing the
 * script holds onto — `setVolume`/`setDetune`/`stop` are imperative
 * mutators on the active source's gain/panner/buffer chain.
 *
 * Per `feedback_no_callbacks_on_primitives`, there are no callbacks on
 * these primitives — auto-stop when a node-bound source's node is
 * removed lives in the runtime's per-frame reaper, not in trait
 * callbacks. Reactive lifecycle (lifetime-tie-to-node, fade-on-room-exit,
 * …) belongs in a trait layer if/when we add one.
 */

import type { Node } from '../core/scene/nodes';
import type { ScriptContext } from '../core/scene/scripts';
import type { SoundHandle } from '../core/sounds/sounds';
import * as Audio from '../client/audio/audio';

export type PlaybackHandle = Audio.PlaybackHandle;
export type PlayOpts = Audio.PlayOpts;
export type SpatialOpts = Audio.SpatialOpts;
export type Falloff = Audio.Falloff;

/** non-positional play — output goes straight to the room's master gain.
 *  use for UI sounds, music, and anything else that shouldn't pan. */
export function playMono(ctx: ScriptContext, sound: SoundHandle, opts?: PlayOpts): PlaybackHandle | null {
    const room = ctx.client?.room;
    if (!room) return null;
    return Audio.playMono(room.audio, sound.soundId, opts);
}

/** play at a fixed world-space position. position is sampled once at
 *  call time — for moving sources use `playOnNode` instead. */
export function playAt(
    ctx: ScriptContext,
    sound: SoundHandle,
    pos: readonly [number, number, number],
    opts?: SpatialOpts,
): PlaybackHandle | null {
    const room = ctx.client?.room;
    if (!room) return null;
    return Audio.playAt(room.audio, sound.soundId, pos, opts);
}

/** play following a scene node — panner position refreshes every frame
 *  from the node's interpolated world transform. cancels automatically
 *  when the node is removed from the scene graph. */
export function playOnNode(ctx: ScriptContext, sound: SoundHandle, node: Node, opts?: SpatialOpts): PlaybackHandle | null {
    const room = ctx.client?.room;
    if (!room) return null;
    return Audio.playOnNode(room.audio, sound.soundId, node, opts);
}
