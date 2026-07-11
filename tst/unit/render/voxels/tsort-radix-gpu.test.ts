// END-TO-END GPU test of the translucent radix sort kernels: compiles the REAL
// kernels' WGSL (gpucat compileCompute), runs the REAL dispatch sequence
// (count₀ → 4 × (scan → scatter)) on a headless Dawn device with synthetic
// keys, and compares the gathered payload order against a reference stable
// sort. This validates WGSL-on-GPU semantics (barriers, atomics, u32 math)
// that the CPU mirror model cannot. Histograms are garbage-prefilled to prove
// the self-zeroing paths; a second smaller fire reuses them to prove the
// cross-fire zeroTo logic.
import { describe, expect, it } from 'vitest';
import { compileCompute } from 'gpucat';
import {
    createRadixCountCompute,
    createRadixScanCompute,
    createRadixScatterCompute,
} from '../../../../src/render/voxels/voxel-resources';

const RADIX_BLOCK = 1024;

function referenceOrder(keys: number[]): number[] {
    return keys
        .map((k, i) => [k >>> 0, i] as const)
        .sort((a, b) => a[0] - b[0] || a[1] - b[1])
        .map(([, i]) => i);
}

function makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s;
    };
}

describe('translucent radix sort — real kernels on GPU (Dawn)', () => {
    it('sorts synthetic keys end-to-end, including a smaller second fire', async () => {
        const { create, globals } = await import('webgpu');
        Object.assign(globalThis, globals);
        const gpu = create([]);
        const adapter = await gpu.requestAdapter();
        if (!adapter) throw new Error('no GPU adapter');
        const device = await adapter.requestDevice();
        device.addEventListener('uncapturederror', (e) => {
            // biome-ignore lint/suspicious/noExplicitAny: diagnostic
            throw new Error(`uncaptured GPU error: ${(e as any).error?.message}`);
        });

        const MAX_BLOCKS = 8; // 8192-quad capacity for the test

        // compile the real kernels.
        const kernels = {
            count0: compileCompute(createRadixCountCompute(MAX_BLOCKS)),
            scan: compileCompute(createRadixScanCompute(MAX_BLOCKS)),
            scatter: compileCompute(createRadixScatterCompute(MAX_BLOCKS, false)),
            scatterLast: compileCompute(createRadixScatterCompute(MAX_BLOCKS, true)),
        };
        const pipelines = Object.fromEntries(
            Object.entries(kernels).map(([name, k]) => [
                name,
                device.createComputePipeline({
                    layout: 'auto',
                    compute: { module: device.createShaderModule({ code: k.code }), entryPoint: 'cs_main' },
                }),
            ]),
        ) as Record<keyof typeof kernels, GPUComputePipeline>;

        // buffers.
        const CAP = MAX_BLOCKS * RADIX_BLOCK;
        const mk = (bytes: number, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC) =>
            device.createBuffer({ size: bytes, usage });
        const buf = {
            args: mk(6 * 4),
            keysA: mk(CAP * 4),
            keysB: mk(CAP * 4),
            idxA: mk(CAP * 4),
            idxB: mk(CAP * 4),
            histA: mk(256 * MAX_BLOCKS * 4),
            histB: mk(256 * MAX_BLOCKS * 4),
            payload: mk(CAP * 8),
            visibleQuads: mk(CAP * 8),
            cfg: [0, 8, 16, 24].map((s) => {
                const b = mk(4);
                device.queue.writeBuffer(b, 0, new Uint32Array([s]));
                return b;
            }),
        };

        const bindByName = (pipeline: GPUComputePipeline, k: (typeof kernels)[keyof typeof kernels], map: Record<string, GPUBuffer>) =>
            device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: k.storage.map((entry, i) => {
                    // biome-ignore lint/suspicious/noExplicitAny: diagnostic introspection
                    const dslName = (entry.node as any).bufferName ?? entry.name;
                    const b = map[dslName];
                    if (!b) throw new Error(`no buffer for binding '${dslName}'`);
                    return { binding: i, resource: { buffer: b } };
                }),
            });

        let prevNb = 0;
        const runFire = async (keys: number[]): Promise<number[]> => {
            const n = keys.length;
            const nb = Math.ceil(n / RADIX_BLOCK);
            const zeroTo = Math.max(nb, prevNb);
            prevNb = nb;

            // upload: args (prep's output, computed CPU-side), keys, identity
            // idx, payload = original index pairs [i, i^0xabcd].
            device.queue.writeBuffer(buf.args, 0, new Uint32Array([nb, 1, 1, n, nb, zeroTo]));
            device.queue.writeBuffer(buf.keysA, 0, new Uint32Array(keys));
            device.queue.writeBuffer(buf.idxA, 0, new Uint32Array(keys.map((_, i) => i)));
            const payload = new Uint32Array(CAP * 2);
            for (let i = 0; i < n; i++) {
                payload[i * 2] = i;
                payload[i * 2 + 1] = (i ^ 0xabcd) >>> 0;
            }
            device.queue.writeBuffer(buf.payload, 0, payload);

            const enc = device.createCommandEncoder();
            const dispatch = (
                pipeline: GPUComputePipeline,
                k: (typeof kernels)[keyof typeof kernels],
                map: Record<string, GPUBuffer>,
                wg: number,
            ) => {
                const pass = enc.beginComputePass();
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, bindByName(pipeline, k, map));
                pass.dispatchWorkgroups(wg, 1, 1);
                pass.end();
            };

            // ── the real chain, mirroring cullDispatches' wiring exactly ──
            const hists = [buf.histA, buf.histB];
            dispatch(pipelines.count0, kernels.count0, {
                sortIndirectArgs: buf.args,
                srcKeys: buf.keysA,
                radixHist: hists[0]!,
            }, nb);
            for (let pass = 0; pass < 4; pass++) {
                const srcKeys = pass % 2 === 0 ? buf.keysA : buf.keysB;
                const srcIdx = pass % 2 === 0 ? buf.idxA : buf.idxB;
                const histCur = hists[pass % 2]!;
                const histNext = hists[(pass + 1) % 2]!;
                dispatch(pipelines.scan, kernels.scan, {
                    sortIndirectArgs: buf.args,
                    radixHist: histCur,
                    radixHistNext: histNext,
                }, 1);
                if (pass < 3) {
                    dispatch(pipelines.scatter, kernels.scatter, {
                        sortIndirectArgs: buf.args,
                        srcKeys,
                        srcIdx,
                        radixHist: histCur,
                        radixHistNext: histNext,
                        radixPassConfig: buf.cfg[pass]!,
                        dstKeys: pass % 2 === 0 ? buf.keysB : buf.keysA,
                        dstIdx: pass % 2 === 0 ? buf.idxB : buf.idxA,
                    }, nb);
                } else {
                    dispatch(pipelines.scatterLast, kernels.scatterLast, {
                        sortIndirectArgs: buf.args,
                        srcKeys,
                        srcIdx,
                        radixHist: histCur,
                        radixPassConfig: buf.cfg[pass]!,
                        sortPayload: buf.payload,
                        visibleQuads: buf.visibleQuads,
                    }, nb);
                }
            }
            // readback visibleQuads.
            const rb = device.createBuffer({ size: n * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            enc.copyBufferToBuffer(buf.visibleQuads, 0, rb, 0, n * 8);
            device.queue.submit([enc.finish()]);
            await rb.mapAsync(GPUMapMode.READ);
            const out = new Uint32Array(rb.getMappedRange().slice(0));
            rb.unmap();
            rb.destroy();
            // sanity: second payload word must match first (catches partial writes).
            const order: number[] = [];
            for (let i = 0; i < n; i++) {
                const a = out[i * 2]!;
                const b = out[i * 2 + 1]!;
                expect(b).toBe((a ^ 0xabcd) >>> 0);
                order.push(a);
            }
            return order;
        };

        // garbage-prefill both histograms to prove the self-zeroing paths.
        const garbage = new Uint32Array(256 * MAX_BLOCKS).fill(0xdeadbeef);
        device.queue.writeBuffer(buf.histA, 0, garbage);
        device.queue.writeBuffer(buf.histB, 0, garbage);

        const rng = makeRng(42);
        // fire 1: big (multi-block, tails), realistic packed keys + duplicates.
        const keys1 = Array.from({ length: 5000 }, (_, i) =>
            i % 4 === 0 ? (((rng() % 4) << 26) | (12345 << 1)) >>> 0 : rng(),
        );
        expect(await runFire(keys1)).toEqual(referenceOrder(keys1));
        // fire 2: much smaller (cross-fire zeroTo must cover fire 1's dirt).
        const keys2 = Array.from({ length: 700 }, () => rng());
        expect(await runFire(keys2)).toEqual(referenceOrder(keys2));
        // fire 3: grow again.
        const keys3 = Array.from({ length: 4100 }, () => rng());
        expect(await runFire(keys3)).toEqual(referenceOrder(keys3));

        device.destroy();
    }, 60_000);
});
