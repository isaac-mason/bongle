// docs generator — expands authored markdown templates into committed docs.
//
//   template/guide.template.md  ->  guide.md   (read top-to-bottom guide)
//   template/api.template.md    ->  api.md     (curated API reference)
//
// templates are hand-authored (thematic ordering + prose); a small set of
// tags pull real signatures / source / example code out of the live engine
// so the docs can't drift from the API. extraction is pure TypeScript
// compiler API (no reflection, no ts-morph):
//
//   <Render select="api/transforms:setPosition" />
//       render one selected symbol's signature inline. `select` is
//       "module:symbol" (module is a path under src, e.g. "api/transforms")
//       or just "symbol" for a global lookup. the module scope is what lets
//       re-export aliases resolve to their real declaration. curation lives
//       in the template: you list each symbol you want, in the order you want.
//       flags: `heading` prefixes a `#### \`name\`` heading (reference style);
//       `source` renders the full body instead of just the signature;
//       `as="ns"` prefixes the display name (for namespaced exports).
//   <Snippet source="transforms.snippet.ts" select="place-node" />
//       a region of a *.snippet.ts file (resolved relative to this dir)
//       marked with /* SNIPPET_START: name */ ... /* SNIPPET_END: name */.
//       these files are a typechecked workspace package (see package.json /
//       tsconfig.json) so a stale snippet fails `pnpm -C lib docs`.
//
// forked from ~/Development/mathcat/docs/build.js, extended for bongle's
// flat re-export barrel (api/* and builtins/* re-export from core/builtins,
// so exported names must be resolved to their real declarations).

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const templateDir = path.dirname(new URL(import.meta.url).pathname);
const docsDir = path.join(templateDir, '..');
const libDir = path.join(docsDir, '..');
const srcDir = path.join(libDir, 'src');

// ── build a program over the whole engine source ────────────────────

function getAllSourceFiles(dir) {
    let files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files = files.concat(getAllSourceFiles(fullPath));
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
            files.push(fullPath);
        }
    }
    return files;
}

const sourceFiles = getAllSourceFiles(srcDir);

const tsProgram = ts.createProgram(sourceFiles, {
    allowJs: false,
    declaration: true,
    emitDeclarationOnly: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    strict: true,
    noEmit: true,
});

// ── module export resolution ────────────────────────────────────────

// resolve a relative module specifier from a file to an absolute .ts path
function resolveModule(fromFile, spec) {
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
        if (sourceFiles.includes(candidate)) return candidate;
    }
    return null;
}

// collect a module's public exports in source order. handles:
//   export function/const/type/class/interface  (direct)
//   export { a, b as c } from './x'             (named re-export)
//   export { a, b }                             (local named export)
//   export * from './x'                         (wildcard, recursed)
//   export * as ns from './x'                   (namespaced wildcard)
// returns [{ exportName, localName, originFile }].
function collectModuleExports(file, prefix = '', seen = new Set()) {
    if (seen.has(file)) return [];
    seen.add(file);

    const sf = tsProgram.getSourceFile(file);
    if (!sf) {
        console.warn('couldnt get sourcefile for', file);
        return [];
    }

    const exports = [];
    for (const node of sf.statements) {
        // export { ... } [from '...']  and  export * [as ns] from '...'
        if (ts.isExportDeclaration(node)) {
            const origin = node.moduleSpecifier ? resolveModule(file, node.moduleSpecifier.text) : file;

            if (!node.exportClause) {
                // export * from './x'
                if (origin) exports.push(...collectModuleExports(origin, prefix, seen));
                continue;
            }
            if (ts.isNamespaceExport(node.exportClause)) {
                // export * as ns from './x'
                const ns = node.exportClause.name.text;
                if (origin) exports.push(...collectModuleExports(origin, `${prefix}${ns}.`, seen));
                continue;
            }
            // export { a, b as c } [from '...']
            for (const el of node.exportClause.elements) {
                const exportName = el.name.text;
                const localName = el.propertyName?.text ?? exportName;
                exports.push({ exportName: `${prefix}${exportName}`, localName, originFile: origin ?? file });
            }
            continue;
        }

        // direct exported declarations
        const isExported = ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (!isExported) continue;

        if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) {
            exports.push({ exportName: `${prefix}${node.name.text}`, localName: node.name.text, originFile: file });
        } else if (ts.isVariableStatement(node)) {
            for (const decl of node.declarationList.declarations) {
                if (decl.name && ts.isIdentifier(decl.name)) {
                    exports.push({ exportName: `${prefix}${decl.name.text}`, localName: decl.name.text, originFile: file });
                }
            }
        }
    }
    return exports;
}

