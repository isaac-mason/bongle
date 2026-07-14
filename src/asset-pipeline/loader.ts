// browser bake-input loader for the pipeline.
//
// Resolves a registry `src` ref to bytes: absolute URLs (starter / engine /
// content-pack assets, re-rooted to CDN by import.meta.url) are fetched;
// everything else is a project-relative path read from the project Filesystem.
// This is the `{ loader }` the pipeline reads bake inputs through in the
// browser worker (the node/disk loader is gone — browser-native only).

import type { ResourceLoader } from '../core/resource-loader';
import type { Filesystem } from './filesystem';

export function createBakeLoader(fs: Filesystem): ResourceLoader {
    return {
        async loadBytes(src: string): Promise<Uint8Array> {
            if (src.startsWith('http:') || src.startsWith('https:') || src.startsWith('blob:')) {
                const res = await fetch(src);
                if (!res.ok) throw new Error(`[bake-loader] fetch ${src}: ${res.status}`);
                return new Uint8Array(await res.arrayBuffer());
            }
            // builtin engine assets: `new URL(asset, import.meta.url)` resolves to
            // file:///node_modules/bongle/dist/assets/… in the realm → read the
            // seeded vfs file (its pathname, minus the leading slash).
            if (src.startsWith('file:')) return fs.read(new URL(src).pathname.replace(/^\/+/, ''));
            // project-relative (strip a leading ./ or /).
            return fs.read(src.replace(/^\.?\//, ''));
        },
    };
}
