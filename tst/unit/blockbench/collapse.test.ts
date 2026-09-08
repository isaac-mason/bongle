import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document, type Node, WebIO } from '@gltf-transform/core';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { collapseToRigBones } from '../../../blockbench/plugin/src/collapse';
import { gltfUnpack } from '../../../src/core/models/model-glb';

const AVATARS_DIR = join(__dirname, '../../../avatars');

// the engine's RIG_6BONE_PERSISTENT_NODES, which is what the plugin passes in.
const BONES = ['waist', 'body', 'head', 'arm_left', 'arm_right', 'leg_left', 'leg_right'];
const SOCKETS = ['hand_left', 'hand_right', 'back'];
const PERSISTENT = [...BONES, ...SOCKETS];

const FIXTURES = [
    ['base', 'base/player.glb'],
    ['boy', 'boy/boy.glb'],
    ['girl', 'girl/girl.glb'],
    ['pigeon', 'pigeon/pigeon.glb'],
    ['penguin', 'blindfoldedpenguin/blindfoldedpenguin.glb'],
] as const;

const io = new WebIO();

function fixture(path: string): Uint8Array {
    return new Uint8Array(readFileSync(join(AVATARS_DIR, path)));
}

function eachNode(doc: Document, visit: (node: Node) => void): void {
    const walk = (node: Node): void => {
        visit(node);
        for (const child of node.listChildren()) walk(child);
    };
    for (const scene of doc.getRoot().listScenes()) {
        for (const node of scene.listChildren()) walk(node);
    }
}

function meshNodeNames(doc: Document): string[] {
    const names: string[] = [];
    eachNode(doc, (node) => {
        if (node.getMesh()) names.push(node.getName());
    });
    return names.sort();
}

/** Every rendered vertex in scene space. Position is what a viewer sees, so this
 *  is the invariant a transform bake must hold: the same points in the same
 *  places, whatever node they hang off. */
function worldPositions(doc: Document): number[][] {
    const out: number[][] = [];
    const element: number[] = [];
    eachNode(doc, (node) => {
        const mesh = node.getMesh();
        if (!mesh) return;
        const m = node.getWorldMatrix();
        for (const prim of mesh.listPrimitives()) {
            const position = prim.getAttribute('POSITION');
            if (!position) continue;
            for (let i = 0; i < position.getCount(); i++) {
                position.getElement(i, element);
                const [x, y, z] = element;
                out.push([
                    m[0] * x + m[4] * y + m[8] * z + m[12],
                    m[1] * x + m[5] * y + m[9] * z + m[13],
                    m[2] * x + m[6] * y + m[10] * z + m[14],
                ]);
            }
        }
    });
    return out;
}

/** Match the two vertex clouds as multisets, pairing each expected point with an
 *  unclaimed actual one nearby. Baking rounds the product back to float32 once,
 *  so points move by ~1e-7 and any sorted comparison would pair the wrong
 *  vertices wherever a coordinate is shared. */
function expectSamePositions(after: Document, before: Document): void {
    const actual = worldPositions(after);
    const expected = worldPositions(before);
    expect(actual).toHaveLength(expected.length);

    const claimed = new Array<boolean>(actual.length).fill(false);
    for (const point of expected) {
        const match = actual.findIndex(
            (candidate, i) =>
                !claimed[i] &&
                Math.abs(candidate[0] - point[0]) < 1e-5 &&
                Math.abs(candidate[1] - point[1]) < 1e-5 &&
                Math.abs(candidate[2] - point[2]) < 1e-5,
        );
        expect(match, `no vertex near ${point.map((v) => v.toFixed(4)).join(', ')}`).toBeGreaterThanOrEqual(0);
        claimed[match] = true;
    }
}

function triangleCount(doc: Document): number {
    let total = 0;
    for (const mesh of doc.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
            const indices = prim.getIndices();
            const count = indices ? indices.getCount() : (prim.getAttribute('POSITION')?.getCount() ?? 0);
            total += count / 3;
        }
    }
    return total;
}

