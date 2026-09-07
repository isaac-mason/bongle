import { bootMarks } from '../boot-marks';
import type { App, AppInit, Channel, Config, PipelineReport } from '../interface';

// The asset-pipeline app. Evaluates the user graph through the runner, drives
// the engine's EditPipeline bake, then serves "pipeline" as a readiness signal —
// connect resolves once the first bake is done. Holds an fs watcher + a
// listener, so it stays alive.
const pipeline: App<AppInit> = async (env) => {
    const fs = env.fs;
    const runner = env.runner;
    const mark = bootMarks('pipeline');
    mark('realm up');

    // NEUTRAL env: client/server/editor all stay false. The bake is its own entry
    // (EditPipeline), not a headless client or server, and nothing it touches reads
    // a flag — declarations register ungated, and the engine's env.server /
    // env.editor branches are all runtime gameplay + UI. Leaving them false keeps a
    // user's `if (!env.server) return` gameplay guard from firing during the bake.
    try {
        // the SAME entry the client and server realms take: baking a different module
        // graph than the game runs would leave this realm's registry — and so every
        // artifact gated on it — describing a project nobody plays.
        await runner.import(env.init.entry ?? 'src/index.ts'); // user declarations register into this realm
    } catch (err) {
        env.err('user code threw at eval — baking what registered:', String((err as Error).message));
    }
    mark('user entry imported');

    const { EditPipeline } = await runner.import('bongle/engine-asset-pipeline');
    mark('pipeline module imported');
    let config: Config | null = null;
    // held connections get the fresh report after every bake (the shell holds
    // one open as its config subscription). PipelineReport is the ABI shape.
    const subscribers = new Set<Channel>();
    const report = (): PipelineReport => ({ config });
    const session = EditPipeline.init(
        {
            fs,
            onBaked: (r: { atlasChanged: boolean; config: Config | null }) => {
                config = r.config;
                for (const conn of subscribers) conn.send(report());
            },
            // mirrored to the console so the bake's stage timings sit next to the boot marks.
            log: (m: string) => {
                env.log(m);
                console.log(`[pipeline] ${m}`);
            },
            // a bake or icon-render failure is stderr, not another progress line — the
            // shell renders it as an error, attributed to this pid. Without it an icon
            // failure only reached this worker's console, which nobody opens.
            err: (m: string) => env.err(m),
        },
        // `renderer` is the host's chosen backend, carried on the session: this app is
        // a worker, so the icon bake can't read it off `self.location` the way a
        // windowed app does, and guessing could bake icons on a backend the client
        // isn't running.
        { mode: 'edit', cache: true, renderer: env.init.renderer },
    );

    // asset-file edits re-bake (they bump no registry revision → forceAll).
    const ASSET_RE = /\.(png|jpe?g|glb|gltf|ogg|wav|mp3|flac)$/i;
    let bakeTimer: ReturnType<typeof setTimeout> | undefined;
    env.fs.watch((changes) => {
        const hit = changes.some((c) => ASSET_RE.test(c.path) && !/(^|\/)(resources|node_modules|dist)(\/|$)/.test(c.path));
        if (!hit) return;
        clearTimeout(bakeTimer);
        bakeTimer = setTimeout(() => void EditPipeline.run(session, { forceAll: true }), 150);
    });

    env.progress('baking assets');
    await EditPipeline.run(session); // the first bake, awaited (bake-then-run)
    mark('first bake done');
    env.log('pipeline: initial bake done');
    env.progress('ready');

    // readiness + config: "pipeline" is served only now (post-bake); each
    // connector receives the current report, then updates on every bake.
    env.listen('pipeline', (conn) => {
        subscribers.add(conn);
        void conn.closed.then(() => subscribers.delete(conn));
        conn.send(report());
        return () => {};
    });
};

export default pipeline;
