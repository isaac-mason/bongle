// editor/persist/blueprints.ts, server-side helpers for the blueprint inventory.
//
// blueprints are scenes under the reserved `blueprints/` folder
// (`content/scenes/blueprints/<name>.scene.json`). they're authored
// content like any other scene, the only special thing is the folder
// convention + the editor flow that writes them from a live selection.
//
// this module owns: name allocation (so right-click "create blueprint"
// can pick a free `blueprint-NNN`), name validation, and the
// `Scenes.saveScene` call site for blueprint writes.

import type { ScenePayload } from '../../core/content/scene-store';
import * as ContentManager from '../../server/content-manager';
import type { EngineServer } from '../../server/server';
import * as Scenes from './scenes';

const BLUEPRINT_PREFIX = 'blueprints/';
const NAME_RE = /^[a-z0-9][a-z0-9\-_]*$/;

function existingBlueprintIds(state: EngineServer): Set<string> {
    const out = new Set<string>();
    for (const e of ContentManager.listScenes(state.contentManager)) {
        if (e.sceneId.startsWith(BLUEPRINT_PREFIX)) {
            out.add(e.sceneId.slice(BLUEPRINT_PREFIX.length));
        }
    }
    return out;
}

/**
 * pick the next free `<base>-NNN` name (zero-padded to 3 digits) under
 * `blueprints/`. used by the right-click "create blueprint" path where
 * the user hasn't supplied a name yet.
 */
export function allocateBlueprintName(state: EngineServer, base = 'blueprint'): string {
    const taken = existingBlueprintIds(state);
    for (let i = 1; i < 1000; i++) {
        const candidate = `${base}-${String(i).padStart(3, '0')}`;
        if (!taken.has(candidate)) return candidate;
    }
    throw new Error(`[blueprints] allocateBlueprintName: exhausted 999 slots for base "${base}"`);
}

export type SaveBlueprintResult =
    | { ok: true; sceneId: string; overwritten: boolean; written: Promise<void> | null }
    | { ok: false; error: string };

/**
 * save a ScenePayload as a blueprint under `blueprints/<name>.scene.json`.
 * overwrites any existing entry with the same name. `name` must match
 * `^[a-z0-9][a-z0-9\-_]*$`, no slashes (single-level under blueprints/).
 */
export function saveBlueprint(state: EngineServer, name: string, payload: ScenePayload): SaveBlueprintResult {
    if (!NAME_RE.test(name)) {
        return {
            ok: false,
            error: `invalid blueprint name "${name}" — use lowercase letters, digits, hyphens, underscores`,
        };
    }
    const sceneId = BLUEPRINT_PREFIX + name;
    const overwritten = existingBlueprintIds(state).has(name);
    // saveScene adds the scene to the in-memory store, so a follow-up
    // allocateBlueprintName sees it via listScenes.
    const written = Scenes.saveScene(state, sceneId, payload);
    return { ok: true, sceneId, overwritten, written };
}
