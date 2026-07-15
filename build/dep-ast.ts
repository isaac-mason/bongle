/**
 * dep-ast.ts — per-module symbol table builder for the DepGraph AST pass.
 *
 * Phase 3 of the DepGraph initiative (see lib/plan-depgraph.md). The
 * `bongle:capture-transform` plugin parses each user `.ts/.tsx` module
 * and asks this module to:
 *
 *   1. Classify imports: which local name binds to which (source, exportName).
 *      The raw source spec is captured here; the plugin pre-resolves each
 *      spec to a normalised module id via `this.resolve()` and stamps it
 *      into `resolvedSources`. The cross-module resolver in `dep-resolve.ts`
 *      uses that map plus the per-module `exports` to walk re-export chains.
 *
 *   2. Classify top-level declarations: `const X = scene('foo')` produces a
 *      `scenes:foo` symbol on local name `X`. Recognised producer calls are
 *      `scene/block/blockTexture/trait/command/model/prefab/matchmaking` and
 *      `blockPreset.<anything>` (presets all internally call `block`).
 *
 *   3. Classify exports: `export const X = …` is captured as a local export;
 *      `export { X } from './path'` and `export * from './path'` are captured
 *      as re-exports so the cross-module resolver can chase them.
 *
 *   4. Find consumer call sites — `prefab('id', { fn })` and
 *      `script(Trait, factory)` — and record the AST node of the function
 *      body for later identifier-scan.
 *
 * Output is a `SymbolTable`. Phase 3c walks it to extract per-consumer dep
 * lists; Phase 3d rewrites the source using `magic-string`.
 *
 * Conservative on purpose: aliased producer imports tracked; namespace
 * imports (`import * as M from 'bongle'`) tracked; re-export chains walked
 * via `dep-resolve.ts` once the plugin has populated table.resolvedSources.
 * Dynamic patterns (computed property access, indirection through helpers)
 * are left opaque — no false-positive deps.
 */

import type {
    ArrayExpression,
    ArrowFunctionExpression,
    CallExpression,
    ExportAllDeclaration,
    ExportNamedDeclaration,
    FunctionExpression,
    Identifier,
    ImportDeclaration,
    Program,
} from 'estree';

/* ── public types ───────────────────────────────────────────────────── */

/**
 * A producer key inside the DepGraph. Mirrors `DepKey` in the engine's
 * `core/capture/dep-graph.ts` — the plugin emits these and the engine
 * consumes them on equal terms.
 */
export type DepKey = { registry: string; id: string };

/**
 * What a local identifier in the module resolves to.
 *
 *  - `producer`     — a handle declared locally via `const X = scene('foo')` etc.
 *                     Carries its DepKey directly.
 *  - `import-named` — `import { Y } from './path'`. Phase 3b resolves the
 *                     source module and walks to the original producer.
 *  - `import-default` — `import Y from './path'`. Same resolution path.
 *  - `import-namespace` — `import * as N from './path'`. Member access
 *                     (`N.X`) requires looking up `X` in the resolved
 *                     module's exports.
 *  - `unknown`      — declared locally but not classifiable as a producer
 *                     (helper function, computed value, etc.). No dep.
 */
export type LocalBinding =
    | { kind: 'producer'; registry: string; id: string }
    | { kind: 'import-named'; source: string; importedName: string }
    | { kind: 'import-default'; source: string }
    | { kind: 'import-namespace'; source: string }
    | { kind: 'unknown' };

/**
 * One consumer call site discovered in the module body. Phase 3c walks
 * `bodyNode` to find producer references in the function's identifier
 * graph; Phase 3d uses `callStart`/`callEnd` (and `argsStart`/`argsEnd`)
 * to rewrite the source.
 */
export type ConsumerCall =
    | {
          kind: 'prefab';
          /** The prefab id (first arg literal). */
          id: string;
          /** The arrow/function expression passed as `fn`, or null if absent. */
          fnNode: ArrowFunctionExpression | FunctionExpression | null;
          /** Position of the entire `prefab(...)` call. */
          callStart: number;
          callEnd: number;
          /** Position of the options-object expression, for in-place rewrite. */
          optionsStart: number | null;
          optionsEnd: number | null;
          /**
           * The `deps` array-expression within options, if the user already
           * supplied one. Phase 3d unions AST-derived with user-supplied so
           * partial migration works (and we don't need a single transition
           * cycle where users have to delete their existing deps).
           */
          userSuppliedDeps: ArrayExpression | null;
      }
    | {
          kind: 'script';
          /** Local name of the trait handle passed as first arg (e.g. `GameplayTrait`). */
          traitLocalName: string;
          /** Position of `script(T, factory)` — used by the wrap rewrite. */
          callStart: number;
          callEnd: number;
          /** Position of the factory arg expression. */
          factoryStart: number | null;
          factoryEnd: number | null;
          /** The factory function AST. */
          factoryNode: ArrowFunctionExpression | FunctionExpression | null;
      };

