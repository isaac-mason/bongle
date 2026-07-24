// lib/editor/sw.ts — the project-fs asset service worker. Serves the editor's working
// copy at `<scope>@project/<path>` so project files work in DOM/URL contexts (`<img
// src>`, `?url`, `new URL(..., import.meta.url)`) without blob-URL juggling. Reads the
// working copy directly (same-origin, no round-trip to the page); read-through with
// `no-store` so dev edits show on the next load.
//
// Backend: OPFS first, then IndexedDB — mirroring openProjectFilesystem (fs-open.ts).
// Where OPFS is blocked (Firefox private windows / strict storage) the editor seeds
// files into the IDB fs instead, so the SW reads the same fallback. The IDB layout is
// the SHARED contract in fs-idb-store.ts — imported, not re-declared. Bundled by Vite
// via `?worker&url` (see project-url.ts), so this is a real module that shares that
// code rather than a hand-kept mirror.
//
// `@project` prefix, not `@fs` — Vite's dev server owns `/@fs/`, and this SW sits in
// front of the network.

import { getFileRow, openFsDbReadonly } from './fs-idb-store';

// Service Worker globals aren't in the DOM lib this project compiles with, and pulling
// in the webworker lib collides with it — so type the tiny surface we use.
type FetchLike = { request: Request; respondWith(r: Response | Promise<Response>): void };
type ExtendableLike = { waitUntil(p: Promise<unknown>): void };
const sw = self as unknown as {
    location: { origin: string };
    skipWaiting(): Promise<void>;
    clients: { claim(): Promise<void> };
    addEventListener(t: 'install' | 'activate', cb: (e: ExtendableLike) => void): void;
    addEventListener(t: 'fetch', cb: (e: FetchLike) => void): void;
};

const PROJECT_MARK = '/@project/';
// the single project subdir/db — matches editor/project.ts PROJECT_NAME. One dev
// project for now; when that generalises, carry the project in the URL.
const PROJECT_ROOT = 'project';

sw.addEventListener('install', () => sw.skipWaiting());
sw.addEventListener('activate', (event) => event.waitUntil(sw.clients.claim()));

sw.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== sw.location.origin) return;
    const at = url.pathname.indexOf(PROJECT_MARK);
    if (at === -1) return;
    // "<path…>" (project-relative) — everything after the marker.
    event.respondWith(serve(url.pathname.slice(at + PROJECT_MARK.length)));
});

async function serve(rel: string): Promise<Response> {
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
            // COEP is credentialless; same-origin CORP keeps the response usable in
            // the isolated editor doc (and its cross-origin embed).
            'Cross-Origin-Resource-Policy': 'same-origin',
            'Cache-Control': 'no-store',
        },
    });
}

// The backend is resolved ONCE per SW lifetime (OPFS or IDB), then every request reads
// from that established handle — no per-request storage probe or IDB open. Same OPFS-
// first decision as openProjectFilesystem, so the SW reads the backend the editor
// actually used. SWs are ephemeral: if the browser kills this one, module state resets
// and the next request re-establishes.
let backend: Promise<(parts: string[]) => Promise<Blob | null>> | null = null;
function getBackend() {
    if (!backend) backend = resolveBackend();
    return backend;
}

async function resolveBackend(): Promise<(parts: string[]) => Promise<Blob | null>> {
    try {
        // OPFS storage opens → the editor used OPFS too. Hold the root handle; each
        // read walks PROJECT_ROOT from it (finding files as they get seeded).
        const root = await navigator.storage.getDirectory();
        return (parts) => readOpfs(root, parts);
    } catch {
        // OPFS blocked (private/strict) → the editor fell back to IDB. Open the fs db
        // ONCE (read-only, no-create) and hold it; a null db just serves nothing.
        const db = await openFsDbReadonly(PROJECT_ROOT);
        return db ? (parts) => readIdb(db, parts) : () => Promise.resolve(null);
    }
}

async function readOpfs(root: FileSystemDirectoryHandle, parts: string[]): Promise<Blob | null> {
    try {
        let dir = await root.getDirectoryHandle(PROJECT_ROOT);
        for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
        return await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
    } catch {
        return null; // not seeded yet / absent
    }
}

async function readIdb(db: IDBDatabase, parts: string[]): Promise<Blob | null> {
    const row = await getFileRow(db, parts.join('/'));
    return row ? new Blob([row.bytes as BlobPart]) : null;
}

function notFound(): Response {
    return new Response('vfs: not found', { status: 404, headers: { 'Cross-Origin-Resource-Policy': 'same-origin' } });
}

function contentType(name: string): string {
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
