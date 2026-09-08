// lib/build — bongle's HOST-NEUTRAL build: "how bongle source becomes a runnable
// bundle", independent of who runs it. Bundling is shakeup — the SAME bundler the
// dev server runs, so dev and publish share one graph, one resolver and one set of
// semantics. shakeup is pure JS, so the browser editor and the node CLI run this
// identical code with nothing injected and no host prep.
// `bongle build` is `openNodeFs → buildBundle(fs, opts)`.
//
// What lives here:
//   - the PROD build (bundle.ts): env-DCE'd client/server bundles + manifest + zip.
//   - the bongle-source compile plugin (bongle-plugin.ts) + `?worker` bundling.
//   - the module resolver (resolve.ts).
//   - ENGINE SEMANTICS: the DepGraph capture pass (recognise scene/block/trait/
//     script producers + consumers, wrap with __bongle.deps) + env replacement —
//     the wrap is per-module and stateless, so it runs the same over a vfs or a
//     node resolver and can't vary with module transform order.
//   - the DEV runtime (shakeup-host / shakeup-port / shakeup-runner-host + the capture
//     plugin): ONE shakeup dev server owns transform + resolution, realms attach over
//     ports and only evaluate.
//   - the relay conduit (relay-link.ts) + net-sim: host-neutral framed transport for
//     multiplayer / bongle-server.

export { bundleWorkerEntry, createBonglePlugin, workerWrapperModule } from './bundle/bongle-plugin';
export { type BuildOptions, buildBundle } from './bundle/bundle';
export { wrapModuleDeps } from './capture/capture-native';
export { CAPTURE_POSTLUDE, CAPTURE_PRELUDE, type CapturePluginOptions, capturePlugin } from './capture/capture-plugin';
export {
    type AvatarPicker,
    avatarPicker,
    devUser,
    editorNetSim,
    frameLoop,
    inertPlatform,
    type NetSimKnobs,
    serverTick,
    transferNotWired,
} from './dev/host';
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
