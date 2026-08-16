import { makeChannel } from './channel';
import type { ToApp, ToOS } from './control';
import type { AppDef, Channel, ConnMeta, IO, Link, OS, OSSnapshot, PeerFrame, PeerLink, ResolveDef } from './interface';

// ─────────────────────────────────────────────────────────────────────────────
// createOS — the workspace. Host-agnostic: the switchboard, process table,
// lifecycle/teardown, peer routing, over the injected `io`. Zero DOM, zero fs
// (fs is opened per-app in the host shim). A factory returning a plain OS.
//
// Every app is a module: spawn resolves the def, asks the host for a runner
// conduit for the new process, and posts the start frame with the transferred
// port — the shim builds the runner from it, evaluates `def.module`, and runs
// its default export.
// ─────────────────────────────────────────────────────────────────────────────

type Endpoint = number | 'peer' | 'shell';

type Rec = {
    pid: number;
    ref: string;
    link: Link;
    startedAt: number;
    surface: boolean;
    listens: Set<string>;
    held: Set<number>;
    waiters: { pid: number; req: number }[];
    exited: boolean;
    code: number;
    stopping?: boolean;
    progress?: unknown;
    onDisposed?: () => void;
    resolveClosed?: () => void;
};

export type OSOptions = {
    /** the project whose disk each app opens (passed to the shim). */
    projectName: string;
    /** how long to wait for an app's cleanup before forcing teardown (default 5s —
     *  the server's flush window). */
    disposeTimeoutMs?: number;
};