/**
 * What an exported name in the module resolves to. The cross-module
 * resolver in `dep-resolve.ts` uses this to chase re-export chains.
 *
 *  - `local`              — `export const X = …` / `export { X }` where X is
 *                           declared in this module. `localName` keys back
 *                           into `bindings`.
 *  - `reexport-named`     — `export { Y as X } from './path'`. Resolver
 *                           jumps to the target module and looks up `Y`.
 *  - `reexport-namespace` — `export * as X from './path'`. Member access
 *                           on this export resolves to the target module's
 *                           export of that name.
 */
export type ExportedSymbol =
    | { kind: 'local'; localName: string }
    | { kind: 'reexport-named'; source: string; importedName: string }
    | { kind: 'reexport-namespace'; source: string };

export type SymbolTable = {
    /** Resolved module id (passed in by the caller). */
    moduleId: string;
    /** localName → binding classification. Populated from imports + top-level `const X = ...`. */
    bindings: Map<string, LocalBinding>;
    /**
     * exportedName → what it points to. Built from `export { X }` /
     * `export const X = …` / `export { Y as X } from './path'`.
     */
    exports: Map<string, ExportedSymbol>;
    /**
     * Raw source specs for `export * from './path'`. The resolver tries
     * each in order when a name isn't found in `exports`. We don't dedupe
     * against star clashes — first match wins, matching ESM semantics
     * loosely enough for dep tracking.
     */
    starReexports: string[];
    /**
     * Raw import/export source spec → resolved module id. Populated by the
     * plugin after `this.resolve()` runs on every spec the module mentions.
     * Bare specs (e.g. `'bongle'`) usually resolve to absolute paths;
     * unresolved specs (externals, missing files) are absent — the resolver
     * treats those as opaque dead-ends, not errors.
     */
    resolvedSources: Map<string, string>;
    /** Consumer calls we want to inject deps into. */
    consumers: ConsumerCall[];
};

/* ── producer call recognition ──────────────────────────────────────── */

/**
 * The public package user code imports producer factories from. Every
 * matcher in this module checks an identifier's import source against
 * this value so that a user-defined `function script() { … }` or
 * `import { script } from 'someone-elses-lib'` doesn't false-positive
 * as a bongle consumer call.
 *
 * `bongle/internal` is an engine-only entrypoint and does NOT re-export
 * producer factories, so it's deliberately excluded.
 *
 * Re-export chains (`import { script } from './my-barrel'` where the
 * barrel re-exports from 'bongle') require Phase 3b's `this.resolve()`
 * walk; for now they go untracked and the user gets the same behaviour
 * as before AST analysis was added.
 */
const BONGLE_PACKAGE = 'bongle';

/**
 * Map of producer factory names (as exported from `'bongle'`) to the
 * registry their return value lives in. The bongle package's public
 * `script`/`scene`/`block`/… exports are all flat at the package root, so
 * an `import { X } from 'bongle'` binding's `importedName` is exactly the
 * factory name.
 *
 * Single-keyed registries (matchmaking) use a fixed id matching the
 * runtime upsert call.
 */
const PRODUCER_FACTORIES: Record<string, { registry: string; fixedId?: string }> = {
    scene: { registry: 'scenes' },
    block: { registry: 'blocks' },
    blockTexture: { registry: 'blockTextures' },
    trait: { registry: 'traits' },
    command: { registry: 'commands' },
    model: { registry: 'models' },
    prefab: { registry: 'prefabs' },
    matchmaking: { registry: 'matchmaking', fixedId: 'main' },
};

/**
 * Namespace-style producer factories — `blockPreset.cube('id', ...)` etc.
 * Every method on these namespaces internally calls `block(id, ...)` so the
 * returned handle is always a block. We don't enumerate methods; any call
 * shape `<NS>.<anything>(STRING_LITERAL, ...)` qualifies as long as
 * `<NS>` resolves (via the binding map) to a known producer namespace
 * imported from `'bongle'`.
 */
const PRODUCER_NAMESPACES: Record<string, { registry: string }> = {
    blockPreset: { registry: 'blocks' },
};

