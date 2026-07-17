// build/mime.ts — content-type by file extension, for serving project files.
//
// The project-fs asset server exists in two hosts: the editor's ServiceWorker
// (public/sw.js, serving OPFS) and `bongle dev`'s node HTTP handler (serving disk).
// Both need this map. The SW is a raw, non-graph script so it CANNOT import this —
// it carries its own mirror (keep the two in sync); every graph consumer uses this.

const CONTENT_TYPE: Record<string, string> = {
    html: 'text/html',
    js: 'text/javascript',
    css: 'text/css',
    json: 'application/json',
    wasm: 'application/wasm',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    glb: 'model/gltf-binary',
    gltf: 'model/gltf+json',
    ogg: 'audio/ogg',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
};

/** the HTTP content-type for a path, by extension (octet-stream fallback). */
export function contentType(path: string): string {
    return CONTENT_TYPE[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
}
