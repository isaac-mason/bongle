/**
 * Icon-artifact writer. Inputs come from the in-process pipeline worker
 * (EngineAssetPipeline): it renders RGBA into a RenderTarget, reads it back
 * into a Uint8Array, and passes that buffer + manifest to these writers
 * (via `local-pipeline`'s ctx).
 *
 * Two output shapes:
 *   - block-icons → a packed `voxels-icons.{png,json}` atlas (many tiny,
 *     bounded icons; one texture + coords JSON).
 *   - scenes + prefabs → one PNG per subject under `<group>/<id>.icon.png`,
 *     plus a `<group>-icons.json` hash map the orchestrator reads back for
 *     gating (few, large, id-addressed icons; loaded lazily by direct URL).
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export type IconManifest = {
    hash: string;
    iconPx: number;
    cols: number;
    rows: number;
    atlasWidth: number;
    atlasHeight: number;
    /** block-icons coords, keyed by block state-key. */
    coords: unknown;
};

export type IconKind = 'block-icons';

const FILE_NAMES: Record<IconKind, { json: string; png: string; coordsKey: 'states' }> = {
    'block-icons': { json: 'voxels-icons.json', png: 'voxels-icons.png', coordsKey: 'states' },
};

export async function writeIconArtifact(
    resourcesClientDir: string,
    kind: IconKind,
    manifest: IconManifest,
    pixels: Uint8Array,
): Promise<void> {
    const { json: jsonName, png: pngName, coordsKey } = FILE_NAMES[kind];
    fs.mkdirSync(resourcesClientDir, { recursive: true });

    const sidecar: Record<string, unknown> = {
        hash: manifest.hash,
        iconPx: manifest.iconPx,
        cols: manifest.cols,
        rows: manifest.rows,
        [coordsKey]: manifest.coords,
    };
    fs.writeFileSync(path.join(resourcesClientDir, jsonName), JSON.stringify(sidecar, null, 2));

    if (manifest.atlasWidth > 0 && manifest.atlasHeight > 0 && pixels.byteLength > 0) {
        const png = await sharp(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength), {
            raw: { width: manifest.atlasWidth, height: manifest.atlasHeight, channels: 4 },
        })
            .png()
            .toBuffer();
        fs.writeFileSync(path.join(resourcesClientDir, pngName), png);
        console.log(`[bongle] ${kind} written to resources/client/${pngName}`);
    } else {
        console.log(`[bongle] no blocks to render — wrote empty ${jsonName}`);
    }
}

// per-subject PNGs at resources/client/<dir>/<id>.icon.png. scenes and
// prefabs are the same shape, different dir. No hash sidecar: render gating
// is in-memory in the orchestrator (it computes + compares hashes itself and
// only dispatches renders that changed), so there's nothing to persist here —
// the worker only ever POSTs a render that needs writing.

export type PerIdIconGroup = { dir: string };

export const SCENE_ICONS: PerIdIconGroup = { dir: 'scenes' };
export const PREFAB_ICONS: PerIdIconGroup = { dir: 'prefabs' };

/** the per-id icon dirs under resources/client. these hold editor-only
 *  library/inspector thumbnails that grow unbounded with content and are never
 *  fetched in a play-mode bundle — so they're excluded from build output. (the
 *  bounded block-icon atlas, `voxels-icons.*`, is kept.) */
export const PER_ID_ICON_DIRS: readonly string[] = [SCENE_ICONS.dir, PREFAB_ICONS.dir];

/** `fs.cpSync` filter for copying resources/client into a bundle: drops the
 *  per-id icon dirs (editor-only) and keeps everything else. `root` is the
 *  resources/client dir being copied. */
export function excludeEditorIcons(root: string): (src: string) => boolean {
    return (src: string): boolean => {
        const top = path.relative(root, src).split(path.sep)[0];
        return !PER_ID_ICON_DIRS.includes(top);
    };
}

function perIdIconPath(resourcesClientDir: string, group: PerIdIconGroup, id: string): string {
    // ids may be slash-segmented (e.g. "blueprints/tree"); mkdir -p the
    // parent so nested ids don't ENOENT on first write.
    return path.join(resourcesClientDir, group.dir, `${id}.icon.png`);
}

export async function writePerIdIcon(
    resourcesClientDir: string,
    group: PerIdIconGroup,
    id: string,
    pxSize: number,
    pixels: Uint8Array,
): Promise<void> {
    // empty pixels = nothing renderable; no file to write.
    if (pixels.byteLength === 0) return;
    const outPath = perIdIconPath(resourcesClientDir, group, id);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const png = await sharp(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength), {
        raw: { width: pxSize, height: pxSize, channels: 4 },
    })
        .png()
        .toBuffer();
    fs.writeFileSync(outPath, png);
    console.log(`[bongle] icon written to resources/client/${group.dir}/${id}.icon.png`);
}
