/**
 * core/capture/flush.ts — debounced cross-module flush request.
 *
 * The bongle() plugin's transform injects `requestFlush()` into every
 * user module's `hot.accept` callback. A single HMR cascade can fire dozens
 * of accepts in quick succession; each calls `requestFlush()`. We coalesce
 * them onto one microtask, so every registered handler runs at most once
 * per cycle.
 *
 * Multiple handlers can coexist — every registration site adds its own
 * handler, and a single `requestFlush()` fans out to all of them. In the
 * gameServer env that means BOTH the engine's `applyRegistryChanges`
 * (registered by the boot template) AND the asset pipeline pass
 * (registered by the bongle:pipeline plugin) fire on each cascade. On the
 * client env only the engine handler is registered. The pipeline env has
 * no separate boot — it piggybacks on gameServer.
 *
 * `registerFlushHandler` returns an unregister fn. Boot entries that
 * might re-evaluate under HMR should use `import.meta.hot.dispose(unregister)`
 * to avoid accumulating duplicates; in practice the boot entries are
 * static during dev so this isn't currently load-bearing.
 *
 * Errors from a handler are caught and logged; a thrown handler must
 * not block siblings or leave the scheduler stuck (subsequent flushes
 * would silently no-op because `pending` stayed `true`).
 */

type FlushHandler = () => void | Promise<void>;

const handlers = new Set<FlushHandler>();
let pending = false;

/**
 * Register a flush handler. Returns an unregister fn for explicit cleanup
 * (e.g. `import.meta.hot.dispose`).
 */
export function registerFlushHandler(fn: FlushHandler): () => void {
    handlers.add(fn);
    return () => {
        handlers.delete(fn);
    };
}

/**
 * Schedule a flush. Multiple calls in the same microtask coalesce into one
 * fan-out invocation. No-op if no handler is registered yet (e.g. user
 * module evaluates before any boot entry registers).
 */
export function requestFlush(): void {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
        pending = false;
        for (const fn of handlers) {
            try {
                const r = fn();
                if (r && typeof (r as Promise<void>).catch === 'function') {
                    (r as Promise<void>).catch((err) => {
                        console.error('[bongle flush] handler rejected:', err);
                    });
                }
            } catch (err) {
                console.error('[bongle flush] handler threw:', err);
            }
        }
    });
}
