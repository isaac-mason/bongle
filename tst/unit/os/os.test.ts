// The OS core, exercised end-to-end in-process: a fake IO runs each spawned
// app through the REAL runtime (runApp) over real MessageChannels, so these
// tests cover the control protocol (start/connect/listen/spawn/wait/kill/
// dispose/exit), the switchboard (pairing, pending connects, meta), teardown
// (awaited disposers, channel + listener cleanup), and relay routing between
// two OS instances.

import { describe, expect, it } from 'vitest';
import type { App, AppDefs, ConnMeta, Filesystem, IO, Runner } from '../../../os';
import { createOS, messagePortPeer, portLink, runApp } from '../../../os';

const stubFs = {} as Filesystem;
const stubRunner: Runner = { import: () => Promise.reject(new Error('no runner in unit tests')) };

/** an OS over an in-process host: spawnWorker runs the app via runApp on the
 *  other end of a MessageChannel. All defs are headless (surface unsupported). */
function testOS(apps: Record<string, App>) {
    const logs: { ref: string; line: string; isErr: boolean }[] = [];
    const io: IO = {
        spawnWorker() {
            const ch = new MessageChannel();
            const appSide = portLink(ch.port2);
            appSide.onMessage((msg) => {
                if (msg?.k === 'start') {
                    const app = apps[msg.module];
                    if (app) void runApp(app, msg.init, false, appSide, stubFs, { runner: stubRunner });
                }
            });
            return portLink(ch.port1);
        },
        spawnFrame() {
            throw new Error('no frames in unit tests');
        },
        openRunner: () => new MessageChannel().port2,
        mount() {},
        stdout: (ref, _pid, line, isErr) => logs.push({ ref, line, isErr }),
    };
    const defs: AppDefs = Object.fromEntries(Object.keys(apps).map((k) => [k, { module: k }]));
    const os = createOS(io, async (ref) => defs[ref] ?? null, { projectName: 'test', disposeTimeoutMs: 500 });
    return { os, logs };
}

