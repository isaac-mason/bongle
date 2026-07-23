// editor/net/guest-session.ts — the guest counterpart to host-session.
//
// A guest runs the FULL editor (Desktop, file tree, code + apps) against the host's
// project over the relay — no local server/bundler/pipeline workers. This builds the
// guest's backend pieces:
//   - the relay link (one socket, channel-muxed: game / bundler / fsrpc / control)
//   - a remote Filesystem over the fsrpc lane (the editor's `fs`)
//   - a ClientConnector that wires each play-preview iframe: game/bundler bridged to
//     the host over the relay, and fsrpc served LOCALLY from the guest's remote fs
//     (the editor owns the single relay fsrpc lane; the iframe proxies through it).
// It also owns a persistent disconnect overlay — if the host stops multiplayer (or
// the socket drops) the guest gets a clear, blocking "reconnect" surface instead of
// a live-looking but dead editor.

import { Channel, createRelayLink, type PortLike, type RelayLink } from '../../build';
import type { Filesystem } from '../fs';
import type { ClientConnector } from '../realms/client/client-host';
import { connectRelaySocket } from './gatho-socket';
import { asPortLike, createRemoteFilesystem, serveFilesystemOverPort } from './remote-fs';

export type GuestSession = {
    /** the relay link (game/bundler/fsrpc lanes to the host). */
    link: RelayLink;
    /** the host's project as a Filesystem — the editor's `fs`. */
    fs: Filesystem;
    /** wires each play-preview iframe to the host over the relay. */
    connector: ClientConnector;
    dispose(): void;
};

export type GuestSessionOptions = {
    /** relay ws url + token from /api/edit/join. */
    url: string;
    log?: (msg: string) => void;
};

/** pump frames both ways between a MessageChannel port and a relay lane. */
function bridge(port: MessagePort, relay: PortLike): void {
    port.onmessage = (e) => relay.postMessage(e.data);
    relay.onmessage = (e) => port.postMessage(e.data);
}

/** the guest's play-preview connector: game/bundler bridged to the host over the
 *  relay, fsrpc served from the guest's remote fs. The relay lanes are singular, so
 *  a guest opens ONE play window. */
function relayConnector(link: RelayLink, fs: Filesystem): ClientConnector {
    return {
        connect() {
            const game = new MessageChannel();
            const bundler = new MessageChannel();
            const fsrpc = new MessageChannel();
            bridge(game.port1, link.port(Channel.game));
            bridge(bundler.port1, link.port(Channel.bundler));
            // the iframe's fs proxies THROUGH the editor's remote fs (which owns the
            // single relay fsrpc lane) — one in-process hop to the host.
            const serve = serveFilesystemOverPort(fs, asPortLike(fsrpc.port1));
            return { ports: [game.port2, bundler.port2, fsrpc.port2], dispose: () => serve.close() };
        },
    };
}

export function createGuestSession(opts: GuestSessionOptions): GuestSession {
    const { url, log = () => {} } = opts;
    const say = (m: string) => {
        console.log(`[mp:guest] ${m}`);
        log(m);
    };

    // full-viewport overlay: blocks the editor until connected, and surfaces a
    // relay drop (host stopped, or the network died) with a Reconnect that reloads.
    const overlay = document.createElement('div');
    overlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483601;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.72);font:13px/1.6 monospace;color:#fff;';
    const card = document.createElement('div');
    card.style.cssText = 'max-width:340px;border:1px solid #555;background:#1a1a1a;padding:16px 18px;text-align:center;';
    overlay.appendChild(card);
    const status = (title: string, detail?: string, reconnect = false) => {
        card.replaceChildren();
        const h = document.createElement('div');
        h.style.cssText = 'font-weight:bold;margin-bottom:6px;';
        h.textContent = title;
        card.append(h);
        if (detail) {
            const p = document.createElement('div');
            p.style.cssText = 'color:#aaa;margin-bottom:12px;';
            p.textContent = detail;
            card.append(p);
        }
        if (reconnect) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = 'Reconnect';
            btn.style.cssText = 'cursor:pointer;border:1px solid #666;background:#333;color:#fff;padding:6px 14px;font:inherit;';
            btn.onclick = () => location.reload();
            card.append(btn);
        }
        overlay.style.display = 'flex';
    };
    status('Connecting to host…');

    let opened = false;
    let closedByUs = false;
    say(`dialing relay ${url}`);
    const socket = connectRelaySocket(url, {
        onOpen: () => {
            opened = true;
            overlay.style.display = 'none';
            say('relay socket open');
        },
        onClose: () => {
            if (closedByUs) return;
            say('relay closed — session ended');
            status(
                opened ? 'Disconnected from the session' : 'Could not join the session',
                opened
                    ? 'The host may have stopped multiplayer, or your connection dropped. Reconnect to try again.'
                    : 'The host session may have ended or the invite link expired.',
                true,
            );
        },
        onError: () => {
            if (closedByUs) return;
            say('relay socket error');
            status('Connection lost', 'There was a connection error reaching the host. Reconnect to try again.', true);
        },
    });

    const link = createRelayLink(socket);
    const fs = createRemoteFilesystem(link.port(Channel.fsrpc));
    const connector = relayConnector(link, fs);
    document.body.appendChild(overlay);

    return {
        link,
        fs,
        connector,
        dispose() {
            closedByUs = true;
            overlay.remove();
            link.close();
        },
    };
}
