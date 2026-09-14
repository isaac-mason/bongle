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

/** Picks the next free `<base>-NNN` name (zero-padded to 3 digits) under `blueprints/`. */
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

/** Saves a ScenePayload under `blueprints/<name>.scene.json`, overwriting any existing entry with the same name. */
export function saveBlueprint(state: EngineServer, name: string, payload: ScenePayload): SaveBlueprintResult {
    if (!NAME_RE.test(name)) {
        return {
            ok: false,
            error: `invalid blueprint name "${name}" — use lowercase letters, digits, hyphens, underscores`,
        };
    }
    const sceneId = BLUEPRINT_PREFIX + name;
    const overwritten = existingBlueprintIds(state).has(name);
    const written = Scenes.saveScene(state, sceneId, payload);
    return { ok: true, sceneId, overwritten, written };
}
