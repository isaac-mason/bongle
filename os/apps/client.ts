import { RIG_TYPE_6BONE } from 'bongle/avatar';
import type { ClientDriver, ClientUser, ResolvedAvatar } from 'bongle/interface';
import { createNetSim } from '../../build/dev/net-sim';
import type { App, Channel, EditorSession, Filesystem } from '../interface';

// The client app. A WINDOWED app: it runs in its own iframe, reads the disk,
// evals the engine through the runner, boots EngineClient in edit mode, joins
// "game", and renders. Its init is the host's EditorSession; deriving the
// ClientUser (avatar resolution) is engine knowledge and lives here.
//
// Engine RUNTIME is reached only via env.runner.import (env flags must be set
// before engine modules evaluate); statics are leaf utilities bundled into this
// entry at engine build.

const client: App = async (env) => {
    const root = env.surface!.root; // this iframe's document.body
    const fs = env.fs;

    try {
        // the engine UI stylesheet (prebundled tailwind), injected into this iframe.
        try {
            const style = document.createElement('style');
            style.textContent = await fs.readText('node_modules/bongle/dist/bongle.css');
            document.head.appendChild(style);
        } catch (err) {
            console.warn('[client] engine stylesheet missing', err);
        }

        const cfg = env.init as EditorSession;
        const runner = env.runner;
        const { env: rt } = await runner.import('bongle/env');
        rt.client = true;
        rt.server = false;
        rt.editor = true;
        await runner.import(cfg.entry ?? 'src/index.ts');
        await runner.import('src/generated/models.ts');
        await runner.import('src/generated/scenes.ts');
        const { EngineClient } = await runner.import('bongle/engine-client');
        const EngineClientEditor = await runner.import('bongle/engine-client-editor');

        const driver: ClientDriver = {
            matchmake() {},
            platform: { commercialBreak: async () => {}, rewardedBreak: async () => false },
            user: sessionUser(cfg), // the real account user (the local player wears this avatar)
        };

        const state = EngineClient.init({
            mode: 'edit',
            driver,
            resourceLoader: clientResourceLoader(fs),
            domElement: root,
        });

        await EngineClientEditor.setup(state, { sceneSource: fsSceneSource(fs) });
        await EngineClient.load(state);
        EngineClientEditor.watchRegistry(state);

        // graceful teardown: release WebGPU / drop the DOM.
        env.onDispose(() => EngineClient.dispose(state));

        // debug-pane latency sim between the game channel and the engine in/out box.
        const netSim = createNetSim<Uint8Array, Uint8Array>(
            () => {
                const s = EngineClientEditor.useEditor.getState();
                return {
                    enabled: s.netSimEnabled,
                    rttMs: s.netSimRttMs,
                    jitterMs: s.netSimJitterMs,
                    burstMs: s.netSimBurstMs,
                    burstChance: s.netSimBurstChance,
                };
            },
            {
                deliverInbound: (bytes) => state.net.inbox.push(bytes),
                deliverOutbound: (bytes) => game.send(bytes),
            },
        );

        // join the sim; a crashed/absent server surfaces an error instead of hanging.
        const toU8 = (d: unknown) => (d instanceof ArrayBuffer ? new Uint8Array(d) : (d as Uint8Array));
        const game: Channel = await env.connect('game', (data) => netSim.receive(toU8(data), performance.now()), {
            signal: AbortSignal.timeout(10_000),
        });

        // frame loop: advance, drain the outbox onto the game channel.
        let last = performance.now();
        const frame = (now: number) => {
            const dt = (now - last) / 1000;
            last = now;
            netSim.pump(now);
            EngineClient.update(state, dt);
            for (const bytes of state.net.outbox) netSim.send(bytes, now);
            state.net.outbox.length = 0;
            netSim.pump(now);
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);

        // react to fs edits: re-read the matching scene / baked resource. The change
        // KIND matters (a deleted path isn't a refresh).
        const applyFsChange = (path: string) => {
            if (path.startsWith('content/scenes/')) {
                EngineClientEditor.refreshBlueprints();
                EngineClientEditor.reloadBlueprint(path.replace(/^content\/scenes\//, '').replace(/\.scene\.json$/, ''));
                return;
            }
            if (!path.startsWith('resources/client/')) return;
            if (path.includes('voxels-icons') || path.startsWith('resources/client/prefab-icons/')) EngineClientEditor.reloadBakedIcons();
            else if (path.includes('sprite')) EngineClient.refreshSpriteResources(state).catch(console.error);
            else if (path.includes('audio')) EngineClient.refreshAudioResources(state).catch(console.error);
            else EngineClient.refreshBlockResources(state).catch(console.error);
        };
        env.fs.watch((changes) => {
            for (const c of changes) if (c.type !== 'deleted') applyFsChange(c.path);
        });

        env.log('client realm booted');
    } catch (err) {
        const message = (err as Error).message;
        env.err('client boot failed:', message);
        showBootError(root, message);
    }
};

/** the account user the local play-preview joins as. */
function sessionUser(session: EditorSession): ClientUser {
    const avatar: ResolvedAvatar = session.avatarUrl
        ? {
              source: 'runtime',
              modelId: 'local-player-avatar',
              clientUrl: session.avatarUrl,
              serverUrl: session.avatarUrl,
              rigType: RIG_TYPE_6BONE,
          }
        : { source: 'bundled', modelId: 'builtin:avatar' };
    return { id: session.user.id, username: session.user.username, avatar };
}

/** load bytes from the project fs (baked client resources under resources/client/,
 *  builtin engine assets under file:///node_modules/…, runtime avatar urls). */
function clientResourceLoader(fs: Filesystem) {
    return {
        loadBytes: async (url: string): Promise<Uint8Array> => {
            if (url.startsWith('http:') || url.startsWith('https:')) {
                const r = await fetch(url);
                if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
                return new Uint8Array(await r.arrayBuffer());
            }
            if (url.startsWith('file:')) return fs.read(new URL(url).pathname.replace(/^\/+/, ''));
            return fs.read(`resources/client/${url.replace(/^\//, '')}`);
        },
    };
}

/** scenes backed by the project fs (no dev-server endpoints in an OS realm). */
function fsSceneSource(fs: Filesystem) {
    return {
        listScenes: async (): Promise<string[]> => {
            const entries = await fs.list('content/scenes', { recursive: true }).catch(() => []);
            return entries
                .filter((e) => e.kind === 'file' && e.path.endsWith('.scene.json'))
                .map((e) => e.path.replace(/^content\/scenes\//, '').replace(/\.scene\.json$/, ''));
        },
        readScene: async (id: string): Promise<string | null> => {
            try {
                return await fs.readText(`content/scenes/${id}.scene.json`);
            } catch {
                return null;
            }
        },
    };
}

/** paint an in-frame error card so a boot failure isn't a silent black void. */
function showBootError(root: HTMLElement, message: string): void {
    const { title, detail, hint } = classifyBootError(message);
    const el = document.createElement('div');
    el.style.cssText =
        'position:fixed;inset:0;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;' +
        'padding:24px;background:#000;color:#fff;font:13px/1.5 ui-monospace,monospace;text-align:center';
    const titleEl = document.createElement('div');
    titleEl.textContent = title;
    titleEl.style.cssText = 'color:#ff5a5a;font-weight:600';
    const detailEl = document.createElement('div');
    detailEl.textContent = detail;
    detailEl.style.cssText = 'max-width:560px;white-space:pre-wrap;word-break:break-word;opacity:.85';
    const hintEl = document.createElement('div');
    hintEl.textContent = hint;
    hintEl.style.cssText = 'opacity:.6';
    el.append(titleEl, detailEl, hintEl);
    root.appendChild(el);
}

function classifyBootError(message: string): { title: string; detail: string; hint: string } {
    if (message.includes('WebGPU') || message.includes('adapter')) {
        return {
            title: 'unable to start WebGPU',
            detail: "This device or browser can't start WebGPU, which bongle needs to render. Update your graphics drivers, then use an up-to-date Chromium browser with hardware acceleration on.",
            hint: 'open chrome://gpu to check your WebGPU status.',
        };
    }
    return { title: 'client failed to load', detail: message, hint: 'fix src/, save, then restart the server.' };
}

export default client;
