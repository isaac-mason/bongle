// editor/platform/bridge.ts — the editor side of the platform postMessage link.
//
// The editor, mounted in an iframe, posts `bongle:ready` to its parent and waits
// for a `bongle:init` declaring the intent. If no platform answers (standalone
// dev, or an embed that isn't our platform) it resolves `null` and the caller
// falls back to the default sample project. After init, the editor hands finished
// payloads back (save/build/avatar-export) and receives result acks.

import type { EditorMessage, PlatformIntent, PlatformMessage, PlatformResult } from './contract';
import { EDITOR_INTERFACE_VERSION, editorInterfaceCompatible } from './contract';

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
    /** subscribe to the platform's "save now" request (its CTA to persist the current
     *  draft as a version); returns an unsubscribe fn. */
    onRequestSave: (cb: () => void) => () => void;
    /** subscribe to the avatar source delivered after `bongle:init` (an avatar session
     *  boots Blockbench first, then loads the model when it arrives). `bbmodel` null =
     *  no source → use the bundled starter. Returns an unsubscribe fn. */
    onSource: (cb: (bbmodel: string | null, name?: string) => void) => () => void;
    /** ask the platform to open this session to multiplayer — it calls
     *  /api/edit/host and resolves with the relay url + share link. Rejects when
     *  standalone (no platform to make the authenticated call). */
    requestMultiplayer: (region?: string) => Promise<{ url: string; shareUrl: string }>;
    /** ask the host to open the folder picker (the iframe can't) and start serving
     *  the chosen folder. The outcome arrives asynchronously via onSyncPort (started)
     *  or onSyncResult (cancelled / failed). No-op when standalone. */
    requestSyncFolder: (direction: SyncDirection) => void;
    /** tell the host the editor tore down its sync so it releases the handle. */
    notifySyncStopped: () => void;
    /** the host picked a folder and is serving it over `port`; the editor connects
     *  its sync loop. Returns an unsubscribe fn. */
    onSyncPort: (cb: (port: MessagePort, direction: SyncDirection, folderName: string) => void) => () => void;
    /** the sync didn't start: `cancelled` for a dismissed picker (stay quiet),
     *  else `message` explains the failure. Returns an unsubscribe fn. */
    onSyncResult: (cb: (r: { cancelled: boolean; message?: string }) => void) => () => void;
};

type SyncDirection = 'editor-to-folder' | 'folder-to-editor';

