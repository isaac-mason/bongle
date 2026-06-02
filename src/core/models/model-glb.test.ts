import { describe, expect, it } from 'vitest';
import { gltfUnpack } from './model-glb';

// Hand-build a `.glb` end-to-end so the test doesn't depend on any
// external lib. Mirrors what a worker-canonicalized avatar looks like:
// single buffer, Float32 attrs, embedded image, one animation channel.

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function pad4(buf: Uint8Array, padByte = 0): Uint8Array {
    const rem = buf.byteLength % 4;
    if (rem === 0) return buf;
    const out = new Uint8Array(buf.byteLength + (4 - rem));
    out.set(buf);
    out.fill(padByte, buf.byteLength);
    return out;
}

function buildGlb(json: object, bin: Uint8Array): Uint8Array {
    const jsonBytes = pad4(new TextEncoder().encode(JSON.stringify(json)), 0x20);
    const binBytes = pad4(bin, 0);

    const totalLen = 12 + 8 + jsonBytes.byteLength + 8 + binBytes.byteLength;
    const out = new Uint8Array(totalLen);
    const dv = new DataView(out.buffer);

    dv.setUint32(0, GLB_MAGIC, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, totalLen, true);

    dv.setUint32(12, jsonBytes.byteLength, true);
    dv.setUint32(16, CHUNK_JSON, true);
    out.set(jsonBytes, 20);

    const binChunkOffset = 20 + jsonBytes.byteLength;
    dv.setUint32(binChunkOffset, binBytes.byteLength, true);
    dv.setUint32(binChunkOffset + 4, CHUNK_BIN, true);
    out.set(binBytes, binChunkOffset + 8);

    return out;
}

/** Build a glb of a 3-vertex triangle mesh with a 1-channel animation
 *  rotating one node, plus an embedded PNG-mimed image. */
