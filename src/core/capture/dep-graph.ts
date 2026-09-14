export type DepKey = { registry: string; id: string };

/** Any producer handle that carries a DepGraph `dependency` stamp; the unified `deps: [...]` field on `prefab()` and `script()` accepts anything matching this shape and reads `h.dependency` to build edges. */
export type DepHandle = { dependency: DepKey };

function encode(key: DepKey): string {
    return `${key.registry}:${key.id}`;
}

function decode(s: string): DepKey {
    const i = s.indexOf(':');
    return { registry: s.slice(0, i), id: s.slice(i + 1) };
}

/** producer key to set of consumer keys */
const forward = new Map<string, Set<string>>();
/** consumer key to set of producer keys (the consumer's current dep set) */
const reverse = new Map<string, Set<string>>();
/** bump on every mutation. dev-only debug surfaces poll this to know when
 *  to rebuild a snapshot, saves walking the maps every frame. */
let version = 0;

/**
 * Replaces the consumer's dep set with `producers`, detaching stale reverse edges and attaching new ones.
 * Returns true when the dep set differed from the previous one; `upsert` uses this to elevate a "content hash
 * unchanged but deps shifted" case (e.g. a block model factory now closing over a different `TileHandle`) into
 * a `changed` event, since the dep set itself is the signal there.
 */
export function setDeps(consumer: DepKey, producers: DepKey[]): boolean {
    const consumerKey = encode(consumer);
    const newProducers = new Set(producers.map(encode));
    const oldProducers = reverse.get(consumerKey);

    let changed = false;

    if (oldProducers) {
        for (const producerKey of oldProducers) {
            if (newProducers.has(producerKey)) continue;
            changed = true;
            const consumers = forward.get(producerKey);
            if (!consumers) continue;
            consumers.delete(consumerKey);
            if (consumers.size === 0) forward.delete(producerKey);
        }
    } else if (newProducers.size > 0) {
        changed = true;
    }

    for (const producerKey of newProducers) {
        if (oldProducers?.has(producerKey)) continue;
        changed = true;
        let consumers = forward.get(producerKey);
        if (!consumers) {
            consumers = new Set();
            forward.set(producerKey, consumers);
        }
        consumers.add(consumerKey);
    }

    if (newProducers.size === 0) reverse.delete(consumerKey);
    else reverse.set(consumerKey, newProducers);

    if (changed) version++;
    return changed;
}

/**
 * Unions `producers` into the consumer's existing dep set. Used by the AST-injected `__addDeps(handle, [...])`
 * wrap to add producer edges detected in a consumer body without disturbing the dep set already wired by the
 * consumer factory itself (e.g. user-supplied `deps:` in `prefab()`/`script()` options).
 */
export function addDeps(consumer: DepKey, producers: DepKey[]): boolean {
    if (producers.length === 0) return false;
    const consumerKey = encode(consumer);
    let existing = reverse.get(consumerKey);
    let changed = false;
    for (const producer of producers) {
        const producerKey = encode(producer);
        if (existing?.has(producerKey)) continue;
        changed = true;
        if (!existing) {
            existing = new Set();
            reverse.set(consumerKey, existing);
        }
        existing.add(producerKey);
        let consumers = forward.get(producerKey);
        if (!consumers) {
            consumers = new Set();
            forward.set(producerKey, consumers);
        }
        consumers.add(consumerKey);
    }
    if (changed) version++;
    return changed;
}

/** Forgets every edge touching `consumer`. Called by the registry on `removed` so its forward producers no longer list it. */
export function clearDeps(consumer: DepKey): void {
    const consumerKey = encode(consumer);
    const oldProducers = reverse.get(consumerKey);
    if (!oldProducers) return;
    for (const producerKey of oldProducers) {
        const consumers = forward.get(producerKey);
        if (!consumers) continue;
        consumers.delete(consumerKey);
        if (consumers.size === 0) forward.delete(producerKey);
    }
    reverse.delete(consumerKey);
    version++;
}

/**
 * Returns the transitive set of consumers affected by `producers` changing, walking forward edges
 * breadth-first (a consumer is itself a producer for its own consumers, e.g. texture -> tile -> block -> scene).
 * Result includes consumers only; producers passed in are not in the output. Callers union with their direct
 * `pendingChanges` set to get the full reaction set.
 */