describe('collapseToRigBones', () => {
    describe.each(FIXTURES)('%s', (_name, path) => {
        it('leaves one mesh node per canonical bone, named for it', async () => {
            const before = await io.readBinary(fixture(path));
            const after = await io.readBinary(await collapseToRigBones(fixture(path), PERSISTENT));

            expect(meshNodeNames(before).length).toBeGreaterThan(meshNodeNames(after).length);
            for (const name of meshNodeNames(after)) {
                expect(name).toMatch(
                    /^(waist|body|head|arm_left|arm_right|leg_left|leg_right|hand_left|hand_right|back)_mesh(_\d+)?$/,
                );
            }
            // every mesh node is a direct child of the bone it is named for.
            eachNode(after, (node) => {
                if (!node.getMesh()) return;
                const bone = node.getName().replace(/_mesh(_\d+)?$/, '');
                expect(node.getParentNode()?.getName()).toBe(bone);
            });
        });

        it('keeps the bones themselves, so mountRig still matches them by name', async () => {
            const before = await io.readBinary(fixture(path));
            const after = await io.readBinary(await collapseToRigBones(fixture(path), PERSISTENT));

            const named = (doc: Document): string[] => {
                const names: string[] = [];
                eachNode(doc, (node) => {
                    if (PERSISTENT.includes(node.getName())) names.push(node.getName());
                });
                return names.sort();
            };
            expect(named(after)).toEqual(named(before));
        });

        it('puts every vertex in the same place it was', async () => {
            const before = await io.readBinary(fixture(path));
            const after = await io.readBinary(await collapseToRigBones(fixture(path), PERSISTENT));

            expectSamePositions(after, before);
        });

        it('draws the same triangles', async () => {
            const before = await io.readBinary(fixture(path));
            const after = await io.readBinary(await collapseToRigBones(fixture(path), PERSISTENT));

            expect(triangleCount(after)).toBe(triangleCount(before));
        });

        // with the image codec available: a single-sheet avatar must come out
        // untouched, never re-encoded through the atlas path.
        it('keeps uvs and the material', async () => {
            const before = await io.readBinary(fixture(path));
            const after = await io.readBinary(await collapseToRigBones(fixture(path), PERSISTENT, { raster }));

            const uvs = (doc: Document): string[] => {
                const out: string[] = [];
                const element: number[] = [];
                for (const mesh of doc.getRoot().listMeshes()) {
                    for (const prim of mesh.listPrimitives()) {
                        const uv = prim.getAttribute('TEXCOORD_0');
                        if (!uv) continue;
                        for (let i = 0; i < uv.getCount(); i++) {
                            uv.getElement(i, element);
                            out.push(`${element[0].toFixed(4)},${element[1].toFixed(4)}`);
                        }
                    }
                }
                return out.sort();
            };
            expect(uvs(after)).toEqual(uvs(before));
            expect(after.getRoot().listTextures().length).toBe(before.getRoot().listTextures().length);
            for (const mesh of after.getRoot().listMeshes()) {
                for (const prim of mesh.listPrimitives()) expect(prim.getMaterial()).not.toBeNull();
            }
        });

        it('drops the geometry it merged away instead of leaving it in the buffer', async () => {
            const before = await io.readBinary(fixture(path));
            const after = await io.readBinary(await collapseToRigBones(fixture(path), PERSISTENT));

            // one merged mesh replaces N cube meshes, so accessors fall too. A leak
            // here means the old per-cube accessors survived unreferenced.
            expect(after.getRoot().listAccessors().length).toBeLessThan(before.getRoot().listAccessors().length);
            expect(after.getRoot().listMeshes().length).toBeLessThan(before.getRoot().listMeshes().length);
        });
    });

    describe.each(FIXTURES)('%s, through the engine loader', (_name, path) => {
        it('parses to one mesh per bone, each on a child mountRig will clone', async () => {
            const model = gltfUnpack('avatar', await collapseToRigBones(fixture(path), PERSISTENT));

            const bones = [...model.nodesByName.values()].filter((n) => BONES.includes(n.name));
            expect(bones.length).toBe(BONES.length);
            for (const bone of bones) {
                // geometry never sits ON a canonical bone: mountRig TRS-matches
                // those and only clones their non-canonical children.
                expect(bone.mesh).toBeNull();
            }
            for (const mesh of model.meshesByName.values()) {
                expect(mesh.image).not.toBeNull();
                expect(mesh.indices.length).toBeGreaterThan(0);
            }
            expect(model.meshesByName.size).toBeLessThanOrEqual(BONES.length);
        });
    });

    it('keeps clip channels that drive canonical bones', async () => {
        // base is the only shipped avatar with a clip; its walk drives four bones.
        const before = await io.readBinary(fixture('base/player.glb'));
        const after = await io.readBinary(await collapseToRigBones(fixture('base/player.glb'), PERSISTENT));

        const channels = (doc: Document): string[] =>
            doc
                .getRoot()
                .listAnimations()
                .flatMap((a) =>
                    a.listChannels().map((c) => `${a.getName()}:${c.getTargetNode()?.getName()}:${c.getTargetPath()}`),
                )
                .sort();

        expect(channels(before).length).toBeGreaterThan(0);
        expect(channels(after)).toEqual(channels(before));
    });

    it('drops a clip channel whose target it merged away, rather than writing a dangling target', async () => {
        const doc = new Document();
        const buffer = doc.createBuffer();
        const scene = doc.createScene();
        const head = doc.createNode('head');
        const tail = doc.createNode('tail').setTranslation([0, 1, 0]);
        tail.setMesh(doc.createMesh().addPrimitive(triangle(doc, buffer)));
        head.addChild(tail);
        scene.addChild(head);

        const sampler = doc
            .createAnimationSampler()
            .setInput(
                doc
                    .createAccessor()
                    .setType('SCALAR')
                    .setArray(new Float32Array([0, 1]))
                    .setBuffer(buffer),
            )
            .setOutput(
                doc
                    .createAccessor()
                    .setType('VEC3')
                    .setArray(new Float32Array([0, 0, 0, 0, 2, 0]))
                    .setBuffer(buffer),
            );
        doc.createAnimation('wag')
            .addSampler(sampler)
            .addChannel(doc.createAnimationChannel().setTargetNode(tail).setTargetPath('translation').setSampler(sampler));

        const after = await io.readBinary(await collapseToRigBones(await io.writeBinary(doc), PERSISTENT));

        expect(after.getRoot().listAnimations()).toHaveLength(0);
        expect(meshNodeNames(after)).toEqual(['head_mesh']);
    });

    it('reverses winding under a mirroring transform, so the same face stays front', async () => {
        const doc = new Document();
        const buffer = doc.createBuffer();
        const scene = doc.createScene();
        const head = doc.createNode('head');
        const mirrored = doc.createNode('cube').setScale([-1, 1, 1]);
        mirrored.setMesh(doc.createMesh().addPrimitive(triangle(doc, buffer)));
        head.addChild(mirrored);
        scene.addChild(head);

        const after = await io.readBinary(await collapseToRigBones(await io.writeBinary(doc), PERSISTENT));

        const prim = after.getRoot().listMeshes()[0].listPrimitives()[0];
        const position = prim.getAttribute('POSITION')!;
        const indices = prim.getIndices()!;
        const at = (i: number): number[] => {
            const element: number[] = [];
            position.getElement(indices.getScalar(i), element);
            return element;
        };
        // source triangle (0,0,0) (1,0,0) (0,1,0) winds CCW seen from +Z; mirroring
        // x flips that, so the collapsed indices must come back reversed.
        const [a, b, c] = [at(0), at(1), at(2)];
        const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        expect(cross).toBeGreaterThan(0);
    });

    // no atlas involved: the parts already share a sheet, they just reach it
    // through separate material objects. Grouping on material identity split
    // these into two meshes and said nothing, because nothing was wrong.
    it('merges parts that share one sheet through different materials', async () => {
        const doc = new Document();
        const buffer = doc.createBuffer();
        const scene = doc.createScene();
        const head = doc.createNode('head');
        scene.addChild(head);
        const texture = doc
            .createTexture('skin')
            .setImage(await sheet(RED))
            .setMimeType('image/png');
        for (const name of ['face', 'hat']) {
            const prim = triangle(doc, buffer)
                .setMaterial(doc.createMaterial(name).setBaseColorTexture(texture))
                .setAttribute('TEXCOORD_0', uvAccessor(doc, buffer));
            head.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)));
        }

        const after = await io.readBinary(await collapseToRigBones(await io.writeBinary(doc), PERSISTENT));

        expect(meshNodeNames(after)).toEqual(['head_mesh']);
    });

    it('says why a bone kept more than one mesh, naming what separated them', async () => {
        const doc = await twoSheetHead();
        const warnings: string[] = [];

        // no raster, so the sheets can't be packed and the head must split.
        await collapseToRigBones(await io.writeBinary(doc), PERSISTENT, { onWarn: (reason) => warnings.push(reason) });

        expect(warnings.join('\n')).toMatch(/"head" kept 2 meshes/);
        expect(warnings.join('\n')).toMatch(/texture "face".*texture "hat"/);
    });

    describe('texture atlasing', () => {
        it('packs two sheets into one so the bone still merges to a single mesh', async () => {
            const doc = await twoSheetHead();

            const after = await io.readBinary(await collapseToRigBones(await io.writeBinary(doc), PERSISTENT, { raster }));

            expect(meshNodeNames(after)).toEqual(['head_mesh']);
            expect(after.getRoot().listTextures()).toHaveLength(1);
            expect(after.getRoot().listMaterials()).toHaveLength(1);
        });

        // a hat layer's sheet has transparency and the skin's does not, so
        // Blockbench exports one BLEND and one OPAQUE material. The engine reads
        // neither (one global opaque pipeline, cutout via dither discard), so
        // that difference must not block the pack.
        it('packs sheets whose materials differ only in alpha mode', async () => {
            const doc = await twoSheetHead();
            const [first, second] = doc.getRoot().listMaterials();
            first.setAlphaMode('OPAQUE');
            second.setAlphaMode('BLEND');

            const after = await io.readBinary(await collapseToRigBones(await io.writeBinary(doc), PERSISTENT, { raster }));

            expect(meshNodeNames(after)).toEqual(['head_mesh']);
            expect(after.getRoot().listTextures()).toHaveLength(1);
        });

        it('bakes a baseColor factor into the sheet instead of letting it split the merge', async () => {
            const doc = await twoSheetHead();
            doc.getRoot().listMaterials()[1].setBaseColorFactor([0.5, 0.5, 0.5, 1]);

            const after = await io.readBinary(await collapseToRigBones(await io.writeBinary(doc), PERSISTENT, { raster }));

            expect(meshNodeNames(after)).toEqual(['head_mesh']);
            const material = after.getRoot().listMaterials()[0];
            expect(material.getBaseColorFactor()).toEqual([1, 1, 1, 1]);

            // half brightness is applied in linear space, where the factor is
            // defined, so full blue lands at ~0.735 of the sRGB range (188), not
            // at half of it. Multiplying the encoded bytes would give 128.
            const atlas = await raster.decode(after.getRoot().listTextures()[0].getImage()!);
            const blue = sampleUv(after, atlas, 3);
            expect(blue[2]).toBeGreaterThanOrEqual(187);
            expect(blue[2]).toBeLessThanOrEqual(188);
        });

        // an unpainted cube exports with a material but no baseColor texture.
        // It gets a solid tile of its factor, which is what it already renders
        // as: the engine pins a textureless mesh to its atlas's white pixel.
        it('gives an untextured part a solid tile rather than declining the pack', async () => {
            const doc = await twoSheetHead();
            const bare = doc.getRoot().listMaterials()[1];
            bare.setBaseColorTexture(null);

            const after = await io.readBinary(await collapseToRigBones(await io.writeBinary(doc), PERSISTENT, { raster }));

            expect(meshNodeNames(after)).toEqual(['head_mesh']);
            expect(after.getRoot().listTextures()).toHaveLength(1);

            // the textured half still reads its own pixels, the bare half reads
            // white (its [1,1,1,1] factor), and neither samples the other.
            const atlas = await raster.decode(after.getRoot().listTextures()[0].getImage()!);
            expect(sampleUv(after, atlas, 0)).toEqual(RED);
            expect(sampleUv(after, atlas, 3)).toEqual([255, 255, 255]);
        });

        it('leaves the sheets split when it has no image codec to pack with', async () => {
            const doc = await twoSheetHead();

            const after = await io.readBinary(await collapseToRigBones(await io.writeBinary(doc), PERSISTENT));

            expect(meshNodeNames(after)).toEqual(['head_mesh', 'head_mesh_1']);
            expect(after.getRoot().listTextures()).toHaveLength(2);
        });

        it('remaps every uv to the texel it named before, so paint-exact art survives the pack', async () => {
            const doc = await twoSheetHead();

            const after = await io.readBinary(await collapseToRigBones(await io.writeBinary(doc), PERSISTENT, { raster }));

            const atlas = await raster.decode(after.getRoot().listTextures()[0].getImage()!);
            const uv = after.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('TEXCOORD_0')!;

            // vertices 0-2 came from the red sheet, 3-5 from the blue one; the
            // engine samples with nearest and no mips, so the texel a uv selects
            // is exactly what shows.
            for (let i = 0; i < uv.getCount(); i++) {
                expect(sampleUv(after, atlas, i), `vertex ${i}`).toEqual(i < 3 ? RED : BLUE);
            }
        });
    });
});

