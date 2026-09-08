// editor/icons.ts, the pipeline-baked icon loaders: the block-icon atlas and the
// per-prefab thumbnails, read through the engine resource loader and published to
// the editor store for the inventory + inspector. `loadEditorAssets(state)` binds the
// loader (mountEditUI calls it); the edit host calls the reload/invalidate entries
// when a baked icon file changes on the fs.

import type { EngineClient } from '../client/client';
import { prefabIconRelPath } from '../client/prefab-icons';
import { useEditor } from './editor-store';

/**
 * fetch the pre-built block icon atlas (written by the offline renderer
 * during dev) into the global editor store. project-wide asset; loaded once
 * per page and shared across every editor activation. fire-and-forget, late
 * resolution onto a doomed store at page teardown is harmless.
 *
 * The block atlas is the only icon artifact fetched into the store: scene +
 * prefab icons are per-file PNGs the UI loads by direct URL, so they need no
 * store state and no refetch.
 */
let currentBlockIconUrl: string | null = null;
let blockIconRenderInFlight = false;
/** a reload requested while one was in flight, replayed when it finishes. */
let blockIconReloadQueued = false;
const prefabIconInFlight = new Set<string>();
/** bumped by every prefab-icon invalidation; a load that resolves against a stale
 *  generation drops its result instead of publishing a url nothing revokes. */
let prefabIconGeneration = 0;

export function loadEditorAssets(state: EngineClient): void {
    useEditor.setState({ resources: state.resources });
    // Icons are baked by the asset pipeline into resources/client/ (block atlas +
    // per-id prefab pngs) and read back here through the engine resource loader.
    // The boot poll picks up the first bake; later reloads come from the edit
    // client calling `reloadBlockIconAtlas` / `invalidatePrefabIcons` when a baked
    // icon file changes on the fs.
    void loadBakedBlockIconsWhenReady();
}

/** Re-read the pipeline-baked block-icon atlas. Called by the edit client when
 *  `voxels-icons.{png,json}` changes on the fs. */
export function reloadBlockIconAtlas(): void {
    void reloadBlockIconAtlasLoop();
}

/**
 * The icon bake writes the atlas png and its coords sidecar as two separate
 * `writeIfChanged` calls, and the fs emits one change per write — so this is
 * called TWICE per bake, and the png notification arrives while the json is
 * still being written. That first load can therefore publish a fresh atlas
 * against the previous pass's coords, and the json notification (the one
 * carrying the new block's tile) is the one that has to correct it. Dropping an
 * overlapping request left exactly that state stuck: a block in the palette with
 * no icon, unfixable short of a pipeline restart. So coalesce onto a trailing
 * re-run instead — the replay reads both artifacts settled.
 */
async function reloadBlockIconAtlasLoop(): Promise<boolean> {
    if (blockIconRenderInFlight) {
        blockIconReloadQueued = true;
        return false;
    }
    blockIconRenderInFlight = true;
    try {
        let loaded = false;
        do {
            blockIconReloadQueued = false;
            loaded = await loadBakedBlockIcons();
        } while (blockIconReloadQueued);
        return loaded;
    } finally {
        blockIconRenderInFlight = false;
        blockIconReloadQueued = false;
    }
}

/** Wrap PNG bytes (a baked artifact) in a blob object URL for CSS/img use. */
function pngBytesToObjectUrl(bytes: Uint8Array): string {
    // Blob rejects a SharedArrayBuffer-backed view on some engines, so those copy
    // into a fresh ArrayBuffer — but the loader hands back plain views, and these
    // are whole atlas PNGs, so don't pay for the copy on the common path.
    const blobSource: BlobPart = bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
    return URL.createObjectURL(new Blob([blobSource], { type: 'image/png' }));
}

/** The first pipeline bake writes the icon atlas asynchronously after boot, so it
 *  may not exist on the first attempt. Retry a few frames until the load succeeds;
 *  registry-change events drive later reloads. */
