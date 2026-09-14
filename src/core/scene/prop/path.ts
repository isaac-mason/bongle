export type PropPath = (string | number)[];

export function getAtPath(root: unknown, path: PropPath): unknown {
    let current = root;
    for (const key of path) {
        if (current === null || typeof current !== 'object') return undefined;
        current = (current as Record<string | number, unknown>)[key];
    }
    return current;
}

/** returns a rebuilt root; containers along `path` are copied, everything else is shared. */
export function setAtPath(root: unknown, path: PropPath, value: unknown): unknown {
    if (path.length === 0) return value;
    const [key, ...rest] = path;
    if (Array.isArray(root)) {
        const next = [...root];
        next[key as number] = setAtPath(root[key as number], rest, value);
        return next;
    }
    const record = (root ?? {}) as Record<string | number, unknown>;
    return { ...record, [key!]: setAtPath(record[key!], rest, value) };
}

export function samePath(a: PropPath, b: PropPath): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
