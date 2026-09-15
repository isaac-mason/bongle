import { asset } from '../api/asset';
import { type PlaybackHandle, playAt, playMono } from '../api/audio';
import { sound } from '../core/registry';
import type { ScriptContext } from '../core/scene/scripts';
import { resolveKey } from '../core/voxels/block-registry';
import type { BlockSoundConfig } from '../core/voxels/blocks';
import { BLOCK_AIR } from '../core/voxels/voxels';

/** `footstep` and `dig` belong to the character side (walking, mining); an edit only breaks or places. */
export type EditSoundSlot = 'break' | 'place';

// structural on purpose (matches VoxelOp / the build tool's local Op) so this module imports no edit code.
type EditedCell = { readonly wx: number; readonly wy: number; readonly wz: number; readonly key: string };

/** pitch spread in cents so a run of edits on one material doesn't read as a stuck sample. */
const DETUNE_CENTS = 120;

/** dominant material of 32 evenly-strided cells matches the dominant material of the whole edit, O(32) not O(n). */
const SAMPLE_LIMIT = 32;

/** at the ceiling (~4096 cells) a bulk edit is +30% gain and two semitones down. */
const BULK_GAIN = 0.3;
const BULK_DETUNE_CENTS = 220;
const BULK_CEILING_LOG2 = 12;

// playAt copies the position into its own tuple at call time, so one module-scope scratch stays allocation-free.
const at: [number, number, number] = [0, 0, 0];
const tally = new Map<string, number>();

/** dominant material and centroid of the last sampled edit, refilled by every sampleBulk call. */
const sample = { key: '', slot: 'place' as EditSoundSlot, x: 0, y: 0, z: 0, count: 0 };

/** an edit asks the block state it touched what material it sounds like; plays `slot` at the centre of voxel (wx, wy, wz). */
export function playBlockEdit(ctx: ScriptContext, state: number, slot: EditSoundSlot, wx: number, wy: number, wz: number): void {
    emit(ctx, state, slot, wx + 0.5, wy + 0.5, wz + 0.5, 1, 0);
}

/**
 * plays one clip for a whole bulk edit, at the centroid of the cells it touched. one sound per
 * action, never one per voxel. slot is derived from whether the dominant forward cell is air
 * (break) or not (place), so undo (forward/reverse swapped) lands on the opposite slot by itself.
 */
export function playBulkEdit(ctx: ScriptContext, forward: readonly EditedCell[], reverse: readonly EditedCell[]): void {
    if (!sampleBulk(forward, reverse)) return;
    const size = Math.min(1, Math.log2(sample.count + 1) / BULK_CEILING_LOG2);
    emit(
        ctx,
        resolveKey(ctx.blocks, sample.key),
        sample.slot,
        sample.x,
        sample.y,
        sample.z,
        1 + BULK_GAIN * size,
        -BULK_DETUNE_CENTS * size,
    );
}

/** false when there's nothing to voice: no cells, or air replacing air. forward[i] and reverse[i] are the same cell. */
function sampleBulk(forward: readonly EditedCell[], reverse: readonly EditedCell[]): boolean {
    const count = forward.length;
    if (count === 0) return false;

    const stride = count <= SAMPLE_LIMIT ? 1 : Math.floor(count / SAMPLE_LIMIT);

    tally.clear();
    let key = '';
    let best = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let sampled = 0;
    for (let i = 0; i < count; i += stride) {
        const cell = forward[i]!;
        sx += cell.wx;
        sy += cell.wy;
        sz += cell.wz;
        sampled++;
        const n = (tally.get(cell.key) ?? 0) + 1;
        tally.set(cell.key, n);
        if (n > best) {
            best = n;
            key = cell.key;
        }
    }

    // only the material needs re-sampling, not the centroid.
    let slot: EditSoundSlot = 'place';
    if (key === BLOCK_AIR) {
        if (reverse.length !== count) return false;
        slot = 'break';
        tally.clear();
        key = '';
        best = 0;
        for (let i = 0; i < count; i += stride) {
            const was = reverse[i]!.key;
            if (was === BLOCK_AIR) continue;
            const n = (tally.get(was) ?? 0) + 1;
            tally.set(was, n);
            if (n > best) {
                best = n;
                key = was;
            }
        }
        if (key === '') return false;
    }

    sample.key = key;
    sample.slot = slot;
    sample.x = sx / sampled + 0.5;
    sample.y = sy / sampled + 0.5;
    sample.z = sz / sampled + 0.5;
    sample.count = count;
    return true;
}

