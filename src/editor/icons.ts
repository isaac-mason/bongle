import type { EngineClient } from '../client/client';
import { prefabIconRelPath } from '../client/prefab-icons';
import { useEditor } from './editor-store';

/** the object URL the store currently holds, revoked when it is replaced. */
let currentBlockIconUrl: string | null = null;
/** bumped by every block-atlas load; one that resolves stale drops its result
 *  instead of publishing behind a newer one. */
let blockIconGeneration = 0;
const prefabIconInFlight = new Set<string>();
/** bumped by every prefab-icon invalidation; a load that resolves against a stale
 *  generation drops its result instead of publishing a url nothing revokes. */
let prefabIconGeneration = 0;

/** binds the engine resource loader the icon readers go through; icons themselves are fetched
 *  by the reload entries below, never here. */
export function loadEditorAssets(state: EngineClient): void {
    useEditor.setState({ resources: state.resources });
}

/** called by the host when the bake announces a new atlas, never speculatively: the png and its
 *  coords sidecar are written one after the other, and the announcement guarantees both halves
 *  are the same pass's. the block atlas is the only icon artifact held in the store; scene +
 *  prefab icons are per-file PNGs the UI loads by direct URL. */
export function reloadBlockIconAtlas(): void {
    void loadBakedBlockIcons();
}

/** wraps PNG bytes (a baked artifact) in a blob object URL for CSS/img use. */
function pngBytesToObjectUrl(bytes: Uint8Array): string {
    // Blob rejects a SharedArrayBuffer-backed view on some engines, so those copy into a fresh
    // ArrayBuffer; the loader hands back plain views for whole atlas PNGs, so skip the copy there.
    const blobSource: BlobPart = bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
    return URL.createObjectURL(new Blob([blobSource], { type: 'image/png' }));
}

async function loadBakedBlockIcons(): Promise<void> {
    const resources = useEditor.getState().resources;
    if (!resources) return;
    const generation = ++blockIconGeneration;
    try {
        const { loader } = resources;
        const [png, jsonBytes] = await Promise.all([loader.loadBytes('voxels-icons.png'), loader.loadBytes('voxels-icons.json')]);
        const meta = JSON.parse(new TextDecoder().decode(jsonBytes)) as {
            coords: Record<string, [number, number]>;
            cols: number;
            rows: number;
            iconPx: number;
        };
        if (generation !== blockIconGeneration) return; // a newer load is already publishing
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
    } catch (err) {
        // the bake said the artifact was there, so a failure here is real, not a race with a write.
        console.error('[editor] block icon atlas failed to load', err);
    }
}

/** called by the inventory icon on first display; cached until a registry change invalidates
 *  it. no-op if already loaded, in flight, or not baked yet. deduped per id. */
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
        // not baked yet; a later registry flush + re-display retries.
    } finally {
        prefabIconInFlight.delete(prefabId);
    }
    // re-read the icon the invalidation dropped, now that the dedupe slot is free.
    if (raced) await ensurePrefabIcon(prefabId);
}

/** drops + revokes cached prefab icons so visible ones re-read their png on next display:
 *  the named ids, or all of them when called with none (a registry flush). */
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