async function until(cond: () => boolean, what = 'condition'): Promise<void> {
    for (let i = 0; i < 300; i++) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timeout waiting for ${what}`);
}

describe('createOS + runApp', () => {
    it('routes connect to a listener and hands the listener the connector meta', async () => {
        let seenMeta: ConnMeta | null = null;
        const { os } = testOS({
            echo: async (env) => {
                env.listen('echo', (conn, meta) => {
                    seenMeta = meta;
                    return (m) => conn.send(`pong:${m}`);
                });
            },
            dialer: async (env) => {
                const got = new Promise<unknown>((resolve) => {
                    void env.connect('echo', resolve).then((ch) => ch.send('ping'));
                });
                const reply = await got;
                if (reply !== 'pong:ping') throw new Error(`bad reply: ${reply}`);
            },
        });
        os.spawn('echo');
        const code = await os.run('dialer');
        expect(code).toBe(0);
        expect(seenMeta).toMatchObject({ ref: 'dialer' });
    });

    it('parks a connect until the service starts listening', async () => {
        const { os } = testOS({
            late: async (env) => {
                env.listen('late', (conn) => {
                    conn.send('here');
                    return () => {};
                });
            },
            dialer: async (env) => {
                const got = new Promise<unknown>((resolve) => void env.connect('late', resolve));
                await got; // resolves only once `late` exists
            },
        });
        const exit = os.run('dialer');
        await new Promise((r) => setTimeout(r, 50)); // dialer is parked
        os.spawn('late');
        expect(await exit).toBe(0);
    });

    it('resolves run() with 127 for an unknown app and reports it', async () => {
        const { os, logs } = testOS({});
        const code = await os.run('nope');
        expect(code).toBe(127);
        await until(() => logs.some((l) => l.isErr && l.line.includes('no such app')), 'stderr line');
    });

    it('a task app exits 0 on return; a throwing app exits 1 with its stack on stderr', async () => {
        const { os, logs } = testOS({
            ok: async () => {},
            boom: async () => {
                throw new Error('kaput');
            },
        });
        expect(await os.run('ok')).toBe(0);
        expect(await os.run('boom')).toBe(1);
        expect(logs.some((l) => l.isErr && l.line.includes('kaput'))).toBe(true);
    });

    it('spawn/wait from inside an app observes the child exit code', async () => {
        const { os } = testOS({
            child: async () => {
                throw new Error('child dies');
            },
            parent: async (env) => {
                const code = await env.spawn('child').exit;
                if (code !== 1) throw new Error(`expected 1, got ${code}`);
            },
        });
        expect(await os.run('parent')).toBe(0);
    });

    it('kill runs awaited disposers before finalizing, then closes held channels and frees names', async () => {
        let flushed = false;
        let connected = false;
        const { os } = testOS({
            svc: async (env) => {
                env.onDispose(async () => {
                    await new Promise((r) => setTimeout(r, 30));
                    flushed = true;
                });
                env.listen('svc', () => {
                    connected = true;
                    return () => {};
                });
            },
            holder: async (env) => {
                const ch = await env.connect('svc');
                await ch.closed; // resolves when the service is torn down
            },
        });
        const pid = os.spawn('svc');
        const holderExit = os.run('holder');
        await until(() => connected, 'holder connected');
        os.kill(pid);
        expect(await holderExit).toBe(0);
        expect(flushed).toBe(true);
        // the name is freed: a fresh shell connect parks (nothing serves it).
        const parked = await Promise.race([
            os.connect('svc').then(() => 'connected'),
            new Promise((r) => setTimeout(() => r('parked'), 100)),
        ]);
        expect(parked).toBe('parked');
    });

    it('shell connect parks until the service is up, then round-trips messages with meta', async () => {
        let seenMeta: ConnMeta | null = null;
        const { os } = testOS({
            svc: async (env) => {
                env.listen('svc', (conn, meta) => {
                    seenMeta = meta;
                    return (m) => conn.send(`svc:${m}`);
                });
            },
        });
        const got = new Promise<unknown>(async (resolve) => {
            // dialed BEFORE the spawn: parks, resolves once svc listens.
            const ch = await os.connect('svc', resolve, { ref: 'guest', pid: 42, user: { id: 'u1', username: 'isaac' } });
            ch.send('hello');
        });
        os.spawn('svc');
        expect(await got).toBe('svc:hello');
        expect(seenMeta).toMatchObject({ ref: 'guest', pid: 42, user: { username: 'isaac' } });
    });

    it('wait(pid) resolves with the exit code, including for already-exited pids', async () => {
        const { os } = testOS({
            boom: async () => {
                throw new Error('dead');
            },
        });
        const pid = os.spawn('boom');
        expect(await os.wait(pid)).toBe(1);
        expect(await os.wait(pid)).toBe(1); // post-exit wait resolves immediately
    });

    it('inspect() reflects procs, serves, and named conns; onChange fires on changes', async () => {
        const { os } = testOS({
            svc: async (env) => {
                env.listen('echo', (conn) => (m) => conn.send(m));
            },
            dialer: async (env) => {
                await env.connect('echo');
                await new Promise(() => {}); // hold the conn open (killed by the test)
            },
        });
        let changes = 0;
        const off = os.onChange(() => changes++);
        os.spawn('svc');
        await os.served('echo');
        const dialerPid = os.spawn('dialer');
        await until(() => os.inspect().conns.some((c) => c.name === 'echo'), 'echo conn');
        const snap = os.inspect();
        expect(snap.procs.map((p) => p.ref).sort()).toEqual(['dialer', 'svc']);
        expect(snap.procs.find((p) => p.ref === 'svc')?.serves).toEqual(['echo']);
        const conn = snap.conns.find((c) => c.name === 'echo')!;
        expect(conn.from).toBe(dialerPid);
        expect(changes).toBeGreaterThan(0);
        off();
        os.kill(dialerPid);
        await os.wait(dialerPid);
        expect(os.inspect().conns.some((c) => c.name === 'echo')).toBe(false);
    });

    it('surfaces env.progress on the proc snapshot and delivers stdin via OS.stdin', async () => {
        let got: (string | Uint8Array) | null = null;
        let pid = 0;
        const { os } = testOS({
            worker: async (env) => {
                env.progress('phase-1');
                env.onStdin((data) => {
                    got = data;
                });
                env.listen('worker', () => () => {}); // stay alive
            },
        });
        pid = os.spawn('worker');
        await until(() => os.inspect().procs.some((p) => p.ref === 'worker' && p.progress === 'phase-1'), 'progress');
        os.stdin(pid, 'hello');
        await until(() => got === 'hello', 'stdin delivered');
    });

    it('exits a process whose host-side spawn throws, instead of leaving a phantom pid', async () => {
        // A spawn that fails PAST the "no such app" check (the host couldn't make a worker, the
        // runner conduit threw) used to reject inside spawn's floating promise: no proc record, no
        // exit code, so `wait(pid)` never settled and the shell could only discover it by timing
        // out on readiness with a misleading "never served".
        const io: IO = {
            spawnWorker() {
                throw new Error('worker construction failed');
            },
            spawnFrame() {
                throw new Error('no frames in unit tests');
            },
            openRunner: () => new MessageChannel().port2,
            mount() {},
            stdout: () => {},
        };
        const os = createOS(io, async () => ({ module: 'boom' }), { projectName: 'test', disposeTimeoutMs: 500 });

        const pid = os.spawn('boom');
        const code = await Promise.race([os.wait(pid), new Promise<'hung'>((r) => setTimeout(() => r('hung'), 300))]);
        expect(code).not.toBe('hung');
        expect(code).not.toBe(0); // a failed spawn is not a success
        expect(os.inspect().procs.some((p) => p.pid === pid)).toBe(false);
    });

    it('drops a readiness wait that is abandoned, rather than parking it forever', async () => {
        const { os } = testOS({});
        const ac = new AbortController();
        const waited = os.served('never-served', ac.signal);
        expect(os.inspect().pending.find((p) => p.name === 'never-served')?.count).toBe(1);

        // the shell races `served` against a timeout; without a way to retract the loser, every
        // timed-out restart left a waiter parked on the name for the life of the session.
        ac.abort();
        await expect(waited).rejects.toThrow(/abort/i);
        expect(os.inspect().pending.find((p) => p.name === 'never-served')).toBeUndefined();
    });

    it('routes connects across two OS instances over a relay, and close propagates', async () => {
        let hostConnected = false;
        const host = testOS({
            svc: async (env) => {
                env.listen('game', (conn, meta) => {
                    hostConnected = true;
                    void meta;
                    return (m) => conn.send(`host:${m}`);
                });
            },
        });
        const guest = testOS({
            dialer: async (env) => {
                const got = new Promise<unknown>((resolve) => {
                    void env.connect('game', resolve).then((ch) => ch.send('join'));
                });
                const reply = await got;
                if (reply !== 'host:join') throw new Error(`bad reply: ${reply}`);
            },
        });
        const pipe = new MessageChannel();
        host.os.attachPeer(messagePortPeer(pipe.port1), []);
        guest.os.attachPeer(messagePortPeer(pipe.port2), ['game']);
        host.os.spawn('svc');
        (await host.os.connect('game')).close(); // parks until the host svc serves
        expect(await guest.os.run('dialer')).toBe(0);
        expect(hostConnected).toBe(true);
    });
});
