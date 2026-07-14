/** Semver of the engine⇄game contract defined by this package (ClientApp /
 *  ClientDriver / ServerApp / ServerDriver / Platform). Bump major on a
 *  breaking change, minor/patch on additive ones, so the platform can warn on
 *  stale bundles. Recorded in each bundle's manifest (`engine.interface`),
 *  alongside the `bongle` package semver. */
export const INTERFACE_VERSION = '0.0.1';

export type { ClientApp, ClientDriver, JsonValue, Platform } from './client';
export { client } from './client';
export type {
    AvatarsServerDriver,
    Client,
    ResolvedAvatar,
    ServerApp,
    ServerDriver,
    ServerInitOptions,
    StorageDeleteResult,
    StorageEntry,
    StorageListOpts,
    StorageListPage,
    StorageServerDriver,
    StorageSetResult,
    User,
} from './server';
export { server } from './server';

// editor⇄platform boundary (the editor mounted in an iframe by the platform).
export { EDITOR_INTERFACE_VERSION } from './editor';
export type { EditorMessage, PlatformIntent, PlatformMessage, PlatformResult } from './editor';
