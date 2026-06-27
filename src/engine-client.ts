// The browser's resource-loading bag the boot templates pass as `resourceLoader`
// (and the raw byte loader it wraps). Live with `assetUrl`; surfaced here so
// consumers get them alongside EngineClient.

export * as EngineClient from './client/engine-client';
export type { ResourceLoader } from './core/resource-loader';
export { browserResourceLoader, fetchResourceLoader } from './render/asset-url';
