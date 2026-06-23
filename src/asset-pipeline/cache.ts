// Shared helpers for hash-gating asset-pipeline tasks.
//
// Each task computes a deterministic hash of its inputs (registry slices,
// prefab defs, scene payloads, atlas hash, etc.), fetches the existing
// generated manifest's `hash` field, and short-circuits with a `cached`
// marker on hit. The cli-side artifact writer no-ops on cached results.

/**
 * JSON.stringify replacer that yields stable, comparable output for
 * inputs that the standard serializer mishandles:
 *   - typed arrays (Uint8Array/Uint16Array/...) are flattened to plain
 *     number arrays so different ArrayBuffer instances with identical
 *     contents hash the same
 *   - Maps and Sets are sorted and tagged so insertion-order does not
 *     leak into the hash
 *
 * Plain Arrays and Objects fall through to the default serializer,
 * which preserves their ordering (Arrays are explicit, Objects use
 * insertion order — keep that in mind when building hash inputs).
 */
function stableReplacer(_key: string, value: unknown): unknown {
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
        return Array.from(value as unknown as Iterable<number>);
    }
    if (value instanceof Map) {
        const entries = Array.from(value.entries()).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        return { __map: entries };
    }
    if (value instanceof Set) {
        const items = Array.from(value).sort();
        return { __set: items };
    }
    return value;
}

/** SHA-256 hex of a deterministically-serialized JSON value. */
export async function sha256Json(input: unknown): Promise<string> {
    const json = JSON.stringify(input, stableReplacer);
    const bytes = new TextEncoder().encode(json);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}