/** no-ops for air, for a material that leaves the slot empty, and on the server (playAt returns null there). */
function emit(
    ctx: ScriptContext,
    state: number,
    slot: EditSoundSlot,
    x: number,
    y: number,
    z: number,
    volume: number,
    detune: number,
): void {
    const sounds: BlockSoundConfig | undefined = ctx.blocks.sounds[state];
    const clips = sounds?.[slot];
    if (!clips || clips.length === 0) return;

    at[0] = x;
    at[1] = y;
    at[2] = z;
    playAt(ctx, clips[(Math.random() * clips.length) | 0]!, at, {
        volume,
        detune: detune + (Math.random() * 2 - 1) * DETUNE_CENTS,
    });
}

/** a seamless 7s bed of digging, looped under a continuous elevation stroke. */
export const DiggingSound = sound('editor:digging', {
    name: 'editor digging',
    src: asset('./assets/sounds/editor-digging.ogg', import.meta.url),
});

/** one loop per stroke; its level chases the rate at which the stroke is accumulating blocks. */
export type DiggingLoop = {
    handle: PlaybackHandle | null;
    /** smoothed gain, updated every frame. */
    level: number;
    /** last gain written to the node; a settled level schedules no automation. */
    written: number;
};

export function createDiggingLoop(): DiggingLoop {
    return { handle: null, level: 0, written: 0 };
}

const DIGGING_GAIN_MAX = 0.35;
/** full level at ~1000 blocks/s of accumulation, a large disc at default rate; a size-1 disc sits near 40%. */
const DIGGING_RATE_CEILING_LOG2 = 10;
/** lowering reads a shade deeper than raising; flatten sits between since its columns go both ways. */
const DIGGING_LOWER_DETUNE_CENTS = -300;
const DIGGING_FLATTEN_DETUNE_CENTS = -150;
/** the level swells quickly with the stroke and settles more slowly after it. */
const DIGGING_ATTACK_S = 0.06;
const DIGGING_RELEASE_S = 0.25;
/** brief but clearly audible: the loop shouldn't just cut when the stroke ends. was cranked to
 *  1s while a real bug in Audio.stop() (fixed now, see client/audio/audio.ts) silently cut every
 *  faded stop to ~one frame regardless of this value; back to a properly brief fade now that the
 *  fade actually plays out. */
const DIGGING_STOP_FADE_S = 0.4;
const DIGGING_WRITE_EPSILON = 0.01;

/** mono: the stroke is under the cursor and the listener is right behind it, so a panner has nothing to add. */
export function startDiggingLoop(loop: DiggingLoop, ctx: ScriptContext, mode: 'raise' | 'lower' | 'flatten'): void {
    stopDiggingLoop(loop);
    loop.level = 0;
    loop.written = 0;
    const detune = mode === 'lower' ? DIGGING_LOWER_DETUNE_CENTS : mode === 'flatten' ? DIGGING_FLATTEN_DETUNE_CENTS : 0;
    loop.handle = playMono(ctx, DiggingSound, { loop: true, volume: 0, detune });
}

/** `rate` is fractional blocks per second accumulated this frame across the live columns; 0 settles the bed to silence. */
export function updateDiggingLoop(loop: DiggingLoop, rate: number, dt: number): void {
    if (!loop.handle) return;
    const target = DIGGING_GAIN_MAX * Math.min(1, Math.log2(1 + rate) / DIGGING_RATE_CEILING_LOG2);
    const tau = target > loop.level ? DIGGING_ATTACK_S : DIGGING_RELEASE_S;
    loop.level += (target - loop.level) * Math.min(1, dt / tau);
    if (Math.abs(loop.level - loop.written) < DIGGING_WRITE_EPSILON) return;
    loop.written = loop.level;
    loop.handle.setVolume(loop.level);
}

export function stopDiggingLoop(loop: DiggingLoop): void {
    if (!loop.handle) return;
    loop.handle.stop({ fade: DIGGING_STOP_FADE_S });
    loop.handle = null;
}

// select is the most frequent trigger in the editor, so it's a real mouse-click recording
// (lowered and pitch-varied so repeated clicks in a drag don't read as one stuck sample) rather
// than a textured litupsubway clip; deselect keeps the longer litupsubway clip since it's rare
// enough that a bit more character doesn't read as noise. see NOTICE.txt in ./assets/sounds.

/** "I selected a thing", whatever the thing is: a voxel region from any of the four select tools. */
export const SelectSound = sound('editor:select', {
    name: 'editor select',
    src: asset('./assets/sounds/editor-select.ogg', import.meta.url),
});

export const DeselectSound = sound('editor:deselect', {
    name: 'editor deselect',
    src: asset('./assets/sounds/editor-deselect.ogg', import.meta.url),
});

