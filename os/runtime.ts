import { makeChannel } from './channel';
import type { ToApp, ToOS } from './control';
import type { App, Channel, ConnMeta, Env, Filesystem, Link, Process, Runner, Server, Surface } from './interface';

// The app-side runtime: builds the Env over a control Link and runs the app. `fs`
// (the host's concrete impl) and `runner` (built from the spawn-provided conduit
// port) are injected by the host shim — the runtime is disk- and host-agnostic.
// Handlers wired at creation.
export async function runApp(
    app: App,
    init: unknown,
    surface: boolean,
    link: Link,
    fs: Filesystem,
    caps: { runner: Runner },
): Promise<void> {
    let nextReq = 1;
    // request/reply correlation is by number, so the reply payload is genuinely
    // dynamic here — the ONE place the runtime reads a frame loosely (a `req`-
    // bearing reply: channel/spawned/exited).
    // biome-ignore lint/suspicious/noExplicitAny: matched-by-number reply payload.
    const pending = new Map<number, (msg: any, ports: readonly MessagePort[]) => void>();
    const listeners = new Map<string, (conn: Channel, meta: ConnMeta) => ((m: unknown) => void) | void>();
    const channels = new Map<number, Channel>();
    const shutdown = new AbortController();
    const disposers = new Set<() => void | Promise<void>>();
    let onStdin: ((data: string | Uint8Array) => void) | undefined;

    /** post a typed app → OS frame (a typo'd frame won't compile). */
    const send = (frame: ToOS, transfer?: Transferable[]): void => link.post(frame, transfer);

    link.onMessage((data, ports) => {
        const msg = data as ToApp;
        switch (msg.k) {
            case 'incoming': {
                const onConnect = listeners.get(msg.name);
                if (onConnect && ports[0]) {
                    const { conn, wire } = makeChannel(ports[0], () => send({ k: 'close', conn: msg.conn }));
                    channels.set(msg.conn, conn);
                    const h = onConnect(conn, msg.meta);
                    if (h) wire(h);
                }
                return;
            }
            case 'closed': {
                const c = channels.get(msg.conn);
                channels.delete(msg.conn);
                c?.close();
                return;
            }
            case 'stdin':
                onStdin?.(msg.data);
                return;
            case 'dispose':
                shutdown.abort(); // cancel in-flight work
                void (async () => {
                    for (const d of disposers) {
                        try {
                            await d(); // awaited teardown (flush) before we ack
                        } catch {
                            /* a failing disposer must not block the ack */
                        }
                    }
                    send({ k: 'disposed' });
                })();
                return;
            default:
                // channel / spawned / exited — the req-correlated replies.
                if ('req' in msg) {
                    const p = pending.get(msg.req);
                    if (p) {
                        pending.delete(msg.req);
                        p(msg, ports);
                    }
                }
        }
    });

    // spawn/wait: post the frame with a fresh req, resolve when its reply lands.
    const call = (frame: { k: 'spawn'; ref: string; init?: unknown } | { k: 'wait'; pid: number }, transfer?: Transferable[]) =>
        // biome-ignore lint/suspicious/noExplicitAny: matched-by-number reply payload.
        new Promise<{ msg: any; ports: readonly MessagePort[] }>((resolve) => {
            const req = nextReq++;
            pending.set(req, (msg, ports) => resolve({ msg, ports }));
            send({ ...frame, req }, transfer);
        });

    const abortReason = (s: AbortSignal): Error =>
        s.reason instanceof Error ? s.reason : new Error('connect aborted');

    const env: Env = {
        init,
        signal: shutdown.signal,
        onDispose: (fn) => void disposers.add(fn),
        fs,
        runner: caps.runner,
        spawn(childRef, childInit): Process {
            let pid = -1;
            const exit = (async () => {
                const spawned = await call({ k: 'spawn', ref: childRef, init: childInit });
                pid = spawned.msg.pid;
                const done = await call({ k: 'wait', pid });
                return done.msg.code as number;
            })();
            return { exit, kill: () => { if (pid >= 0) send({ k: 'kill', pid }); } };
        },
        connect(name, onMessage, opts) {
            const signal = opts?.signal;
            return new Promise<Channel>((resolve, reject) => {
                if (signal?.aborted) return reject(abortReason(signal));
                const req = nextReq++;
                const onAbort = () => {
                    pending.delete(req);
                    send({ k: 'cancel-connect', req });
                    reject(abortReason(signal!));
                };
                pending.set(req, (msg, ports) => {
                    signal?.removeEventListener('abort', onAbort);
                    const { conn, wire } = makeChannel(ports[0], () => send({ k: 'close', conn: msg.conn }));
                    channels.set(msg.conn, conn);
                    if (onMessage) wire(onMessage);
                    resolve(conn);
                });
                signal?.addEventListener('abort', onAbort, { once: true });
                send({ k: 'connect', name, req });
            });
        },
        listen(name, onConnect): Server {
            listeners.set(name, onConnect);
            send({ k: 'listen', name });
            return {
                close: () => {
                    listeners.delete(name);
                    send({ k: 'unlisten', name });
                },
            };
        },
        surface: surface ? ({ root: document.body } as Surface) : undefined,
        log: (...parts) => send({ k: 'stdout', line: parts.join(' ') }),
        err: (...parts) => send({ k: 'stderr', line: parts.join(' ') }),
        progress: (status) => send({ k: 'progress', status }),
        onStdin: (cb) => {
            onStdin = cb;
        },
    };

    try {
        await app(env);
        // a task exits when it returns; a window / service / (fs watcher, app-held)
        // is event-driven and lives on.
        if (!surface && listeners.size === 0) send({ k: 'exit', code: 0 });
    } catch (e) {
        env.err(String((e as Error)?.stack ?? e));
        send({ k: 'exit', code: 1 });
    }
}
