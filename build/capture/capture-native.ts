// build/capture/capture-native.ts — the DepGraph capture pass, over shakeup's NATIVE AST.
//
// Parses with shakeup's `parse` and walks `N.*` nodes directly — no ESTree hop. A module's
// SymbolTable records its producer bindings and its consumer calls; each prefab()/script() consumer
// is then wrapped as `__bongle.deps(call, [() => ref, ...])` with the candidate producer references
// its body closes over.
//
// The refs are THUNKS, and which of them are really producers is decided at RUNTIME by
// `__addDeps` (src/core/capture/dep-wrap.ts) reading each value's `dependency` stamp. That split is
// deliberate. Proving "is this imported identifier a producer?" statically needs the producer
// module's symbol table, which only exists once that module has itself been transformed — and a dev
// server transforms top-down from the entry, so a consumer is always reached BEFORE the module it
// imports its producers from. The static answer is therefore "no" at exactly the moment it matters,
// and the edge silently never gets wired. At runtime the handle either carries a `dependency` or it
// doesn't, with no ordering to get wrong.
//
// So this pass is deliberately permissive: it emits a thunk for every identifier in a consumer body
// that could plausibly resolve to a handle (a local producer, or anything imported), and lets the
// runtime filter. A thunk that reads a binding still in TDZ (an import cycle) throws inside
// `__addDeps` and is skipped rather than taking down module evaluation.
//
// Consumers (`prefab`/`script`) are recognised only when their identifier binds to an import from
// `'bongle'` — a user's own `function script(){}` never false-positives.

import MagicString from 'magic-string';
import { N, type Node, parse, walk } from 'shakeup/ast';

const BONGLE_PACKAGE = 'bongle';

const PRODUCER_FACTORIES: Record<string, { registry: string; fixedId?: string }> = {
    scene: { registry: 'scenes' },
    block: { registry: 'blocks' },
    tile: { registry: 'tiles' },
    texture: { registry: 'textures' },
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

export type ConsumerCall = { kind: 'prefab' | 'script'; callStart: number; callEnd: number; bodyNode: Node | null };

export type SymbolTable = {
    moduleId: string;
    bindings: Map<string, LocalBinding>;
    consumers: ConsumerCall[];
};

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
    const table: SymbolTable = { moduleId, bindings: new Map(), consumers: [] };
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

    // Pass 2 — top-level declarations (incl. `export const X = producer()`): local producer bindings.
    const recordDeclarators = (decls: Node[]): void => {
        for (const decl of decls) {
            if (decl.type !== N.VariableDeclarator) continue;
            const id = decl.data.id as Node;
            const init = decl.data.init as Node | null;
            // A declarator binds via a BindingIdentifier (not IdentifierReference); destructuring
            // patterns have no `.name` → skipped (we don't track destructured producers).
            const name = nameOf(code, id);
            if (name === null || !init) continue;
            const binding = classifyInitializer(code, init, table);
            if (binding) table.bindings.set(name, binding);
        }
    };
    for (const node of body) {
        if (node.type === N.VariableDeclaration) recordDeclarators(node.data.declarations as Node[]);
        if (node.type === N.ExportNamedDeclaration) {
            const decl = node.data.declaration as Node | null;
            if (decl?.type === N.VariableDeclaration) recordDeclarators(decl.data.declarations as Node[]);
        }
    }

    // Pass 3 — consumer calls (prefab/script). TOP-LEVEL only (an ExpressionStatement, a declarator
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
 * The function body a consumer's deps are collected from: `script(Trait, 'id', factory)`'s factory
 * (3rd arg, when the trait arg is an identifier and the factory is a function), or `prefab('id',
 * { fn })`'s `fn` property. Returns null when the call shape doesn't qualify (→ no wrap).
 */
function consumerBody(code: string, call: Node, importedName: string): Node | null {
    if (call.type !== N.CallExpression) return null;
    const args = call.data.arguments as Node[];
    if (importedName === 'script') {
        // script(handle, scriptId, factory, opts?) — the scriptId is required, so the factory is
        // always the 3rd argument (a trailing `opts` object may follow it).
        const traitArg = args[0];
        if (!traitArg || traitArg.type !== N.IdentifierReference) return null;
        if (!args[1] || args[1].type !== N.StringLiteral) return null;
        const factory = args[2];
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

/**
 * Candidate producer expressions a consumer body closes over, in first-seen order (deduped).
 *
 * "Candidate", not "proven": a local producer binding, anything imported (its handle-ness lives in
 * the other module), and `ns.member` reads off a namespace import. `__addDeps` drops whatever turns
 * out not to carry a `dependency` at runtime, so over-including here costs one property read per
 * ref and under-including costs a missing edge — the asymmetry is why this leans permissive.
 */
function extractConsumerDeps(bodyNode: Node, table: SymbolTable): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (expr: string): void => {
        if (seen.has(expr)) return;
        seen.add(expr);
        out.push(expr);
    };
    // `false` prunes the subtree; anything else keeps walking.
    walk(bodyNode, (n): boolean => {
        // `ns.Enemy` off a namespace import — the handle is the MEMBER, not `ns`, so match the
        // member expression and prune so the bare `ns` underneath isn't collected separately.
        if (n.type === N.StaticMemberExpression) {
            const obj = n.data.object as Node;
            const prop = n.data.property as Node;
            if (obj.type !== N.IdentifierReference || prop.type !== N.IdentifierName) return true;
            if (table.bindings.get(obj.name)?.kind !== 'import-namespace') return true;
            add(`${obj.name}.${prop.name}`);
            return false;
        }
        if (n.type !== N.IdentifierReference) return true;
        const binding = table.bindings.get(n.name);
        if (binding === undefined) return true;
        if (binding.kind === 'producer' || binding.kind === 'import-named' || binding.kind === 'import-default') add(n.name);
        return true;
    });
    return out;
}

/**
 * Analyse a user module and return its source with `__bongle.deps(...)` wraps injected around
 * eligible prefab()/script() consumer calls. Pure and stateless: the wrap depends only on this
 * module's own text, so it can't vary with the order modules happen to be transformed in.
 * Parse failures fall back to the unwrapped source (a syntax error must not break the transform).
 */
export function wrapModuleDeps(id: string, code: string): string {
    const jsx = id.endsWith('.tsx') || id.endsWith('.jsx');
    const { program, errors } = parse(code, { ts: true, jsx });
    if (errors.length > 0) return code;

    const table = buildSymbolTable(program, code, id);

    let ms: MagicString | null = null;
    for (const consumer of table.consumers) {
        if (!consumer.bodyNode) continue;
        const refs = extractConsumerDeps(consumer.bodyNode, table);
        if (refs.length === 0) continue;
        ms ??= new MagicString(code);
        ms.appendLeft(consumer.callStart, '__bongle.deps(');
        // thunks, not values: deferring the read lets __addDeps survive a ref that's still in TDZ
        // (an import cycle) instead of throwing partway through the module body.
        ms.appendRight(consumer.callEnd, `, [${refs.map((r) => `() => ${r}`).join(', ')}])`);
    }

    return ms ? ms.toString() : code;
}