/** The atlas texel a merged vertex's uv selects, as [r, g, b]. */
function sampleUv(doc: Document, atlas: { width: number; height: number; data: Uint8Array }, vertex: number): number[] {
    const uv = doc.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('TEXCOORD_0')!;
    const element: number[] = [];
    uv.getElement(vertex, element);
    const x = Math.min(Math.floor(element[0] * atlas.width), atlas.width - 1);
    const y = Math.min(Math.floor(element[1] * atlas.height), atlas.height - 1);
    const at = (y * atlas.width + x) * 4;
    return [atlas.data[at], atlas.data[at + 1], atlas.data[at + 2]];
}

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];

/** Image codec standing in for the plugin's OffscreenCanvas one. */
const raster = {
    async decode(bytes: Uint8Array): Promise<{ width: number; height: number; data: Uint8Array }> {
        const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        return { width: info.width, height: info.height, data: new Uint8Array(data) };
    },
    async encode(image: { width: number; height: number; data: Uint8Array }): Promise<Uint8Array> {
        const png = await sharp(Buffer.from(image.data), {
            raw: { width: image.width, height: image.height, channels: 4 },
        })
            .png()
            .toBuffer();
        return new Uint8Array(png);
    },
};

async function sheet(color: number[]): Promise<Uint8Array> {
    const data = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < 8 * 8; i++) {
        data[i * 4] = color[0];
        data[i * 4 + 1] = color[1];
        data[i * 4 + 2] = color[2];
        data[i * 4 + 3] = 255;
    }
    return raster.encode({ width: 8, height: 8, data });
}

