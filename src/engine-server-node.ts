// bongle/engine-server-node — server bits that reach Node builtins (node:fs to
// read the engine's example avatars off disk, node:zlib for the native chunk
// compressor). Split out of the browser-facing `bongle/engine-server` entry so
// no Node builtin leaks into the browser server graph the editor bundles: the
// editor injects its own drivers (createEditorAvatarsDriver, zstd-wasm), the
// node hosts import these.

export { createFallbackAvatarsDriver, resolveSampleAvatarFile, SAMPLE_AVATAR_ROUTE_PREFIX } from './node/sample-avatars-driver';
export { nodeZstd } from './node/zstd';
