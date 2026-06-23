/**
 * Transport abstraction for the pipeline orchestrator. The orchestrator
 * (kit/pipeline/orchestrator.ts) drives a worker through these four primitives,
 * staying transport-agnostic. The implementation is `LocalWorkerHandle`
 * (kit/pipeline/local-pipeline.ts), which calls the in-process `PipelineWorker`
 * (EngineAssetPipeline) directly — no page, no IPC.
 */

export interface WorkerHandle {
    /** Resolve once the worker surface is exposed and ready for verbs. */
    ready(): Promise<void>;
    /** The worker's per-boot identity. The orchestrator watches this: a new id
     *  ⇒ the worker reloaded, so wipe applied state and re-boot the engine. */
    bootId(): Promise<string>;
    /** Reload the worker so it re-reads the on-disk atlas into its GPU
     *  TextureArray (browser: page reload; Node: re-decode + re-boot). Rotates
     *  bootId. */
    reload(): Promise<void>;
    /** Dispatch one `WorkerApi` verb. Args must be structured-cloneable. */
    call<T = void>(verb: string, ...args: unknown[]): Promise<T>;
}
