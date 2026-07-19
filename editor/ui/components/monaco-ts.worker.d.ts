// Ambient types for monaco-editor's internal TypeScript worker ESM modules, which
// ship no `.d.ts`. ts.worker.ts bare-imports the worker ENTRY (for its boot side
// effect) and augments the `TypeScriptWorker` class prototype (typed locally there).
declare module 'monaco-editor/esm/vs/language/typescript/ts.worker' {}
declare module 'monaco-editor/esm/vs/language/typescript/tsWorker' {
    export class TypeScriptWorker {}
}
