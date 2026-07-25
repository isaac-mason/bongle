// Icon rendering for the pipeline worker. The bake is a pure data step; icons
// are a GPU render step that runs after it, in the same realm, so it draws
// against the registry the user code populated. Grouped here (not in the bake)
// because both are the pipeline's concern once it owns a headless renderer.
//
// The heavy lifting lives in client/: `createHeadlessRenderContext` +
// `buildRenderDeps` stand up a canvas-less render stack, and the same
// `renderBlockIconAtlas` / `renderPrefabIcon` the live client uses draw the
// icons through the shared `RenderRoomDeps` seam.

import { registry } from '../core/registry';
import type { RenderRoomDeps } from '../client/rooms';
import { prefabIconRelPath, renderPrefabIcon } from '../client/prefab-icons';
import type { Filesystem } from './filesystem';

export { renderBlockIconAtlas } from '../client/block-icons';
export type { BlockIconAtlas } from '../client/block-icons';
export { buildRenderDeps, createHeadlessRenderContext } from '../client/headless-render';
export type { HeadlessRenderContext } from '../client/headless-render';
export { prefabIconRelPath, renderPrefabIcon } from '../client/prefab-icons';
export type { PrefabIcon } from '../client/prefab-icons';

/** FNV-1a string hash → base36, for the prefab-icon freshness manifest. */
function fnv1a(s: string): string {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}

/** relative path of the prefab-icon freshness manifest (id -> def hash). */
const PREFAB_ICON_MANIFEST = 'resources/client/prefab-icons.json';

/**
 * Bake each prefab's icon to `resources/client/prefab-icons/<id>.png`, shared by
 * the browser pipeline-worker and the node CLI (only `encodePng` differs — worker
 * OffscreenCanvas vs. node skia-canvas). Prefabs are many/heavy, so this is
 * INCREMENTAL: a prefab is (re)rendered only when its def changed since the last
 * bake (tracked in a `prefab-icons.json` id -> `fnv1a(def)` manifest) or when the
 * block atlas changed (textures affect appearance). An unhashable def (rare) is
 * always re-rendered. Files for removed prefabs are pruned. Returns the count
 * rendered. Never throws for a single prefab — a failed render is skipped.
 */
export async function bakePrefabIcons(
    deps: RenderRoomDeps,
    fs: Filesystem,
    atlasChanged: boolean,
    encodePng: (pixels: Uint8Array, width: number, height: number) => Promise<Uint8Array>,
): Promise<number> {
    let prev: Record<string, string> = {};
    try {
        prev = JSON.parse(await fs.readText(PREFAB_ICON_MANIFEST)) as Record<string, string>;
    } catch {
        // no manifest yet (first bake) — everything is fresh work.
    }
    const next: Record<string, string> = {};
    let rendered = 0;
    for (const [id, def] of registry.prefabs.byId) {
        // null hash (unserializable def) → can't detect changes, so always re-render.
        let hash: string | null = null;
        try {
            hash = fnv1a(JSON.stringify(def));
        } catch {}
        const path = `resources/client/${prefabIconRelPath(id)}`;
        const fresh = hash !== null && !atlasChanged && prev[id] === hash && (await fs.exists(path));
        next[id] = hash ?? '';
        if (fresh) continue;
        const icon = await renderPrefabIcon(deps, id);
        if (!icon) continue;
        await fs.write(path, await encodePng(icon.pixels, icon.pxSize, icon.pxSize));
        rendered++;
    }
    // prune icons for prefabs that no longer exist.
    for (const id of Object.keys(prev)) {
        if (!(id in next)) await fs.remove(`resources/client/${prefabIconRelPath(id)}`).catch(() => {});
    }
    await fs.write(PREFAB_ICON_MANIFEST, new TextEncoder().encode(JSON.stringify(next)));
    return rendered;
}
