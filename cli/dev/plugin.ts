// cli/dev/plugin.ts — the bongle() Vite plugin (CLI host).
//
// The runtime side of granular engine HMR, over the build/capture core.
//
// Two plugins:
//   • bongle:capture-transform — brackets every USER-src module with the __bongle
//     capture push/pop + a self-accept (import.meta.hot.accept → __bongle.reload →
//     invalidate-or-flush), AND runs the rung-2 dep-wrap (build/capture's
//     wrapModuleDeps injects __bongle.deps around prefab()/script() bodies so an
//     importer-cascade fires on shape change), via the shakeup-native capture
//     (build/capture/capture-native). Vite provides import.meta.hot natively, so
//     the emitted code runs unchanged here.
//   • bongle:engine-reboot — engine/workspace source (outside the project) has no
//     HMR accept boundary; on such a change we reboot the server env + respawn the
//     pipeline worker (via engineReboot), suppressing the client's racing reload.

import path from 'node:path';
import type { Plugin } from 'vite';
import { CAPTURE_POSTLUDE, CAPTURE_PRELUDE, initSymbolTables, wrapModuleDeps } from '../../build';

/** Set by the dev orchestrator (start.ts) so an engine-source change reboots the
 *  server env + respawns the pipeline worker. Omitted by non-dev consumers. */
export type EngineRebootRef = {
    requestServer: (() => void) | null;
    requestPipeline: (() => void) | null;
};

export type BongleOptions = {
    /** absolute project root; only files under `<projectDir>/src` are captured. */
    projectDir: string;
    engineReboot?: EngineRebootRef;
};

export function bongle(opts: BongleOptions): Plugin[] {
    const projectDir = path.resolve(opts.projectDir);
    const userSrcDir = path.join(projectDir, 'src') + path.sep;
    // per-module symbol table, shared across the capture transforms (the
    // cross-module resolver walks re-export chains across it).
    const symbolTables = initSymbolTables();

    return [
        {
            name: 'bongle:engine-reboot',
            hotUpdate(options) {
                // engine/workspace source = a changed file OUTSIDE the user project
                // (content/resources/user-src all live under projectDir). It has no
                // HMR accept boundary, so a plain HMR would leave a stale server
                // runner while clients reload to new code — a wire-format skew.
                if (options.file.startsWith(projectDir)) return; // default HMR
                if (this.environment.name === 'server') {
                    opts.engineReboot?.requestServer?.();
                    return []; // suppress the no-op server "full reload"
                }
                if (this.environment.name === 'pipeline') {
                    opts.engineReboot?.requestPipeline?.();
                    return [];
                }
                if (this.environment.name === 'client') {
                    // suppress the auto page-reload so it can't beat the async server
                    // reboot; start.ts sends the full-reload once the fresh server is up.
                    return [];
                }
                return undefined;
            },
        },
        {
            name: 'bongle:capture-transform',
            async transform(code, id) {
                const filePath = id.split('?')[0] ?? id;
                if (!filePath.startsWith(userSrcDir) || !/\.tsx?$/.test(filePath)) return null;

                // rung-2 dep-wrap: __bongle.deps around prefab()/script() bodies, so an
                // importer-cascade fires when a producer's shape changes. Swallow a
                // parse failure — it must not break the capture bracket.
                let wrapped = code;
                try {
                    wrapped = await wrapModuleDeps(filePath, code, symbolTables, async (spec) => {
                        const resolved = await this.resolve(spec, id);
                        return resolved?.id.split('?')[0] ?? spec;
                    });
                } catch (err) {
                    this.warn(`[bongle:capture] dep-wrap skipped for ${path.relative(projectDir, filePath)}: ${(err as Error).message}`);
                }

                return { code: CAPTURE_PRELUDE + wrapped + CAPTURE_POSTLUDE, map: null };
            },
        },
    ];
}
