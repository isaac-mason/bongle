// editor/platform/bridge.ts — the editor side of the platform postMessage link.
//
// The editor, mounted in an iframe, posts `bongle:ready` to its parent and waits
// for a `bongle:init` declaring the intent. If no platform answers (standalone
// dev, or an embed that isn't our platform) it resolves `null` and the caller
// falls back to the default sample project. After init, the editor hands finished
// payloads back (save/build/avatar-export) and receives result acks.

import type { EditorMessage, PlatformIntent, PlatformMessage, PlatformResult } from './contract';

/** how long to wait for the platform's init before assuming we're standalone.
 *  NOT a timing hack: it's the only way to distinguish "platform will answer" from
 *  "no platform" — a non-answering embed sends nothing, so there's no event to
 *  wait on. Fast path (top-level, not iframed) skips the wait entirely. */
const INIT_TIMEOUT_MS = 1500;

export type PlatformBridge = {
    /** the platform's declared intent, or null when running standalone. */
    ready: Promise<PlatformIntent | null>;
    /** true once a platform init has been received (payloads route to it). */
    embedded: () => boolean;
    /** post a message to the platform (no-op when standalone). */
    send: (msg: EditorMessage) => void;
    /** subscribe to platform result acks; returns an unsubscribe fn. */
    onResult: (cb: (r: PlatformResult) => void) => () => void;
};

export function createPlatformBridge(): PlatformBridge {
    const parent = window.parent !== window ? window.parent : null;
    const resultCbs = new Set<(r: PlatformResult) => void>();
    let embedded = false;

    const send = (msg: EditorMessage) => parent?.postMessage(msg, '*');

    const ready = new Promise<PlatformIntent | null>((resolve) => {
        if (!parent) {
            resolve(null); // top-level: standalone dev, no platform
            return;
        }
        let settled = false;
        window.addEventListener('message', (e: MessageEvent) => {
            const m = e.data as PlatformMessage | undefined;
            if (!m || typeof m.type !== 'string' || !m.type.startsWith('bongle:')) return;
            if (m.type === 'bongle:init') {
                if (settled) return;
                settled = true;
                embedded = true;
                resolve(m.intent);
            } else if (m.type === 'bongle:result') {
                for (const cb of resultCbs) cb(m);
            }
        });
        send({ type: 'bongle:ready' });
        // no init within the window → treat as standalone.
        setTimeout(() => {
            if (!settled) {
                settled = true;
                resolve(null);
            }
        }, INIT_TIMEOUT_MS);
    });

    return {
        ready,
        embedded: () => embedded,
        send,
        onResult: (cb) => {
            resultCbs.add(cb);
            return () => resultCbs.delete(cb);
        },
    };
}
