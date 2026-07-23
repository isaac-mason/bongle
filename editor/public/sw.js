// editor/public/sw.js — the project-fs asset ServiceWorker.
//
// Serves the editor's working copy at `<scope>@project/<path>`, so project files
// are usable in DOM/URL contexts — `<img src>`, `?url`, `new URL(..., import.meta
// .url)` — which the editor otherwise only exposes as bytes (blob-URL juggling).
// Reads the working copy directly (same-origin, no round-trip to the page);
// read-through with `no-store` so dev edits show on the next load.
//
// Backend: OPFS first, then IndexedDB — mirroring openProjectFilesystem (fs-open.ts).
// Where OPFS is blocked (Firefox private windows / strict storage) the editor seeds
// files into the IDB fs instead, so the SW MUST read the same fallback or every
// `@project/` asset 404s (magenta textures) even though the editor booted fine.
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
    const parts = rel
        .split('/')
        .map((p) => decodeURIComponent(p))
        .filter(Boolean);
    if (parts.length === 0) return notFound();
    const read = await getBackend();
    const body = await read(parts);
    if (body == null) return notFound();
    return new Response(body, {
        headers: {
            'Content-Type': contentType(parts[parts.length - 1]),
            // COEP is credentialless; same-origin CORP keeps the response usable
            // in the isolated editor doc (and its cross-origin embed).
            'Cross-Origin-Resource-Policy': 'same-origin',
            'Cache-Control': 'no-store',
        },
    });
}

// The backend is resolved ONCE per SW lifetime (OPFS or IDB), then every request
// reads from that established handle — no per-request storage probe or IDB open.
// Same OPFS-first decision as openProjectFilesystem (fs-open.ts), so the SW always
// reads the backend the editor actually used. SWs are ephemeral: if the browser
// kills this one, module state resets and the next request re-establishes.
let backend;

function getBackend() {
    if (!backend) backend = resolveBackend();
    return backend;
}

// resolves to a `read(parts) → File | Uint8Array | null` bound to the live backend.
async function resolveBackend() {
    try {
        // OPFS storage opens → the editor used OPFS too. Hold the root handle; each
        // read walks PROJECT_ROOT from it (finding files as they get seeded).
        const root = await navigator.storage.getDirectory();
        return (parts) => readOpfs(root, parts);
    } catch {
        // OPFS blocked (private/strict) → the editor fell back to IDB. Open the fs db
        // ONCE and hold the connection; a null db just serves nothing.
        const db = await openFsDb();
        return db ? (parts) => readIdb(db, parts) : () => Promise.resolve(null);
    }
}

async function readOpfs(root, parts) {
    try {
        let dir = await root.getDirectoryHandle(PROJECT_ROOT);
        for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
        return await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
    } catch {
        return null; // not seeded yet / absent
    }
}

async function readIdb(db, parts) {
    try {
        const row = await request(db.transaction('files', 'readonly').objectStore('files').get(parts.join('/')));
        return row ? row.bytes : null;
    } catch {
        return null;
    }
}

function request(r) {
    return new Promise((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}

/** Open the fs IDB (fs-idb.ts: db `bongle-fs:<project>`, store `files`) read-only
 *  WITHOUT creating it: if the editor never used the IDB backend (OPFS session),
 *  abort the implicit create so we neither leave a phantom db nor pin a version
 *  that would block the editor's own store creation. Close on versionchange so a
 *  future editor upgrade isn't blocked by our held connection. */
function openFsDb() {
    return new Promise((resolve) => {
        const open = indexedDB.open(`bongle-fs:${PROJECT_ROOT}`);
        open.onupgradeneeded = () => open.transaction?.abort();
        open.onsuccess = () => {
            const db = open.result;
            db.onversionchange = () => db.close();
            resolve(db);
        };
        open.onerror = () => resolve(null); // abort/absent → nothing to serve
        open.onblocked = () => resolve(null);
    });
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
