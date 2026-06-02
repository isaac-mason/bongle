/**
 * dep-resolve.ts — cross-module symbol resolution for the DepGraph AST pass.
 *
 * Each user module's `SymbolTable` (built by `dep-ast.ts`) records imports
 * by raw spec (`'./scenes'`, `'bongle'`) and exports by name. The plugin
 * pre-resolves every spec via Rollup's `this.resolve()` and stamps the
 * normalised module id into `table.resolvedSources`. This module walks
 * those edges to answer:
 *
 *   "given local name `X` in module M, which producer DepKey (if any)
 *    does it refer to?"
 *
 * The walk terminates when:
 *   - the chain bottoms out at a `producer` binding (success — return its DepKey),
 *   - the chain leaves the resolved-module map (external / opaque — return null),
 *   - the chain hits a namespace import or an `unknown` binding (opaque — null),
 *   - we revisit a (moduleId, name) pair (cycle — null).
 *
 * Designed to be cheap: pure synchronous map walks over the plugin's
 * `SymbolTableRegistry`. The expensive part (calling `this.resolve()`) is
 * done once per module at transform time.
 */

import type { ArrowFunctionExpression, FunctionExpression } from 'estree';
import { collectIdentifierUses, type DepKey, type LocalBinding, type SymbolTable } from './dep-ast';

/**
 * Plugin-wide map of every module the capture-transform plugin has parsed,
 * keyed by Rollup's normalised module id. The plugin populates this from
 * its `transform` hook and queries it during dep extraction (Phase 3c).
 */
export type SymbolTableRegistry = Map<string, SymbolTable>;

/**
 * Resolve a local name in `table` to a producer DepKey by following the
 * binding to its origin module, then chasing re-export chains until a
 * `producer` is found. Returns null when the resolution is opaque.
 *
 * `visited` is a guard against re-export cycles (`./a` re-exports from
 * `./b` which re-exports from `./a`). Keys are `${moduleId}::${name}` to
 * track (module, name) pairs rather than just modules.
 */
export function resolveLocalName(
    table: SymbolTable,
    localName: string,
    registry: SymbolTableRegistry,
    visited: Set<string> = new Set(),
): DepKey | null {
    const binding = table.bindings.get(localName);
    if (!binding) return null;
    return resolveBinding(binding, table, registry, visited);
}

/**
 * Given a binding (already looked up from some module's `bindings`), keep
 * walking. Local producers terminate the chain; imports trampoline into
 * the imported module's exports.
 */
function resolveBinding(
    binding: LocalBinding,
    fromTable: SymbolTable,
    registry: SymbolTableRegistry,
    visited: Set<string>,
): DepKey | null {
    if (binding.kind === 'producer') {
        return { registry: binding.registry, id: binding.id };
    }
    if (binding.kind === 'import-named') {
        const targetId = fromTable.resolvedSources.get(binding.source);
        if (!targetId) return null;
        const targetTable = registry.get(targetId);
        if (!targetTable) return null;
        return resolveExportedName(targetTable, binding.importedName, registry, visited);
    }
    // `import-default`, `import-namespace`, and `unknown` are opaque for
    // dep tracking. Default exports are rarely producers; namespaces would
    // need a member-expression scan we deliberately don't do.
    return null;
}

/**
 * Look up `exportedName` in `table.exports` and follow it:
 *   - `local`              → recurse into `bindings.get(localName)`.
 *   - `reexport-named`     → trampoline into source module's export of `importedName`.
 *   - `reexport-namespace` → opaque (resolving member access on a namespace
 *                            re-export would require knowing the consumer's
 *                            access pattern, which we don't pass down here).
 *
 * Falls through to `starReexports` when no direct match exists.
 */
export function resolveExportedName(
    table: SymbolTable,
    exportedName: string,
    registry: SymbolTableRegistry,
    visited: Set<string>,
): DepKey | null {
    const visitKey = `${table.moduleId}::${exportedName}`;
    if (visited.has(visitKey)) return null;
    visited.add(visitKey);

    const direct = table.exports.get(exportedName);
    if (direct) {
        if (direct.kind === 'local') {
            const binding = table.bindings.get(direct.localName);
            if (!binding) return null;
            return resolveBinding(binding, table, registry, visited);
        }
        if (direct.kind === 'reexport-named') {
            const targetId = table.resolvedSources.get(direct.source);
            if (!targetId) return null;
            const targetTable = registry.get(targetId);
            if (!targetTable) return null;
            return resolveExportedName(targetTable, direct.importedName, registry, visited);
        }
        // reexport-namespace is opaque (see docstring).
        return null;
    }

    // No direct export — try each `export * from './path'` in declaration
    // order. First module that exports the name wins. We don't detect
    // ambiguous star-re-export collisions; that's the user's bug, not ours.
    for (const starSpec of table.starReexports) {
        const targetId = table.resolvedSources.get(starSpec);
        if (!targetId) continue;
        const targetTable = registry.get(targetId);
        if (!targetTable) continue;
        const hit = resolveExportedName(targetTable, exportedName, registry, visited);
        if (hit) return hit;
    }
    return null;
}

/* ── consumer dep extraction ────────────────────────────────────────── */

/**
 * Walk a consumer's function body (`prefab({ fn })` or `script(T, factory)`),
 * collect identifier references, and resolve each to a producer DepKey
 * paired with the local name (in the consumer module) used to refer to it.
 *
 * The `localName` is what Phase 3d injects into the rewritten `deps:[...]`
 * array — it must be the identifier as written in the consumer's source so
 * the resulting code still type-checks and the runtime gets a live handle
 * reference (not a DepKey string lookup).
 *
 * Pure composition of `collectIdentifierUses` and `resolveBinding`. Opaque
 * refs (helpers, dynamic lookups, namespace member access) silently drop.
 */
export function extractConsumerDeps(
    fn: ArrowFunctionExpression | FunctionExpression,
    table: SymbolTable,
    registry: SymbolTableRegistry,
): Array<{ dep: DepKey; localName: string }> {
    const uses = collectIdentifierUses(fn, table);
    // dedupe key — registry+id pair. A consumer that references the same
    // scene twice in its body should only register one edge.
    const seen = new Set<string>();
    const out: Array<{ dep: DepKey; localName: string }> = [];
    for (const use of uses) {
        let dep: DepKey | null = null;
        if (use.kind === 'producer') {
            dep = use.dep;
        } else if (use.kind === 'unresolved-import') {
            dep = resolveBinding(use.binding, table, registry, new Set());
        }
        if (!dep) continue;
        const key = `${dep.registry}::${dep.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ dep, localName: use.localName });
    }
    return out;
}
