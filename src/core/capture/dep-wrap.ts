/**
 * core/capture/dep-wrap.ts, runtime helper for AST-injected dep wiring.
 *
 * The capture-transform pass walks each user module, scans the
 * body of every `prefab(...)` / `script(...)` consumer call for producer
 * identifier refs, and wraps the call with `__addDeps(call, [refs])`
 * when it finds any. At runtime this helper:
 *
 *   1. Reads `handle.dependency` to get the consumer's DepKey.
 *   2. Unions `deps.map(d => d.dependency)` into the existing dep set
 *      via `addDeps` (preserves user-supplied `deps:` already wired by
 *      the factory body).
 *   3. Returns the handle unchanged so the wrap is transparent.
 *
 * Kept separate from `dep-graph.ts` so the graph stays free of handle-
 * shape assumptions; this file is the single place that crosses the
 * boundary from "producer handle with `dependency`" to "raw DepKey".
 */

import { addDeps, type DepHandle } from './dep-graph';

export function __addDeps<H extends DepHandle>(handle: H, deps: ReadonlyArray<DepHandle>): H {
    if (deps.length > 0) {
        addDeps(
            handle.dependency,
            deps.map((d) => d.dependency),
        );
    }
    return handle;
}