function makeRichGlb(): Uint8Array {
    // ── geometry: a single triangle in XY plane
    const positions = new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
    ]);
    const indices = new Uint32Array([0, 1, 2]);

    // ── animation: 2 keyframes rotating 'head' node around Y, 0..1s
    const times = new Float32Array([0, 1]);
    const rotations = new Float32Array([
        0, 0, 0, 1,           // identity
        0, 0.7071, 0, 0.7071, // 90° around Y
    ]);

    // ── image: 4 bytes of fake PNG payload
    const imgBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    // build BIN: positions | indices | times | rotations | image
    // each section starts at a 4-byte-aligned offset (PNG header is
    // 1-byte-aligned but bufferView offsets in this test happen to land
    // on 4-byte boundaries since prior sections all are 4*N).
    const sections = [
        new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength),
        new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength),
        new Uint8Array(times.buffer, times.byteOffset, times.byteLength),
        new Uint8Array(rotations.buffer, rotations.byteOffset, rotations.byteLength),
        imgBytes,
    ];
    const total = sections.reduce((s, b) => s + b.byteLength, 0);
    const bin = new Uint8Array(total);
    let off = 0;
    const offsets: number[] = [];
    for (const s of sections) {
        offsets.push(off);
        bin.set(s, off);
        off += s.byteLength;
    }
    const [posOff, idxOff, timesOff, rotOff, imgOff] = offsets as [number, number, number, number, number];

    const json = {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [
            { name: 'avatar_root', children: [1] },
            { name: 'head', mesh: 0 },
        ],
        meshes: [
            {
                name: 'HeadMesh',
                primitives: [
                    {
                        attributes: { POSITION: 0 },
                        indices: 1,
                        material: 0,
                    },
                ],
            },
        ],
        animations: [
            {
                name: 'spin',
                channels: [{ sampler: 0, target: { node: 1, path: 'rotation' } }],
                samplers: [{ input: 2, output: 3, interpolation: 'LINEAR' }],
            },
        ],
        materials: [
            { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
        ],
        textures: [{ source: 0 }],
        images: [{ bufferView: 4, mimeType: 'image/png' }],
        accessors: [
            // 0: positions (3 vec3 floats)
            { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
            // 1: indices (3 uint32 scalars)
            { bufferView: 1, componentType: 5125, count: 3, type: 'SCALAR' },
            // 2: anim times (2 float scalars)
            { bufferView: 2, componentType: 5126, count: 2, type: 'SCALAR' },
            // 3: anim rotations (2 vec4 floats)
            { bufferView: 3, componentType: 5126, count: 2, type: 'VEC4' },
        ],
        bufferViews: [
            { buffer: 0, byteOffset: posOff, byteLength: positions.byteLength },
            { buffer: 0, byteOffset: idxOff, byteLength: indices.byteLength },
            { buffer: 0, byteOffset: timesOff, byteLength: times.byteLength },
            { buffer: 0, byteOffset: rotOff, byteLength: rotations.byteLength },
            { buffer: 0, byteOffset: imgOff, byteLength: imgBytes.byteLength },
        ],
        buffers: [{ byteLength: total }],
    };

    return buildGlb(json, bin);
}

describe('gltfUnpack — happy path', () => {
    const model = gltfUnpack('test', makeRichGlb());

    it('produces one mesh with the expected geometry', () => {
        expect(model.meshesByName.size).toBe(1);
        const mesh = model.meshesByName.get('HeadMesh')!;
        expect(mesh.name).toBe('HeadMesh');
        expect(Array.from(mesh.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
        expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
        expect(mesh.indices).toBeInstanceOf(Uint32Array);
        // no NORMAL → default to +Y per primitive
        expect(Array.from(mesh.normals)).toEqual([0, 1, 0, 0, 1, 0, 0, 1, 0]);
        // no TEXCOORD_0 → zeros
        expect(Array.from(mesh.uvs)).toEqual([0, 0, 0, 0, 0, 0]);
    });

    it('computes the mesh aabb from positions', () => {
        const mesh = model.meshesByName.get('HeadMesh')!;
        expect(mesh.aabb).toEqual([0, 0, 0, 1, 1, 0]);
    });

    it('links the mesh to the embedded image via material', () => {
        const mesh = model.meshesByName.get('HeadMesh')!;
        expect(model.images.length).toBe(1);
        expect(mesh.image).toBe(model.images[0]);
        expect(model.images[0]!.mimeType).toBe('image/png');
        expect(Array.from(model.images[0]!.bytes)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    });

    it('extracts the animation channel targeting the named node', () => {
        expect(model.clipsByName.size).toBe(1);
        const clip = model.clipsByName.get('spin')!;
        expect(clip.duration).toBe(1);
        expect(clip.channels.length).toBe(1);
        const ch = clip.channels[0]!;
        expect(ch.target).toBe(model.nodesByName.get('head'));
        expect(ch.property).toBe('rotation');
        expect(ch.interpolation).toBe('LINEAR');
        expect(Array.from(ch.times)).toEqual([0, 1]);
        expect(ch.values.length).toBe(8);
    });

    it('builds the scene tree with parent/child refs', () => {
        const root = model.nodesByName.get('avatar_root')!;
        const head = model.nodesByName.get('head')!;
        expect(model.root).toBe(root);
        expect(head.parent).toBe(root);
        expect(root.children).toContain(head);
        expect(head.mesh).toBe(model.meshesByName.get('HeadMesh'));
    });
});

describe('gltfUnpack — error paths', () => {
    it('rejects a truncated .glb (magic present, header incomplete)', () => {
        const bad = new Uint8Array(10);
        new DataView(bad.buffer).setUint32(0, GLB_MAGIC, true);
        expect(() => gltfUnpack('t', bad)).toThrow(/truncated/);
    });

    it('rejects a non-glb, non-json buffer as invalid JSON', () => {
        // looksLikeGlb dispatch routes anything without GLB_MAGIC to the
        // .gltf JSON parser, so a random binary blob surfaces as a JSON
        // parse error rather than the (now unreachable) "bad magic" path.
        const bad = new Uint8Array(20);
        new DataView(bad.buffer).setUint32(0, 0xdeadbeef, true);
        expect(() => gltfUnpack('t', bad)).toThrow(/not valid JSON/);
    });

    it('rejects glb version != 2', () => {
        const bytes = buildGlb({ asset: { version: '1.0' } }, new Uint8Array(0));
        // force version=1 in the header
        new DataView(bytes.buffer).setUint32(4, 1, true);
        expect(() => gltfUnpack('t', bytes)).toThrow(/unsupported glb version 1/);
    });

    it('rejects an external-URI image (worker should have embedded)', () => {
        const json = {
            asset: { version: '2.0' },
            scenes: [{ nodes: [] }],
            nodes: [],
            images: [{ uri: 'cat.png', mimeType: 'image/png' }],
            buffers: [{ byteLength: 0 }],
        };
        const bytes = buildGlb(json, new Uint8Array(0));
        expect(() => gltfUnpack('t', bytes)).toThrow(/external URIs unsupported/);
    });

    it('rejects an index accessor with non-SCALAR element type', () => {
        const idx = new Uint32Array([0, 1, 2, 3, 4, 5]);
        const bin = new Uint8Array(idx.buffer, idx.byteOffset, idx.byteLength);
        const positions = new Float32Array([0, 0, 0]);
        const allBin = new Uint8Array(bin.byteLength + positions.byteLength);
        allBin.set(new Uint8Array(positions.buffer), 0);
        allBin.set(bin, positions.byteLength);

        const json = {
            asset: { version: '2.0' },
            scene: 0,
            scenes: [{ nodes: [0] }],
            nodes: [{ name: 'm', mesh: 0 }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
            accessors: [
                { bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' },
                // wrong: indices should be SCALAR
                { bufferView: 1, componentType: 5125, count: 3, type: 'VEC2' },
            ],
            bufferViews: [
                { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
                { buffer: 0, byteOffset: positions.byteLength, byteLength: bin.byteLength },
            ],
            buffers: [{ byteLength: allBin.byteLength }],
        };
        expect(() => gltfUnpack('t', buildGlb(json, allBin))).toThrow(/indices accessor must be SCALAR/);
    });
});
