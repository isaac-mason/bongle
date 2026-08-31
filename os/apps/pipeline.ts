import type { App, Channel, Config, EditorSession, PipelineReport } from '../interface';

// The asset-pipeline app. Evaluates the user graph through the runner, drives
// the engine's EditPipeline bake, then serves "pipeline" as a readiness signal —
// connect resolves once the first bake is done. Holds an fs watcher + a
// listener, so it stays alive.
const pipeline: App = async (env) => {
    const fs = env.fs;
    const runner = env.runner;

    const { env: rt } = await runner.import('bongle/env');
    rt.client = false;
    rt.server = true;
    rt.editor = true;
    try {
        await runner.import('src/index.ts'); // user declarations register into this realm
    } catch (err) {
        env.err('user code threw at eval — baking what registered:', String((err as Error).message));
    }

    const { EditPipeline } = await runner.import('bongle/engine-asset-pipeline');
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
            log: (m: string) => env.log(m),
            // a bake or icon-render failure is stderr, not another progress line — the
            // shell renders it as an error, attributed to this pid. Without it an icon
            // failure only reached this worker's console, which nobody opens.
            err: (m: string) => env.err(m),
        },
        // `renderer` is the shell's `?renderer=` override: this app is a worker, so
        // the icon bake can't read it off `self.location` the way a windowed app does.
        { mode: 'edit', cache: true, renderer: (env.init as EditorSession | undefined)?.renderer },
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