/** A head bone with two cubes painted from two different sheets, the case a
 *  material split would otherwise leave as two meshes. */
async function twoSheetHead(): Promise<Document> {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const scene = doc.createScene();
    const head = doc.createNode('head');
    scene.addChild(head);

    for (const [name, color] of [
        ['face', RED],
        ['hat', BLUE],
    ] as const) {
        const texture = doc
            .createTexture(name)
            .setImage(await sheet(color))
            .setMimeType('image/png');
        const material = doc.createMaterial(name).setBaseColorTexture(texture);
        const prim = triangle(doc, buffer).setMaterial(material).setAttribute('TEXCOORD_0', uvAccessor(doc, buffer));
        head.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)));
    }
    return doc;
}

/** Uvs on texel centres of an 8px sheet, so a nearest sample is unambiguous. */
function uvAccessor(doc: Document, buffer: ReturnType<Document['createBuffer']>) {
    return doc
        .createAccessor()
        .setType('VEC2')
        .setArray(new Float32Array([0.125, 0.125, 0.875, 0.125, 0.125, 0.875]))
        .setBuffer(buffer);
}

/** One CCW triangle in the XY plane. */
function triangle(doc: Document, buffer: ReturnType<Document['createBuffer']>) {
    return doc
        .createPrimitive()
        .setAttribute(
            'POSITION',
            doc
                .createAccessor()
                .setType('VEC3')
                .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
                .setBuffer(buffer),
        )
        .setIndices(
            doc
                .createAccessor()
                .setType('SCALAR')
                .setArray(new Uint32Array([0, 1, 2]))
                .setBuffer(buffer),
        );
}
