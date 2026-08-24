// build/dev/shakeup-port.ts — wire a realm's message port to shakeup's transport.
//
// A realm (client iframe, server worker, pipeline runner) reaches the dev server over a port that
// carries shakeup TransportFrames: invoke/result for fetchModule + resolveId, push for HMR. This
// module is the two ends of that wire — `attachRealmPort` on the dev-server side, `connectRealmPort`
// on the realm side.

import {
    attachEnvironment,
    connectEnvironment,
    createEnvironmentBridge,
    type DevServer,
    type Environment,
    type EnvironmentOptions,
    type TransportFrame,
} from 'shakeup';

/** The port surface a realm conduit needs: a worker/iframe channel end, or a test channel. A real
 *  `MessagePort` types its handler against `MessageEvent`, so adapt one with {@link asRealmPort}. */
export type RealmPort = { postMessage(data: unknown): void; onmessage: ((e: { data: unknown }) => void) | null };

/** Adapt a `MessagePort` to the structural {@link RealmPort} the transport speaks. Assigning
 *  `mp.onmessage` here starts the port; the caller assigns `p.onmessage` synchronously right after
 *  (attachRealmPort / connectRealmPort both do), so no frame is dispatched before it lands. */
export function asRealmPort(mp: MessagePort): RealmPort {
    const p: RealmPort = { postMessage: (data) => mp.postMessage(data), onmessage: null };
    mp.onmessage = (e) => p.onmessage?.({ data: e.data });
    return p;
}

/**
 * BUNDLER side (in the dev-server worker): attach a realm's port to the shakeup dev server so it
 * serves that realm's fetchModule/resolveId and pushes HMR.
 */
export function attachRealmPort(server: DevServer, name: string, port: RealmPort): { close(): void } {
    const { handleFrame, close } = attachEnvironment(server, name, (frame) => port.postMessage(frame));
    port.onmessage = (e) => handleFrame(e.data as TransportFrame);
    return { close };
}

/**
 * RUNNER side (in a client iframe / server worker): build an Environment that fetches its modules
 * and receives HMR over a port. `options` carries the host bits (name, createImportMeta, evaluator,
 * prepare, env).
 */
export function connectRealmPort(
    port: RealmPort,
    options: Omit<EnvironmentOptions, 'fetchModule' | 'resolveId'> & {
        /** Fail a module fetch left unanswered this long. The bundler runs in a worker the host can
         *  terminate (a compiler restart); a terminated worker's port fires no event, it just stops
         *  replying, so this is the only thing that turns "realm waits forever, silently" into a
         *  reportable error. */
        timeoutMs?: number;
    },
): Environment {
    const { timeoutMs, ...envOptions } = options;
    const bridge = createEnvironmentBridge((frame) => port.postMessage(frame), { timeoutMs });
    port.onmessage = (e) => bridge.handleFrame(e.data as TransportFrame);
    return connectEnvironment(bridge, envOptions);
}
