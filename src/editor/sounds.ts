/**
 * editor edit sfx.
 *
 * every block already declares `break` / `place` / `dig` clip pools per
 * material (`BlockSoundConfig`, filled out by `kit/block-sound-presets`),
 * so an edit doesn't pick a sound, it asks the state it touched what that
 * material sounds like. nothing here knows about stone or glass.
 *
 * positional for free: the room's audio listener falls back to the
 * client's `pov` node, which in the editor is the camera, so `playAt` at
 * the voxel centre puts the sound where the edit landed with no listener
 * wiring of our own.
 *
 * one sound per action, never one per voxel. a 5000-cell fill is a single
 * clip at the centroid, pitched down and pushed a little louder so the
 * edit's size is audible without being 5000 clips.
 */

import { asset } from '../api/asset';
import { playAt, playMono } from '../api/audio';
import { sound } from '../core/registry';
import type { ScriptContext } from '../core/scene/scripts';
import { resolveKey } from '../core/voxels/block-registry';
import type { BlockSoundConfig } from '../core/voxels/blocks';
import { BLOCK_AIR } from '../core/voxels/voxels';

/** the one-shot slots an editor edit fires. `footstep` belongs to the
 *  character trait; `dig` is for the drag-cadence tools (smooth,
 *  elevation, paint), which have no mining progress to loop under. */
export type EditSoundSlot = 'break' | 'place' | 'dig';

/** the cell shape the edit verbs already build: `VoxelOp` in actions.ts,
 *  the build tool's local `Op`. structural on purpose, so this module
 *  imports no edit code and stays a leaf. */
type EditedCell = { readonly wx: number; readonly wy: number; readonly wz: number; readonly key: string };

/** random pitch spread in cents, so a run of edits on one material
 *  doesn't read as a stuck sample. */
const DETUNE_CENTS = 120;

/** cells inspected to characterise a bulk edit. the dominant material of
 *  32 evenly-strided cells matches the dominant material of all of them
 *  for any real pattern, and keeps a huge fill O(32) rather than O(n). */
const SAMPLE_LIMIT = 32;

/** how far a bulk edit's size bends the clip. at the ceiling (~4096 cells)
 *  that's +30% gain and two semitones down, which reads as weight. */
const BULK_GAIN = 0.3;
const BULK_DETUNE_CENTS = 220;
const BULK_CEILING_LOG2 = 12;

// playAt copies the position into its own tuple at call time, so one
// module-scope scratch keeps an edit allocation-free.
const at: [number, number, number] = [0, 0, 0];
// scratch tally for the dominant-material sample, cleared on entry. never
// read outside the call that filled it.
const tally = new Map<string, number>();

/** play `slot` for block `state` at the centre of voxel (wx, wy, wz). */
export function playBlockEdit(ctx: ScriptContext, state: number, slot: EditSoundSlot, wx: number, wy: number, wz: number): void {
    emit(ctx, state, slot, wx + 0.5, wy + 0.5, wz + 0.5, 1, 0);
}

/**
 * play the one clip that stands for a whole bulk edit, at the centroid of
 * the cells it touched.
 *
 * the slot is derived, not passed: an edit whose forward cells are mostly
 * air took a material away, so it breaks (delete, lowering terrain),
 * anything else put a material down, so it places (fill, replace, walls,
 * raising terrain). undo is therefore the same call with the two arrays
 * swapped, and lands on the opposite slot by itself.
 *
 * `forward` and `reverse` are the parallel per-cell arrays every edit verb
 * already builds. no-ops when nothing changed or the edit was air to air.
 */
export function playBulkEdit(ctx: ScriptContext, forward: readonly EditedCell[], reverse: readonly EditedCell[]): void {
    const count = forward.length;
    if (count === 0) return;

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

    // the cells are the same either way (forward[i] and reverse[i] are one
    // cell), so only the material has to be re-sampled, not the centroid.
    let slot: EditSoundSlot = 'place';
    if (key === BLOCK_AIR) {
        if (reverse.length !== count) return;
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
        if (key === '') return; // air replaced by air, nothing left to hear
    }

    const size = Math.min(1, Math.log2(count + 1) / BULK_CEILING_LOG2);
    emit(
        ctx,
        resolveKey(ctx.blocks, key),
        slot,
        sx / sampled + 0.5,
        sy / sampled + 0.5,
        sz / sampled + 0.5,
        1 + BULK_GAIN * size,
        -BULK_DETUNE_CENTS * size,
    );
}

