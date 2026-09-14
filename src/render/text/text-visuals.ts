import { type Camera, packTo, type Scene } from 'gpucat';
import { box3 } from 'math/shapes';
import { TextTrait } from '../../builtins/text';
import { getVisualWorldMatrix, TransformTrait } from '../../builtins/transform';
import { query, type SceneTree } from '../../core/scene/scene-tree';
import {
    CENTER_BIT,
    growSpriteBatch,
    INSTANCE_MATERIAL_STRIDE,
    INSTANCE_POSE_STRIDE,
    InstanceMaterial,
    MODE_BILLBOARD,
    MODE_WORLD,
    MODE_Y_BILLBOARD,
    POSE_OFFSET_F32,
    SPRITE_OCCLUSIONS,
    type SpriteOcclusion,
    type SpriteResources,
} from '../sprites/sprite-resources';
import { freeSlot } from '../sprites/sprite-visuals';
import * as Visibility from '../visibility/visibility';
import { GLYPH_COUNT, glyphIndex, glyphSpriteId } from './glyph-font';

/** one glyph's place in the batch. Pooled per run; the batch's swap-pop rewrites `slot` in place. */
type GlyphSlot = { slot: number };

/** Renderer-owned state on `TextTrait._state`: one batch slot per character, and one cull entry for the run. */
export type TextVisualState = {
    trait: TextTrait;
    /** the run's own frustum-cull entry, sized to the laid-out text. */
    cull: Visibility.CullState;
    /** which batch owns the slots; a trait changing `occlusion` re-installs into the other one. */
    occlusion: SpriteOcclusion;
    /** parallel to the characters of `textAtInstall`; `slot` is -1 while the run is hidden. */
    glyphs: GlyphSlot[];
    /** the string the slot count and cull box were built for; a different one re-installs. */
    textAtInstall: string;
    worldScaleAtInstall: number;
    lastSeenFrame: number;
};

type TextQuery = ReturnType<typeof query<[typeof TextTrait, typeof TransformTrait]>>;

/** a glyph's atlas rect plus its pixel size, rebuilt whenever the atlas changes. */
type GlyphCell = { u: number; v: number; w: number; h: number; pixelWidth: number; pixelHeight: number };

export type TextVisuals = {
    aliveStates: TextVisualState[];
    _query: TextQuery;
    frameId: number;
    /** per glyph index, from the `kit:glyph:*` sprites; null for a glyph the atlas lacks. */
    cells: (GlyphCell | null)[];
    /** atlas hash `cells` was built from. */
    cellsAtlasHash: string | null;
    scene: Scene;
};

export function init(sceneTree: SceneTree, scene: Scene): TextVisuals {
    return {
        aliveStates: [],
        _query: query(sceneTree, [TextTrait, TransformTrait]),
        frameId: 0,
        cells: new Array(GLYPH_COUNT).fill(null),
        cellsAtlasHash: null,
        scene,
    };
}

function refreshCells(visuals: TextVisuals, resources: SpriteResources): void {
    if (visuals.cellsAtlasHash === resources.atlasHash) return;
    visuals.cellsAtlasHash = resources.atlasHash;
    const atlasSize = resources.metadata?.atlasSize ?? 0;
    for (let i = 0; i < GLYPH_COUNT; i++) {
        const frame = resources.frames.get(glyphSpriteId(i))?.frames[0];
        visuals.cells[i] = frame
            ? {
                  u: frame.u,
                  v: frame.v,
                  w: frame.w,
                  h: frame.h,
                  pixelWidth: Math.round(frame.w * atlasSize),
                  pixelHeight: Math.round(frame.h * atlasSize),
              }
            : null;
    }
}

/** the font's pixel cell, taken from whichever glyph the atlas has; the kit's font is fixed-width. */
function cellSize(visuals: TextVisuals): { width: number; height: number } {
    for (const cell of visuals.cells) {
        if (cell) return { width: cell.pixelWidth, height: cell.pixelHeight };
    }
    return { width: 0, height: 0 };
}

function encodeFlags(mode: 'world' | 'billboard' | 'y-billboard'): number {
    const index = mode === 'world' ? MODE_WORLD : mode === 'billboard' ? MODE_BILLBOARD : MODE_Y_BILLBOARD;
    // glyph quads are placed by their own in-plane offset, which is measured to their centres.
    return index | CENTER_BIT;
}

const _lineLengths: number[] = [];

/** characters per line, into a reused array; newlines are separators and never counted. */
function lineLengths(text: string): number[] {
    _lineLengths.length = 1;
    _lineLengths[0] = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') _lineLengths.push(0);
        else _lineLengths[_lineLengths.length - 1]!++;
    }
    return _lineLengths;
}

