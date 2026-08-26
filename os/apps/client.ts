import { RIG_TYPE_6BONE } from 'bongle/avatar';
import type { ClientDriver, ClientUser, ResolvedAvatar } from 'bongle/interface';
import { createNetSim } from '../../build/dev/net-sim';
import { exposeDevtools } from '../devtools';
import type { App, EditorSession, Filesystem, Runner } from '../interface';

// The edit-mode client — ONE implementation of "render the game in an editable
// preview". `bootEditClient` holds everything real and takes its host-varying
// pieces — fs, runner, the game transport, how to reach the embedding platform —
// as caps, so an entry point supplies only those. The OS `client` app (default
// export below) is the one entry today, with caps from `env`.
//
// Engine RUNTIME is reached only via runner.import (env flags must be set before
// engine modules evaluate); statics are leaf utilities bundled at engine build.

const toU8 = (d: unknown): Uint8Array => (d instanceof ArrayBuffer ? new Uint8Array(d) : (d as Uint8Array));

/** the host-varying capabilities the client boot needs. */
export type ClientBootCaps = {
    /** the project disk (host: OPFS; guest: remote-fs over the relay). */
    fs: Filesystem;
    /** the module runner (host: local substrate; guest: bridged to the host). */
    runner: Runner;
    /** where to render + inject styles + paint a boot-error card. */
    surface: HTMLElement;
    /** the account user the local player wears. */
    user: ClientUser;
    /** the game entry module (project-root-relative); default 'src/index.ts'. */
    entry?: string;
    /** open the game transport: register the inbound handler, get `send` back.
     *  host = env.connect('game'); guest = the transferred game port. */
    connectGame: (onReceive: (bytes: Uint8Array) => void) => Promise<{ send: (bytes: Uint8Array) => void }>;
    log: (...parts: unknown[]) => void;
    err: (...parts: unknown[]) => void;
    /** structured boot status for the task manager (host + guest debugging). */
    progress: (status: unknown) => void;
    /** the game asked to send this player to another project (`client.portal`).
     *  Whether to ask, and how to get them there — a route, a new tab, a
     *  redirect — is entirely the host's business, so this just forwards the
     *  slug and resolves whether the player went. Required, not optional: a
     *  boot site that silently answered `false` would look like a player who
     *  declined, so each one states its answer. */
    portal: (req: {
        slug: string;
        options: Record<string, string | number | boolean>;
        joinData: Record<string, string | number | boolean>;
    }) => Promise<boolean>;
    /** register graceful teardown (release WebGPU). Absent where teardown is a
     *  frame reload (the guest). */
    onDispose?: (fn: () => void) => void;
};

/** Boot EngineClient in edit mode against the given capabilities, wire the game
 *  transport + the debug net-sim, run the frame loop, and refresh on fs edits. */
