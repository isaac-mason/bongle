// editor/project-url.ts — build a URL for a file in the project's OPFS working
// copy, served by the project-fs ServiceWorker (public/sw.js). Use for
// `<img src>`, `?url`, `new URL(...)` — a real fetchable URL, instead of reading
// bytes + createObjectURL.
//
// The prefix is `@project` (not `@fs`, which Vite's dev server owns). The
// project-name segment is omitted — there's one project and the SW opens its
// root. `import.meta.env.BASE_URL` is the editor's base ('/' in dev,
// '/static/bongle-editor/' deployed) = the SW's scope, so `<base>@project/…` lands
// in scope.

/** register the project-fs ServiceWorker (public/sw.js) at `<base>sw.js`, scope
 *  `<base>` (so it controls the editor's own `@project/` URLs). Call once at boot;
 *  no-ops where ServiceWorker is unavailable. */
export function registerProjectFsWorker(): void {
    if (!('serviceWorker' in navigator)) return;
    const base = import.meta.env.BASE_URL;
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch((err) => {
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
