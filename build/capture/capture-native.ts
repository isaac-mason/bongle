// build/capture/capture-native.ts — the DepGraph capture pass, over shakeup's NATIVE AST.
//
// Parses with shakeup's `parse` and walks `N.*` nodes directly — no ESTree hop. A module's
// SymbolTable records its producer bindings, its exports, and its consumer calls; cross-module
// resolution then wraps `__bongle.deps(call, [refs])` around prefab()/script() consumers whose
// bodies close over producer identifiers.
//
// Producer factories (`scene`/`block`/`trait`/…) and consumers (`prefab`/`script`) are recognised
// only when their identifier binds to an import from `'bongle'` — a user's own `function script(){}`
// never false-positives.

import MagicString from 'magic-string';
import { N, type Node, parse, walk } from 'shakeup';

const BONGLE_PACKAGE = 'bongle';

const PRODUCER_FACTORIES: Record<string, { registry: string; fixedId?: string }> = {
    scene: { registry: 'scenes' },
    block: { registry: 'blocks' },
    blockTexture: { registry: 'blockTextures' },
    trait: { registry: 'traits' },
    command: { registry: 'commands' },
    model: { registry: 'models' },
    prefab: { registry: 'prefabs' },
    config: { registry: 'config', fixedId: 'main' },
};
const PRODUCER_NAMESPACES: Record<string, { registry: string }> = { blockPreset: { registry: 'blocks' } };

export type LocalBinding =
    | { kind: 'producer'; registry: string; id: string | null }
    | { kind: 'import-named'; source: string; importedName: string }
    | { kind: 'import-default'; source: string }
    | { kind: 'import-namespace'; source: string }
    | { kind: 'unknown' };

export type ExportedSymbol =
    | { kind: 'local'; localName: string }
    | { kind: 'reexport-named'; source: string; importedName: string }
    | { kind: 'reexport-namespace'; source: string };

export type ConsumerCall = { kind: 'prefab' | 'script'; callStart: number; callEnd: number; bodyNode: Node | null };

export type SymbolTable = {
    moduleId: string;
    bindings: Map<string, LocalBinding>;
    exports: Map<string, ExportedSymbol>;
    starReexports: string[];
    resolvedSources: Map<string, string>;
    consumers: ConsumerCall[];
};
export type SymbolTableRegistry = Map<string, SymbolTable>;

export function initSymbolTables(): SymbolTableRegistry {
    return new Map();
}

/** The inner text of a string-literal node (quotes stripped). */
const strVal = (code: string, n: Node): string => code.slice(n.start + 1, n.end - 1);
/** An identifier-or-string node's name/value. */
function nameOf(code: string, n: Node | null | undefined): string | null {
    if (!n) return null;
    if (n.type === N.StringLiteral) return strVal(code, n);
    // IdentifierReference / IdentifierName both carry `.name`.
    const name = (n as unknown as { name?: string }).name;
    return typeof name === 'string' && name.length > 0 ? name : null;
}

/** Classify a variable initializer: is it a `trait('x')` / `blockPreset.cube('x')` producer call? */
function classifyInitializer(code: string, init: Node, table: SymbolTable): LocalBinding | null {
    if (init.type !== N.CallExpression) return null;
    const callee = init.data.callee as Node;
    const args = init.data.arguments as Node[];
    const firstId = args.length > 0 && args[0].type === N.StringLiteral ? strVal(code, args[0]) : null;

    // `trait('enemy')` — bare producer factory imported from 'bongle'.
    if (callee.type === N.IdentifierReference) {
        const binding = table.bindings.get(callee.name);
        if (binding?.kind === 'import-named' && binding.source === BONGLE_PACKAGE) {
            const factory = PRODUCER_FACTORIES[binding.importedName];
            if (factory) return { kind: 'producer', registry: factory.registry, id: factory.fixedId ?? firstId };
        }
        return null;
    }
    // `M.scene('id')` (bongle namespace) or `blockPreset.cube('id')` (producer namespace).
    if (callee.type === N.StaticMemberExpression) {
        const obj = callee.data.object as Node;
        const prop = callee.data.property as Node;
        if (obj.type !== N.IdentifierReference || prop.type !== N.IdentifierName) return null;
        const objBinding = table.bindings.get(obj.name);
        const propName = prop.name;
        if (objBinding?.kind === 'import-namespace' && objBinding.source === BONGLE_PACKAGE) {
            const factory = PRODUCER_FACTORIES[propName];
            if (factory) return { kind: 'producer', registry: factory.registry, id: factory.fixedId ?? firstId };
        }
        const ns = PRODUCER_NAMESPACES[obj.name];
        if (ns && objBinding?.kind === 'import-named' && objBinding.source === BONGLE_PACKAGE) {
            return { kind: 'producer', registry: ns.registry, id: firstId };
        }
    }
    return null;
}

