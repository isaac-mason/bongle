// ── mesh worker bundle entry ────────────────────────────────────────
//
// Loaded as a Web Worker (vite resolves `new Worker(new URL(...,
// import.meta.url), { type: 'module' })` and bundles this file as a
// separate worker chunk). All real logic lives in
// `core/voxels/mesh-worker.ts` so unit tests can drive `handleMessage`
// directly without spawning a worker.

import {
    type MeshWorkerInMsg,
    type MeshWorkerOutMsg,
    createWorkerState,
    handleMessage,
} from '../../core/voxels/mesh-worker';

const state = createWorkerState();

self.onmessage = (e: MessageEvent<MeshWorkerInMsg>) => {
    const out = handleMessage(state, e.data);
    if (out === null) return;
    const transfers: Transferable[] = [];
    if (out.cmd === 'result') {
        // PassMesh.quads views point into the recycle pass buffers (same
        // underlying ArrayBuffer) — transferring the 5 recycle bufs
        // carries the views along. Listing each only once is required by
        // the postMessage transfer protocol.
        transfers.push(
            out.recycle.blocksBuf,
            out.recycle.lightBuf,
            out.recycle.opaqueBuf,
            out.recycle.transparentBuf,
            out.recycle.translucentBuf,
        );
    }
    (self as unknown as {
        postMessage: (msg: MeshWorkerOutMsg, transfer: Transferable[]) => void;
    }).postMessage(out, transfers);
};
