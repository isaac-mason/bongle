import type { ModelDef } from '../core/models/handle';
import * as Resources from '../core/resources';
import type { ScriptContext } from '../core/scene/scripts';

/**
 * Look up a model's handle, gated on payload readiness. Returns null until
 * the bytes are parsed; poll each frame and key off the null-to-non-null
 * transition. The handle is identity-stable across HMR/re-registration.
 */
export function getModel(ctx: ScriptContext, id: string): ModelDef | null {
    const resources = ctx._runtime?.resources;
    if (!resources) return null;
    if (!Resources.hasModel(resources, id)) return null;
    return Resources.modelDef(resources, id);
}

/**
 * Kick the lazy payload load for an already-registered model. Idempotent;
 * use when referencing a bundled model directly instead of through the
 * avatar pipeline, which ensures on your behalf. No-op if unregistered.
 */
export function ensureModel(ctx: ScriptContext, id: string): void {
    const resources = ctx._runtime?.resources;
    if (!resources) return;
    Resources.ensureModel(resources, id);
}

export type LoadModelOptions = {
    /** Fetch URL. Pass a single string when both sides hit the same URL,
     *  or `{ client, server }` when the URLs differ per side. */
    url: string | { client: string; server: string };
    /** Content hash; surfaces in the handle for cache-busting. */
    hash?: string;
    /** Payload size in bytes; informational. */
    size?: number;
};

/**
 * Register a runtime model and resolve once its payload is hydrated.
 * Idempotent against the same id; re-calls bump the refcount. Pair with
 * `releaseModel` so refcounts stay honest. Rejects on fetch/parse failure
 * after retries give up, or if released before it loads.
 */
export function loadModel(ctx: ScriptContext, id: string, options: LoadModelOptions): Promise<ModelDef> {
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
 * Release a previously-loaded runtime model. Decrements the refcount; at
 * zero, drops bytes and the URL entry. No-op for an unknown or bundled id.
 */
export function releaseModel(ctx: ScriptContext, id: string): void {
    const resources = ctx._runtime?.resources;
    if (!resources) return;
    Resources.releaseRuntimeModel(resources, id);
}
