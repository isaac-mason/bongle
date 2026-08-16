import type { App, Channel, Process } from '../interface';

// The boot supervisor. Owns the service topology + spawn order the host used to
// hardcode: bake the pipeline, then start the server, emitting the aggregate boot
// phase as `progress` (the shell reflects it onto the preview chip). Auto-started
// with the session (handed through to the server), it then stays alive as the
// 'supervisor' the shell drives restart through and watches for crashes.
//
// The host no longer knows pipeline-then-server, the phase strings, or how to
// restart a service — it runs this blind and dials only the services it genuinely
// needs ('pipeline' for the prod-build config, 'game' readiness for the client
// backend), plus 'supervisor' to request a restart and to hear crash events.
const boot: App = async (env) => {
    // the services this supervisor owns, restarted in place on command.
    const procs: Record<string, Process> = {};
    // open supervisor connections — the shell holds one to hear crash events.
    const subscribers = new Set<Channel>();
    // procs we killed on purpose (a restart) — so their exit isn't read as a crash.
    const killing = new Set<Process>();

    const announce = (event: unknown): void => {
        for (const conn of subscribers) conn.send(event);
    };

    const spawn = (name: 'pipeline' | 'server'): void => {
        const proc = name === 'server' ? env.spawn('server', env.init) : env.spawn('pipeline');
        procs[name] = proc;
        // an exit we didn't ask for is a crash — tell the shell so it fails fast
        // instead of waiting out its readiness timeout.
        void proc.exit.then((code) => {
            if (killing.delete(proc)) return; // an intentional restart, not a crash
            announce({ event: 'crashed', service: name, code });
        });
    };

    // serve 'supervisor' first, so the shell's health connection is up before any
    // service can crash. restart: cycle a service in place (kill → graceful dispose
    // flush → respawn = fresh pid = fresh module graph), reply when it's back.
    env.listen('supervisor', (conn) => {
        subscribers.add(conn);
        void conn.closed.then(() => subscribers.delete(conn));
        return async (msg) => {
            const name = (msg as { restart?: 'pipeline' | 'server' }).restart;
            const proc = name ? procs[name] : undefined;
            if (!name || !proc) return;
            killing.add(proc);
            proc.kill();
            await proc.exit; // graceful: the OS holds teardown for the app's flush
            spawn(name);
            conn.send({ restarted: name });
        };
    });

    env.progress('baking assets');
    spawn('pipeline');
    await env.connect('pipeline'); // resolves once the first bake is done (pipeline serves post-bake)
    env.progress('starting server');
    spawn('server'); // the server self-gates on the pipeline again
};

export default boot;
