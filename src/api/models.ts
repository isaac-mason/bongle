// Runtime model loading, the async sibling of build-time `model()`.
//
// `model()` declares a build-pipeline-baked model whose handle is
// available synchronously at module eval. `loadModel()` registers a
// model whose bytes live somewhere fetchable at runtime, an uploaded
// avatar in R2, a user's local file via blob: URL, anything the
// engine's per-side `loadBytes` impl can read.
//
// Wraps `Resources.acquireRuntimeModel` + `ensureModel` against the
// side-correct resources reachable through `ScriptContext._runtime`.
// Same primitive the server's avatar resolve pipeline and the client's
// `register_model` broadcast handler ultimately use, promoted to a
// user-facing API so client-only call sites (standalone preview
// iframes, in-process tools) can drive it directly without a server
// roundtrip.

import type { ModelHandle } from '../core/models/handle';
import * as Resources from '../core/resources';
import type { ScriptContext } from '../core/scene/scripts';

/**
 * Look up a model's handle, gated on payload readiness. Returns null
 * until `Resources` has parsed the bytes and hydrated the handle,
 * consumers can poll this each frame and key off the null→non-null
 * transition (the character reconciler is the canonical example).
 *
 * The returned handle is identity-stable: `setModel` constructs the
 * shell on first registration and `ensureModel` hydrates it in place,
 * so a non-null result keeps the same object reference across HMR /
 * re-registrations of the same id.
 */
export function getModel(ctx: ScriptContext, id: string): ModelHandle | null {
    const resources = ctx._runtime?.resources;
    if (!resources) return null;
    if (!Resources.hasModel(resources, id)) return null;
    return Resources.modelHandle(resources, id);
}

/**
 * Kick the lazy payload load for an already-registered (bundled or
 * runtime) model. Idempotent and safe to call every tick, it's the
 * trigger that flips a declared `model()` from "URL known" to "bytes
 * fetched + parsed", after which `getModel` returns non-null. Use when
 * you reference a bundled model directly (e.g. set `CharacterTrait.modelId`
 * on an NPC) rather than going through the player avatar pipeline, which
 * ensures on your behalf. Warns (no-op) if the id isn't registered.
 */
export function ensureModel(ctx: ScriptContext, id: string): void {
    const resources = ctx._runtime?.resources;
    if (!resources) return;
    Resources.ensureModel(resources, id);
}

export type LoadModelOptions = {
    /** Fetch URL the engine will pull bytes from. Pass a single string
     *  when both sides hit the same URL (the common case, public R2
     *  URLs, blob: URLs in standalone client-only contexts). Pass an
     *  object when client and server URLs differ (signed URLs with
     *  per-side scopes, dev where the server reads disk and the client
     *  goes via a dev-server route). */
    url: string | { client: string; server: string };
    /** Content hash; surfaces in the handle for cache-busting. */
    hash?: string;
    /** Payload size in bytes; informational. */
    size?: number;
};

/**
 * Register a runtime model and resolve once its payload is hydrated.
 * Idempotent against the same id, re-calls bump the refcount instead
 * of re-registering, and resolve immediately if the payload is already
 * ready.
 *
 * Pair every successful `loadModel` with a `releaseModel` at the end of
 * the consumer's lifetime so refcounts stay honest. Forgetting is
 * cheap (the entry sits in memory for the engine's life) but accretes.
 *
 * Rejects with the underlying fetch/parse error if the payload reaches
 * its retry give-up, or if the model is released before it loads. Until
 * then, transient failures retry in the background and the promise stays
 * pending, the load self-drives its own retries while awaited.
 */
export function loadModel(ctx: ScriptContext, id: string, options: LoadModelOptions): Promise<ModelHandle> {
    const resources = ctx._runtime?.resources;
    if (!resources) {
        return Promise.reject(new Error('[bongle] loadModel: no runtime resources on ctx'));
    }
    const { clientUrl, serverUrl } =
        typeof options.url === 'string'
            ? { clientUrl: options.url, serverUrl: options.url }
            : { clientUrl: options.url.client, serverUrl: options.url.server };

    Resources.acquireRuntimeModel(resources, id, {
        clientUrl,
        serverUrl,
        source: 'runtime',
        hash: options.hash,
        size: options.size,
    });
    Resources.ensureModel(resources, id);
    return Resources.whenModelReady(resources, id);
}

/**
 * Release a previously-loaded runtime model. Decrements the refcount;
 * at zero, drops bytes + URL entry. Safe to call against an unknown id
 * or a bundled entry (both no-ops).
 */
export function releaseModel(ctx: ScriptContext, id: string): void {
    const resources = ctx._runtime?.resources;
    if (!resources) return;
    Resources.releaseRuntimeModel(resources, id);
}
