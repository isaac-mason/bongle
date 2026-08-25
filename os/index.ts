// bongle/os — the editor-OS: the contract (interface.ts) + the host-agnostic
// core. The host (browser editor / a future node host) consumes this statically;
// engine editor apps (os/apps) and user apps program against the types only.

export { makeChannel } from './channel';
export { exposeDevtools } from './devtools';
export * from './interface';
export { portLink, selfLink, workerLink } from './link';
export { createOS, type OSOptions } from './os';
export { decodePeerFrame, encodePeerFrame, framedPeer, messagePortPeer } from './peer';
export { asPortLike, createRemoteFilesystem, type PortLike, serveFilesystemOverPort } from './remote-fs';
export { runApp } from './runtime';