/* ── import-binding predicates ──────────────────────────────────────── */

/**
 * Is `binding` a namespace import of the `'bongle'` package
 * (`import * as M from 'bongle'`)? Used to authorise member-expression
 * matchers like `M.script(...)` and `M.scene('id')`.
 */
function isBongleNamespaceImport(binding: LocalBinding | undefined): boolean {
    return binding?.kind === 'import-namespace' && binding.source === BONGLE_PACKAGE;
}

/* ── analysis entry point ───────────────────────────────────────────── */

export function buildSymbolTable(ast: Program, moduleId: string): SymbolTable {
    const table: SymbolTable = {
        moduleId,
        bindings: new Map(),
        exports: new Map(),
        starReexports: [],
        resolvedSources: new Map(),
        consumers: [],
    };

    // Pass 1: imports. Establishes alias bindings before we walk top-level
    // declarations so `const X = sceneAlias('foo')` resolves correctly even
    // when the import statement appears further up the file (it always does
    // in ESM, but be explicit anyway).
    for (const node of ast.body) {
        if (node.type === 'ImportDeclaration') {
            collectImportBindings(node, table);
        }
    }

    // Pass 2: top-level declarations. Recognises producer calls and stamps
    // the bound name. Variables we don't recognise stay un-recorded (default
    // is `unknown`); we only set explicit bindings for clarity in the table.
    // Also walks ExportNamedDeclaration to record both the binding (when the
    // initializer is a producer call) AND the local export.
    for (const node of ast.body) {
        if (node.type === 'VariableDeclaration') {
            for (const decl of node.declarations) {
                if (decl.id.type !== 'Identifier' || !decl.init) continue;
                const binding = classifyInitializer(decl.init, table);
                if (binding) table.bindings.set(decl.id.name, binding);
            }
        }
        // `export const X = scene('foo')` — record the binding AND the export.
        if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration') {
            for (const decl of node.declaration.declarations) {
                if (decl.id.type !== 'Identifier' || !decl.init) continue;
                const binding = classifyInitializer(decl.init, table);
                if (binding) table.bindings.set(decl.id.name, binding);
                table.exports.set(decl.id.name, { kind: 'local', localName: decl.id.name });
            }
        }
    }

    // Pass 3: exports. Re-export declarations (`export { X } from './path'`,
    // `export * from './path'`, `export * as N from './path'`) populate the
    // exports map for cross-module chasing. Plain `export { X }` (no source)
    // points to the local binding of the same name.
    for (const node of ast.body) {
        if (node.type === 'ExportNamedDeclaration') {
            collectNamedExports(node, table);
        } else if (node.type === 'ExportAllDeclaration') {
            collectStarExports(node, table);
        }
    }

    // Pass 4: walk every CallExpression in the module body looking for
    // consumer calls (prefab/script). Top-level only — nested consumer
    // calls (e.g. inside a function) are out of scope; the engine's
    // module-scope tracking already constrains where these can legally
    // appear.
    for (const node of ast.body) {
        walkForConsumers(node, table);
    }

    return table;
}

/* ── imports ────────────────────────────────────────────────────────── */

function collectImportBindings(node: ImportDeclaration, table: SymbolTable): void {
    if (typeof node.source.value !== 'string') return;
    const source = node.source.value;
    for (const spec of node.specifiers) {
        if (spec.type === 'ImportSpecifier') {
            // `import { foo as bar } from 'x'` — local name is `bar`, imported is `foo`.
            const importedName = spec.imported.type === 'Identifier' ? spec.imported.name : null;
            if (!importedName) continue;
            table.bindings.set(spec.local.name, {
                kind: 'import-named',
                source,
                importedName,
            });
        } else if (spec.type === 'ImportDefaultSpecifier') {
            table.bindings.set(spec.local.name, { kind: 'import-default', source });
        } else if (spec.type === 'ImportNamespaceSpecifier') {
            table.bindings.set(spec.local.name, { kind: 'import-namespace', source });
        }
    }
}

/* ── exports ────────────────────────────────────────────────────────── */

/**
 * `export { X }` / `export { X as Y }` / `export { Y as X } from './path'`.
 * The first two are local exports; the third is a re-export. When the
 * declaration has both `source` and specifiers, every specifier is a
 * re-export — local bindings are NOT consulted (mirroring ESM semantics).
 *
 * `export const X = …` is handled in pass 2 (the declaration variant), not
 * here. This function only deals with the *specifier* form.
 */