export function getDirtyConsumers(producers: DepKey[]): DepKey[] {
    const seen = new Set<string>();
    const out: DepKey[] = [];
    const frontier: string[] = producers.map(encode);

    while (frontier.length > 0) {
        const producerKey = frontier.pop()!;
        const consumers = forward.get(producerKey);
        if (!consumers) continue;
        for (const consumerKey of consumers) {
            if (seen.has(consumerKey)) continue;
            seen.add(consumerKey);
            out.push(decode(consumerKey));
            frontier.push(consumerKey);
        }
    }

    return out;
}

/** Test/debug helper. Returns true if `producer` has any registered consumers. */
export function hasConsumers(producer: DepKey): boolean {
    return forward.has(encode(producer));
}

/**
 * The consumer's direct producers (one hop of its current dep set). On-demand
 * read of the reverse map, pays nothing unless called. Used by tooling that
 * needs to walk a consumer's dependency closure itself (e.g. the offline icon
 * pipeline deciding which icons a producer edit invalidates), rather than the
 * forward `getDirtyConsumers` propagation the runtime uses.
 */
export function directProducersOf(consumer: DepKey): DepKey[] {
    const producers = reverse.get(encode(consumer));
    return producers ? Array.from(producers, decode) : [];
}

/** tests only, wipe all producer/consumer edges. */
export function _reset(): void {
    forward.clear();
    reverse.clear();
    version = 0;
}

export function getDepGraphVersion(): number {
    return version;
}

export type DepGraphSnapshot = {
    version: number;
    /** every node that appears in the graph (consumer or producer), de-duped. */
    nodes: DepKey[];
    /** edges as producer/consumer pairs (forward direction). */
    edges: Array<{ producer: DepKey; consumer: DepKey }>;
};

/**
 * One-shot snapshot of the current graph for dev visualization. Returns
 * decoded DepKey arrays so the consumer doesn't need to know the internal
 * `registry:id` string encoding.
 */
export function snapshotDepGraph(): DepGraphSnapshot {
    const nodeKeys = new Set<string>();
    const edges: Array<{ producer: DepKey; consumer: DepKey }> = [];
    for (const [producerKey, consumers] of forward) {
        nodeKeys.add(producerKey);
        for (const consumerKey of consumers) {
            nodeKeys.add(consumerKey);
            edges.push({ producer: decode(producerKey), consumer: decode(consumerKey) });
        }
    }
    // consumers with no producers (or producers with no consumers but
    // registered via reverse), fold in too so the list view shows them.
    for (const consumerKey of reverse.keys()) nodeKeys.add(consumerKey);
    const nodes = Array.from(nodeKeys, decode);
    return { version, nodes, edges };
}

/**
 * For dispatch: takes the union of direct producers (everything in each registry's `pendingChanges` queue) and
 * their transitive consumers, grouped by registry name, so side-specific `applyRegistryChanges*` can scope
 * reactions without iterating every consumer in every room. Direct producers are included alongside transitive
 * consumers so a single registry lookup covers both. Result includes only registries with dirty entries;
 * callers default missing entries to an empty set.
 */
export type DispatchRegistry = {
    name: string;
    pendingChanges: ReadonlyArray<{ id: string }>;
};
export function collectDirtyByRegistry(regs: ReadonlyArray<DispatchRegistry>): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    const directProducers: DepKey[] = [];
    for (const reg of regs) {
        if (reg.pendingChanges.length === 0) continue;
        let set = out.get(reg.name);
        for (const ch of reg.pendingChanges) {
            if (!set) {
                set = new Set();
                out.set(reg.name, set);
            }
            set.add(ch.id);
            directProducers.push({ registry: reg.name, id: ch.id });
        }
    }
    if (directProducers.length === 0) return out;
    for (const consumer of getDirtyConsumers(directProducers)) {
        let set = out.get(consumer.registry);
        if (!set) {
            set = new Set();
            out.set(consumer.registry, set);
        }
        set.add(consumer.id);
    }
    return out;
}
