// editor/project-url.ts — build a URL for a file in the project's working copy,
// served by the project-fs ServiceWorker (lib/editor/sw.ts). Use for `<img src>`,
// `?url`, `new URL(...)` — a real fetchable URL, instead of reading bytes +
// createObjectURL.
//
// The prefix is `@project` (not `@fs`, which Vite's dev server owns). The
// project-name segment is omitted — there's one project and the SW opens its
// root. `import.meta.env.BASE_URL` is the editor's base ('/' both in dev and
// deployed) = the SW's scope, so `<base>@project/…` lands in scope.

// The SW is bundled by Vite (`?worker&url`) so it can share fs-idb-store.ts with the
// editor's fs — a real module, not a hand-kept public/sw.js mirror. This gives us a
// URL that Vite serves in dev and emits in build, uniformly.
import swUrl from './sw?worker&url';

/** register the project-fs ServiceWorker so it controls the editor's own `@project/`
 *  URLs. Call once at boot; no-ops where ServiceWorker is unavailable.
 *
 *  The bundled script isn't at the origin root, so we widen scope to `<base>` — which
 *  requires `Service-Worker-Allowed: <base>` on the script response. That header is
 *  set by the dev vite plugin (standalone `vite dev`), scripts/dev-static-server.mjs
 *  (dev.sh), and the editor.<zone> edge rule (prod). */
export function registerProjectFsWorker(): void {
    if (!('serviceWorker' in navigator)) return;
    const base = import.meta.env.BASE_URL;
    navigator.serviceWorker.register(swUrl, { type: 'module', scope: base }).catch((err) => {
        console.warn('[project-fs] service worker registration failed', err);
    });
}

/** URL for `path` (project-relative) served by the project-fs SW. Pass a
 *  `version` to cache-bust on edit (the SW sends no-store, but a stable src won't
 *  re-fetch on the same element without a changed URL). */
export function projectUrl(path: string, version?: number): string {
    const segments = path.replace(/^\/+/, '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const base = `${import.meta.env.BASE_URL}@project/${segments}`;
    return version === undefined ? base : `${base}?v=${version}`;
}
