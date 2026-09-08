export const INTERFACE_VERSION = '0.0.3';

export type { ClientApp, ClientDriver, ClientUser, JsonValue, Platform } from './client';
export { Channel, client } from './client';
export type {
    AvatarsServerDriver,
    Client,
    Filesystem,
    FsEntry,
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
    Zstd,
} from './server';
export { server } from './server';
