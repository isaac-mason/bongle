import { resetOwnerStack } from './module-scope';

type FlushHandler = () => void | Promise<void>;

const handlers = new Set<FlushHandler>();
let pending = false;

/**
 * Registers a flush handler; a single `requestFlush()` fans out to every registered handler. In the server env
 * both the engine's `applyRegistryChanges` and the asset pipeline pass are registered and both fire on each
 * cascade; the client env only registers the engine handler. Returns an unregister fn for explicit cleanup
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
        // flush handlers are engine-level reconciliation and must run at __prod__ scope; drop any module id a
        // thrown module body left on the owning-module stack so reindex-derived upserts aren't misattributed to it.
        resetOwnerStack();
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
