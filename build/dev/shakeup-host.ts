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
    /** Which modules are the user's OWN source. Three things key off it, all asking that one
     *  question: capture brackets them, an fs edit fans HMR for them, and only they get source
     *  maps — a seeded package's map would point at its built file, which is worth little and
     *  costs a full map plus a base64 `sourceMappingURL` on every module body, every boot, in
     *  every realm. Omit and shakeup applies its own node_modules default. */
    isUserModule?: (id: string) => boolean;
    /** Map a resolved asset path to a served URL, for `?url` imports. In the editor this is
     *  `projectUrl` (the project-fs service worker's `/@project/<path>`); the file is already in the
     *  vfs, so nothing is emitted. Omit to leave `?url` unhandled. */
    assetUrl?: (path: string) => string;
    /** Map a resolved `node_modules/**` module id to a URL the realm imports NATIVELY. When set, the
     *  dev server transforms and serves ONLY user modules: every dependency resolves to its URL as an
     *  external, the runner `import()`s it, and the browser parses, caches and dedupes it per realm.
     *  The seed is packed with relative specifiers for exactly this (scripts/pack-vfs.mjs). In the
     *  editor this is `projectUrl`, the same scheme `import.meta.url` already uses. Omit to serve
     *  everything through the runner (tests, hosts without a module-serving fs). */
    moduleUrl?: (path: string) => string;
    reportError?: (message: string) => void;
};

const NODE_MODULES = /(^|\/)node_modules\//;

/** Externalize every dependency to a natively importable URL. Runs after normal resolution
 *  (`this.resolve` skips this plugin), so package `exports`, extensions and the fs probe all apply
 *  as usual; only the RESULT is redirected. Importers are always user modules or the realm itself
 *  (`runner.import('bongle/env')`): a natively loaded module never calls back into the dev server,
 *  its own imports are relative and the browser resolves them. Left alone: unresolvable specifiers
 *  (surface as today), plugin-virtual ids (`\0...`), and anything outside node_modules. */
function nativeModulesPlugin(moduleUrl: (path: string) => string): Plugin {
    // The nested `this.resolve` re-runs every resolveId hook including this one (the dev server's
    // ctx does not skip the caller), so the inner call is tagged through `custom` and declined here.
    const SELF = 'bongle:native-modules';
    return {
        name: SELF,
        async resolveId(spec, importer, extra) {
            if (extra.custom?.[SELF]) return null;
            const r = await this.resolve(spec, importer, { kind: extra.kind, isEntry: extra.isEntry, custom: { [SELF]: true } });
            if (r === null || r.external || r.id.startsWith('\0') || !NODE_MODULES.test(r.id)) return r;
            return { id: moduleUrl(r.id), external: true };
        },
    };
}

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
        // Module ids are fs-RELATIVE (`src/index.ts`, `node_modules/bongle/dist/index.js`): that is
        // what the realms import, what `onFsChange` fans, and what bare-package resolution yields.
        // shakeup probes an importer-less entry against its resolver cwd first, and in a browser
        // that cwd defaults to `/`, so the entry resolved to `/src/index.ts` and every dep reached
        // from it to `/node_modules/...`. The OS apps are bare specifiers and resolve WITHOUT the
        // slash, so one realm evaluated two instances of the engine core: user code registered into
        // one registry and the engine booted the other (empty blocks, no config, dead HMR because
        // `handleChange('src/index.ts')` never matched `/src/index.ts`). An empty cwd keeps the
        // cwd-relative probe on the fs-relative id scheme.
        resolve: { cwd: '' },
        // `?worker` — bundled into a self-contained chunk via shakeup's OWN bundle() (no rolldown);
        // inline-vs-chunk is per-import (`?worker&inline`). The dev server has no output sink, so a
        // plain `?worker` falls back to an inline blob anyway (matching the old always-blob).
        plugins: [
            ...(opts.moduleUrl ? [nativeModulesPlugin(opts.moduleUrl)] : []),
            worker({ plugins: transforms, jsx: jsx ? {} : undefined }),
            ...transforms,
        ],
        // JSX HANDLING is keyed on the file extension (.tsx/.jsx) inside shakeup; this only carries
        // the lowering options (importSource, pure). `{}` takes the automatic-runtime defaults.
        jsx: jsx ? {} : undefined,
        sourcemap: opts.isUserModule,
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
