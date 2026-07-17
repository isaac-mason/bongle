// build/port-bridge.ts — the REALM side of the BundlerFrame protocol (the host
// side is realm-host.ts's attachRealm). A realm's RunnerBridge tunnels the
// module-runner protocol (fetchModule invoke + HMR push + vite:invalidate) over a
// port. The port is host-supplied: a browser MessagePort (editor), a
// worker_threads MessagePort or relay PortLike (`bongle dev`). All this needs is
// postMessage + a settable onmessage, so RealmPort covers every one.

import type { BundlerFrame } from './realm-host';
import type { RunnerBridge } from './runner';

export type { BundlerFrame };

/** the minimal port createPortBridge needs — satisfied by a browser MessagePort, a
 *  worker_threads MessagePort, and a relay PortLike alike. */
export type RealmPort = {
    postMessage(data: unknown): void;
    // biome-ignore lint/suspicious/noExplicitAny: the event shape varies by port kind; only .data is read.
    onmessage: ((e: any) => void) | null;
};

type ResultFrame = Extract<BundlerFrame, { __bundler: 'result' }>;

export function createPortBridge(port: RealmPort): RunnerBridge {
    let onMsg: ((p: unknown) => void) | undefined;
    const pending = new Map<number, (frame: ResultFrame) => void>();
    let nextId = 0;

    port.onmessage = (e) => {
        const msg = e.data as BundlerFrame;
        if (msg.__bundler === 'result') {
            pending.get(msg.id)?.(msg);
            pending.delete(msg.id);
        } else if (msg.__bundler === 'push') {
            onMsg?.(msg.payload);
        }
    };

    return {
        invoke: (payload) =>
            new Promise<{ result: unknown } | { error: unknown }>((resolve) => {
                const id = nextId++;
                // a build failure comes back as { error } → the ModuleRunner throws it.
                pending.set(id, (frame) =>
                    resolve(frame.error !== undefined ? { error: frame.error } : { result: frame.result }),
                );
                port.postMessage({ __bundler: 'invoke', id, payload } satisfies BundlerFrame);
            }),
        onMessage: (cb) => {
            onMsg = cb;
        },
        send: (payload) => port.postMessage({ __bundler: 'send', payload } satisfies BundlerFrame),
    };
}
