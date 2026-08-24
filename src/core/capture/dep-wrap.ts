/**
 * core/capture/dep-wrap.ts, runtime helper for AST-injected dep wiring.
 *
 * The capture-transform pass walks each user module, scans the
 * body of every `prefab(...)` / `script(...)` consumer call for candidate
 * producer refs, and wraps the call with `__addDeps(call, [() => ref, ...])`.
 * At runtime this helper:
 *
 *   1. Reads `handle.dependency` to get the consumer's DepKey.
 *   2. Reads each thunk and keeps the values that carry a `dependency` of
 *      their own, unioning them into the existing dep set via `addDeps`
 *      (preserves user-supplied `deps:` already wired by the factory body).
 *   3. Returns the handle unchanged so the wrap is transparent.
 *
 * THIS is where producer-ness is decided. The transform pass can't answer it:
 * proving an imported identifier is a producer needs the exporting module's
 * symbol table, which doesn't exist yet when a dev server transforms top-down
 * from the entry and reaches a consumer before its producers. So the pass
 * emits candidates and the filtering happens here, where a handle either has
 * a `dependency` stamp or it doesn't and no ordering can get it wrong.
 *
 * Refs arrive as thunks so a binding still in TDZ (an import cycle) throws
 * inside this helper, where it costs one skipped edge, rather than during the
 * consumer call's argument evaluation, where it would abort the module body.
 *
 * Kept separate from `dep-graph.ts` so the graph stays free of handle-
 * shape assumptions; this file is the single place that crosses the
 * boundary from "producer handle with `dependency`" to "raw DepKey".
 */

import { addDeps, type DepHandle, type DepKey } from './dep-graph';

/** A value is a producer iff it carries the DepGraph `dependency` stamp every handle gets. */
function depKeyOf(value: unknown): DepKey | null {
    if (typeof value !== 'object' || value === null) return null;
    const dep = (value as { dependency?: unknown }).dependency;
    if (typeof dep !== 'object' || dep === null) return null;
    const { registry, id } = dep as DepKey;
    return typeof registry === 'string' && typeof id === 'string' ? (dep as DepKey) : null;
}

export function __addDeps<H extends DepHandle>(handle: H, refs: ReadonlyArray<() => unknown>): H {
    if (refs.length === 0 || depKeyOf(handle) === null) return handle;
    const producers: DepKey[] = [];
    for (const read of refs) {
        let value: unknown;
        try {
            value = read();
        } catch {
            continue; // uninitialised binding (import cycle) — no edge to add for it
        }
        const key = depKeyOf(value);
        if (key !== null) producers.push(key);
    }
    if (producers.length > 0) addDeps(handle.dependency, producers);
    return handle;
}
