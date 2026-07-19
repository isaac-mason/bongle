// editor/ui/components/ts.worker.ts — our Monaco TypeScript language worker.
//
// We import monaco's TS worker ENTRY for its side effect: it installs the
// `self.onmessage` bootstrap that boots the worker (create() → new TypeScriptWorker).
// We then AUGMENT `TypeScriptWorker.prototype` in place, rather than subclassing:
//   * subclassing needs OUR `self.onmessage` to win over monaco's, but esbuild dep
//     pre-bundling reorders the top-level assignments unreliably (stock worker boots);
//   * importing the boot pieces separately to dodge that race breaks worker startup
//     ("Could not create web worker(s)").
// Patching the shared prototype sidesteps both: monaco's own bootstrap boots the
// worker as designed, and the stock instance create() builds already carries our
// methods (create() does `new TypeScriptWorker`, resolving off this same prototype).
//
// What we add:
//   1. Diagnostic wrappers that strip the non-cloneable `repopulateInfo` fn from the
//      messageText chain (monaco 0.55's bundled TS). postMessage-ing it throws
//      DataCloneError on every edit. Getter-safe: only `.repopulateInfo` + `.next`.
//      (Replaces the old vite `stripMonacoRepopulateInfo` source patch.)
//   2. getAutoImport* methods that pass `includeCompletionsForModuleExports` and
//      forward the entry source/data, so the language service computes the
//      `import { … } from '…'` edit. The completion provider in Monaco.tsx calls
//      these through the worker proxy ($fmr).

// BARE side-effect import of monaco's own TS worker entry: this IS the stock worker,
// so it boots correctly (installs the self.onmessage bootstrap → create() → new
// TypeScriptWorker). A bare import guarantees the top-level runs; a *named* import
// from this entry can be deferred by esbuild's interop and miss the bootstrap, which
// crashes worker startup ("Could not create web worker(s)").
import 'monaco-editor/esm/vs/language/typescript/ts.worker';
// The class create() instantiates (ts.worker re-exports it from here). We patch its
// prototype so the stock instance carries our methods. tsWorker sets no onmessage.
import { TypeScriptWorker } from 'monaco-editor/esm/vs/language/typescript/tsWorker';

// preferences that enable cross-module completions + insert-text; quote and
// specifier style match the house single-quote convention so inserted imports
// don't fight Biome.
const AUTO_IMPORT_PREFERENCES = {
    includeCompletionsForModuleExports: true,
    includeCompletionsWithInsertText: true,
    // 'relative' (RelativePreference 0), NOT 'shortest': with moduleResolution:Bundler,
    // resolvePackageJsonImports is on, so for LOCAL (non-node_modules) targets monaco's
    // bundled TS 5.9.3 computes a paths base dir and passes `undefined` into
    // getNormalizedAbsolutePath → `normalizeSlashes(undefined)` crash (no baseUrl/paths
    // in this host). relativePreference 0 short-circuits to the relative path before that
    // line. node_modules packages are unaffected (they resolve to the bare name earlier,
    // and getLocalModuleSpecifier early-returns via pathsOnly && !paths) — so packages
    // still import as `bongle`, local files as `./foo`, matching our import style.
    importModuleSpecifierPreference: 'relative',
    quotePreference: 'single',
};

// FormatCodeSettings shared by the auto-import code action and the Format Document /
// Organize Imports commands. Two reasons this must be COMPLETE, not a partial:
//   * getCompletionEntryDetails builds `formatOptions && getFormatContext(...)`, so
//     passing undefined crashes the code-action generator (reads `.options`);
//   * TS's formatter does NOT default omitted boolean flags — a missing
//     `insertSpace*` is treated as false. A partial object silently strips spacing
//     (e.g. `const x = 1` → `const x=1`). So mirror TS's own getDefaultFormatCodeSettings,
//     overriding only `semicolons` to match the house (semicolon) style.
const FORMAT_OPTIONS = {
    tabSize: 4,
    indentSize: 4,
    convertTabsToSpaces: true,
    newLineCharacter: '\n',
    indentStyle: 2, // Smart
    trimTrailingWhitespace: true,
    indentSwitchCase: true,
    insertSpaceAfterConstructor: false,
    insertSpaceAfterCommaDelimiter: true,
    insertSpaceAfterSemicolonInForStatements: true,
    insertSpaceBeforeAndAfterBinaryOperators: true,
    insertSpaceAfterKeywordsInControlFlowStatements: true,
    insertSpaceAfterFunctionKeywordForAnonymousFunctions: false,
    insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis: false,
    insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: false,
    insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true,
    insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces: false,
    insertSpaceAfterOpeningAndBeforeClosingJsxExpressionBraces: false,
    insertSpaceBeforeFunctionParenthesis: false,
    placeOpenBraceOnNewLineForFunctions: false,
    placeOpenBraceOnNewLineForControlBlocks: false,
    semicolons: 'insert',
};

interface DiagnosticLike {
    messageText?: unknown;
}

interface TextChangeLike {
    span: { start: number; length: number };
    newText: string;
}

interface WorkerLanguageService {
    getCompletionsAtPosition(fileName: string, position: number, options: unknown): unknown;
    getCompletionEntryDetails(
        fileName: string,
        position: number,
        name: string,
        formatOptions: unknown,
        source: string | undefined,
        preferences: unknown,
        data: unknown,
    ): unknown;
    getFormattingEditsForDocument(fileName: string, options: unknown): TextChangeLike[];
    organizeImports(
        args: { type: 'file'; fileName: string; mode: string },
        formatOptions: unknown,
        preferences: unknown,
    ): readonly { textChanges: TextChangeLike[] }[];
}