// ── signature / source extraction (declaration-level, no body) ──────

function printSignature(node, sourceFile, fileText, displayName) {
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });
    const jsDoc = ts
        .getJSDocCommentsAndTags(node)
        .map((doc) => fileText.slice(doc.pos, doc.end))
        .join('')
        .trim();

    let sigStr = '';
    if (ts.isFunctionDeclaration(node)) {
        sigStr = printer.printNode(
            ts.EmitHint.Unspecified,
            ts.factory.createFunctionDeclaration(node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, undefined),
            sourceFile,
        );
    } else if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
        sigStr = printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
    }
    if (!sigStr) return null;
    // re-export aliases (`x as y`): present under the exported name.
    if (displayName && node.name && displayName !== node.name.text) {
        sigStr = sigStr.replace(node.name.text, displayName);
    }
    return (jsDoc ? `${jsDoc}\n` : '') + sigStr;
}

// extract a signature for a name. `scopeFile` narrows the search to the
// declaration's origin module to avoid same-name collisions across the tree.
function getType(typeName, scopeFile = null, displayName = null) {
    const checker = tsProgram.getTypeChecker();
    let found = null;

    function visit(node, sourceFile, fileText) {
        if (found) return;
        if ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === typeName) {
            found = printSignature(node, sourceFile, fileText, displayName);
        } else if (ts.isFunctionDeclaration(node) && node.name?.text === typeName && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
            found = printSignature(node, sourceFile, fileText, displayName);
        } else if (ts.isVariableStatement(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
            for (const decl of node.declarationList.declarations) {
                if (!decl.name || !ts.isIdentifier(decl.name) || decl.name.text !== typeName) continue;
                const jsDoc = ts.getJSDocCommentsAndTags(node).map((d) => fileText.slice(d.pos, d.end)).join('').trim();
                const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });
                const init = decl.initializer;
                const name = displayName ? ts.factory.createIdentifier(displayName) : decl.name;
                if (init && (ts.isFunctionExpression(init) || ts.isArrowFunction(init))) {
                    const sigNode = ts.factory.createFunctionDeclaration(
                        [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
                        undefined, name, init.typeParameters, init.parameters,
                        init.type ?? checker.typeToTypeNode(checker.getTypeAtLocation(init), node, ts.NodeBuilderFlags.NoTruncation),
                        undefined,
                    );
                    found = (jsDoc ? `${jsDoc}\n` : '') + printer.printNode(ts.EmitHint.Unspecified, sigNode, sourceFile);
                } else {
                    const varNode = ts.factory.createVariableStatement(
                        [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
                        ts.factory.createVariableDeclarationList([ts.factory.createVariableDeclaration(name, undefined, decl.type, undefined)], node.declarationList.flags),
                    );
                    found = (jsDoc ? `${jsDoc}\n` : '') + printer.printNode(ts.EmitHint.Unspecified, varNode, sourceFile);
                }
            }
        }
        if (!found) ts.forEachChild(node, (child) => visit(child, sourceFile, fileText));
    }

    const files = scopeFile ? [scopeFile] : sourceFiles.map((f) => tsProgram.getSourceFile(f)).filter(Boolean);
    for (const sf of files) {
        visit(sf, sf, sf.getFullText());
        if (found) break;
    }
    return found;
}

