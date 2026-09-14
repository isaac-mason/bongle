import type { Filesystem } from '../../os/interface';
import type { ResourceLoader } from '../core/resource-loader';

// baked client assets (atlases, model bins) land here; the render read-back
// loader roots bare names against it, mirroring how the client serves them from
// the document origin root.
const CLIENT_RESOURCES_DIR = 'resources/client';

async function loadUrlBytes(src: string): Promise<Uint8Array> {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`[bake-loader] fetch ${src}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
}

/**
 * fs-backed byte loader, shared by every browser pipeline loader. Passthroughs:
 * http/blob URLs are fetched; `file:` srcs (builtin engine assets, from an
 * `asset('./x', import.meta.url)` ref resolved under node) read the seeded vfs
 * file by pathname. Everything else is a project-relative path read off `fs`,
 * rooted at `base`.
 */
function createFsLoader(fs: Filesystem, base = ''): ResourceLoader {
    const prefix = base ? `${base}/` : '';
    return {
        async loadBytes(src: string): Promise<Uint8Array> {
            if (src.startsWith('http:') || src.startsWith('https:') || src.startsWith('blob:')) return loadUrlBytes(src);
            if (src.startsWith('file:')) return fs.read(new URL(src).pathname.replace(/^\/+/, ''));
            return fs.read(`${prefix}${src.replace(/^\.?\//, '')}`);
        },
    };
}

/** Reads bake inputs by their project-relative `src` (registry refs point at paths relative to the project root). */
export function createBakeLoader(fs: Filesystem): ResourceLoader {
    return createFsLoader(fs);
}

/**
 * Reads baked client assets back out of the project fs, the pipeline worker's in-worker icon
 * renderer uses this to fetch the atlas/model bins the bake just wrote. The engine requests these
 * by bare name (`voxels-atlas.png`); the live client resolves that to the origin root, which the
 * dev middleware maps onto `resources/client/`.
 */
export function createClientResourceLoader(fs: Filesystem): ResourceLoader {
    return createFsLoader(fs, CLIENT_RESOURCES_DIR);
}