/**
 * fire one clip from `state`'s `slot` pool at an already-centred world
 * position. no-ops for air, for a material that leaves the slot empty, and
 * on the server, where playAt returns null for want of a client room.
 */
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

/* ── selection ─────────────────────────────────────────────────────── */
//
// selecting changes no blocks, so unlike everything above it has no
// material to ask and nothing in the block registry to draw on. these two
// clips are the editor's own, declared here the way any engine builtin
// ships audio (`SoundOptions.src`, the `asset()` form). registration is
// import-driven, so a game that never pulls the editor in never bakes
// them.
//
// the clips in ./assets/sounds are placeholders, see NOTICE.txt there.

/** one tick for "I selected a thing", whatever the thing is: a voxel
 *  region from any of the four select tools, or a scene node. */
export const SelectSound = sound('editor:select', {
    name: 'editor select',
    src: asset('./assets/sounds/editor-select.ogg', import.meta.url),
});

/** and one for letting a selection go. */
export const DeselectSound = sound('editor:deselect', {
    name: 'editor deselect',
    src: asset('./assets/sounds/editor-deselect.ogg', import.meta.url),
});

/** selection sfx are mono: selecting happens in the ui, not at a place in
 *  the world, so there's nothing for a panner to be right about. */
const SELECT_GAIN = 0.5;
const DESELECT_GAIN = 0.45;
/** narrower than the block jitter. these are the same clip every time, so
 *  a wide spread reads as a wobble rather than as variation. */
const SELECT_DETUNE_CENTS = 40;
/** shift-add reuses the select clip a fifth up rather than a third file. */
const ADD_DETUNE_CENTS = 700;
/** and an anchor reuses it a fourth down, quieter: the same gesture, not
 *  yet finished. */
const ANCHOR_GAIN = 0.35;
const ANCHOR_DETUNE_CENTS = -500;
/** floor between selection ticks, ms. box, magic and lasso commit once per
 *  click, but a brush-select drag commits for as long as it's held. */
const SELECT_MIN_GAP_MS = 60;

let lastSelectAt = 0;

/**
 * tick for a selection the user just made. `added` is the shift-held merge
 * onto an existing selection, which answers a fifth higher.
 *
 * rate-limited, so a brush-select drag streams rather than machine-guns.
 */
export function playSelected(ctx: ScriptContext, added: boolean): void {
    const now = performance.now();
    if (now - lastSelectAt < SELECT_MIN_GAP_MS) return;
    lastSelectAt = now;

    playMono(ctx, SelectSound, {
        volume: SELECT_GAIN,
        detune: (added ? ADD_DETUNE_CENTS : 0) + (Math.random() * 2 - 1) * SELECT_DETUNE_CENTS,
    });
}

/**
 * the release half of the pair, for an explicit user deselect only.
 *
 * `clearSelection` is that; `clearVoxelSelection` is NOT, it's the tidy-up
 * fill/replace/delete already run after committing, and would double up on
 * a sound those verbs have just made for themselves.
 */
export function playDeselected(ctx: ScriptContext): void {
    playMono(ctx, DeselectSound, {
        volume: DESELECT_GAIN,
        detune: (Math.random() * 2 - 1) * SELECT_DETUNE_CENTS,
    });
}

/**
 * tick for a corner placed but not yet committed, the first click of a
 * two-click box-select. same clip as the commit a fourth down and quieter,
 * so the two clicks read as an ascending pair: anchored, then selected.
 *
 * deliberately outside the select rate limit. that floor exists to tame a
 * brush-select drag, and an anchor is always one discrete click, never a
 * stream, so it neither waits on the floor nor consumes it (which would
 * swallow a commit that follows quickly).
 */
export function playAnchored(ctx: ScriptContext): void {
    playMono(ctx, SelectSound, {
        volume: ANCHOR_GAIN,
        detune: ANCHOR_DETUNE_CENTS + (Math.random() * 2 - 1) * SELECT_DETUNE_CENTS,
    });
}
