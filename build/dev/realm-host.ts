// build/realm-host.ts — host-neutral realm attachment.
//
// A realm (client / server / pipeline) runs a ModuleRunner whose module-runner
// protocol (fetchModule invoke + HMR push + vite:invalidate) tunnels to the
// DevServer. `attachRealm` owns that protocol logic; it is TRANSPORT-agnostic —
// it takes a `post` fn (send one frame to the realm) and returns a `handleFrame`
// (feed it each incoming frame). The host owns the pipe: the browser editor pumps
// it over a MessagePort, `bongle dev` over a WebSocket / worker_thread port. This
// deliberately takes primitive send/receive rather than a port OBJECT, so no
// `MessagePort`-vs-`PortLike` type juggling leaks into the shared core.

import { type DevServerState, fetchModule, handleRunnerMessage, registerPusher } from './dev-server';

/** frames on the realm conduit (one per attached realm). Mirror on the realm side
 *  is port-bridge.ts (createPortBridge). */
export type BundlerFrame =
    | { __bundler: 'invoke'; id: number; payload: unknown }
    | { __bundler: 'result'; id: number; result?: unknown; error?: unknown }
    | { __bundler: 'send'; payload: unknown }
    | { __bundler: 'push'; payload: unknown };

/** format an unknown throw for a build log. */
export function describeError(err: unknown): string {
    if (err instanceof Error) return err.stack ?? err.message;
    return String(err);
}

export type AttachRealmOptions = {
    /** send one frame to the realm — the host wires its transport's postMessage. */
    post: (frame: BundlerFrame) => void;
    /** surface a transform / resolution failure to a build log. */
    reportError?: (msg: string) => void;
};

/** attach realm `env` to `state`: registers the HMR pusher and returns the handler
 *  the host feeds incoming realm frames to. `fetchModule` / `getBuiltins` requests
 *  resolve through `post`; `hot.invalidate()` bounces back via `handleRunnerMessage`. */
export function attachRealm(
    state: DevServerState,
    env: string,
    opts: AttachRealmOptions,
): { handleFrame: (frame: BundlerFrame) => void } {
    registerPusher(state, env, (p) => opts.post({ __bundler: 'push', payload: p }));

    const invoke = async (payload: unknown): Promise<unknown> => {
        const call = (payload as { data?: { name?: string; data?: unknown[] } }).data;
        if (call?.name === 'fetchModule') {
            const [id, importer, options] = call.data ?? [];
            return fetchModule(state, env, id as string, importer as string | undefined, (options as { cached?: boolean }) ?? {});
        }
        if (call?.name === 'getBuiltins') return [];
        return undefined;
    };

    return {
        handleFrame(msg) {
            if (msg.__bundler === 'invoke') {
                void invoke(msg.payload).then(
                    (result) => opts.post({ __bundler: 'result', id: msg.id, result }),
                    (err: unknown) => {
                        // a transform / resolution failure — surface it, and hand the
                        // realm an error so its load rejects (not hangs) at the import site.
                        opts.reportError?.(describeError(err));
                        const error = { message: err instanceof Error ? err.message : String(err) };
                        opts.post({ __bundler: 'result', id: msg.id, error });
                    },
                );
            } else if (msg.__bundler === 'send') {
                handleRunnerMessage(state, env, msg.payload);
            }
        },
    };
}
