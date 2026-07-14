// editor/net/relay-server.mjs — the "really stupid" WS relay for multiplayer edit
// sessions. Zero game/fs/bundler knowledge: it forwards opaque binary frames
// between the ONE host of a session and its guests, routing by a 2-byte
// connection id it stamps onto the wire. Host closes → session ends.
//
// Protocol (all binary WS frames):
//   host  dials:  GET /?session=<id>&role=host&token=<t>
//   guest dials:  GET /?session=<id>&role=guest&token=<t>
//
//   guest→relay frame:  <relay-link frame bytes>
//     relay prepends the guest's connId → host frame:  [u16 connId][frame...]
//   host→relay  frame:  [u16 connId][frame...]
//     relay strips connId → forwards raw <frame> to that guest's socket
//
// So a guest speaks plain relay-link frames (createRelayLink over its socket);
// the host speaks connId-prefixed frames (one logical relay-link per guest,
// demuxed here). The relay never looks past the 2-byte connId. Auth/permission
// is the platform adapter's job (it mints the token); a real deploy validates it
// here — this poke accepts any token.
//
// Run: node lib/editor/net/relay-server.mjs   (PORT env, default 8787)

import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8787);

/** session id → { host: WebSocket|null, guests: Map<connId, WebSocket> } */
const sessions = new Map();
let nextConnId = 1;

function sessionOf(id) {
    let s = sessions.get(id);
    if (!s) {
        s = { host: null, guests: new Map() };
        sessions.set(id, s);
    }
    return s;
}

const wss = new WebSocketServer({ port: PORT });
console.log(`[relay] listening on :${PORT}`);

wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sessionId = url.searchParams.get('session');
    const role = url.searchParams.get('role');
    if (!sessionId || (role !== 'host' && role !== 'guest')) {
        ws.close(1008, 'need session + role');
        return;
    }
    const session = sessionOf(sessionId);
    ws.binaryType = 'arraybuffer';

    if (role === 'host') {
        if (session.host) {
            ws.close(1008, 'session already hosted');
            return;
        }
        session.host = ws;
        console.log(`[relay] host up: ${sessionId}`);

        ws.on('message', (data) => {
            // [u16 connId][frame...] → strip, route to that guest.
            const buf = new Uint8Array(data);
            const connId = (buf[0] << 8) | buf[1];
            const guest = session.guests.get(connId);
            guest?.send(buf.subarray(2));
        });

        ws.on('close', () => {
            // host leaves → whole session ends (matches the plan: host-authoritative,
            // dies with the tab).
            console.log(`[relay] host gone, ending session: ${sessionId}`);
            for (const g of session.guests.values()) g.close(1001, 'host left');
            sessions.delete(sessionId);
        });
        return;
    }

    // guest
    if (!session.host) {
        ws.close(1008, 'no host for session');
        return;
    }
    const connId = nextConnId++;
    session.guests.set(connId, ws);
    console.log(`[relay] guest ${connId} joined: ${sessionId}`);
    // tell the host a guest arrived (control frame on the host's stream).
    hostNotify(session.host, connId, { type: 'guest-join', connId });

    ws.on('message', (data) => {
        // guest frame → prepend connId → host.
        const frame = new Uint8Array(data);
        const out = new Uint8Array(2 + frame.byteLength);
        out[0] = (connId >> 8) & 0xff;
        out[1] = connId & 0xff;
        out.set(frame, 2);
        session.host.send(out);
    });

    ws.on('close', () => {
        session.guests.delete(connId);
        console.log(`[relay] guest ${connId} left: ${sessionId}`);
        if (session.host) hostNotify(session.host, connId, { type: 'guest-leave', connId });
    });
});

// Deliver a relay-side control message to the host as a connId-tagged control
// frame. Mirrors relay-link's frame format: [u8 channel=0][u8 kind=1][json].
// (Kept in sync with Channel.control / KIND_JSON in relay-link.ts.)
function hostNotify(hostWs, connId, msg) {
    const json = new TextEncoder().encode(JSON.stringify(msg));
    const frame = new Uint8Array(2 + json.byteLength);
    frame[0] = 0; // Channel.control
    frame[1] = 1; // KIND_JSON
    frame.set(json, 2);
    const out = new Uint8Array(2 + frame.byteLength);
    out[0] = (connId >> 8) & 0xff;
    out[1] = connId & 0xff;
    out.set(frame, 2);
    hostWs.send(out);
}
