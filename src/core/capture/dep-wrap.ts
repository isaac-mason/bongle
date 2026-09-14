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
            continue; // uninitialised binding (import cycle), no edge to add for it
        }
        const key = depKeyOf(value);
        if (key !== null) producers.push(key);
    }
    if (producers.length > 0) addDeps(handle.dependency, producers);
    return handle;
}