function collectNamedExports(node: ExportNamedDeclaration, table: SymbolTable): void {
    // `export const/let/var ...` was handled in pass 2 as a paired binding +
    // local export, so skip when there's an inline declaration.
    if (node.declaration) return;
    const source = node.source && typeof node.source.value === 'string' ? node.source.value : null;
    for (const spec of node.specifiers) {
        if (spec.type !== 'ExportSpecifier') continue;
        const localName = spec.local.type === 'Identifier' ? spec.local.name : null;
        const exportedName = spec.exported.type === 'Identifier' ? spec.exported.name : null;
        if (!localName || !exportedName) continue;
        if (source) {
            table.exports.set(exportedName, {
                kind: 'reexport-named',
                source,
                importedName: localName,
            });
        } else {
            table.exports.set(exportedName, { kind: 'local', localName });
        }
    }
}

/**
 * `export * from './path'` (added to `starReexports`) or
 * `export * as N from './path'` (added to `exports` as a namespace re-export).
 */
function collectStarExports(node: ExportAllDeclaration, table: SymbolTable): void {
    if (typeof node.source.value !== 'string') return;
    const source = node.source.value;
    if (node.exported && node.exported.type === 'Identifier') {
        table.exports.set(node.exported.name, { kind: 'reexport-namespace', source });
    } else {
        table.starReexports.push(source);
    }
}

/* ── initializer classification ─────────────────────────────────────── */

/**
 * Decide what the right-hand side of `const X = ...` binds to. Returns
 * `null` for shapes we don't track (treated as the absence of binding).
 *
 * Recognised producer call shapes:
 *   - `scene('foo')`                    via identifier `scene`
 *   - `sceneAlias('foo')`               via `import { scene as sceneAlias }`
 *   - `blockPreset.leaves('foo', ...)`  via namespace `blockPreset`
 *   - `M.scene('foo')`                  via `import * as M from 'bongle'`
 *     (when M's namespace import target eventually resolves to bongle —
 *     Phase 3b validates source; for now we accept any namespace member
 *     whose method name matches PRODUCER_FACTORIES and whose first arg is
 *     a string literal)
 */
function classifyInitializer(
    init: NonNullable<import('estree').VariableDeclarator['init']>,
    table: SymbolTable,
): LocalBinding | null {
    if (init.type !== 'CallExpression') return null;
    const call = init;

    // Shape 1: identifier callee — `scene('foo')` (only when `scene` is
    // imported from 'bongle'). resolveFactoryName enforces the source.
    if (call.callee.type === 'Identifier') {
        const factoryName = resolveFactoryName(call.callee.name, table);
        if (!factoryName) return null;
        const factory = PRODUCER_FACTORIES[factoryName];
        if (!factory) return null;
        return producerFromCall(factory, call);
    }

    // Shape 2: member-expression callee.
    if (call.callee.type === 'MemberExpression' && !call.callee.computed) {
        const obj = call.callee.object;
        const prop = call.callee.property;
        if (obj.type !== 'Identifier' || prop.type !== 'Identifier') return null;
        const objBinding = table.bindings.get(obj.name);

        // Namespace import of bongle: `import * as M from 'bongle'; M.scene('foo')`.
        if (isBongleNamespaceImport(objBinding) && prop.name in PRODUCER_FACTORIES) {
            return producerFromCall(PRODUCER_FACTORIES[prop.name]!, call);
        }

        // Producer namespace imported from bongle: `blockPreset.cube('id', …)`.
        const nsName = resolveNamespaceName(obj.name, table);
        if (nsName) {
            const registry = PRODUCER_NAMESPACES[nsName]!.registry;
            const idArg = call.arguments[0];
            if (!idArg || !isStringLiteral(idArg)) return null;
            return { kind: 'producer', registry, id: idArg.value };
        }
    }

    return null;
}

function producerFromCall(factory: { registry: string; fixedId?: string }, call: CallExpression): LocalBinding | null {
    if (factory.fixedId !== undefined) {
        return { kind: 'producer', registry: factory.registry, id: factory.fixedId };
    }
    const idArg = call.arguments[0];
    if (!idArg || !isStringLiteral(idArg)) return null;
    return { kind: 'producer', registry: factory.registry, id: idArg.value };
}

/**
 * Resolve a callee identifier to its canonical producer-factory name,
 * verifying the import source is `'bongle'`. Returns null when the
 * identifier isn't bound, isn't imported from bongle, or isn't a known
 * factory. Robust against shadowing — a user-defined `function scene() {}`
 * has no `import-named` binding, so it won't false-match.
 */
