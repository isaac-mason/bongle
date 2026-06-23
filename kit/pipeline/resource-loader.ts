/**
 * kit/pipeline/resource-loader.ts — the asset pipeline's `ResourceLoader`.
 *
 * The Node-only counterpart to the browser's `browserResourceLoader`: byte
 * loading off disk + a `sharp` image decoder. This is the ONLY place `sharp`
 * is imported in the asset-pipeline path; the engine (`src/`) sees only the
 * `ResourceLoader` type, so sharp can never reach the client bundle.
 *
 * No caching: the sharp/Dawn-overlap segfault is avoided by VoxelResources.load
 * serialising the atlas decode before the compute compile when `decodeImage` is
 * present, not by pre-warming a cache (which would go stale on atlas refresh).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { ResourceLoader } from 'bongle/engine-client';

export function createPipelineResourceLoader(resourcesClientDir: string): ResourceLoader {
    return {
        async loadBytes(url) {
            if (url.startsWith('http:') || url.startsWith('https:')) {
                return new Uint8Array(await (await fetch(url)).arrayBuffer());
            }
            const buf = readFileSync(path.join(resourcesClientDir, url));
            return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        },

        async decodeImage(bytes) {
            const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            return { width: info.width, height: info.height, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
        },
    };
}