/** one line's width in font pixels: the glyph cells plus the single-pixel gaps between them. */
function lineWidth(characters: number, cellWidth: number): number {
    return characters === 0 ? 0 : characters * (cellWidth + 1) - 1;
}

/** width of the longest line and the number of lines, in font pixels. */
export function measure(text: string, cellWidth: number): { width: number; lines: number } {
    const lengths = lineLengths(text);
    let width = 0;
    for (const characters of lengths) width = Math.max(width, lineWidth(characters, cellWidth));
    return { width, lines: lengths.length };
}

const _scratchRight: [number, number, number] = [0, 0, 0];
const _scratchUp: [number, number, number] = [0, 0, 0];

/** columns 0 and 1 of the world matrix, the node's own right and up, used by `mode: 'world'`. */
function extractBasis(m: ArrayLike<number>, right: [number, number, number], up: [number, number, number]): void {
    right[0] = m[0]!;
    right[1] = m[1]!;
    right[2] = m[2]!;
    up[0] = m[4]!;
    up[1] = m[5]!;
    up[2] = m[6]!;
}

/**
 * Per-frame update. Walks (TextTrait, TransformTrait) pairs, holding one batch slot per character of `text`.
 * Every slot shares the node's world position and carries its own in-plane offset, so a run stays a straight
 * line whatever basis the billboard modes resolve to.
 */
export function update(
    visuals: TextVisuals,
    resources: SpriteResources,
    _camera: Camera,
    visibility: Visibility.Visibility,
): void {
    const frameId = ++visuals.frameId;
    refreshCells(visuals, resources);
    const { width: cellWidth, height: cellHeight } = cellSize(visuals);
    const dirty: Record<SpriteOcclusion, boolean> = { world: false, none: false };

    for (const [trait, transform] of visuals._query) {
        const text = trait.text;
        if (text === '' || cellWidth === 0) {
            if (trait._state !== null) destroyInstance(visuals, resources, trait, visibility, dirty);
            continue;
        }

        let state = trait._state;
        if (
            state === null ||
            state.textAtInstall !== text ||
            state.occlusion !== trait.occlusion ||
            state.worldScaleAtInstall !== trait.worldScale
        ) {
            if (state !== null) destroyInstance(visuals, resources, trait, visibility, dirty);
            const { width, lines } = measure(text, cellWidth);
            // the run can face any direction in the billboard modes, so the cull box is a conservative
            // sphere-in-a-box around its longest diagonal.
            const runWidth = width * trait.worldScale;
            const runHeight = lines * (cellHeight + 1) * trait.worldScale;
            const r = Math.sqrt(runWidth * runWidth + runHeight * runHeight) * 0.5;
            const glyphs: GlyphSlot[] = [];
            for (let i = 0; i < text.length; i++) glyphs.push({ slot: -1 });
            state = {
                trait,
                cull: Visibility.add(visibility, box3.set(box3.create(), -r, -r, -r, r, r, r), transform),
                occlusion: trait.occlusion,
                glyphs,
                textAtInstall: text,
                worldScaleAtInstall: trait.worldScale,
                lastSeenFrame: frameId,
            };
            trait._state = state;
            visuals.aliveStates.push(state);
        }
        state.lastSeenFrame = frameId;

        const batch = resources.batches[state.occlusion];
        if (!state.cull.visible || !trait.visible) {
            releaseSlots(batch, state, dirty);
            continue;
        }

        const worldMat = getVisualWorldMatrix(transform);
        extractBasis(worldMat, _scratchRight, _scratchUp);
        const worldScale = trait.worldScale;
        const advance = (cellWidth + 1) * worldScale;
        const lineStep = (cellHeight + 1) * worldScale;
        const flags = encodeFlags(trait.mode);
        const lengths = lineLengths(text);
        const align = trait.align;
        // each line is aligned on its own width, so a centred block is centred line by line.
        const shiftOf = (line: number): number => {
            if (align === 'left') return 0;
            const width = lineWidth(lengths[line] ?? 0, cellWidth) * worldScale;
            return align === 'center' ? -width * 0.5 : -width;
        };
        // the first line sits so the whole block is vertically centred on the node.
        const firstLineY = ((lengths.length - 1) * lineStep) / 2;
        const tint = trait.tint;
        const flash = trait.flash;
        const glyphWidth = cellWidth * worldScale;
        const glyphHeight = cellHeight * worldScale;

        let column = 0;
        let line = 0;
        let shift = shiftOf(0);
        for (let i = 0; i < text.length; i++) {
            const glyph = state.glyphs[i]!;
            if (text[i] === '\n') {
                if (glyph.slot !== -1) {
                    freeSlot(batch, glyph);
                    glyph.slot = -1;
                    dirty[state.occlusion] = true;
                }
                line++;
                column = 0;
                shift = shiftOf(line);
                continue;
            }
            const cell = visuals.cells[glyphIndex(text.charCodeAt(i))];
            if (!cell) {
                column++;
                continue;
            }

            if (glyph.slot === -1) {
                if (batch.head >= batch.instanceCapacity) growSpriteBatch(batch, batch.instanceCapacity * 2);
                glyph.slot = batch.head++;
                batch.slotOwner[glyph.slot] = glyph;
            }
            const poseArr = batch.instancePoseBuf.array as Float32Array;
            const matArr = batch.instanceMaterialBuf.array as Float32Array;
            const poseOff = glyph.slot * (INSTANCE_POSE_STRIDE / 4);
            poseArr[poseOff + 0] = worldMat[12]!;
            poseArr[poseOff + 1] = worldMat[13]!;
            poseArr[poseOff + 2] = worldMat[14]!;
            poseArr[poseOff + 3] = glyphWidth;
            poseArr[poseOff + 4] = _scratchRight[0];
            poseArr[poseOff + 5] = _scratchRight[1];
            poseArr[poseOff + 6] = _scratchRight[2];
            poseArr[poseOff + 7] = glyphHeight;
            poseArr[poseOff + 8] = _scratchUp[0];
            poseArr[poseOff + 9] = _scratchUp[1];
            poseArr[poseOff + 10] = _scratchUp[2];
            new Uint32Array(poseArr.buffer, poseArr.byteOffset, poseArr.length)[poseOff + 11] = flags;
            poseArr[poseOff + POSE_OFFSET_F32] = shift + column * advance + glyphWidth / 2;
            poseArr[poseOff + POSE_OFFSET_F32 + 1] = firstLineY - line * lineStep;

            packTo(InstanceMaterial, matArr, glyph.slot * INSTANCE_MATERIAL_STRIDE, {
                uvRect: [cell.u, cell.v, cell.w, cell.h],
                tint: [tint[0], tint[1], tint[2], tint[3]],
                flash: [flash[0], flash[1], flash[2], flash[3]],
                glow: trait.glow,
                unlit: trait.unlit ? 1 : 0,
                litMin: trait.litMin,
                dither: trait.dither,
            });
            dirty[state.occlusion] = true;
            column++;
        }
    }

    const aliveStates = visuals.aliveStates;
    for (let i = aliveStates.length - 1; i >= 0; i--) {
        const state = aliveStates[i]!;
        if (state.lastSeenFrame !== frameId) destroyInstance(visuals, resources, state.trait, visibility, dirty);
    }

    // the sprite batches are shared, so their `mesh.count` and uploads are flushed by whichever pass runs last;
    // both are written here because text may be the only thing in a batch this frame.
    for (const occlusion of SPRITE_OCCLUSIONS) {
        const batch = resources.batches[occlusion];
        batch.mesh.count = batch.head;
        if (!dirty[occlusion]) continue;
        batch.instancePoseBuf.addUpdateRange(0, batch.head * (INSTANCE_POSE_STRIDE / 4));
        batch.instancePoseBuf.needsUpdate = true;
        batch.instanceMaterialBuf.addUpdateRange(0, batch.head * (INSTANCE_MATERIAL_STRIDE / 4));
        batch.instanceMaterialBuf.needsUpdate = true;
    }
}

