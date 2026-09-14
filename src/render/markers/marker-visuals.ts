import { box3 } from 'math/shapes';
import { MarkerTrait } from '../../builtins/marker';
import { TransformTrait } from '../../builtins/transform';
import { query, type SceneTree } from '../../core/scene/scene-tree';
import * as Visibility from '../visibility/visibility';

/** a marker's pick box in `visibility`; the editor's node bodies read it, the card draws the icon. */
export type MarkerVisualState = {
    cull: Visibility.CullState;
    sizeAtInstall: number;
    lastSeenFrame: number;
};

type MarkerQuery = ReturnType<typeof query<[typeof MarkerTrait, typeof TransformTrait]>>;

export type MarkerVisuals = {
    aliveStates: Array<{ trait: MarkerTrait; state: MarkerVisualState }>;
    _query: MarkerQuery;
    frameId: number;
};

export function init(sceneTree: SceneTree): MarkerVisuals {
    return { aliveStates: [], _query: query(sceneTree, [MarkerTrait, TransformTrait]), frameId: 0 };
}

/** every marker with a transform, for the card pass. */
export function markers(visuals: MarkerVisuals): Iterable<[MarkerTrait, TransformTrait]> {
    return visuals._query;
}

/** call once per frame while an edit lens is active: keeps one pick box per marker, sized `trait.size`. */
export function update(visuals: MarkerVisuals, visibility: Visibility.Visibility): void {
    const frameId = ++visuals.frameId;
    for (const [trait, transform] of visuals._query) {
        if (!trait.enabled) continue;
        let state = trait._state;
        if (state !== null && state.sizeAtInstall !== trait.size) {
            destroyInstance(visuals, trait, visibility);
            state = null;
        }
        if (state === null) {
            const r = trait.size / 2;
            state = {
                cull: Visibility.add(visibility, box3.set(box3.create(), -r, -r, -r, r, r, r), transform),
                sizeAtInstall: trait.size,
                lastSeenFrame: frameId,
            };
            trait._state = state;
            visuals.aliveStates.push({ trait, state });
        }
        state.lastSeenFrame = frameId;
    }
    const alive = visuals.aliveStates;
    for (let i = alive.length - 1; i >= 0; i--) {
        if (alive[i]!.state.lastSeenFrame !== frameId) destroyInstance(visuals, alive[i]!.trait, visibility);
    }
}

/** release every pick box; markers stop being clickable until the next `update`. */
export function clear(visuals: MarkerVisuals, visibility: Visibility.Visibility): void {
    for (let i = visuals.aliveStates.length - 1; i >= 0; i--) destroyInstance(visuals, visuals.aliveStates[i]!.trait, visibility);
}

export function dispose(visuals: MarkerVisuals, visibility: Visibility.Visibility): void {
    clear(visuals, visibility);
}

function destroyInstance(visuals: MarkerVisuals, trait: MarkerTrait, visibility: Visibility.Visibility): void {
    const state = trait._state;
    if (state === null) return;
    Visibility.remove(visibility, state.cull);
    const idx = visuals.aliveStates.findIndex((entry) => entry.trait === trait);
    if (idx !== -1) visuals.aliveStates.splice(idx, 1);
    trait._state = null;
}
