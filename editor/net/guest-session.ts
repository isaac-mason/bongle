// editor/net/guest-session.ts — the guest counterpart to host-session.
//
// A guest tab runs NONE of the host stack (no server/bundler/pipeline workers,
// no OPFS project). It dials the host's relay room and boots exactly ONE thing:
// a client iframe whose three lanes point at the host over the relay —
//   game    → the host's server worker
//   bundler → the host's DevServer (transforms; the guest only evaluates)
//   fsrpc   → the host's OPFS (read-through)
// The iframe is the same client/index.html the host uses locally; only its
// Source differs (relay lanes + a remote fs, keyed by the fsrpc port being
// present). We bridge each relay PortLike to a MessageChannel transferred into
// the iframe (an iframe can't receive a PortLike, only a real transferable port).

import { Channel, createRelayLink, type PortLike } from './relay-link';
import { connectRelaySocket } from './gatho-socket';

export type GuestSession = { close(): void };

export type GuestSessionOptions = {
    /** relay ws url + token from /api/edit/join. */
    url: string;
    /** same-origin path to the client document (client/index.html), as the host
     *  uses for its own client windows. */
    clientPath: string;
    /** the project entry to evaluate (resolved over the bundler lane from the
     *  host's DevServer). */
    entry?: string;
    /** where to mount the full-viewport client iframe (defaults to document.body). */
    mount?: HTMLElement;
    log?: (msg: string) => void;
};

/** pump frames both ways between a MessageChannel port and a relay lane. */
function bridge(port: MessagePort, relay: PortLike): void {
    port.onmessage = (e) => relay.postMessage(e.data);
    relay.onmessage = (e) => port.postMessage(e.data);
}

export function joinGuestSession(opts: GuestSessionOptions): GuestSession {
    const { url, clientPath, entry = 'src/index.ts', mount = document.body, log = () => {} } = opts;
    const targetOrigin = window.location.origin;

    // a visible status line ABOVE the client iframe (which covers the editor UI,
    // so log windows are hidden). Green once joined, red if the relay drops.
    const banner = document.createElement('div');
    banner.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:2147483600;font:12px/1.6 monospace;text-align:center;padding:4px 8px;color:#fff;background:#334;';
    const setBanner = (text: string, color: string) => {
        banner.textContent = text;
        banner.style.background = color;
    };
    setBanner('connecting to host…', '#334');

    const say = (m: string) => {
        console.log(`[mp:guest] ${m}`);
        log(m);
    };
    say(`dialing relay ${url}`);

    const socket = connectRelaySocket(url, {
        onOpen: () => {
            say('relay socket open');
            setBanner('connected to relay — joining session…', '#446');
        },
        onClose: () => {
            say('relay closed — session ended');
            setBanner('disconnected from host session', '#833');
        },
        onError: () => {
            say('relay socket error');
            setBanner('relay connection error', '#833');
        },
    });
    const link = createRelayLink(socket);

    const iframe = document.createElement('iframe');
    iframe.src = clientPath;
    iframe.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;background:#000;z-index:2147483000';
    iframe.allow = 'clipboard-read; clipboard-write; fullscreen';

    const onMessage = (e: MessageEvent) => {
        if (e.origin !== targetOrigin || e.source !== iframe.contentWindow) return;
        const msg = e.data as { type?: string; message?: string };
        if (msg.type === 'client-ready') {
            say('client iframe ready — bridging the three relay lanes');
            // three lanes → three MessageChannels transferred into the iframe.
            const game = new MessageChannel();
            const bundler = new MessageChannel();
            const fsrpc = new MessageChannel();
            bridge(game.port1, link.port(Channel.game));
            bridge(bundler.port1, link.port(Channel.bundler));
            bridge(fsrpc.port1, link.port(Channel.fsrpc));
            iframe.contentWindow?.postMessage({ type: 'client-init', projectName: '', entry }, targetOrigin, [
                game.port2,
                bundler.port2,
                fsrpc.port2,
            ]);
            say('client-init sent (game/bundler/fsrpc)');
            setBanner('in session — loading the host world…', '#264');
            // dim the banner once we're presumably rendering.
            setTimeout(() => banner.remove(), 6000);
        } else if (msg.type === 'client-error') {
            say(`client error: ${msg.message ?? 'unknown'}`);
            setBanner(`client error: ${msg.message ?? 'unknown'}`, '#833');
        }
    };
    window.addEventListener('message', onMessage);
    mount.appendChild(banner);
    mount.appendChild(iframe);

    return {
        close() {
            window.removeEventListener('message', onMessage);
            iframe.remove();
            banner.remove();
            link.close();
        },
    };
}
