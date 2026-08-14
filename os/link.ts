import type { Link } from './interface';

// Adapters presenting a Worker, a MessagePort, or a worker's own scope as a Link.

export function workerLink(w: Worker): Link {
    return {
        post: (m, t) => w.postMessage(m, t ?? []),
        onMessage: (cb) => {
            w.onmessage = (e) => cb(e.data, e.ports);
        },
        close: () => w.terminate(),
    };
}

export function portLink(p: MessagePort): Link {
    return {
        post: (m, t) => p.postMessage(m, t ?? []),
        onMessage: (cb) => {
            p.onmessage = (e) => cb(e.data, e.ports);
        },
        close: () => p.close(),
    };
}

/** the app side inside a Worker: its global scope IS the control link. */
export function selfLink(): Link {
    const g = self as unknown as {
        postMessage: (m: unknown, t?: Transferable[]) => void;
        onmessage: ((e: MessageEvent) => void) | null;
        close: () => void;
    };
    return {
        post: (m, t) => g.postMessage(m, t ?? []),
        onMessage: (cb) => {
            g.onmessage = (e) => cb(e.data, e.ports);
        },
        close: () => g.close(),
    };
}