function getSource(typeName) {
    let found = null;
    function visit(node, fileText) {
        if (found) return;
        const named =
            (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.text === typeName;
        if (named) found = fileText.slice(node.getStart(), node.getEnd());
        else if (ts.isVariableStatement(node)) {
            for (const decl of node.declarationList.declarations) {
                if (decl.name && ts.isIdentifier(decl.name) && decl.name.text === typeName) found = fileText.slice(node.getStart(), node.getEnd());
            }
        }
        if (!found) ts.forEachChild(node, (child) => visit(child, fileText));
    }
    for (const file of sourceFiles) {
        const sf = tsProgram.getSourceFile(file);
        if (sf) visit(sf, sf.getFullText());
        if (found) break;
    }
    return found;
}

// ── rendering ───────────────────────────────────────────────────────

// parse a `select` expression: "module:symbol" or just "symbol".
// the module (a path under src, e.g. "api/transforms") scopes the lookup so
// re-export aliases resolve to their real declaration; the symbol may itself
// be dotted for namespaced exports (e.g. "aabbBody.create").
function resolveSelector(select) {
    const sep = select.indexOf(':');
    const moduleName = sep >= 0 ? select.slice(0, sep).trim() : null;
    const name = (sep >= 0 ? select.slice(sep + 1) : select).trim();

    if (moduleName) {
        const file = resolveModule(path.join(srcDir, 'index.ts'), `./${moduleName}`);
        const found = file && collectModuleExports(file).find((e) => e.exportName === name || e.exportName.endsWith(`.${name}`));
        if (found) return { exportName: found.exportName, localName: found.localName, scope: tsProgram.getSourceFile(found.originFile) };
        console.warn(`Render: '${name}' not found in module '${moduleName}', falling back to global lookup`);
    }
    return { exportName: name, localName: name, scope: null };
}

// render one selected symbol. attrs:
//   select="[module:]symbol"  required — what to render
//   source                    full source incl. body (default: signature only)
//   heading                   prefix a `#### \`name\`` heading (reference style)
//   as="ns"                   display-name prefix (for namespaced exports)
function renderSymbol(attrs) {
    if (!attrs.select) {
        console.warn('Render: missing `select`');
        return '<!-- Render: missing `select` -->';
    }
    const { exportName, localName, scope } = resolveSelector(attrs.select);
    const symbolName = exportName.split('.').pop();
    const code = attrs.source ? getSource(localName) : getType(localName, scope, symbolName);
    if (!code) {
        console.warn(`Render: symbol not found: ${attrs.select}`);
        return `<!-- Render: not found: ${attrs.select} -->`;
    }
    const block = `\`\`\`ts\n${code.trim()}\n\`\`\``;
    if (!attrs.heading) return block;
    const display = (attrs.as ? `${attrs.as}.` : '') + exportName;
    return `#### \`${display}\`\n\n${block}`;
}

// ── template tag expansion ──────────────────────────────────────────

// parse tag attributes. supports key="value" and bare boolean flags (e.g.
// `heading` -> true).
function parseAttrs(raw) {
    const attrs = {};
    for (const m of raw.matchAll(/(\w+)(?:=["']([^"']*)["'])?/g)) {
        if (m[1]) attrs[m[1]] = m[2] !== undefined ? m[2] : true;
    }
    return attrs;
}

function expandTemplate(text) {
    text = text.replace(/<Render\s+([^>]*?)\/>/g, (_m, raw) => renderSymbol(parseAttrs(raw)));

    text = text.replace(/<Snippet\s+([^>]*?)\/>/g, (full, raw) => {
        const { source, select } = parseAttrs(raw);
        const abs = path.join(templateDir, source);
        if (!fs.existsSync(abs)) {
            console.warn(`Snippet: file not found: ${source}`);
            return full;
        }
        const fileText = fs.readFileSync(abs, 'utf-8');
        const re = new RegExp(
            String.raw`^([ \t]*)\/\*[ \t]*SNIPPET_START:[ \t]*${select}[ \t]*\*\/[\r\n]+([\s\S]*?)[ \t]*^\1\/\*[ \t]*SNIPPET_END:[ \t]*${select}[ \t]*\*\/`,
            'gm',
        );
        const matches = [...fileText.matchAll(re)];
        if (matches.length === 0) {
            console.warn(`Snippet: group '${select}' not found in ${source}`);
            return full;
        }
        const code = matches
            .map((m) => {
                let part = m[2];
                if (m[1]) part = part.replace(new RegExp(`^${m[1]}`, 'gm'), '');
                // drop any nested SNIPPET_START/END marker lines from the body
                part = part.replace(/^.*\/\*[ \t]*SNIPPET_(?:START|END):[^*]*\*\/.*\n?/gm, '');
                return part;
            })
            .join('')
            .replace(/^\s*\n|\n\s*$/g, '');
        return `\`\`\`ts\n${code}\n\`\`\``;
    });

    return text;
}

// ── build ───────────────────────────────────────────────────────────

for (const [tpl, out] of [['guide.template.md', 'guide.md'], ['api.template.md', 'api.md']]) {
    const tplPath = path.join(templateDir, tpl);
    if (!fs.existsSync(tplPath)) {
        console.warn(`skipping ${tpl}: not found`);
        continue;
    }
    const result = expandTemplate(fs.readFileSync(tplPath, 'utf-8'));
    fs.writeFileSync(path.join(docsDir, out), result, 'utf-8');
    console.log(`wrote ${out}`);
}
