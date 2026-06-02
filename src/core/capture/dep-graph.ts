/**
 * core/capture/dep-graph.ts — producer→consumer edges across registries.
 *
 * Each registry can declare an `extractDeps(payload)` that returns the set
 * of (registry, id) producers a consumer payload depends on. `upsert`
 * routes through `setDeps`, which maintains forward (`producer → consumers`)
 * and reverse (`consumer → producers`) maps, diffing against the previous
 * dep set to detach stale reverse edges on every update.
 *
 * Dispatch reads `getDirtyConsumers(directlyChanged)` to expand a direct
 * pendingChanges set into the transitive set of consumers that need
 * reaction — covering the cases where the consumer's own hash didn't
 * change (closure-bound refs, AST-only refs) but a producer it relies on
 * did. Reaction still lives in `applyRegistryChanges*`; the graph only
 * answers "who is affected".
 *
 * Keys are encoded as `${registry}:${id}` strings for cheap set membership.
 */

export type DepKey = { registry: string; id: string };

/**
 * Any producer handle that carries a DepGraph `dependency` stamp. The
 * unified `deps: [...]` field on `prefab()` and `script()` accepts
 * anything matching this shape — scene, model, block, trait, command,
 * prefab handles, etc. — and reads `h.dependency` to build edges.
 */
export type DepHandle = { dependency: DepKey };

function encode(key: DepKey): string {
    return `${key.registry}:${key.id}`;
}

function decode(s: string): DepKey {
    const i = s.indexOf(':');
    return { registry: s.slice(0, i), id: s.slice(i + 1) };
}

/** producer → set of consumer keys */
const forward = new Map<string, Set<string>>();
/** consumer → set of producer keys (the consumer's current dep set) */
const reverse = new Map<string, Set<string>>();
/** bump on every mutation. dev-only debug surfaces poll this to know when
 *  to rebuild a snapshot — saves walking the maps every frame. */
let version = 0;

/**
 * Replace the consumer's dep set with `producers`. Detaches any stale
 * reverse edges, attaches any new ones. Returns `true` if the dep set
 * actually differed from the previous one — `upsert` uses this to elevate
 * a "content hash unchanged but deps shifted" case (e.g. a block model
 * factory that now closes over a different `BlockTextureDef`) into a
 * `changed` event on the consumer's registry. The dep set itself is the
 * signal, since neither the consumer's source nor the producer's content
 * moved.
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
 * Union `producers` into the consumer's existing dep set. Used by the
 * AST-injected `__addDeps(handle, [...])` wrap to add producer edges
 * detected in a consumer body without disturbing the dep set already
 * wired by the consumer factory itself (e.g. user-supplied `deps:` in
 * `prefab()` / `script()` options). Returns `true` if any new edge was
 * actually added.
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

/**
 * Forget every edge touching `consumer`. Called by the registry on
 * `removed` so its forward producers no longer list it.
 */
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
 * Return the transitive set of consumers affected by `producers` changing.
 * Walks forward edges breadth-first; a consumer is itself a producer for
 * its own consumers (e.g. blockTexture → block → scene), so the frontier
 * grows until no new entries appear.
 *
 * Result includes consumers only — producers passed in are not in the
 * output. Callers union with their direct `pendingChanges` set to get
 * the full reaction set.
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

/** Bumped on every setDeps/addDeps/clearDeps that actually changed an edge.
 *  Dev surfaces (debug panel deps tab) poll this to know when to rebuild
 *  their snapshot — saves walking the maps every frame. */
/** tests only — wipe all producer/consumer edges. */
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
    /** edges as producer → consumer pairs (forward direction). */
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
    // registered via reverse) — fold in too so the list view shows them.
    for (const consumerKey of reverse.keys()) nodeKeys.add(consumerKey);
    const nodes = Array.from(nodeKeys, decode);
    return { version, nodes, edges };
}

/**
 * For dispatch: take the union of direct producers (everything in each
 * registry's `pendingChanges` queue) and their transitive consumers, and
 * group by registry name. Used by side-specific `applyRegistryChanges*` to
 * scope reactions — e.g. extract the set of prefab IDs that need
 * re-instantiation, or the set of script IDs whose factory body must
 * re-run, without iterating every consumer in every room.
 *
 * Direct producers are included in the result alongside transitive
 * consumers so a single registry lookup covers both: a `prefabs:foo` that
 * appears in its own pendingChanges *and* a `prefabs:bar` reached via a
 * scene-dep edge both land in `result.get('prefabs')`.
 *
 * Result includes only registries that actually had dirty entries — empty
 * registries are absent. Callers default missing entries to an empty set.
 */
export type DispatchRegistry = {
    name: string;
    pendingChanges: ReadonlyArray<{ handle: { id: string } }>;
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
            set.add(ch.handle.id);
            directProducers.push({ registry: reg.name, id: ch.handle.id });
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
