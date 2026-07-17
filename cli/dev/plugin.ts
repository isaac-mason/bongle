// cli/dev/plugin.ts — the bongle() Vite plugin (CLI host).
//
// The runtime side of granular engine HMR, resurrected from the pre-pivot
// kit/vite/plugin.ts (commit 0ca35db) against the current build/capture core.
//
// Two plugins:
//   • bongle:capture-transform — brackets every USER-src module with the __kit
//     capture push/pop + a self-accept (import.meta.hot.accept → __kit.reload →
//     invalidate-or-flush), AND runs the rung-2 dep-wrap (build/capture's
//     wrapModuleDeps injects __kit.deps around prefab()/script() bodies so an
//     importer-cascade fires on shape change). Same contract as the editor
//     mini-bundler's transform (build/dev/transform.ts) — Vite provides
//     import.meta.hot natively, so the emitted code runs unchanged here.
//   • bongle:engine-reboot — engine/workspace source (outside the project) has no
//     HMR accept boundary; on such a change we reboot the server env + respawn the
//     pipeline worker (via engineReboot), suppressing the client's racing reload.

import path from 'node:path';
import { parseSync } from 'rolldown/experimental';
import type { Plugin } from 'vite';
import { type DepParser, initSymbolTables, wrapModuleDeps } from '../../build';

// the capture dep-wrap's parser: NATIVE node rolldown (not @rolldown/browser, whose
// wasi binding logs an ExperimentalWarning + loads a multi-MB wasm bundle in node).
const depParser = parseSync as unknown as DepParser;

const PRELUDE = `import { __kit } from 'bongle/internal';
const __kit_prev = __kit.push(import.meta.url);
`;

const POSTLUDE = `
;__kit.pop(__kit_prev);
if (import.meta.hot) {
  import.meta.hot.accept((__kit_next) => {
    if (__kit.reload(import.meta.url, __kit_next) === 'invalidate') {
      import.meta.hot.invalidate();
    }
    __kit.flush();
  });
}
`;

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

                // rung-2 dep-wrap: __kit.deps around prefab()/script() bodies, so an
                // importer-cascade fires when a producer's shape changes. Swallow a
                // parse failure — it must not break the capture bracket.
                let wrapped = code;
                try {
                    wrapped = await wrapModuleDeps(
                        filePath,
                        code,
                        symbolTables,
                        async (spec) => {
                            const resolved = await this.resolve(spec, id);
                            return resolved?.id.split('?')[0] ?? spec;
                        },
                        depParser,
                    );
                } catch (err) {
                    this.warn(`[bongle:capture] dep-wrap skipped for ${path.relative(projectDir, filePath)}: ${(err as Error).message}`);
                }

                return { code: PRELUDE + wrapped + POSTLUDE, map: null };
            },
        },
    ];
}