function releaseSlots(
    batch: SpriteResources['batches'][SpriteOcclusion],
    state: TextVisualState,
    dirty: Record<SpriteOcclusion, boolean> | null,
): void {
    for (const glyph of state.glyphs) {
        if (glyph.slot === -1) continue;
        freeSlot(batch, glyph);
        glyph.slot = -1;
        if (dirty) dirty[state.occlusion] = true;
    }
}

export function dispose(visuals: TextVisuals, resources: SpriteResources, visibility: Visibility.Visibility): void {
    const arr = visuals.aliveStates;
    for (let i = arr.length - 1; i >= 0; i--) destroyInstance(visuals, resources, arr[i]!.trait, visibility, null);
}

function destroyInstance(
    visuals: TextVisuals,
    resources: SpriteResources,
    trait: TextTrait,
    visibility: Visibility.Visibility,
    dirty: Record<SpriteOcclusion, boolean> | null,
): void {
    const state = trait._state;
    if (state === null) return;

    Visibility.remove(visibility, state.cull);
    releaseSlots(resources.batches[state.occlusion], state, dirty);

    const arr = visuals.aliveStates;
    const last = arr.length - 1;
    for (let i = last; i >= 0; i--) {
        if (arr[i] === state) {
            if (i !== last) arr[i] = arr[last]!;
            arr.pop();
            break;
        }
    }

    trait._state = null;
}