export function createOS(io: IO, resolve: ResolveDef, opts: OSOptions): OS {
    const disposeTimeoutMs = opts.disposeTimeoutMs ?? 5000;
    const procs = new Map<number, Rec>();
    const listeners = new Map<string, number>();
    // callbacks parked on a name that isn't served yet — an app connect, a shell
    // connect, or a shell served() all wait the same way and flush together the
    // instant a process listens on the name. `owner` (app connects only) gives
    // the waiter an identity for cancellation + the unrouted warning.
    type Waiter = { resolve: () => void; owner?: { pid: number; req: number } };
    const waiters = new Map<string, Waiter[]>();
    // a = the listener side, b = the dialer; `name` is what the dialer asked for.
    const conns = new Map<number, { a: Endpoint; b: Endpoint; name: string }>();
    const shellChans = new Map<number, Channel>();
    const exitResolvers = new Map<number, ((code: number) => void)[]>();
    const exitCodes = new Map<number, number>();
    let nextPid = 1;
    let nextConn = 1;
    let nextCid = 1;

    // park a waiter on a not-yet-served name (see Waiter).
    function park(name: string, w: Waiter): void {
        const arr = waiters.get(name) ?? [];
        arr.push(w);
        waiters.set(name, arr);
        notify();
    }

    // coarse change stream for the shell's task-manager view.
    const observers = new Set<() => void>();
    const notify = (): void => {
        for (const cb of observers) cb();
    };

    let peer: PeerLink | undefined;
    let remoteNames = new Set<string>();
    const bridges = new Map<number, MessagePort>();
    const connCid = new Map<number, number>();
    const cidConn = new Map<number, number>();

    /** post a typed OS → app frame (a typo'd frame won't compile). */
    const toApp = (link: Link, frame: ToApp, transfer?: Transferable[]): void => link.post(frame, transfer);

    // ── spawning ────────────────────────────────────────────────────────────
    // spawn allocates the pid synchronously (callers treat it as fire-and-forget),
    // then resolves the definition async and boots it. A missing def fails the
    // process (exit 127) rather than throwing.
    function spawn(ref: string, init?: unknown): number {
        const pid = nextPid++;
        void resolve(ref).then((def) => (def ? boot(ref, def, init, pid) : failSpawn(ref, pid)));
        return pid;
    }

    function boot(ref: string, def: AppDef, init: unknown, pid: number): void {
        if (def.surface) spawnFrame(ref, def, init, pid);
        else spawnWorker(ref, def, init, pid);
    }

    function failSpawn(ref: string, pid: number): void {
        io.stdout(ref, pid, `no such app: "${ref}"`, true);
        exitCodes.set(pid, 127);
        for (const r of exitResolvers.get(pid) ?? []) r(127);
        exitResolvers.delete(pid);
    }

    function startFrame(ref: string, def: AppDef, init: unknown, surface: boolean): ToApp {
        return { k: 'start', ref, init, projectName: opts.projectName, module: def.module, surface };
    }

    // the transferred conduits every start frame carries: the runner, and
    // (guest OS only) an fsrpc port — else the shim opens the local disk.
    function startPorts(ref: string, pid: number): MessagePort[] {
        const ports = [io.openRunner(ref, pid)];
        const fsPort = io.openFs?.(ref, pid);
        if (fsPort) ports.push(fsPort);
        return ports;
    }

    function spawnWorker(ref: string, def: AppDef, init: unknown, pid: number): void {
        const link = io.spawnWorker();
        register(pid, ref, link, false);
        toApp(link, startFrame(ref, def, init, false), startPorts(ref, pid));
    }

    function spawnFrame(ref: string, def: AppDef, init: unknown, pid: number): void {
        const { link, element } = io.spawnFrame();
        let resolveClosed!: () => void;
        const closed = new Promise<void>((r) => (resolveClosed = r));
        const rec = register(pid, ref, link, true);
        rec.resolveClosed = resolveClosed;
        io.mount({ ref, pid, element, closed });
        toApp(link, startFrame(ref, def, init, true), startPorts(ref, pid));
    }

    function register(pid: number, ref: string, link: Link, surface: boolean): Rec {
        const rec: Rec = {
            pid,
            ref,
            link,
            startedAt: Date.now(),
            surface,
            listens: new Set(),
            held: new Set(),
            waiters: [],
            exited: false,
            code: 0,
        };
        procs.set(pid, rec);
        link.onMessage((msg, ports) => onMsg(rec, msg as ToOS, ports));
        notify();
        return rec;
    }

    // ── app control frames ────────────────────────────────────────────────────
    function onMsg(rec: Rec, msg: ToOS, _ports: readonly MessagePort[]): void {
        switch (msg.k) {
            case 'listen': {
                listeners.set(msg.name, rec.pid);
                rec.listens.add(msg.name);
                // wake everyone parked on this name — connects reconnect, served()
                // resolves, all through their own continuation.
                const parked = waiters.get(msg.name);
                if (parked) {
                    waiters.delete(msg.name);
                    for (const w of parked) w.resolve();
                }
                notify();
                break;
            }
            case 'unlisten':
                if (listeners.get(msg.name) === rec.pid) listeners.delete(msg.name);
                rec.listens.delete(msg.name);
                notify();
                break;
            case 'connect': {
                if (listeners.has(msg.name)) connectPair(msg.name, rec.pid, msg.req);
                else if (peer && remoteNames.has(msg.name)) openRemote(msg.name, rec, msg.req);
                else {
                    const pid = rec.pid;
                    const req = msg.req;
                    const name = msg.name;
                    park(name, { resolve: () => connectPair(name, pid, req), owner: { pid, req } });
                    warnIfUnrouted(rec, name, req);
                }
                break;
            }
            case 'cancel-connect':
                cancelConnect(rec.pid, msg.req);
                break;
            case 'close':
                closeConn(msg.conn, rec.pid);
                break;
            case 'spawn': {
                const childPid = spawn(msg.ref, msg.init);
                toApp(rec.link, { k: 'spawned', req: msg.req, pid: childPid });
                break;
            }
            case 'wait': {
                const target = procs.get(msg.pid);
                if (!target || target.exited) toApp(rec.link, { k: 'exited', req: msg.req, code: target?.code ?? 0 });
                else target.waiters.push({ pid: rec.pid, req: msg.req });
                break;
            }
            case 'kill': {
                const target = procs.get(msg.pid);
                if (target) stop(target, 137);
                break;
            }
            case 'disposed':
                rec.onDisposed?.();
                break;
            case 'stdout':
                io.stdout(rec.ref, rec.pid, msg.line, false);
                break;
            case 'stderr':
                io.stdout(rec.ref, rec.pid, msg.line, true);
                break;
            case 'progress':
                rec.progress = msg.status;
                notify();
                break;
            case 'exit':
                finalize(rec, msg.code ?? 0);
                break;
        }
    }

    // ── the switchboard ───────────────────────────────────────────────────────
    function connectPair(name: string, connectorPid: number, req: number): void {
        const listener = procs.get(listeners.get(name)!);
        const connector = procs.get(connectorPid);
        if (!listener || !connector) return;
        const conn = nextConn++;
        const ch = new MessageChannel();
        const meta: ConnMeta = { ref: connector.ref, pid: connector.pid };
        toApp(listener.link, { k: 'incoming', name, conn, meta }, [ch.port1]);
        toApp(connector.link, { k: 'channel', req, conn }, [ch.port2]);
        conns.set(conn, { a: listener.pid, b: connector.pid, name });
        listener.held.add(conn);
        connector.held.add(conn);
        notify();
    }

    function cancelConnect(pid: number, req: number): void {
        for (const [name, arr] of waiters) {
            const i = arr.findIndex((w) => w.owner?.pid === pid && w.owner?.req === req);
            if (i >= 0) {
                arr.splice(i, 1);
                if (arr.length === 0) waiters.delete(name);
                return;
            }
        }
    }

    function warnIfUnrouted(rec: Rec, name: string, req: number): void {
        setTimeout(() => {
            const pending = waiters.get(name)?.some((w) => w.owner?.pid === rec.pid && w.owner?.req === req);
            if (pending && procs.has(rec.pid))
                io.stdout(rec.ref, rec.pid, `connect("${name}") unrouted after 3s — typo or crashed service?`, true);
        }, 3000);
    }

    // ── peer routing (channels only; fs stays its own lane) ────────────────────
    function attachPeer(p: PeerLink, names: string[]): void {
        peer = p;
        remoteNames = new Set(names);
        p.onMessage(onPeer);
    }

    function openRemote(name: string, connector: Rec, req: number): void {
        const conn = nextConn++;
        const cid = nextCid++;
        const ch = new MessageChannel();
        toApp(connector.link, { k: 'channel', req, conn }, [ch.port2]);
        bridge(cid, ch.port1);
        conns.set(conn, { a: 'peer', b: connector.pid, name });
        connCid.set(conn, cid);
        cidConn.set(cid, conn);
        connector.held.add(conn);
        peer!.send({ t: 'open', cid, name, meta: { ref: connector.ref, pid: connector.pid } });
        notify();
    }

    function onPeer(frame: PeerFrame): void {
        switch (frame.t) {
            case 'open': {
                const lp = listeners.get(frame.name);
                if (lp == null) {
                    peer?.send({ t: 'close', cid: frame.cid });
                    return;
                }
                const listener = procs.get(lp)!;
                const conn = nextConn++;
                const ch = new MessageChannel();
                toApp(listener.link, { k: 'incoming', name: frame.name, conn, meta: frame.meta }, [ch.port1]);
                bridge(frame.cid, ch.port2);
                conns.set(conn, { a: lp, b: 'peer', name: frame.name });
                connCid.set(conn, frame.cid);
                cidConn.set(frame.cid, conn);
                listener.held.add(conn);
                notify();
                return;
            }
            case 'data':
                bridges.get(frame.cid)?.postMessage(frame.data);
                return;
            case 'close': {
                const conn = cidConn.get(frame.cid);
                if (conn !== undefined) closeConn(conn, 'peer');
                return;
            }
        }
    }

    function bridge(cid: number, port: MessagePort): void {
        bridges.set(cid, port);
        port.onmessage = (e) => peer!.send({ t: 'data', cid, data: e.data });
    }

    // ── teardown ────────────────────────────────────────────────────────────
    function closeConn(conn: number, by: Endpoint): void {
        const e = conns.get(conn);
        if (!e) return;
        conns.delete(conn);
        const cid = connCid.get(conn);
        if (cid !== undefined) {
            if (by !== 'peer') peer?.send({ t: 'close', cid });
            bridges.get(cid)?.close();
            bridges.delete(cid);
            connCid.delete(conn);
            cidConn.delete(cid);
        }
        for (const ep of [e.a, e.b]) {
            if (ep === by || ep === 'peer') continue;
            if (ep === 'shell') {
                const c = shellChans.get(conn);
                shellChans.delete(conn);
                c?.close();
            } else {
                const rec = procs.get(ep);
                rec?.held.delete(conn);
                if (rec) toApp(rec.link, { k: 'closed', conn });
            }
        }
        if (typeof by === 'number') procs.get(by)?.held.delete(conn);
        notify();
    }

    function stop(rec: Rec, code: number): void {
        if (rec.stopping || rec.exited) return;
        rec.stopping = true;
        notify();
        toApp(rec.link, { k: 'dispose' });
        const timer = setTimeout(() => finalize(rec, code), disposeTimeoutMs);
        rec.onDisposed = () => {
            clearTimeout(timer);
            finalize(rec, code);
        };
    }

    function finalize(rec: Rec, code: number): void {
        if (rec.exited) return;
        rec.exited = true;
        rec.code = code;
        for (const conn of [...rec.held]) closeConn(conn, rec.pid);
        for (const name of rec.listens) if (listeners.get(name) === rec.pid) listeners.delete(name);
        for (const w of rec.waiters) {
            const waiter = procs.get(w.pid);
            if (waiter) toApp(waiter.link, { k: 'exited', req: w.req, code });
        }
        exitCodes.set(rec.pid, code);
        for (const resolve of exitResolvers.get(rec.pid) ?? []) resolve(code);
        exitResolvers.delete(rec.pid);
        rec.resolveClosed?.();
        rec.link.close();
        procs.delete(rec.pid);
        notify();
    }

    // ── operator surface ──────────────────────────────────────────────────────
    function run(ref: string, init?: unknown): Promise<number> {
        const pid = spawn(ref, init);
        return new Promise((resolve) => {
            const arr = exitResolvers.get(pid) ?? [];
            arr.push(resolve);
            exitResolvers.set(pid, arr);
        });
    }

    function openShellConn(name: string, onMessage?: (m: unknown) => void, meta?: Partial<ConnMeta>): Channel {
        const lp = listeners.get(name)!;
        const listener = procs.get(lp)!;
        const conn = nextConn++;
        const ch = new MessageChannel();
        const connMeta: ConnMeta = { ref: meta?.ref ?? 'shell', pid: meta?.pid ?? 0, user: meta?.user };
        toApp(listener.link, { k: 'incoming', name, conn, meta: connMeta }, [ch.port1]);
        listener.held.add(conn);
        conns.set(conn, { a: lp, b: 'shell', name });
        const { conn: chan, wire } = makeChannel(ch.port2, () => closeConn(conn, 'shell'));
        if (onMessage) wire(onMessage);
        shellChans.set(conn, chan);
        notify();
        return chan;
    }

    // parks until the name is served — the shell's readiness signal for a spawned
    // service, symmetric with an app-side connect.
    function connectShell(name: string, onMessage?: (m: unknown) => void, meta?: Partial<ConnMeta>): Promise<Channel> {
        if (listeners.has(name)) return Promise.resolve(openShellConn(name, onMessage, meta));
        return new Promise((resolve) => park(name, { resolve: () => resolve(openShellConn(name, onMessage, meta)) }));
    }

    function served(name: string): Promise<void> {
        if (listeners.has(name)) return Promise.resolve();
        return new Promise((resolve) => park(name, { resolve }));
    }

    function wait(pid: number): Promise<number> {
        if (!procs.has(pid)) {
            const code = exitCodes.get(pid);
            if (code !== undefined) return Promise.resolve(code);
            // spawned but the def is still resolving — fall through and register.
        }
        return new Promise((resolve) => {
            const arr = exitResolvers.get(pid) ?? [];
            arr.push(resolve);
            exitResolvers.set(pid, arr);
        });
    }

    function stdin(pid: number, data: string | Uint8Array): void {
        const rec = procs.get(pid);
        if (rec && !rec.exited) toApp(rec.link, { k: 'stdin', data });
    }

    function kill(pid: number): void {
        const rec = procs.get(pid);
        if (rec) stop(rec, 0);
    }

    // ── observability ─────────────────────────────────────────────────────────
    function inspect(): OSSnapshot {
        return {
            procs: [...procs.values()].map((r) => ({
                pid: r.pid,
                ref: r.ref,
                startedAt: r.startedAt,
                state: r.stopping ? ('stopping' as const) : ('running' as const),
                serves: [...r.listens],
                surface: r.surface,
                progress: r.progress,
            })),
            conns: [...conns.values()].map((c) => ({ name: c.name, from: c.b, to: c.a })),
            pending: [...waiters].map(([name, arr]) => ({ name, count: arr.length })),
        };
    }

    function onChange(cb: () => void): () => void {
        observers.add(cb);
        return () => observers.delete(cb);
    }

    return { spawn, run, connect: connectShell, served, wait, stdin, kill, attachPeer, inspect, onChange };
}
