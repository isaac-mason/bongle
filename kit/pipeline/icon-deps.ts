/**
 * On-demand dependency-closure for icon-render gating. Given an icon subject
 * (a prefab or scene), walk every producer it transitively depends on, so the
 * orchestrator can re-render only the icons a given edit actually invalidates
 * instead of all of them.
 *
 * Two dep sources are interleaved — neither always-on, both read here only
 * when gating runs:
 *   - prefabs → the runtime DepGraph's reverse edges (`directProducersOf`),
 *     which carry a prefab's declared `deps:` + AST-detected refs.
 *   - scenes  → the prefab ids the scene payload embeds
 *     (`extractScenePrefabDeps`). The DepGraph has no scene→prefab edges by
 *     design (scenes need none at runtime), so we compute them on demand.
 *
 * Models stay coarse (the caller folds all model versions into every icon
 * hash): a scene can reference a model via a MeshTrait without any dep edge,
 * so closure-tracking models would miss that. Model edits are rarer than
 * logic edits, so re-rendering all icons on a model change is an acceptable
 * trade for not walking every node tree for mesh refs.
 */

import { type DepKey, directProducersOf, extractScenePrefabDeps } from 'bongle/internal';
import type { PipelineInternal } from '../asset-pipeline/pipeline';

const encode = (k: DepKey): string => `${k.registry}:${k.id}`;

/** One hop of producers for a node in the closure walk. */
function directDeps(internal: PipelineInternal, node: DepKey): DepKey[] {
    if (node.registry === 'scenes') {
        // scenes carry no DepGraph edges — derive embedded prefabs from the
        // payload. (best-effort: a scene not yet in the registry returns none,
        // and its own bytes-hash still drives its icon.)
        const payload = internal.registry.scenes.byId.get(node.id)?.payload._payload;
        return payload ? extractScenePrefabDeps(payload) : [];
    }
    return directProducersOf(node);
}

/**
 * Transitive producer closure of `subject` (excluding the subject itself), as
 * `registry:id → DepKey`. Cycle-safe.
 */
export function iconDepClosure(internal: PipelineInternal, subject: DepKey): Map<string, DepKey> {
    const closure = new Map<string, DepKey>();
    const seen = new Set<string>([encode(subject)]);
    const frontier: DepKey[] = [subject];
    while (frontier.length > 0) {
        const node = frontier.pop()!;
        for (const producer of directDeps(internal, node)) {
            const key = encode(producer);
            if (seen.has(key)) continue;
            seen.add(key);
            closure.set(key, producer);
            frontier.push(producer);
        }
    }
    return closure;
}

/** A producer's current registry `version` (bumps on its content/dep-set
 *  change). -1 when absent — distinct from any real version, so a producer
 *  appearing/disappearing moves the digest. */
function producerVersion(internal: PipelineInternal, key: DepKey): number {
    const store = (internal.registry as unknown as Record<string, { byId: Map<string, { version: number }> }>)[
        key.registry
    ];
    return store?.byId.get(key.id)?.version ?? -1;
}

/**
 * Stable `[registry:id, version]` digest of a subject's closure — fold into
 * the icon hash so any change to a transitive dependency re-renders the icon.
 */
export function closureVersionDigest(internal: PipelineInternal, closure: Map<string, DepKey>): Array<[string, number]> {
    return Array.from(closure.keys())
        .sort()
        .map((key) => [key, producerVersion(internal, closure.get(key)!)]);
}
