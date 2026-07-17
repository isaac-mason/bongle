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
//   - the host-neutral realm conduit (realm-host.ts): attachRealm owns the
//     module-runner protocol logic; the host injects the transport (MessagePort /
//     WebSocket / worker_thread port).
//
// What does NOT live here: the browser-specific realm PLUMBING (Vite ModuleRunner,
// OPFS, @rolldown/browser/experimental transform, the MessagePort pumps) — that's
// editor/bundler. `bongle dev` supplies the node counterparts and shares this core.

export { type Bundler, bundleWorkers, createBonglePlugin } from './bundle/bongle-plugin';
export { type BuildOptions, buildBundle } from './bundle/bundle';
export { type DepParser, initSymbolTables, type SymbolTableRegistry, wrapModuleDeps } from './capture/capture-deps';
export {
    applyEdit,
    type BundleWorker,
    type DevServerDeps,
    type DevServerState,
    type FetchResult,
    fetchModule,
    type HotPayload,
    handleRunnerMessage,
    initDevServer,
    registerPusher,
    type TransformModule,
    type TransformResult,
} from './dev/dev-server';
export { contentType } from './dev/mime';
export { createPortBridge } from './dev/port-bridge';
export { type AttachRealmOptions, attachRealm, type BundlerFrame, describeError } from './dev/realm-host';
export {
    Channel,
    createRelayHostLink,
    createRelayLink,
    type DecodedFrame,
    decodeFrame,
    encodeFrame,
    type PortLike,
    type RelayHostLink,
    type RelayHostLinkOptions,
    type RelayLink,
    type SocketLike,
} from './dev/relay-link';
export { makeRunner, type RunnerBridge, type RunnerHost } from './dev/runner';
export { createTransformModule, type OxcTransforms } from './dev/transform';
export { type EnvValues, replaceEnv } from './env-replace';
export { type BuildFs, dirOf, type PackageJson, posixJoin, resolveFile, resolveModule, resolvePackage } from './resolve';