function resolveFactoryName(localName: string, table: SymbolTable): string | null {
    const binding = table.bindings.get(localName);
    if (!binding || binding.kind !== 'import-named') return null;
    if (binding.source !== BONGLE_PACKAGE) return null;
    if (binding.importedName in PRODUCER_FACTORIES) return binding.importedName;
    return null;
}

/**
 * Resolve an object identifier to its canonical producer-namespace name
 * (currently just `'blockPreset'`), verifying the import source is
 * `'bongle'`.
 */
function resolveNamespaceName(localName: string, table: SymbolTable): string | null {
    const binding = table.bindings.get(localName);
    if (!binding || binding.kind !== 'import-named') return null;
    if (binding.source !== BONGLE_PACKAGE) return null;
    if (binding.importedName in PRODUCER_NAMESPACES) return binding.importedName;
    return null;
}

/* ── consumer call discovery ────────────────────────────────────────── */

/**
 * Recursive walk over the top-level statement looking for `prefab(...)`
 * and `script(...)` calls. Both can appear as the initializer of a const
 * (`const X = prefab(...)`) or as a bare expression statement
 * (`script(T, fn)`). We don't recurse into function bodies — consumer
 * registration is a module-scope concern.
 */
function walkForConsumers(node: import('estree').Node, table: SymbolTable): void {
    if (node.type === 'VariableDeclaration') {
        for (const decl of node.declarations) {
            if (decl.init) inspectCall(decl.init, table);
        }
        return;
    }
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
        walkForConsumers(node.declaration, table);
        return;
    }
    if (node.type === 'ExportDefaultDeclaration') {
        // `export default prefab(...)` is unusual but handle it.
        if (node.declaration.type === 'CallExpression') inspectCall(node.declaration, table);
        return;
    }
    if (node.type === 'ExpressionStatement') {
        inspectCall(node.expression, table);
        return;
    }
}

function inspectCall(expr: import('estree').Expression, table: SymbolTable): void {
    if (expr.type !== 'CallExpression') return;

    // Identifier callee: `prefab(id, opts)` or `script(T, factory)` —
    // bound name must trace back to an `import { … } from 'bongle'`.
    if (expr.callee.type === 'Identifier') {
        const binding = table.bindings.get(expr.callee.name);
        if (!binding || binding.kind !== 'import-named') return;
        if (binding.source !== BONGLE_PACKAGE) return;
        if (binding.importedName === 'prefab') {
            const consumer = parsePrefabCall(expr);
            if (consumer) table.consumers.push(consumer);
        } else if (binding.importedName === 'script') {
            const consumer = parseScriptCall(expr);
            if (consumer) table.consumers.push(consumer);
        }
        return;
    }

    // Namespace member call: `M.prefab(...)` / `M.script(...)` where
    // `M` is `import * as M from 'bongle'`.
    if (expr.callee.type === 'MemberExpression' && !expr.callee.computed) {
        const obj = expr.callee.object;
        const prop = expr.callee.property;
        if (obj.type !== 'Identifier' || prop.type !== 'Identifier') return;
        if (!isBongleNamespaceImport(table.bindings.get(obj.name))) return;
        if (prop.name === 'prefab') {
            const consumer = parsePrefabCall(expr);
            if (consumer) table.consumers.push(consumer);
        } else if (prop.name === 'script') {
            const consumer = parseScriptCall(expr);
            if (consumer) table.consumers.push(consumer);
        }
    }
}

function parsePrefabCall(call: CallExpression): ConsumerCall | null {
    const idArg = call.arguments[0];
    const optsArg = call.arguments[1];
    if (!idArg || !isStringLiteral(idArg)) return null;
    const id = idArg.value;
    const callStart = (call as unknown as { start: number }).start;
    const callEnd = (call as unknown as { end: number }).end;

    if (!optsArg || optsArg.type !== 'ObjectExpression') {
        return {
            kind: 'prefab',
            id,
            fnNode: null,
            callStart,
            callEnd,
            optionsStart: null,
            optionsEnd: null,
            userSuppliedDeps: null,
        };
    }

    let fnNode: ArrowFunctionExpression | FunctionExpression | null = null;
    let userSuppliedDeps: ArrayExpression | null = null;
    for (const prop of optsArg.properties) {
        if (prop.type !== 'Property' || prop.key.type !== 'Identifier') continue;
        if (
            prop.key.name === 'fn' &&
            (prop.value.type === 'ArrowFunctionExpression' || prop.value.type === 'FunctionExpression')
        ) {
            fnNode = prop.value;
        }
        if (prop.key.name === 'deps' && prop.value.type === 'ArrayExpression') {
            userSuppliedDeps = prop.value;
        }
    }

    return {
        kind: 'prefab',
        id,
        fnNode,
        callStart,
        callEnd,
        optionsStart: (optsArg as unknown as { start: number }).start,
        optionsEnd: (optsArg as unknown as { end: number }).end,
        userSuppliedDeps,
    };
}

