// browser-safe server surface: the core engine (drivers injected at init) + the
// in-memory storage driver. Node-only bits (avatars-fallback / node zstd) live
// in bongle/engine-server-node so no Node builtin enters the browser graph.
export * as EngineServer from './server/engine-server';
export { createInMemoryStorageDriver } from './server/storage-in-memory';