// mono: selecting happens in the ui, not at a place in the world, so there's nothing for a panner to be right about.
const SELECT_GAIN = 0.16;
const DESELECT_GAIN = 0.14;
/** the raw click recording reads bright; pitched down for a duller, less clacky click. */
const SELECT_BASE_DETUNE_CENTS = -400;
/** wider than deselect's spread: a click retriggers often (a brush-select drag), so it needs to
 *  vary noticeably rather than sound like one stuck sample looping. */
const SELECT_PITCH_VARIANCE_CENTS = 90;
const DESELECT_DETUNE_CENTS = 30;
/** shift-add reuses the select clip a fifth up rather than a third file. */
const ADD_DETUNE_CENTS = 700;
/** an anchor reuses the select clip a fourth down, quieter: the same gesture, not yet finished. */
const ANCHOR_GAIN = 0.11;
const ANCHOR_DETUNE_CENTS = -500;
/** the select clip is short (~0.3s), so a brush-select drag can retrigger it often without mush. */
const SELECT_MIN_GAP_MS = 70;
/** the deselect clip runs ~0.8s (litupsubway), so its floor stays wide. */
const DESELECT_MIN_GAP_MS = 220;

let lastSelectAt = 0;
let lastDeselectAt = 0;

/** `added` is the shift-held merge onto an existing selection, which answers a fifth higher. */
export function playSelected(ctx: ScriptContext, added: boolean): void {
    const now = performance.now();
    if (now - lastSelectAt < SELECT_MIN_GAP_MS) return;
    lastSelectAt = now;

    playMono(ctx, SelectSound, {
        volume: SELECT_GAIN,
        detune: SELECT_BASE_DETUNE_CENTS + (added ? ADD_DETUNE_CENTS : 0) + (Math.random() * 2 - 1) * SELECT_PITCH_VARIANCE_CENTS,
    });
}

/** for an explicit user deselect (`clearSelection`) only, not `clearVoxelSelection`'s post-commit
 *  tidy-up. */
export function playDeselected(ctx: ScriptContext): void {
    const now = performance.now();
    if (now - lastDeselectAt < DESELECT_MIN_GAP_MS) return;
    lastDeselectAt = now;

    playMono(ctx, DeselectSound, {
        volume: DESELECT_GAIN,
        detune: (Math.random() * 2 - 1) * DESELECT_DETUNE_CENTS,
    });
}

/** first click of a two-click box-select. deliberately outside the select rate limit (that floor
 *  tames a brush-select drag; an anchor is always one discrete click). */
export function playAnchored(ctx: ScriptContext): void {
    playMono(ctx, SelectSound, {
        volume: ANCHOR_GAIN,
        detune: SELECT_BASE_DETUNE_CENTS + ANCHOR_DETUNE_CENTS + (Math.random() * 2 - 1) * SELECT_PITCH_VARIANCE_CENTS,
    });
}

/** node-graph edits with no voxel content to sample a material from. each kind has its own real
 *  clip; reparent has none of its own (it's the same node, just filed elsewhere) so it reuses
 *  create's clip at a neutral, undetuned pitch. */
export type StructuralEditKind = 'create' | 'delete' | 'copy' | 'reparent';

export const CreateSound = sound('editor:create', {
    name: 'editor create',
    src: asset('./assets/sounds/editor-create.ogg', import.meta.url),
});

export const DeleteSound = sound('editor:delete', {
    name: 'editor delete',
    src: asset('./assets/sounds/editor-delete.ogg', import.meta.url),
});

export const CopySound = sound('editor:copy', {
    name: 'editor copy',
    src: asset('./assets/sounds/editor-copy.ogg', import.meta.url),
});

const STRUCTURAL_GAIN = 0.15;
const STRUCTURAL_DETUNE_CENTS = 20;

export function playStructuralEdit(ctx: ScriptContext, kind: StructuralEditKind): void {
    const clip = kind === 'delete' ? DeleteSound : kind === 'copy' ? CopySound : CreateSound;
    playMono(ctx, clip, {
        volume: STRUCTURAL_GAIN,
        detune: (Math.random() * 2 - 1) * STRUCTURAL_DETUNE_CENTS,
    });
}

/** paste reuses create's clip quieter and a shade down, the same "gesture started, not yet
 *  finished" trick `playAnchored` uses for box-select: a ghost just appeared under the cursor,
 *  nothing is in the scene until it's clicked down (`playStructuralEdit('create')` then). */
const PASTE_START_GAIN = 0.1;
const PASTE_START_DETUNE_CENTS = -300;

export function playPasteStart(ctx: ScriptContext): void {
    playMono(ctx, CreateSound, {
        volume: PASTE_START_GAIN,
        detune: PASTE_START_DETUNE_CENTS + (Math.random() * 2 - 1) * STRUCTURAL_DETUNE_CENTS,
    });
}