// the TypeScriptWorker prototype surface we read + augment (monaco ships no types).
interface TsWorkerProto {
    _languageService: WorkerLanguageService;
    getSemanticDiagnostics(fileName: string): Promise<DiagnosticLike[]>;
    getSuggestionDiagnostics(fileName: string): Promise<DiagnosticLike[]>;
    getSyntacticDiagnostics(fileName: string): Promise<DiagnosticLike[]>;
    getCompilerOptionsDiagnostics(fileName: string): Promise<DiagnosticLike[]>;
    getEmitOutput(
        fileName: string,
        emitOnlyDtsFiles?: boolean,
        forceDtsEmit?: boolean,
    ): Promise<{ diagnostics?: DiagnosticLike[] }>;
    getAutoImportCompletions(fileName: string, position: number): Promise<unknown>;
    getAutoImportDetails(
        fileName: string,
        position: number,
        name: string,
        source: string | undefined,
        data: unknown,
    ): Promise<unknown>;
    getFormatEdits(fileName: string): Promise<TextChangeLike[]>;
    getOrganizeImportsEdits(fileName: string): Promise<readonly { textChanges: TextChangeLike[] }[]>;
}

// delete the non-cloneable repopulateInfo fn from a DiagnosticMessageChain node.
// Touch ONLY `.repopulateInfo` + `.next` — a blind key walk invokes live-compiler
// getters that can throw and kill the worker.
function stripRepopulateInfo(chain: unknown, depth = 0): void {
    if (!chain || typeof chain !== 'object' || depth > 32) return;
    const node = chain as { repopulateInfo?: unknown; next?: unknown };
    if (typeof node.repopulateInfo === 'function') {
        try {
            delete node.repopulateInfo;
        } catch {
            // frozen — leave it; the clone will fail loudly rather than silently
        }
    }
    if (Array.isArray(node.next)) for (const next of node.next) stripRepopulateInfo(next, depth + 1);
}

function sanitizeDiagnostics<T extends DiagnosticLike>(diagnostics: T[]): T[] {
    for (const diagnostic of diagnostics) stripRepopulateInfo(diagnostic.messageText);
    return diagnostics;
}

// Patch at load, before any message → before create() builds the first instance. A
// throw here would otherwise fail worker startup silently, so surface it.
try {
    const proto = TypeScriptWorker.prototype as unknown as TsWorkerProto;

    // (1) wrap the diagnostic methods — strip the non-cloneable fn before RPC serialization.
    const originalSemantic = proto.getSemanticDiagnostics;
    proto.getSemanticDiagnostics = async function (this: TsWorkerProto, fileName: string) {
        return sanitizeDiagnostics(await originalSemantic.call(this, fileName));
    };
    const originalSuggestion = proto.getSuggestionDiagnostics;
    proto.getSuggestionDiagnostics = async function (this: TsWorkerProto, fileName: string) {
        return sanitizeDiagnostics(await originalSuggestion.call(this, fileName));
    };
    const originalSyntactic = proto.getSyntacticDiagnostics;
    proto.getSyntacticDiagnostics = async function (this: TsWorkerProto, fileName: string) {
        return sanitizeDiagnostics(await originalSyntactic.call(this, fileName));
    };
    const originalCompilerOptions = proto.getCompilerOptionsDiagnostics;
    proto.getCompilerOptionsDiagnostics = async function (this: TsWorkerProto, fileName: string) {
        return sanitizeDiagnostics(await originalCompilerOptions.call(this, fileName));
    };
    const originalEmit = proto.getEmitOutput;
    proto.getEmitOutput = async function (
        this: TsWorkerProto,
        fileName: string,
        emitOnlyDtsFiles?: boolean,
        forceDtsEmit?: boolean,
    ) {
        const output = await originalEmit.call(this, fileName, emitOnlyDtsFiles, forceDtsEmit);
        if (Array.isArray(output.diagnostics)) sanitizeDiagnostics(output.diagnostics);
        return output;
    };

    // (2) auto-import completions — reached from the completion provider via the proxy.
    proto.getAutoImportCompletions = async function (this: TsWorkerProto, fileName: string, position: number) {
        return this._languageService.getCompletionsAtPosition(fileName, position, AUTO_IMPORT_PREFERENCES);
    };
    proto.getAutoImportDetails = async function (
        this: TsWorkerProto,
        fileName: string,
        position: number,
        name: string,
        source: string | undefined,
        data: unknown,
    ) {
        return this._languageService.getCompletionEntryDetails(
            fileName,
            position,
            name,
            FORMAT_OPTIONS,
            source,
            AUTO_IMPORT_PREFERENCES,
            data,
        );
    };

    // (3) Format Document + Organize Imports — reached from the command palette. Both
    // return TextChange[] the caller maps to editor edits.
    proto.getFormatEdits = async function (this: TsWorkerProto, fileName: string) {
        return this._languageService.getFormattingEditsForDocument(fileName, FORMAT_OPTIONS);
    };
    proto.getOrganizeImportsEdits = async function (this: TsWorkerProto, fileName: string) {
        return this._languageService.organizeImports(
            { type: 'file', fileName, mode: 'All' },
            FORMAT_OPTIONS,
            AUTO_IMPORT_PREFERENCES,
        );
    };
} catch (err) {
    console.error('[ts.worker] failed to augment TypeScriptWorker prototype', err);
}
