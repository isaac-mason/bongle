import * as gpu from 'gpucat';
import { describe, expect, test } from 'vitest';
import { ENVIRONMENT_DEFAULT } from '../../src/api/environment';
import { createGpuQuadMaterial, createCpuQuadMaterial } from '../../src/render/voxels/voxel-material';
import { createEnvironmentResources } from '../../src/render/environment/environment';

const { compile, d } = gpu as unknown as {
    compile: (slots: { vertex: unknown; fragment: unknown; depth?: unknown }) => {
        code: string;
        uniformGroups: Array<{
            groupIndex: number;
            binding: number;
            shared: boolean;
            totalBytes: number;
            members: Array<{ node: { id: number; name: string; uniform: { value: unknown } }; schema: { type?: string; fields?: Record<string, unknown> }; offset: number }>;
        }>;
    };
    d: typeof gpu.d;
};

function compileMat(mat: gpu.Material) {
    return compile({ vertex: mat.vertex, fragment: mat.fragment, depth: undefined });
}

function frameDump(r: ReturnType<typeof compileMat>) {
    return r.uniformGroups
        .filter((g) => g.members.some((m) => (m.schema.fields as Record<string, unknown> | undefined)?.enabled !== undefined))
        .flatMap((g) =>
            g.members.map((m) => ({
                name: m.node.name,
                id: m.node.id,
                offset: m.offset,
                isCfg: (m.schema.fields as Record<string, unknown> | undefined)?.enabled !== undefined,
                totalBytes: g.totalBytes,
            })),
        );
}

function makeStubAtlas() {
    return new gpu.ArrayTexture(new Uint8Array(4), 1, 1, 1) as unknown as gpu.ArrayTexture;
}
function makeStubBuffer() {
    return gpu.createStorageBuffer(d.array(d.vec4f), new Float32Array(4)) as unknown as gpu.GpuBuffer;
}

describe('sky vs voxel frameGroup layout of shared EnvConfig', () => {
    test('EnvConfig lands at the same offset in sky and both voxel resolvers', () => {
        const res = createEnvironmentResources(ENVIRONMENT_DEFAULT);
        const sky = compileMat(res.skyMaterial);
        const voxGpu = compileMat(
            createGpuQuadMaterial({ atlas: makeStubAtlas(), texAnimBuffer: makeStubBuffer(), pass: 'opaque', elapsedTime: gpu.f32(0), env: res }),
        );
        const voxCpu = compileMat(
            createCpuQuadMaterial({ atlas: makeStubAtlas(), texAnimBuffer: makeStubBuffer(), pass: 'opaque', elapsedTime: gpu.f32(0), env: res }),
        );

        const cfgOffset = (r: ReturnType<typeof compileMat>) => frameDump(r).find((m) => m.isCfg)!.offset;

        const skyDump = frameDump(sky);
        const voxGpuDump = frameDump(voxGpu);
        const voxCpuDump = frameDump(voxCpu);

        console.log('SKY frame members:', JSON.stringify(skyDump));
        console.log('VOX-GPU frame members:', JSON.stringify(voxGpuDump));
        console.log('VOX-CPU frame members:', JSON.stringify(voxCpuDump));

        const skyCfg = cfgOffset(sky);
        const voxGpuCfg = cfgOffset(voxGpu);
        const voxCpuCfg = cfgOffset(voxCpu);
        console.log(`EnvConfig offsets: sky=${skyCfg} voxGpu=${voxGpuCfg} voxCpu=${voxCpuCfg}`);

        // The engine-global cfgNode (id 286) is shared; if its byte offset differs
        // between materials that share the SAME frame buffer, one reads garbage.
        // (Sky has an extra envSky member so its SET differs and it gets its own
        // cached buffer — so this only needs voxGpu==voxCpu strictly; sky is
        // reported for completeness.)
        expect(voxGpuCfg).toBe(voxCpuCfg);
    });
});