function parseScriptCall(call: CallExpression): ConsumerCall | null {
    const traitArg = call.arguments[0];
    const factoryArg = call.arguments[1];
    if (!traitArg || traitArg.type !== 'Identifier') return null;
    const callStart = (call as unknown as { start: number }).start;
    const callEnd = (call as unknown as { end: number }).end;

    if (!factoryArg) {
        return {
            kind: 'script',
            traitLocalName: traitArg.name,
            callStart,
            callEnd,
            factoryStart: null,
            factoryEnd: null,
            factoryNode: null,
        };
    }
    const factoryNode =
        factoryArg.type === 'ArrowFunctionExpression' || factoryArg.type === 'FunctionExpression' ? factoryArg : null;

    return {
        kind: 'script',
        traitLocalName: traitArg.name,
        callStart,
        callEnd,
        factoryStart: (factoryArg as unknown as { start: number }).start,
        factoryEnd: (factoryArg as unknown as { end: number }).end,
        factoryNode,
    };
}

/* ── utilities ──────────────────────────────────────────────────────── */

function isStringLiteral(node: import('estree').Node): node is import('estree').Literal & { value: string } {
    return node.type === 'Literal' && typeof (node as { value: unknown }).value === 'string';
}

/**
 * Walk a function body collecting identifier references that resolve to
 * producers via the symbol table. Used in Phase 3c to populate the dep
 * list for a `prefab({ fn })` or `script(T, factory)` call.
 *
 * Conservative:
 *   - Property access on a producer namespace import is NOT followed
 *     (e.g. `M.thing` where M is `import * as M from 'bongle'`); only
 *     direct identifier refs that themselves are producers count.
 *   - Identifiers that resolve to imports requiring cross-module lookup
 *     are returned as { localName, binding } so Phase 3b can later
 *     resolve them.
 *   - Nested function literals are walked too; closures-of-closures are
 *     in scope of the same module-level symbol table.
 */
export type IdentifierUse =
    | { kind: 'producer'; localName: string; dep: DepKey }
    | { kind: 'unresolved-import'; localName: string; binding: LocalBinding };

export function collectIdentifierUses(fn: ArrowFunctionExpression | FunctionExpression, table: SymbolTable): IdentifierUse[] {
    const seen = new Set<string>();
    const out: IdentifierUse[] = [];

    function visit(node: import('estree').Node | null | undefined): void {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            for (const child of node as unknown as import('estree').Node[]) visit(child);
            return;
        }
        if (typeof (node as { type?: unknown }).type !== 'string') return;

        // Identifier in expression position. Property names in MemberExpression
        // (when not computed) are syntactically Identifiers but don't reference
        // a binding — skip them. Object property keys (`{ foo: ... }`) likewise.
        if (node.type === 'Identifier') {
            recordIdentifier((node as Identifier).name, seen, out, table);
            return;
        }
        if (node.type === 'MemberExpression') {
            visit(node.object);
            if (node.computed) visit(node.property);
            // Non-computed property is just a name lookup — don't visit.
            return;
        }
        if (node.type === 'Property') {
            // Visit value; key is only visited when computed.
            if (node.computed) visit(node.key);
            visit(node.value);
            return;
        }

        // Generic walk: visit every child node.
        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'range' || key === 'parent') continue;
            visit((node as unknown as Record<string, unknown>)[key] as import('estree').Node);
        }
    }

    visit(fn.body);
    return out;
}

function recordIdentifier(name: string, seen: Set<string>, out: IdentifierUse[], table: SymbolTable): void {
    if (seen.has(name)) return;
    seen.add(name);
    const binding = table.bindings.get(name);
    if (!binding) return;
    if (binding.kind === 'producer') {
        out.push({ kind: 'producer', localName: name, dep: { registry: binding.registry, id: binding.id } });
        return;
    }
    if (binding.kind === 'import-named' || binding.kind === 'import-default' || binding.kind === 'import-namespace') {
        out.push({ kind: 'unresolved-import', localName: name, binding });
        return;
    }
}
