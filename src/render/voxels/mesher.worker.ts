import { createWorkerState, handleMessage, type MeshWorkerInMsg, type MeshWorkerOutMsg } from '../../core/voxels/mesh-worker';

const state = createWorkerState();

self.onmessage = (e: MessageEvent<MeshWorkerInMsg>) => {
    const out = handleMessage(state, e.data);

    if (out === null) return;

    const transfers: Transferable[] = [];

    if (out.cmd === 'result') {
        // PassMesh.quads views point into these buffers; list each once for postMessage transfer.
        transfers.push(out.recycle.packetBuf, ...out.recycle.outBufs);
    }

    (
        self as unknown as {
            postMessage: (msg: MeshWorkerOutMsg, transfer: Transferable[]) => void;
        }
    ).postMessage(out, transfers);
};