async function loadBakedBlockIconsWhenReady(attempt = 0): Promise<void> {
    if (!useEditor.getState().resources) return;
    const ok = await reloadBlockIconAtlasLoop();
    if (!ok && attempt < 600) requestAnimationFrame(() => void loadBakedBlockIconsWhenReady(attempt + 1));
}

/**
 * Load the pipeline-baked block-icon atlas (`resources/client/voxels-icons.{png,json}`)
 * through the engine resource loader and publish it to the editor store for the
 * inventory + inspector. Returns false (quietly) if the artifact isn't baked yet.
 * Serialized by `reloadBlockIconAtlasLoop`, the only caller.
 */
async function loadBakedBlockIcons(): Promise<boolean> {
    const resources = useEditor.getState().resources;
    if (!resources) return false;
    try {
        const { loader } = resources;
        const [png, jsonBytes] = await Promise.all([loader.loadBytes('voxels-icons.png'), loader.loadBytes('voxels-icons.json')]);
        const meta = JSON.parse(new TextDecoder().decode(jsonBytes)) as {
            coords: Record<string, [number, number]>;
            cols: number;
            rows: number;
            iconPx: number;
        };
        const url = pngBytesToObjectUrl(png);
        if (currentBlockIconUrl) URL.revokeObjectURL(currentBlockIconUrl);
        currentBlockIconUrl = url;
        useEditor.setState({
            blockIconAtlasUrl: url,
            blockIconCoords: meta.coords,
            blockIconPx: meta.iconPx,
            blockIconCols: meta.cols,
            blockIconRows: meta.rows,
        });
        return true;
    } catch {
        // not baked yet (or fetch failed) — the caller retries / a later registry
        // change reloads.
        return false;
    }
}

/**
 * Lazily load one prefab's pipeline-baked icon (`resources/client/prefab-icons/<id>.png`)
 * and publish its object URL to the store. Called by the inventory icon on first
 * display; cached until a registry change invalidates it. No-op if already loaded,
 * in flight, or not baked yet. Deduped per id.
 */
export async function ensurePrefabIcon(prefabId: string): Promise<void> {
    const resources = useEditor.getState().resources;
    if (!resources || !prefabId) return;
    if (useEditor.getState().prefabIconUrls[prefabId] || prefabIconInFlight.has(prefabId)) return;
    prefabIconInFlight.add(prefabId);
    const generation = prefabIconGeneration;
    let raced = false;
    try {
        const png = await resources.loader.loadBytes(prefabIconRelPath(prefabId));
        const url = pngBytesToObjectUrl(png);
        if (generation !== prefabIconGeneration) {
            // an invalidation landed mid-load: these bytes are the ones it dropped,
            // so let the url go instead of publishing something already stale.
            URL.revokeObjectURL(url);
            raced = true;
        } else {
            useEditor.setState((s) => {
                const previous = s.prefabIconUrls[prefabId];
                if (previous) URL.revokeObjectURL(previous);
                return { prefabIconUrls: { ...s.prefabIconUrls, [prefabId]: url } };
            });
        }
    } catch {
        // not baked yet — a later registry flush + re-display retries.
    } finally {
        prefabIconInFlight.delete(prefabId);
    }
    // re-read the icon the invalidation dropped, now that the dedupe slot is free.
    if (raced) await ensurePrefabIcon(prefabId);
}

/** Drop + revoke cached prefab icons so visible ones re-read their png on next
 *  display: the named ids, or all of them when called with none (a registry flush,
 *  where every prefab's appearance can have moved). */
export function invalidatePrefabIcons(ids?: readonly string[]): void {
    prefabIconGeneration++;
    const urls = useEditor.getState().prefabIconUrls;
    if (!ids) {
        for (const id in urls) URL.revokeObjectURL(urls[id]!);
        useEditor.setState({ prefabIconUrls: {} });
        return;
    }
    const next = { ...urls };
    let dropped = false;
    for (const id of ids) {
        const url = next[id];
        if (!url) continue;
        URL.revokeObjectURL(url);
        delete next[id];
        dropped = true;
    }
    if (dropped) useEditor.setState({ prefabIconUrls: next });
}
