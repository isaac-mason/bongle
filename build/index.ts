// lib/build — bongle's HOST-NEUTRAL build: "how bongle source becomes a runnable
// bundle", independent of who runs the bundler. The one host dependency — the
// `rolldown` impl — is INJECTED (see Bundler): @rolldown/browser (browser editor)
// and node `rolldown` share an API, so the same code runs in both. A future
// `bongle build` CLI is `openNodeFs → buildBundle(fs, { rolldown }, opts)`.
//
// What lives here:
//   - the PROD build (bundle.ts): env-DCE'd client/server bundles + manifest + zip.
//   - the bongle-source compile plugin (bongle-plugin.ts) + `?worker` bundling.
//   - the module resolver (resolve.ts).
//   - ENGINE SEMANTICS: the DepGraph capture pass (recognise scene/block/trait/
//     script producers + consumers, wrap with __kit.deps) + env replacement —
//     cross-module resolution is injected so it runs over a vfs or a node resolver.
//
// What does NOT live here: the browser DEV path (Vite ModuleRunner, OPFS,
// @rolldown/browser/experimental transform, port bridges) — that's editor-specific
// plumbing in editor/bundler. Pulling the shared dev bits here is a follow-up.

export { type Bundler, bundleWorkers, createBonglePlugin } from './bongle-plugin';
export { type BuildOptions, buildBundle } from './bundle';
export { initSymbolTables, type SymbolTableRegistry, wrapModuleDeps } from './capture-deps';
export { type EnvValues, replaceEnv } from './env-replace';
export { type BuildFs, dirOf, type PackageJson, posixJoin, resolveFile, resolveModule, resolvePackage } from './resolve';