export async function bootEditClient(caps: ClientBootCaps): Promise<void> {
    const { fs, runner, surface, user, log, err, progress } = caps;
    try {
        // the client's own surface aesthetic (a black canvas backdrop) — the host
        // frame stays app-agnostic, so the app dresses its own surface.
        surface.style.background = '#000';

        // the engine UI stylesheet (prebundled tailwind), injected into this frame.
        try {
            const style = document.createElement('style');
            style.textContent = await fs.readText('node_modules/bongle/dist/bongle.css');
            document.head.appendChild(style);
        } catch (styleErr) {
            console.warn('[client] engine stylesheet missing', styleErr);
        }

        // env flags BEFORE user code / engine eval — compile-time replaceEnv covers
        // literal reads; runtime/destructured reads fall through to env.js defaults.
        progress('loading engine');
        const { env: rt } = await runner.import('bongle/env');
        rt.client = true;
        rt.server = false;
        rt.editor = true;
        await runner.import(caps.entry ?? 'src/index.ts');
        await runner.import('src/generated/models.ts');
        await runner.import('src/generated/scenes.ts');
        const { EngineClient } = await runner.import('bongle/engine-client');
        const EngineClientEditor = await runner.import('bongle/engine-client-editor');

        const driver: ClientDriver = {
            matchmake() {},
            portal({ slug, options, joinData }) {
                return caps.portal({ slug, options, joinData: (joinData ?? {}) as Record<string, string | number | boolean> });
            },
            platform: { commercialBreak: async () => {}, rewardedBreak: async () => false },
            user,
        };

        const state = EngineClient.init({
            mode: 'edit',
            driver,
            resourceLoader: clientResourceLoader(fs),
            domElement: surface,
        });

        progress('booting');
        await EngineClientEditor.setup(state, { sceneSource: fsSceneSource(fs) });
        await EngineClient.load(state);
        EngineClientEditor.watchRegistry(state);
        caps.onDispose?.(() => EngineClient.dispose(state));

        // DevTools automation surface for this client realm: `bongle` in the frame's
        // console context.
        exposeDevtools('client', { fs, state, client: EngineClient, editor: EngineClientEditor, runner });

        // debug-pane latency sim between the game transport and the engine in/out box.
        let game: { send: (bytes: Uint8Array) => void } = { send: () => {} };
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

        // wire receive first, then take `send` — so a snapshot sent at join-time
        // isn't dropped before the handler exists.
        progress('joining game');
        game = await caps.connectGame((bytes) => netSim.receive(bytes, performance.now()));

        // frame loop: advance, drain the outbox onto the game transport.
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
        progress('live');

        // react to fs edits: re-read the matching scene / baked resource. The change
        // KIND matters (a deleted path isn't a refresh).
        const applyFsChange = (path: string) => {
            if (path.startsWith('content/scenes/')) {
                EngineClientEditor.refreshBlueprints();
                EngineClientEditor.reloadBlueprint(path.replace(/^content\/scenes\//, '').replace(/\.scene\.json$/, ''));
                return;
            }
            if (!path.startsWith('resources/client/')) return;
            if (path.includes('voxels-icons') || path.startsWith('resources/client/prefab-icons/'))
                EngineClientEditor.reloadBakedIcons();
            else if (path.includes('sprite')) EngineClient.refreshSpriteResources(state).catch(console.error);
            else if (path.includes('audio')) EngineClient.refreshAudioResources(state).catch(console.error);
            else EngineClient.refreshBlockResources(state).catch(console.error);
        };
        fs.watch((changes) => {
            for (const c of changes) if (c.type !== 'deleted') applyFsChange(c.path);
        });

        log('client realm booted');
    } catch (bootErr) {
        const message = (bootErr as Error).message;
        err('client boot failed:', message);
        showBootError(surface, message);
    }
}

// ── the OS client app: caps from `env` ──────────────────────────────────────
const client: App = async (env) => {
    const session = env.init as EditorSession;
    await bootEditClient({
        fs: env.fs,
        runner: env.runner,
        surface: env.surface!.root,
        user: sessionUser(session),
        entry: session.entry,
        // join the sim; a crashed/absent server surfaces an error instead of hanging.
        connectGame: async (onReceive) => {
            const chan = await env.connect('game', (data) => onReceive(toU8(data)), { signal: AbortSignal.timeout(10_000) });
            return { send: (bytes) => chan.send(bytes) };
        },
        // 'platform' is served by the shell when something is embedding the
        // editor. One dial per request: send the ask, take the single answer,
        // hang up. Nothing serving it (a bare OS) means nowhere to send the
        // player, which the timeout resolves to `false`.
        portal: async (req) => {
            try {
                let answer!: (ok: boolean) => void;
                const answered = new Promise<boolean>((resolve) => {
                    answer = resolve;
                });
                const chan = await env.connect('platform', (m) => answer(!!(m as { ok?: boolean } | null)?.ok), {
                    signal: AbortSignal.timeout(PORTAL_ASK_TIMEOUT_MS),
                });
                chan.send({ type: 'portal', ...req });
                const ok = await answered;
                chan.close();
                return ok;
            } catch {
                return false;
            }
        },
        log: (...p) => env.log(...p),
        err: (...p) => env.err(...p),
        progress: (status) => env.progress(status),
        onDispose: (fn) => env.onDispose(fn),
    });
};

/** How long to wait for the shell to answer a portal ask. Generous: the answer
 *  is a human deciding in a dialog, and a dial parks until the name is served
 *  at all, so this doubles as the "nothing is embedding us" timeout. */
const PORTAL_ASK_TIMEOUT_MS = 120_000;

/** the account user the local play-preview joins as (avatar resolution — engine
 *  knowledge, so it lives with the client). */
export function sessionUser(session: EditorSession): ClientUser {
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
