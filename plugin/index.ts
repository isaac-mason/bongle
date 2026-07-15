// lib/plugin — bongle's HOST-NEUTRAL bundler semantics: "how bongle source
// becomes a runnable + reactive module", independent of who runs the bundler.
//
// Two layers of bundler logic live in this repo (see llm/plan-in-browser-editor):
//   - HOST PLUMBING (where modules come from + how they're transported): the vfs
//     resolver, the in-browser ModuleRunner, OPFS, port bridges, @rolldown/browser
//     orchestration. That stays in `editor/` — it's specific to the browser editor.
//   - ENGINE SEMANTICS (this package): the DepGraph capture pass (recognise
//     scene/block/trait/script producers + consumers, wrap with __kit.deps) and
//     env replacement. These are the SAME whether the host is the in-browser
//     editor, a published `@bongle/vite` plugin, or a `bongle dev` CLI on a
//     computer. The one host dependency — cross-module resolution — is INJECTED
//     (`wrapModuleDeps` takes a `resolve(spec, importer)` callback), so the same
//     logic runs over a vfs (editor), Rollup's `this.resolve` (node vite), or a
//     build's resolver.
//
// Consumers today: the editor's transform pipeline + dev-server. Aspirationally:
// the publish build (closes the dev/build DepGraph parity gap) and an external
// node dev host. This is functions, not `Plugin` objects — the thin Vite/rolldown
// `Plugin` adapter is added when a host that needs it actually exists.

export { initSymbolTables, type SymbolTableRegistry, wrapModuleDeps } from './capture-deps';
export { type EnvValues, replaceEnv } from './env-replace';
