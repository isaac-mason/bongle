// bongle/engine-server-node — the Node capabilities a host injects into the
// bundled server: node:fs (openNodeFs) and node:zlib (nodeZstd, the native chunk
// compressor). Split out of the browser-facing `bongle/engine-server` entry so no
// Node builtin leaks into the browser server graph the editor bundles. Kept clear
// of any engine-core graph, so importing it (e.g. from a play room that only needs
// to hand the bundled server its fs + zstd) drags in node builtins and nothing
// else. The sample-avatars host helper lives in its own module (node/sample-
// avatars-driver) and is imported from source by the CLI dev host that serves them.

export { openNodeFs } from './node/node-fs';
export { nodeZstd } from './node/zstd';
