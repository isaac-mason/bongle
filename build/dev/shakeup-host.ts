// build/dev/shakeup-host.ts — the shakeup-backed bundler host: a drop-in for editor/dev/host.ts's
// createBundlerHost, assembled from shakeup's dev server + the capture plugin + the realm port
// bridge. ONE dev server (transform-once); realms attach over ports and evaluate their own
// instances. The editor injects the host bits: the project filesystem (OPFS — ASYNC, which
// shakeup's Fs is first-class), a report callback, and — on the RUNNER side — the browser
// evaluator / import.meta (shakeup-runner-host).

import { asset, createDevServer, css, type DevServer, type Fs, type Plugin, worker } from 'shakeup';
import { capturePlugin } from '../capture/capture-plugin';
import { attachRealmPort, type RealmPort } from './shakeup-port';

export type ShakeupHostOptions = {
    /** The project filesystem to serve. May be ASYNC (OPFS) — shakeup's Fs is first-class async,
     *  so the dev server reads it on-demand; no eager mirror or seed step. */
    fs: Fs;
    jsx?: boolean;
    /** Restrict capture to user project modules (seeded lib / node_modules skip it). */
    isUserModule?: (id: string) => boolean;
    /** Map a resolved asset path to a served URL, for `?url` imports. In the editor this is
     *  `projectUrl` (the project-fs service worker's `/@project/<path>`); the file is already in the
     *  vfs, so nothing is emitted. Omit to leave `?url` unhandled. */
    assetUrl?: (path: string) => string;
    reportError?: (message: string) => void;
};

export type ShakeupBundlerHost = {
    /** The shared dev server (transform cache + graph). */
    server: DevServer;
    /** Attach a realm's port (client iframe / server worker / pipeline). */
    connectRealm(name: string, port: RealmPort): void;
    /** Detach a realm whose process is gone. Realms are keyed per-process (`${ref}:${pid}`), so a
     *  respawn never reuses a name and nothing would otherwise drop the dead one: its environment
     *  would stay registered and every later edit would fan an applyEdit into a closed port. */
    disconnectRealm(name: string): void;
    /** Fan HMR to every realm holding a changed path (the live fs already reflects the edit). */
    onFsChange(paths: string[]): void;
    close(): void;
};

export function createShakeupBundlerHost(opts: ShakeupHostOptions): ShakeupBundlerHost {
    const jsx = opts.jsx ?? true;
    // The transforms a module (and a `?worker` graph) goes through: asset URLs, empty css,
    // __bongle capture. The worker plugin reuses THIS set for its nested bundle (minus itself, so a
    // worker importing a worker can't recurse).
    const transforms: Plugin[] = [
        ...(opts.assetUrl ? [asset({ url: opts.assetUrl })] : []),
        // engine `import './x.css'` — styles ship as the prebuilt bongle.css (injected by
        // client-main), so a css import is just an empty, resolved side-effect module.
        css({ mode: 'empty' }),
        capturePlugin({ isUserModule: opts.isUserModule }),
    ];
    const server = createDevServer({
        fs: opts.fs,
        // `?worker` — bundled into a self-contained chunk via shakeup's OWN bundle() (no rolldown);
        // inline-vs-chunk is per-import (`?worker&inline`). The dev server has no output sink, so a
        // plain `?worker` falls back to an inline blob anyway (matching the old always-blob).
        plugins: [worker({ plugins: transforms, jsx: jsx ? {} : undefined }), ...transforms],
        // JSX HANDLING is keyed on the file extension (.tsx/.jsx) inside shakeup; this only carries
        // the lowering options (importSource, pure). `{}` takes the automatic-runtime defaults.
        jsx: jsx ? {} : undefined,
        warn: opts.reportError,
    });
    const realms = new Map<string, { close(): void }>();

    return {
        server,
        connectRealm(name, port) {
            realms.get(name)?.close(); // a reconnect replaces the old attachment
            realms.set(name, attachRealmPort(server, name, port));
        },
        disconnectRealm(name) {
            realms.get(name)?.close();
            realms.delete(name);
        },
        onFsChange(paths) {
            // The async fs already reflects the edit; just invalidate the transform cache once and
            // fan applyEdit to every realm holding the file.
            for (const path of paths) {
                void server.handleChange(path).catch((e: unknown) => opts.reportError?.(String(e)));
            }
        },
        close() {
            for (const r of realms.values()) r.close();
            realms.clear();
        },
    };
}
