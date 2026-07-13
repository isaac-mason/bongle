// editor/bundler/port-bridge.ts — the realm side of the bundler conduit.
//
// A realm (server worker / client iframe) runs a ModuleRunner whose transport is
// this bridge: it tunnels the module-runner protocol (fetchModule invoke + HMR
// push + vite:invalidate) over a MessagePort to the host DevServer (connectRealm
// in host.ts). Kept SEPARATE from host.ts so realms don't import the transform
// (@rolldown/browser → SharedArrayBuffer); the realm only evaluates.

import type { RunnerBridge } from './runner';

/** frames on the bundler conduit (a dedicated MessagePort per remote realm). */
export type BundlerFrame =
    | { __bundler: 'invoke'; id: number; payload: unknown }
    | { __bundler: 'result'; id: number; result: unknown }
    | { __bundler: 'send'; payload: unknown }
    | { __bundler: 'push'; payload: unknown };

/** the remote realm's RunnerBridge over its bundler MessagePort — the mirror of
 *  host.ts's connectRealm. */
export function createPortBridge(port: MessagePort): RunnerBridge {
    let onMsg: ((p: unknown) => void) | undefined;
    const pending = new Map<number, (result: unknown) => void>();
    let nextId = 0;

    port.onmessage = (e: MessageEvent<BundlerFrame>) => {
        const msg = e.data;
        if (msg.__bundler === 'result') {
            pending.get(msg.id)?.(msg.result);
            pending.delete(msg.id);
        } else if (msg.__bundler === 'push') {
            onMsg?.(msg.payload);
        }
    };

    return {
        invoke: (payload) =>
            new Promise<{ result: unknown }>((resolve) => {
                const id = nextId++;
                pending.set(id, (result) => resolve({ result }));
                port.postMessage({ __bundler: 'invoke', id, payload } satisfies BundlerFrame);
            }),
        onMessage: (cb) => {
            onMsg = cb;
        },
        send: (payload) => port.postMessage({ __bundler: 'send', payload } satisfies BundlerFrame),
    };
}
