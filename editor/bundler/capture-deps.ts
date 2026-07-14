// editor/bundler/capture-deps.ts — the DepGraph AST pass for the in-browser
// dev server. Ported from kit's `bongle:capture-transform` (kit/vite/plugin.ts),
// which is retired in favour of the editor bundler.
//
// For every user `.ts/.tsx` module the dev server transforms, this pass:
//   1. parses it (oxc parseSync → an ESTree-compatible Program),
//   2. builds a per-module SymbolTable (dep-ast.ts) classifying producer
//      handles, imports/exports, and `prefab()`/`script()` consumer calls,
//   3. pre-resolves each import/re-export spec to a module id via the dev
//      server's own resolver (the editor equivalent of Vite's this.resolve),
//   4. wraps eligible consumer calls with `__kit.deps(call, [refs])` so the
//      engine DepGraph learns the source-blind producer→consumer edges
//      (a `script` re-runs when a trait/block/texture it references changes).
//
// The `__kit.deps` runtime helper (bongle/internal → core/capture/dep-wrap)
// already exists; this pass only decides which identifiers go in the array.
//
// Cross-module resolution is best-effort on cold load: resolving an imported
// producer needs that module's SymbolTable already in the registry. A consumer
// transformed before a producer it imports (import order in the graph) misses
// that edge until it next re-transforms — at which point the whole graph is in
// the registry and the wrap is complete. Same-module producers always resolve.
// This mirrors kit's semantics; a settle-pass could close the cold-load gap if
// a real miss ever surfaces.

import { parseSync } from '@rolldown/browser/experimental';
import type { Program } from 'estree';
import MagicString from 'magic-string';
import { buildSymbolTable } from './dep-ast';
import { extractConsumerDeps, type SymbolTableRegistry } from './dep-resolve';

const KNOWN_EXT = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;

export type { SymbolTableRegistry } from './dep-resolve';

/** the plugin-wide table registry: module id → its SymbolTable. */
export function initSymbolTables(): SymbolTableRegistry {
    return new Map();
}

/**
 * Analyse a user module and return its source with `__kit.deps(...)` wraps
 * injected around eligible consumer calls. Populates `registry` with the
 * module's SymbolTable as a side effect. Parse failures fall back to the
 * unwrapped source — a syntax error in user code must not break the transform.
 *
 * `resolveSpec` maps an import spec (as written) to the module id the dev
 * server resolves it to, so the cross-module resolver can walk re-export
 * chains without re-implementing resolution. It should mirror whatever id
 * form keys `registry` (the dev server's fs-relative module ids).
 */
export async function wrapModuleDeps(
    id: string,
    code: string,
    registry: SymbolTableRegistry,
    resolveSpec: (spec: string) => Promise<string>,
): Promise<string> {
    const fname = KNOWN_EXT.test(id) ? id : `${id}.ts`;
    let table: ReturnType<typeof buildSymbolTable>;
    try {
        // oxc emits an ESTree-compatible AST (Literal / Identifier node types,
        // start/end offsets) — the shape dep-ast.ts targets. Cast through the
        // binding's own Program type, matching kit's `this.parse(...) as Program`.
        const { program } = parseSync(fname, code);
        table = buildSymbolTable(program as unknown as Program, id);
    } catch {
        return code;
    }

    // Pre-resolve every import/re-export source spec to a module id so the
    // cross-module resolver never resolves anything itself. Specs that resolve
    // to non-user modules (bongle, bare npm) simply have no table in the
    // registry — the resolver treats those as opaque dead-ends, which is right.
    const specs = new Set<string>();
    for (const binding of table.bindings.values()) {
        if (binding.kind === 'import-named' || binding.kind === 'import-default' || binding.kind === 'import-namespace') {
            specs.add(binding.source);
        }
    }
    for (const exp of table.exports.values()) {
        if (exp.kind === 'reexport-named' || exp.kind === 'reexport-namespace') specs.add(exp.source);
    }
    for (const spec of table.starReexports) specs.add(spec);
    await Promise.all(
        [...specs].map(async (spec) => {
            try {
                table.resolvedSources.set(spec, await resolveSpec(spec));
            } catch {
                // unresolved → leave absent; resolver treats as opaque
            }
        }),
    );

    registry.set(id, table);

    // Inject `__kit.deps(...)` around eligible prefab()/script() calls.
    const rewritten = wrapConsumerCalls(code, table, registry);

    // Drop the consumer AST nodes now the wrap is done — they are the ONLY
    // field that holds rolldown parse nodes. Those nodes carry lazy-accessor
    // functions (e.g. `() => ({ moduleReference, ... })`) that are NOT
    // structured-cloneable, and they pin the parse buffer alive. This table
    // lives on in the long-lived `symbolTables` registry (for cross-module
    // resolution, which only reads bindings/exports/resolvedSources), so
    // leaving the nodes in would leak the parse buffer across the whole module
    // graph and risk a non-cloneable node escaping over a worker boundary.
    // After this, every retained table is pure plain data.
    table.consumers = [];

    return rewritten ?? code;
}

/**
 * Wrap every `prefab(...)` / `script(...)` call whose body closes over
 * producer identifiers with `__kit.deps(call, [refs])`. Returns the rewritten
 * source, or null when no wrap was needed.
 *
 * The runtime helper reads `handle.dependency` off the call's return value and
 * unions the refs into the DepGraph, leaving any user-supplied `deps:` the
 * factory already wired untouched. The wrap preserves the call's return value
 * so `export const X = prefab(...)` assignments still work.
 */
function wrapConsumerCalls(code: string, table: ReturnType<typeof buildSymbolTable>, registry: SymbolTableRegistry): string | null {
    let ms: MagicString | null = null;
    for (const consumer of table.consumers) {
        const bodyNode = consumer.kind === 'prefab' ? consumer.fnNode : consumer.factoryNode;
        if (!bodyNode) continue;

        const all = extractConsumerDeps(bodyNode, table, registry);
        if (all.length === 0) continue;

        const names = all.map((d) => d.localName).join(', ');
        ms ??= new MagicString(code);
        ms.appendLeft(consumer.callStart, '__kit.deps(');
        ms.appendRight(consumer.callEnd, `, [${names}])`);
    }
    return ms ? ms.toString() : null;
}
