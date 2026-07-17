// editor/public/sw.js — the project-fs asset ServiceWorker.
//
// Serves the editor's OPFS working copy at `<scope>@project/<path>`, so project
// files are usable in DOM/URL contexts — `<img src>`, `?url`, `new URL(...,
// import.meta.url)` — which the editor otherwise only exposes as bytes (blob-URL
// juggling). Reads OPFS directly (same-origin, no round-trip to the page);
// read-through with `no-store` so dev edits show on the next load.
//
// `@project` prefix, not `@fs` — Vite's dev server owns `/@fs/` (out-of-root
// module serving), and this SW is in front of the network. Plain JS in public/
// (not the vite graph) so it works identically in dev + the static build.

const PROJECT_MARK = '/@project/';
// the single OPFS project subdir — matches editor/project.ts PROJECT_NAME. One
// dev project for now; when that generalises, carry the project in the URL.
const PROJECT_ROOT = 'project';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    const at = url.pathname.indexOf(PROJECT_MARK);
    if (at === -1) return;
    // "<path…>" (project-relative) — everything after the marker.
    const rel = url.pathname.slice(at + PROJECT_MARK.length);
    event.respondWith(serve(rel));
});

async function serve(rel) {
    try {
        const parts = rel
            .split('/')
            .map((p) => decodeURIComponent(p))
            .filter(Boolean);
        if (parts.length === 0) return notFound();
        let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(PROJECT_ROOT);
        for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
        const handle = await dir.getFileHandle(parts[parts.length - 1]);
        const file = await handle.getFile();
        return new Response(file, {
            headers: {
                'Content-Type': contentType(parts[parts.length - 1]),
                // COEP is credentialless; same-origin CORP keeps the response usable
                // in the isolated editor doc (and its cross-origin embed).
                'Cross-Origin-Resource-Policy': 'same-origin',
                'Cache-Control': 'no-store',
            },
        });
    } catch {
        return notFound();
    }
}

function notFound() {
    return new Response('vfs: not found', { status: 404, headers: { 'Cross-Origin-Resource-Policy': 'same-origin' } });
}

// mirror of build/mime.ts contentType — a raw SW can't import the graph, so keep
// the two maps in sync.
function contentType(name) {
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    return (
        {
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
            json: 'application/json',
            wasm: 'application/wasm',
            js: 'text/javascript',
            css: 'text/css',
        }[ext] ?? 'application/octet-stream'
    );
}
