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
//     script producers + consumers, wrap with __bongle.deps) + env replacement —
//     cross-module resolution is injected so it runs over a vfs or a node resolver.
//   - the DEV runtime (shakeup-host / shakeup-port / shakeup-runner-host + the capture
//     plugin): ONE shakeup dev server owns transform + resolution, realms attach over
//     ports and only evaluate.
//   - the relay conduit (relay-link.ts) + net-sim: host-neutral framed transport for
//     multiplayer / bongle-server.

export { type Bundler, bundleWorkerEntry, bundleWorkers, createBonglePlugin, workerWrapperModule } from './bundle/bongle-plugin';
export { type BuildOptions, buildBundle } from './bundle/bundle';
export { initSymbolTables, type SymbolTableRegistry, wrapModuleDeps } from './capture/capture-native';
export { CAPTURE_POSTLUDE, CAPTURE_PRELUDE, type CapturePluginOptions, capturePlugin } from './capture/capture-plugin';
export { contentType } from './dev/mime';
export { createNetSim, type NetSim, type NetSimConfig, type NetSimSinks } from './dev/net-sim';
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
export { createShakeupBundlerHost, type ShakeupBundlerHost, type ShakeupHostOptions } from './dev/shakeup-host';
export { asRealmPort, attachRealmPort, connectRealmPort, type RealmPort } from './dev/shakeup-port';
export { browserEvaluator, ensureProcessShim, makeImportMeta } from './dev/shakeup-runner-host';
export { type EnvValues, replaceEnv } from './env-replace';
export { type BuildFs, dirOf, type PackageJson, posixJoin, resolveFile, resolveModule, resolvePackage } from './resolve';
