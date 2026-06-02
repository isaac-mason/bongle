/**
 * Icon-artifact writer. Inputs come from the persistent-puppeteer page via
 * POST /__bongle/pipeline/emit — the page renders RGBA into a RenderTarget,
 * reads it back into a Uint8Array, and POSTs that buffer + a manifest header.
 * Here we sharp-encode it to PNG and write the sidecar JSON. Mirrors the
 * legacy `voxels-icons.{png,json}` + `prefabs-icons.{png,json}` artifact
 * shape so client + game-client consumers don't need to change.
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
    /** opaque to this writer — block-icons uses `states`, prefab-icons uses
     *  `coords`. We pass it through under the same key the source result used. */
    coords: unknown;
};

export type IconKind = 'block-icons' | 'prefab-icons';

const FILE_NAMES: Record<IconKind, { json: string; png: string; coordsKey: 'states' | 'coords' }> = {
    'block-icons': { json: 'voxels-icons.json', png: 'voxels-icons.png', coordsKey: 'states' },
    'prefab-icons': { json: 'prefabs-icons.json', png: 'prefabs-icons.png', coordsKey: 'coords' },
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
        console.log(`[bongle] no ${kind === 'block-icons' ? 'blocks' : 'prefabs'} to render — wrote empty ${jsonName}`);
    }
}

// per-scene PNGs at resources/client/scenes/<id>.icon.png with a shared
// hash sidecar at resources/client/scenes-icons.json. one sidecar (rather
// than per-id) keeps the watcher target set small — the writer rewrites
// the sidecar after every per-scene write so the on-disk hash map and PNG
// set stay consistent.

const SCENE_ICONS_DIR = 'scenes';
const SCENE_HASHES_FILE = 'scenes-icons.json';

export type SceneIconHashes = {
    /** map of sceneId → render hash; the page reads this back via
     *  /__bongle/pipeline/hashes to skip unchanged scenes. */
    icons: Record<string, string>;
};

export function readSceneIconHashes(resourcesClientDir: string): SceneIconHashes {
    const p = path.join(resourcesClientDir, SCENE_HASHES_FILE);
    if (!fs.existsSync(p)) return { icons: {} };
    try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as SceneIconHashes;
        return { icons: parsed.icons ?? {} };
    } catch {
        return { icons: {} };
    }
}

function sceneIconPath(resourcesClientDir: string, id: string): string {
    // ids may be slash-segmented (e.g. "blueprints/tree"); mkdir -p the
    // parent so nested ids don't ENOENT on first write.
    return path.join(resourcesClientDir, SCENE_ICONS_DIR, `${id}.icon.png`);
}

export async function writeSceneIcon(
    resourcesClientDir: string,
    id: string,
    hash: string,
    pxSize: number,
    pixels: Uint8Array,
): Promise<void> {
    if (pixels.byteLength === 0) {
        // skip-write: caller already determined this scene's render is
        // unchanged. just update the hash map.
        updateSceneHash(resourcesClientDir, id, hash);
        return;
    }
    const outPath = sceneIconPath(resourcesClientDir, id);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const png = await sharp(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength), {
        raw: { width: pxSize, height: pxSize, channels: 4 },
    })
        .png()
        .toBuffer();
    fs.writeFileSync(outPath, png);
    updateSceneHash(resourcesClientDir, id, hash);
    console.log(`[bongle] scene-icon written to resources/client/${SCENE_ICONS_DIR}/${id}.icon.png`);
}

function updateSceneHash(resourcesClientDir: string, id: string, hash: string): void {
    fs.mkdirSync(resourcesClientDir, { recursive: true });
    const current = readSceneIconHashes(resourcesClientDir);
    current.icons[id] = hash;
    fs.writeFileSync(
        path.join(resourcesClientDir, SCENE_HASHES_FILE),
        JSON.stringify(current, null, 2),
    );
}