export function buildSymbolTable(program: Node, code: string, moduleId: string): SymbolTable {
    const table: SymbolTable = {
        moduleId,
        bindings: new Map(),
        exports: new Map(),
        starReexports: [],
        resolvedSources: new Map(),
        consumers: [],
    };
    if (program.type !== N.Program) return table;
    const body = program.data.body as Node[];

    // Pass 1 — imports → bindings.
    for (const node of body) {
        if (node.type !== N.ImportDeclaration) continue;
        const source = nameOf(code, node.data.source as Node);
        if (source === null) continue;
        for (const spec of node.data.specifiers as Node[]) {
            if (spec.type === N.ImportSpecifier) {
                const local = nameOf(code, spec.data.local as Node);
                const importedName = nameOf(code, spec.data.imported as Node);
                if (local !== null && importedName !== null)
                    table.bindings.set(local, { kind: 'import-named', source, importedName });
            } else if (spec.type === N.ImportDefaultSpecifier) {
                const local = nameOf(code, spec.data.local as Node);
                if (local !== null) table.bindings.set(local, { kind: 'import-default', source });
            } else if (spec.type === N.ImportNamespaceSpecifier) {
                const local = nameOf(code, spec.data.local as Node);
                if (local !== null) table.bindings.set(local, { kind: 'import-namespace', source });
            }
        }
    }

    // Pass 2 — top-level declarations (incl. `export const X = producer()`): producer bindings + local exports.
    const recordDeclarators = (decls: Node[], isExport: boolean): void => {
        for (const decl of decls) {
            if (decl.type !== N.VariableDeclarator) continue;
            const id = decl.data.id as Node;
            const init = decl.data.init as Node | null;
            // A declarator binds via a BindingIdentifier (not IdentifierReference); destructuring
            // patterns have no `.name` → skipped (we don't track destructured producers).
            const name = nameOf(code, id);
            if (name === null) continue;
            if (init) {
                const binding = classifyInitializer(code, init, table);
                if (binding) table.bindings.set(name, binding);
            }
            if (isExport) table.exports.set(name, { kind: 'local', localName: name });
        }
    };
    for (const node of body) {
        if (node.type === N.VariableDeclaration) recordDeclarators(node.data.declarations as Node[], false);
        if (node.type === N.ExportNamedDeclaration) {
            const decl = node.data.declaration as Node | null;
            if (decl?.type === N.VariableDeclaration) recordDeclarators(decl.data.declarations as Node[], true);
        }
    }

    // Pass 3 — specifier-form exports + `export *`.
    for (const node of body) {
        if (node.type === N.ExportNamedDeclaration && (node.data.declaration as Node | null) === null) {
            const source = nameOf(code, node.data.source as Node | null);
            for (const spec of node.data.specifiers as Node[]) {
                if (spec.type !== N.ExportSpecifier) continue;
                const local = nameOf(code, spec.data.local as Node);
                const exported = nameOf(code, spec.data.exported as Node);
                if (local === null || exported === null) continue;
                table.exports.set(
                    exported,
                    source ? { kind: 'reexport-named', source, importedName: local } : { kind: 'local', localName: local },
                );
            }
        } else if (node.type === N.ExportAllDeclaration) {
            const source = nameOf(code, node.data.source as Node);
            if (source === null) continue;
            const exported = nameOf(code, node.data.exported as Node | null);
            if (exported !== null) table.exports.set(exported, { kind: 'reexport-namespace', source });
            else table.starReexports.push(source);
        }
    }

    // Pass 4 — consumer calls (prefab/script). TOP-LEVEL only (an ExpressionStatement, a declarator
    // init, or an export declaration) — nested calls are out of scope.
    // Callee is either `script`/`prefab` (import-named from 'bongle') or `M.script`/
    // `M.prefab` (member of a 'bongle' namespace import).
    const inspectCall = (expr: Node): void => {
        if (expr.type !== N.CallExpression) return;
        const callee = expr.data.callee as Node;
        let importedName: string | null = null;
        if (callee.type === N.IdentifierReference) {
            const b = table.bindings.get(callee.name);
            if (b?.kind === 'import-named' && b.source === BONGLE_PACKAGE) importedName = b.importedName;
        } else if (callee.type === N.StaticMemberExpression) {
            const obj = callee.data.object as Node;
            const prop = callee.data.property as Node;
            if (obj.type === N.IdentifierReference && prop.type === N.IdentifierName) {
                const b = table.bindings.get(obj.name);
                if (b?.kind === 'import-namespace' && b.source === BONGLE_PACKAGE) importedName = prop.name;
            }
        }
        if (importedName !== 'prefab' && importedName !== 'script') return;
        table.consumers.push({
            kind: importedName,
            callStart: expr.start,
            callEnd: expr.end,
            bodyNode: consumerBody(code, expr, importedName),
        });
    };
    const inspectStatement = (node: Node): void => {
        if (node.type === N.VariableDeclaration) {
            for (const decl of node.data.declarations as Node[]) {
                if (decl.type !== N.VariableDeclarator) continue;
                const init = decl.data.init as Node | null;
                if (init) inspectCall(init);
            }
        } else if (node.type === N.ExportNamedDeclaration) {
            const decl = node.data.declaration as Node | null;
            if (decl) inspectStatement(decl);
        } else if (node.type === N.ExportDefaultDeclaration) {
            const decl = node.data.declaration as Node;
            if (decl.type === N.CallExpression) inspectCall(decl);
        } else if (node.type === N.ExpressionStatement) {
            inspectCall(node.data.expression as Node);
        }
    };
    for (const node of body) inspectStatement(node);

    return table;
}

