// bongle/os — the editor-OS: the contract (interface.ts) + the host-agnostic
// core. The host (browser editor / a future node host) consumes this statically;
// engine editor apps (os/apps) and user apps program against the types only.

export * from './interface';
export { makeChannel } from './channel';
export { exposeDevtools } from './devtools';
export { portLink, selfLink, workerLink } from './link';
export { createOS, type OSOptions } from './os';
export { messagePortRelay } from './relay';
export { runApp } from './runtime';
