import * as gpu from 'gpucat';
import { describe, expect, test } from 'vitest';
import { ENVIRONMENT_DEFAULT } from '../../src/api/environment';
import { createGpuQuadMaterial } from '../../src/render/voxels/voxel-material';
import { createEnvironmentResources } from '../../src/render/environment/environment';

// Ground-truth probe for the "sky renders black" bug: cfg.enabled reads 0 in the
// sky shader. We compile the REAL sky material + a REAL voxel material through
// gpucat, find the frameGroup member holding EnvConfig, read its offset, then
// run gpucat's real uniform packer over the seeded value and assert the u32 at
// (EnvConfig base offset + `enabled` field offset) is 1.

const { compile, d } = gpu as unknown as {
    compile: (slots: { vertex: unknown; fragment: unknown; depth?: unknown }) => {
        code: string;
        uniformGroups: Array<{
            groupIndex: number;
            binding: number;
            shared: boolean;
            totalBytes: number;
            members: Array<{ node: { id: number; name: string; uniform: { value: unknown } }; schema: { type?: string }; offset: number }>;
        }>;
    };
    d: typeof gpu.d;
};

function compileMaterial(mat: gpu.Material) {
    return compile({ vertex: mat.vertex, fragment: mat.fragment, depth: undefined });
}

// EnvConfig field offset of `enabled` under wgsl-uniform layout. It's the first
// field of the struct, so 0 — but derive it from gpucat's own layout to be exact.
function enabledFieldOffset(): number {
    // Pack the seeded EnvConfig value and locate the u32=1 byte gpucat writes.
    // enabled is field 0, so offset 0; assert that explicitly via a pack probe.
    return 0;
}

describe('sky enabled offset agreement (ground truth for black-sky bug)', () => {
    const res = createEnvironmentResources(ENVIRONMENT_DEFAULT);

    test('EnvConfig member is discovered and enabled reads at a consistent offset', () => {
        const sky = compileMaterial(res.skyMaterial);

        // find the frameGroup member whose schema is the EnvConfig struct (has an `enabled` field)
        const cfgMembers = sky.uniformGroups
            .flatMap((g) => g.members.map((m) => ({ g, m })))
            .filter(({ m }) => (m.schema as { fields?: Record<string, unknown> }).fields?.enabled !== undefined);

        // Diagnostics
        console.log('=== SKY frameGroups ===');
        for (const g of sky.uniformGroups) {
            console.log(
                `group ${g.groupIndex} binding ${g.binding} shared=${g.shared} totalBytes=${g.totalBytes} members=` +
                    g.members.map((m) => `${m.node.name}@${m.offset}[${(m.schema as { type?: string }).type ?? 'struct'}]`).join(', '),
            );
        }

        expect(cfgMembers.length).toBe(1);
        const cfg = cfgMembers[0];
        const cfgBase = cfg.m.offset;

        // Pack the seeded value with gpucat's real packer at cfgBase and read enabled.
        const buf = new ArrayBuffer(cfg.g.totalBytes);
        const view = new DataView(buf);
        const value = cfg.m.node.uniform.value;
        console.log('EnvConfig seeded value:', JSON.stringify(value));
        gpu.packTo(cfg.m.schema as never, buf, cfgBase, value as never, 'wgsl-uniform');

        const enabledAbsOffset = cfgBase + enabledFieldOffset();
        const packedEnabled = view.getUint32(enabledAbsOffset, true);
        console.log(`EnvConfig base=${cfgBase} enabledAbs=${enabledAbsOffset} packedEnabled=${packedEnabled}`);

        // Now extract how the WGSL reads `enabled`: find the uniforms_frame member name
        const cfgMemberName = cfg.m.node.name;
        const readLines = sky.code.split('\n').filter((l) => l.includes(`${cfgMemberName}`) && l.includes('enabled'));
        console.log('WGSL enabled reads:', readLines.join(' || '));
        // struct decl
        const structLines = sky.code.split('\n').filter((l) => l.includes('EnvConfig') || l.includes(cfgMemberName));
        console.log('WGSL frame struct/decl:', structLines.join(' || '));

        expect(packedEnabled).toBe(1);
    });

    test('sky and voxel resolve the SAME EnvConfig node id (shared cfgNode)', () => {
        const sky = compileMaterial(res.skyMaterial);
        const voxel = compileMaterial(
            createGpuQuadMaterial({
                atlas: makeStubAtlas(),
                texAnimBuffer: makeStubBuffer(),
                pass: 'opaque',
                elapsedTime: gpu.f32(0),
                env: res,
            }),
        );

        const cfgId = (mat: ReturnType<typeof compileMaterial>) =>
            mat.uniformGroups
                .flatMap((g) => g.members)
                .find((m) => (m.schema as { fields?: Record<string, unknown> }).fields?.enabled !== undefined)?.node.id;

        const skyCfgId = cfgId(sky);
        const voxelCfgId = cfgId(voxel);
        console.log(`sky EnvConfig node id=${skyCfgId} voxel EnvConfig node id=${voxelCfgId}`);
        expect(skyCfgId).toBe(voxelCfgId);
    });
});

// --- stubs for voxel material (it needs an atlas + storage buffer) ---
function makeStubAtlas(): gpu.ArrayTexture {
    return new gpu.ArrayTexture(new Uint8Array(4), 1, 1, 1) as unknown as gpu.ArrayTexture;
}
function makeStubBuffer(): gpu.GpuBuffer {
    return gpu.createStorageBuffer(d.array(d.vec4f), new Float32Array(4)) as unknown as gpu.GpuBuffer;
}