/**
 * The function body a consumer's deps are collected from: `script(Trait, factory)`'s factory
 * (2nd arg, when the trait arg is an identifier and the factory is a function), or `prefab('id',
 * { fn })`'s `fn` property. Returns null when the call shape doesn't qualify (→ no wrap).
 */
function consumerBody(code: string, call: Node, importedName: string): Node | null {
    if (call.type !== N.CallExpression) return null;
    const args = call.data.arguments as Node[];
    if (importedName === 'script') {
        const traitArg = args[0];
        if (!traitArg || traitArg.type !== N.IdentifierReference) return null;
        const factory = args[1];
        if (!factory) return null;
        return factory.type === N.ArrowFunctionExpression || factory.type === N.FunctionExpression ? factory : null;
    }
    // prefab
    const idArg = args[0];
    if (!idArg || idArg.type !== N.StringLiteral) return null;
    const opts = args[1];
    if (!opts || opts.type !== N.ObjectExpression) return null;
    for (const prop of opts.data.properties as Node[]) {
        if (prop.type !== N.ObjectProperty) continue;
        const keyName = nameOf(code, prop.data.key as Node);
        const val = prop.data.value as Node;
        if (keyName === 'fn' && (val.type === N.ArrowFunctionExpression || val.type === N.FunctionExpression)) return val;
    }
    return null;
}

/** Is `name` (in `table`) a producer — locally, or an import whose resolved module produces it? */
function isProducerRef(name: string, table: SymbolTable, registry: SymbolTableRegistry, seen = new Set<string>()): boolean {
    const key = `${table.moduleId}\0${name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const binding = table.bindings.get(name);
    if (!binding) return false;
    if (binding.kind === 'producer') return true;
    if (binding.kind === 'import-named') {
        const modId = table.resolvedSources.get(binding.source);
        if (modId === undefined) return false;
        const producerTable = registry.get(modId);
        if (producerTable === undefined) return false;
        return isProducerExport(binding.importedName, producerTable, registry, seen);
    }
    return false;
}

/** Is `exportName` a producer in `table` (following a local binding or a re-export chain)? */
function isProducerExport(exportName: string, table: SymbolTable, registry: SymbolTableRegistry, seen: Set<string>): boolean {
    const exp = table.exports.get(exportName);
    if (exp?.kind === 'reexport-named') {
        const modId = table.resolvedSources.get(exp.source);
        const next = modId !== undefined ? registry.get(modId) : undefined;
        return next !== undefined && isProducerExport(exp.importedName, next, registry, seen);
    }
    const localName = exp?.kind === 'local' ? exp.localName : exportName;
    return isProducerRef(localName, table, registry, seen);
}

/** Producer identifiers a consumer body closes over, in first-seen order (deduped). */
function extractConsumerDeps(bodyNode: Node, table: SymbolTable, registry: SymbolTableRegistry): string[] {
    const out: string[] = [];
    const seenNames = new Set<string>();
    walk(bodyNode, (n) => {
        if (n.type !== N.IdentifierReference) return;
        const name = n.name;
        if (seenNames.has(name)) return;
        if (isProducerRef(name, table, registry)) {
            seenNames.add(name);
            out.push(name);
        }
    });
    return out;
}

/**
 * Analyse a user module and return its source with `__bongle.deps(...)` wraps injected around
 * eligible prefab()/script() consumer calls; populates `registry` with the module's SymbolTable.
 * Parse failures fall back to the unwrapped source (a syntax error must not break the transform).
 */
export async function wrapModuleDeps(
    id: string,
    code: string,
    registry: SymbolTableRegistry,
    resolveSpec: (spec: string) => Promise<string>,
): Promise<string> {
    const jsx = id.endsWith('.tsx') || id.endsWith('.jsx');
    const { program, errors } = parse(code, { ts: true, jsx });
    if (errors.length > 0) return code;

    const table = buildSymbolTable(program, code, id);

    // Pre-resolve every import/re-export source spec to a module id.
    const specs = new Set<string>();
    for (const binding of table.bindings.values()) {
        if (binding.kind === 'import-named' || binding.kind === 'import-default' || binding.kind === 'import-namespace')
            specs.add(binding.source);
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
                /* unresolved → opaque */
            }
        }),
    );

    registry.set(id, table);

    let ms: MagicString | null = null;
    for (const consumer of table.consumers) {
        if (!consumer.bodyNode) continue;
        const refs = extractConsumerDeps(consumer.bodyNode, table, registry);
        if (refs.length === 0) continue;
        ms ??= new MagicString(code);
        ms.appendLeft(consumer.callStart, '__bongle.deps(');
        ms.appendRight(consumer.callEnd, `, [${refs.join(', ')}])`);
    }

    // Drop AST nodes now the wrap is done — the registry only reads bindings/exports/resolvedSources.
    table.consumers = [];

    return ms ? ms.toString() : code;
}