export function createPlatformBridge(): PlatformBridge {
    const parent = window.parent !== window ? window.parent : null;
    const resultCbs = new Set<(r: PlatformResult) => void>();
    const requestSaveCbs = new Set<() => void>();
    const sourceCbs = new Set<(bbmodel: string | null, name?: string) => void>();
    const syncPortCbs = new Set<(port: MessagePort, direction: SyncDirection, folderName: string) => void>();
    const syncResultCbs = new Set<(r: { cancelled: boolean; message?: string }) => void>();
    // the last source the platform sent, so a subscriber that attaches AFTER it arrived
    // (a fast local source can beat the boot's onSource wiring) still gets it.
    let latestSource: { bbmodel: string | null; name?: string } | undefined;
    // in-flight open-multiplayer request (one at a time — the host opens once).
    let multiplayerPending: { resolve: (v: { url: string; shareUrl: string }) => void; reject: (e: Error) => void } | null = null;
    let embedded = false;
    // The editor is served cross-origin from its embedder, so it can't name the
    // parent's origin; it posts to '*'. That only ever reaches window.parent, and
    // the edge's frame-ancestors (editor.<zone>) guarantees the parent is one of
    // our pages — so '*' can't leak to a hostile framer.
    const send = (msg: EditorMessage) => parent?.postMessage(msg, '*');

    const ready = new Promise<PlatformIntent | null>((resolve) => {
        if (!parent) {
            resolve(null); // top-level: standalone dev, no platform
            return;
        }
        let settled = false;
        // a platform has acked `ready` (bongle:init-pending) but hasn't sent its intent
        // yet — it's fetching the source. While true, we DON'T fall back to standalone.
        let platformAnswering = false;
        window.addEventListener('message', (e: MessageEvent) => {
            const m = e.data as PlatformMessage | undefined;
            if (!m || typeof m.type !== 'string' || !m.type.startsWith('bongle:')) return;
            if (m.type === 'bongle:init') {
                if (settled) return;
                if (!editorInterfaceCompatible(m.version, EDITOR_INTERFACE_VERSION)) {
                    console.warn(
                        `[bongle] editor⇄platform interface mismatch: platform ${m.version}, editor ${EDITOR_INTERFACE_VERSION}`,
                    );
                }
                settled = true;
                embedded = true;
                resolve(m.intent);
            } else if (m.type === 'bongle:init-pending') {
                // A real platform IS answering — its intent just needs a moment (an
                // avatar remix fetching its .bbmodel source can exceed INIT_TIMEOUT_MS).
                // Hold for the real init instead of racing it to standalone.
                platformAnswering = true;
            } else if (m.type === 'bongle:result') {
                for (const cb of resultCbs) cb(m);
            } else if (m.type === 'bongle:source') {
                latestSource = { bbmodel: m.bbmodel, name: m.name };
                for (const cb of sourceCbs) cb(m.bbmodel, m.name);
            } else if (m.type === 'bongle:request-save') {
                for (const cb of requestSaveCbs) cb();
            } else if (m.type === 'bongle:multiplayer-opened') {
                multiplayerPending?.resolve({ url: m.url, shareUrl: m.shareUrl });
                multiplayerPending = null;
            } else if (m.type === 'bongle:multiplayer-failed') {
                multiplayerPending?.reject(new Error(m.message));
                multiplayerPending = null;
            } else if (m.type === 'bongle:sync-folder-port') {
                // the folder handle rides in the transfer list, not the payload.
                const port = e.ports[0];
                if (port) for (const cb of syncPortCbs) cb(port, m.direction, m.folderName);
            } else if (m.type === 'bongle:sync-folder-cancelled') {
                for (const cb of syncResultCbs) cb({ cancelled: true });
            } else if (m.type === 'bongle:sync-folder-failed') {
                for (const cb of syncResultCbs) cb({ cancelled: false, message: m.message });
            }
        });
        // Re-announce `ready` until the parent acks with `init`. A single ping
        // can be lost when the parent's message listener attaches AFTER the
        // iframe's JS runs (cached/fast reload) — the classic iframe-handshake
        // race that makes the "editing X" window flicker in and out across
        // reboots. Bounded: give up to standalone after INIT_TIMEOUT_MS.
        send({ type: 'bongle:ready', version: EDITOR_INTERFACE_VERSION });
        const started = performance.now();
        const beat = setInterval(() => {
            if (settled) {
                clearInterval(beat);
                return;
            }
            // a platform acked → it's resolving our intent; stop pinging and wait for
            // `bongle:init` (which the platform always sends, even on a fetch error) —
            // never fall back to standalone once we know one is there.
            if (platformAnswering) {
                clearInterval(beat);
                return;
            }
            if (performance.now() - started >= INIT_TIMEOUT_MS) {
                clearInterval(beat);
                settled = true;
                resolve(null); // no platform answered → standalone
                return;
            }
            send({ type: 'bongle:ready', version: EDITOR_INTERFACE_VERSION }); // parent may only now be listening
        }, 150);
    });

    return {
        ready,
        embedded: () => embedded,
        send,
        onResult: (cb) => {
            resultCbs.add(cb);
            return () => resultCbs.delete(cb);
        },
        onRequestSave: (cb) => {
            requestSaveCbs.add(cb);
            return () => requestSaveCbs.delete(cb);
        },
        onSource: (cb) => {
            sourceCbs.add(cb);
            if (latestSource) cb(latestSource.bbmodel, latestSource.name);
            return () => sourceCbs.delete(cb);
        },
        requestMultiplayer: (region) =>
            new Promise((resolve, reject) => {
                if (!parent) {
                    reject(new Error('multiplayer needs the platform (run the editor embedded, not standalone)'));
                    return;
                }
                multiplayerPending?.reject(new Error('superseded by a newer request'));
                multiplayerPending = { resolve, reject };
                send({ type: 'bongle:open-multiplayer', region });
            }),
        requestSyncFolder: (direction) => send({ type: 'bongle:request-sync-folder', direction }),
        notifySyncStopped: () => send({ type: 'bongle:sync-folder-stopped' }),
        onSyncPort: (cb) => {
            syncPortCbs.add(cb);
            return () => syncPortCbs.delete(cb);
        },
        onSyncResult: (cb) => {
            syncResultCbs.add(cb);
            return () => syncResultCbs.delete(cb);
        },
    };
}
