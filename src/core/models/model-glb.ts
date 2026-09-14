import { mat4 } from 'math';
import type { Box3 } from 'math/shapes';
import type { Model, ModelChannel, ModelClip, ModelImage, ModelMesh, ModelNode } from './model';

const GLB_MAGIC = 0x46546c67; // 'glTF' LE
const CHUNK_JSON = 0x4e4f534a; // 'JSON' LE
const CHUNK_BIN = 0x004e4942; // 'BIN\0' LE

type GltfNode = {
    name?: string;
    translation?: [number, number, number];
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
    mesh?: number;
    children?: number[];
};

type GltfPrimitive = {
    attributes: { POSITION?: number; NORMAL?: number; TEXCOORD_0?: number };
    indices?: number;
    material?: number;
};

type GltfMesh = {
    name?: string;
    primitives: GltfPrimitive[];
};

type GltfAccessor = {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT2' | 'MAT3' | 'MAT4';
    sparse?: unknown;
};

type GltfBufferView = {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    /** interleaved vertex layouts (gltf-transform's writeBinary default) are de-interleaved in `readAccessor` when stride is non-tight. */
    byteStride?: number;
};

type GltfAnimationChannel = {
    sampler: number;
    target: { node?: number; path: 'translation' | 'rotation' | 'scale' | 'weights' };
};

type GltfAnimationSampler = {
    input: number;
    output: number;
    interpolation?: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
};

type GltfAnimation = {
    name?: string;
    channels: GltfAnimationChannel[];
    samplers: GltfAnimationSampler[];
};

type GltfTexture = { source?: number };
type GltfImage = { bufferView?: number; mimeType?: string; uri?: string };
type GltfMaterial = {
    pbrMetallicRoughness?: { baseColorTexture?: { index: number } };
};
type GltfScene = { nodes?: number[] };

type GltfBuffer = { uri?: string; byteLength?: number };

type GltfRoot = {
    scenes?: GltfScene[];
    scene?: number;
    nodes?: GltfNode[];
    meshes?: GltfMesh[];
    accessors?: GltfAccessor[];
    bufferViews?: GltfBufferView[];
    buffers?: GltfBuffer[];
    animations?: GltfAnimation[];
    materials?: GltfMaterial[];
    textures?: GltfTexture[];
    images?: GltfImage[];
};

const GL_BYTE = 5120;
const GL_UNSIGNED_BYTE = 5121;
const GL_SHORT = 5122;
const GL_UNSIGNED_SHORT = 5123;
const GL_UNSIGNED_INT = 5125;
const GL_FLOAT = 5126;

const COMPONENT_SIZE: Record<number, number> = {
    [GL_BYTE]: 1,
    [GL_UNSIGNED_BYTE]: 1,
    [GL_SHORT]: 2,
    [GL_UNSIGNED_SHORT]: 2,
    [GL_UNSIGNED_INT]: 4,
    [GL_FLOAT]: 4,
};

const TYPE_COMPONENTS: Record<GltfAccessor['type'], number> = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16,
};

/**
 * Parses a `.glb` byte buffer into the engine's runtime `Model` shape, the same shape the .bin
 * path produces via `toModel(unpack(bytes))`. Throws `Error` on malformed or out-of-subset input.
 * Pure function, safe in both browser and node. `modelId` names a synthetic wrapper root when the
 * source has multiple top-level nodes.
 */
export function gltfUnpack(modelId: string, bytes: Uint8Array): Model {
    const { json, bin } = looksLikeGlb(bytes) ? parseGlbContainer(bytes) : parseGltfJson(bytes);

    const root = JSON.parse(json) as GltfRoot;

    const accessors = root.accessors ?? [];
    const bufferViews = root.bufferViews ?? [];
    const gltfNodes = root.nodes ?? [];
    const gltfMeshes = root.meshes ?? [];
    const animations = root.animations ?? [];
    const materials = root.materials ?? [];
    const textures = root.textures ?? [];
    const images = root.images ?? [];

    // canonical .glb always uses bufferView; raw .gltf exports often inline images as base64
    // `data:` URIs on `img.uri` instead, accept those too. External file URIs still throw.
    const outImages: ModelImage[] = [];
    const imageByGltfIdx = new Map<number, ModelImage>();
    for (let i = 0; i < images.length; i++) {
        const img = images[i]!;
        let bytes: Uint8Array;
        let mimeType: string;
        if (img.bufferView !== undefined) {
            bytes = sliceBufferView(bufferViews, bin, img.bufferView).slice();
            mimeType = img.mimeType ?? 'image/png';
        } else if (img.uri?.startsWith('data:')) {
            const decoded = decodeDataUri(img.uri);
            bytes = decoded.bytes;
            mimeType = img.mimeType ?? decoded.mimeType ?? 'image/png';
        } else {
            throw new Error(`gltfUnpack: image[${i}] has no bufferView and no data: URI (external URIs unsupported)`);
        }
        const mi: ModelImage = { mimeType, bytes };
        outImages.push(mi);
        imageByGltfIdx.set(i, mi);
    }

    /** Resolves a primitive's material to a ModelImage ref, or null. */
    const materialImage = (matIdx: number | undefined): ModelImage | null => {
        if (matIdx === undefined) return null;
        const tex = materials[matIdx]?.pbrMetallicRoughness?.baseColorTexture;
        if (!tex) return null;
        const src = textures[tex.index]?.source;
        if (src === undefined) return null;
        return imageByGltfIdx.get(src) ?? null;
    };

    // meshes are extracted lazily during the scene walk so the first node referencing an
    // anonymous gltf mesh can name it after itself; mesh names dedup independently of node names.
    const meshNameSet = new Set<string>();
    const meshesByName = new Map<string, ModelMesh>();
    /** gltf mesh index -> ModelMesh ref, populated lazily. */
    const meshByGltfIdx = new Map<number, ModelMesh>();

    // DFS scene walk, building ModelNode refs in place and wiring children arrays while recursing
    const uniqueNodeNames = new Set<string>();
    const nodeNames: string[] = new Array(gltfNodes.length);
    const nodesByName = new Map<string, ModelNode>();
    const sceneNodesDFS: ModelNode[] = [];
    const roots: ModelNode[] = [];
    const visit = new Set<number>();

    const flatten = (ni: number, parent: ModelNode | null): void => {
        if (visit.has(ni)) return; // gltf forbids node-sharing across children but be defensive
        visit.add(ni);
        const n = gltfNodes[ni]!;
        const base = n.name || `node_${ni}`;
        const uname = uniqueName(base, uniqueNodeNames);
        nodeNames[ni] = uname;

        let mesh: ModelMesh | null = null;
        if (n.mesh !== undefined) {
            mesh = meshByGltfIdx.get(n.mesh) ?? null;
            if (!mesh) {
                const m = gltfMeshes[n.mesh]!;
                const baseName = m.name || uname;
                const finalName = uniqueName(baseName, meshNameSet);
                mesh = extractMesh(finalName, m, accessors, bufferViews, bin, materialImage);
                meshByGltfIdx.set(n.mesh, mesh);
                meshesByName.set(finalName, mesh);
            }
        }

        const node: ModelNode = {
            name: uname,
            position: n.translation ? [n.translation[0], n.translation[1], n.translation[2]] : [0, 0, 0],
            quaternion: n.rotation ? [n.rotation[0], n.rotation[1], n.rotation[2], n.rotation[3]] : [0, 0, 0, 1],
            scale: n.scale ? [n.scale[0], n.scale[1], n.scale[2]] : [1, 1, 1],
            parent,
            children: [],
            mesh,
        };
        if (parent) parent.children.push(node);
        else roots.push(node);
        nodesByName.set(uname, node);
        sceneNodesDFS.push(node);

        for (const c of n.children ?? []) flatten(c, node);
    };

    for (const scene of root.scenes ?? []) {
        for (const ni of scene.nodes ?? []) flatten(ni, null);
    }
    // orphan nodes (not reachable via any scene root, e.g. animation-only targets) still get a
    // unique name for animator channel lookup, but are not appended to the scene tree.
    for (let i = 0; i < gltfNodes.length; i++) {
        if (nodeNames[i] !== undefined) continue;
        const base = gltfNodes[i]!.name || `node_${i}`;
        nodeNames[i] = uniqueName(base, uniqueNodeNames);
    }
    // gltf meshes never referenced by any scene node still get a ModelMesh entry, downstream
    // code may look them up by name via authored MeshTraits.
    for (let mi = 0; mi < gltfMeshes.length; mi++) {
        if (meshByGltfIdx.has(mi)) continue;
        const m = gltfMeshes[mi]!;
        const baseName = m.name || `mesh_${mi}`;
        const finalName = uniqueName(baseName, meshNameSet);
        const mesh = extractMesh(finalName, m, accessors, bufferViews, bin, materialImage);
        meshByGltfIdx.set(mi, mesh);
        meshesByName.set(finalName, mesh);
    }

    const clipsByName = new Map<string, ModelClip>();
    const clipNameSet = new Set<string>();
    for (let ai = 0; ai < animations.length; ai++) {
        const anim = animations[ai]!;
        const name = uniqueName(anim.name || `clip_${ai}`, clipNameSet);
        clipsByName.set(name, extractClip(name, anim, accessors, bufferViews, bin, nodeNames, nodesByName));
    }

    const aabb = computeModelAabb(sceneNodesDFS);

    const sceneRoot = pickOrSynthesizeRoot(modelId, roots);

    return {
        root: sceneRoot,
        nodesByName,
        meshesByName,
        clipsByName,
        images: outImages,
        aabb,
    };
}

function pickOrSynthesizeRoot(modelId: string, roots: ModelNode[]): ModelNode {
    if (roots.length === 1) return roots[0]!;
    const wrapper: ModelNode = {
        name: modelId,
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
        parent: null,
        children: [],
        mesh: null,
    };
    for (const r of roots) {
        r.parent = wrapper;
        wrapper.children.push(r);
    }
    return wrapper;
}

function looksLikeGlb(bytes: Uint8Array): boolean {
    if (bytes.byteLength < 4) return false;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return dv.getUint32(0, true) === GLB_MAGIC;
}

// .gltf JSON variant: same accepted subset as .glb, but the BIN payload rides as an embedded
// base64 data: URI on buffers[0]. External URIs are rejected, same as .glb image bufferViews.
function parseGltfJson(bytes: Uint8Array): { json: string; bin: Uint8Array } {
    const json = new TextDecoder('utf-8').decode(bytes);
    let root: GltfRoot;
    try {
        root = JSON.parse(json) as GltfRoot;
    } catch (err) {
        throw new Error(`gltfUnpack: not a .glb and not valid JSON (${(err as Error).message})`);
    }
    const buffers = root.buffers ?? [];
    if (buffers.length === 0) return { json, bin: new Uint8Array(0) };
    if (buffers.length > 1) {
        throw new Error(`gltfUnpack: ${buffers.length} buffers (only single-buffer .gltf supported)`);
    }
    const uri = buffers[0]!.uri;
    if (uri === undefined) {
        throw new Error('gltfUnpack: buffers[0].uri missing (.gltf must embed BIN as a data: URI)');
    }
    if (!uri.startsWith('data:')) {
        throw new Error('gltfUnpack: external buffer URI not supported — use a self-contained .gltf');
    }
    return { json, bin: decodeDataUri(uri).bytes };
}

function decodeDataUri(uri: string): { bytes: Uint8Array; mimeType: string | null } {
    const commaIdx = uri.indexOf(',');
    if (commaIdx < 0) throw new Error('gltfUnpack: malformed data: URI');
    const header = uri.slice(5, commaIdx); // strip "data:"
    if (!header.includes(';base64')) {
        throw new Error('gltfUnpack: only base64-encoded data: URIs supported');
    }
    const mimeType = header.split(';')[0] || null;
    const s = atob(uri.slice(commaIdx + 1));
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return { bytes, mimeType: mimeType || null };
}

function parseGlbContainer(bytes: Uint8Array): { json: string; bin: Uint8Array } {
    if (bytes.byteLength < 20) {
        throw new Error(`gltfUnpack: truncated .glb (${bytes.byteLength} bytes, need ≥20 for header)`);
    }
    // offset accounts for possibly-sliced Uint8Array views (bytes.byteOffset !== 0)
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = dv.getUint32(0, true);
    if (magic !== GLB_MAGIC) {
        throw new Error(`gltfUnpack: bad magic 0x${magic.toString(16)} (expected 'glTF')`);
    }
    const version = dv.getUint32(4, true);
    if (version !== 2) throw new Error(`gltfUnpack: unsupported glb version ${version} (expected 2)`);
    const totalLen = dv.getUint32(8, true);
    if (totalLen > bytes.byteLength) {
        throw new Error(`gltfUnpack: header length ${totalLen} > buffer ${bytes.byteLength}`);
    }

    // JSON chunk
    const jsonLen = dv.getUint32(12, true);
    const jsonType = dv.getUint32(16, true);
    if (jsonType !== CHUNK_JSON) {
        throw new Error(`gltfUnpack: first chunk type 0x${jsonType.toString(16)} (expected JSON)`);
    }
    const jsonStart = 20;
    if (jsonStart + jsonLen > totalLen) {
        throw new Error(`gltfUnpack: JSON chunk overruns file (${jsonStart + jsonLen} > ${totalLen})`);
    }
    const jsonBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + jsonStart, jsonLen);
    const json = new TextDecoder('utf-8').decode(jsonBytes);

    // BIN chunk (optional per spec, but every avatar we accept has one)
    const binChunkOffset = jsonStart + jsonLen;
    let bin: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    if (binChunkOffset + 8 <= totalLen) {
        const binLen = dv.getUint32(binChunkOffset, true);
        const binType = dv.getUint32(binChunkOffset + 4, true);
        if (binType !== CHUNK_BIN) {
            throw new Error(`gltfUnpack: second chunk type 0x${binType.toString(16)} (expected BIN)`);
        }
        const binStart = binChunkOffset + 8;
        if (binStart + binLen > totalLen) {
            throw new Error(`gltfUnpack: BIN chunk overruns file (${binStart + binLen} > ${totalLen})`);
        }
        bin = new Uint8Array(bytes.buffer, bytes.byteOffset + binStart, binLen);
    }

    return { json, bin };
}

function uniqueName(base: string, used: Set<string>): string {
    if (!used.has(base)) {
        used.add(base);
        return base;
    }
    let n = 1;
    while (used.has(`${base}${n}`)) n++;
    const out = `${base}${n}`;
    used.add(out);
    return out;
}

function sliceBufferView(views: GltfBufferView[], bin: Uint8Array, idx: number): Uint8Array {
    const v = views[idx];
    if (!v) throw new Error(`gltfUnpack: bufferView[${idx}] missing`);
    if (v.buffer !== 0) {
        throw new Error(`gltfUnpack: bufferView[${idx}] targets buffer ${v.buffer} (only embedded buffer 0 supported)`);
    }
    const off = v.byteOffset ?? 0;
    if (off + v.byteLength > bin.byteLength) {
        throw new Error(`gltfUnpack: bufferView[${idx}] overruns BIN (${off + v.byteLength} > ${bin.byteLength})`);
    }
    return new Uint8Array(bin.buffer, bin.byteOffset + off, v.byteLength);
}

/** Resolves an accessor to a typed-array view over BIN, asserting it matches the expected gl component + element type. */
function readAccessor(
    accessors: GltfAccessor[],
    views: GltfBufferView[],
    bin: Uint8Array,
    idx: number,
): {
    array: Float32Array | Uint8Array | Uint16Array | Uint32Array;
    count: number;
    componentType: number;
    type: GltfAccessor['type'];
} {
    const a = accessors[idx];
    if (!a) throw new Error(`gltfUnpack: accessor[${idx}] missing`);
    if (a.sparse !== undefined) {
        throw new Error(`gltfUnpack: accessor[${idx}] is sparse (worker should densify before emit)`);
    }
    if (a.bufferView === undefined) {
        throw new Error(`gltfUnpack: accessor[${idx}] has no bufferView`);
    }

    const bv = views[a.bufferView];
    if (!bv) throw new Error(`gltfUnpack: bufferView[${a.bufferView}] missing`);
    const view = sliceBufferView(views, bin, a.bufferView);
    const offset = a.byteOffset ?? 0;
    const components = TYPE_COMPONENTS[a.type];
    const compSize = COMPONENT_SIZE[a.componentType];
    if (compSize === undefined) {
        throw new Error(`gltfUnpack: accessor[${idx}] unknown componentType ${a.componentType}`);
    }
    const elemSize = components * compSize;
    const stride = bv.byteStride ?? elemSize;
    const span = a.count === 0 ? 0 : (a.count - 1) * stride + elemSize;
    if (offset + span > view.byteLength) {
        throw new Error(`gltfUnpack: accessor[${idx}] overruns its bufferView`);
    }

    const elementCount = a.count * components;
    const base = view.byteOffset + offset;
    const interleaved = stride !== elemSize;

    let array: Float32Array | Uint8Array | Uint16Array | Uint32Array;
    if (interleaved) {
        // the bufferView packs other accessors' bytes between our elements; walk the stride manually
        array = makeTypedArray(a.componentType, elementCount);
        const src = new DataView(view.buffer, view.byteOffset + offset, view.byteLength - offset);
        for (let i = 0; i < a.count; i++) {
            const srcOff = i * stride;
            for (let c = 0; c < components; c++) {
                const o = srcOff + c * compSize;
                const dstIdx = i * components + c;
                switch (a.componentType) {
                    case GL_FLOAT:
                        (array as Float32Array)[dstIdx] = src.getFloat32(o, true);
                        break;
                    case GL_UNSIGNED_INT:
                        (array as Uint32Array)[dstIdx] = src.getUint32(o, true);
                        break;
                    case GL_UNSIGNED_SHORT:
                        (array as Uint16Array)[dstIdx] = src.getUint16(o, true);
                        break;
                    case GL_UNSIGNED_BYTE:
                        (array as Uint8Array)[dstIdx] = src.getUint8(o);
                        break;
                    default:
                        throw new Error(`gltfUnpack: accessor[${idx}] componentType ${a.componentType} not in supported subset`);
                }
            }
        }
    } else {
        switch (a.componentType) {
            case GL_FLOAT:
                array = new Float32Array(view.buffer, base, elementCount);
                break;
            case GL_UNSIGNED_INT:
                array = new Uint32Array(view.buffer, base, elementCount);
                break;
            case GL_UNSIGNED_SHORT:
                array = new Uint16Array(view.buffer, base, elementCount);
                break;
            case GL_UNSIGNED_BYTE:
                array = new Uint8Array(view.buffer, base, elementCount);
                break;
            default:
                throw new Error(`gltfUnpack: accessor[${idx}] componentType ${a.componentType} not in supported subset`);
        }
    }
    return { array, count: a.count, componentType: a.componentType, type: a.type };
}

function makeTypedArray(componentType: number, length: number): Float32Array | Uint8Array | Uint16Array | Uint32Array {
    switch (componentType) {
        case GL_FLOAT:
            return new Float32Array(length);
        case GL_UNSIGNED_INT:
            return new Uint32Array(length);
        case GL_UNSIGNED_SHORT:
            return new Uint16Array(length);
        case GL_UNSIGNED_BYTE:
            return new Uint8Array(length);
        default:
            throw new Error(`gltfUnpack: unsupported componentType ${componentType}`);
    }
}

function readFloat32Accessor(
    accessors: GltfAccessor[],
    views: GltfBufferView[],
    bin: Uint8Array,
    idx: number,
    expectedType: GltfAccessor['type'],
): Float32Array {
    const r = readAccessor(accessors, views, bin, idx);
    if (r.componentType !== GL_FLOAT) {
        throw new Error(`gltfUnpack: accessor[${idx}] componentType=${r.componentType}, expected FLOAT`);
    }
    if (r.type !== expectedType) {
        throw new Error(`gltfUnpack: accessor[${idx}] type=${r.type}, expected ${expectedType}`);
    }
    // copy out of the BIN view since downstream code retains this beyond the input bytes' lifetime
    return new Float32Array(r.array as Float32Array);
}

function extractMesh(
    name: string,
    mesh: GltfMesh,
    accessors: GltfAccessor[],
    views: GltfBufferView[],
    bin: Uint8Array,
    resolveImage: (mat: number | undefined) => ModelImage | null,
): ModelMesh {
    // mirrors bongle's `extractMesh` semantics: concat primitives end-to-end, rebasing indices per primitive
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    let baseVertex = 0;
    let image: ModelImage | null = null;

    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;

    for (const prim of mesh.primitives) {
        const posIdx = prim.attributes.POSITION;
        if (posIdx === undefined) continue;

        const pos = readFloat32Accessor(accessors, views, bin, posIdx, 'VEC3');
        const vc = pos.length / 3;
        for (let v = 0; v < vc; v++) {
            const x = pos[v * 3]!;
            const y = pos[v * 3 + 1]!;
            const z = pos[v * 3 + 2]!;
            positions.push(x, y, z);
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if (z > maxZ) maxZ = z;
        }

        if (prim.attributes.NORMAL !== undefined) {
            const nrm = readFloat32Accessor(accessors, views, bin, prim.attributes.NORMAL, 'VEC3');
            for (let i = 0; i < nrm.length; i++) normals.push(nrm[i]!);
        } else {
            // default to +Y, matching bongle's projection fallback
            for (let v = 0; v < vc; v++) normals.push(0, 1, 0);
        }

        if (prim.attributes.TEXCOORD_0 !== undefined) {
            const uv = readFloat32Accessor(accessors, views, bin, prim.attributes.TEXCOORD_0, 'VEC2');
            for (let i = 0; i < uv.length; i++) uvs.push(uv[i]!);
        } else {
            for (let v = 0; v < vc; v++) uvs.push(0, 0);
        }

        if (prim.indices !== undefined) {
            const idx = readAccessor(accessors, views, bin, prim.indices);
            if (idx.type !== 'SCALAR') {
                throw new Error(`gltfUnpack: indices accessor must be SCALAR, got ${idx.type}`);
            }
            for (let i = 0; i < idx.array.length; i++) {
                indices.push((idx.array as Uint8Array | Uint16Array | Uint32Array)[i]! + baseVertex);
            }
        } else {
            // un-indexed: trivial 0..vc index buffer
            for (let v = 0; v < vc; v++) indices.push(baseVertex + v);
        }

        if (image === null) image = resolveImage(prim.material);

        baseVertex += vc;
    }

    if (!Number.isFinite(minX)) {
        minX = minY = minZ = 0;
        maxX = maxY = maxZ = 0;
    }

    return {
        name,
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        uvs: new Float32Array(uvs),
        indices: new Uint32Array(indices),
        aabb: [minX, minY, minZ, maxX, maxY, maxZ],
        image,
    };
}

function extractClip(
    name: string,
    anim: GltfAnimation,
    accessors: GltfAccessor[],
    views: GltfBufferView[],
    bin: Uint8Array,
    nodeNames: string[],
    nodesByName: Map<string, ModelNode>,
): ModelClip {
    let duration = 0;
    const channels: ModelChannel[] = [];

    for (const ch of anim.channels) {
        const nodeIdx = ch.target.node;
        if (nodeIdx === undefined) continue;
        const nodeName = nodeNames[nodeIdx];
        if (!nodeName) continue;
        const target = nodesByName.get(nodeName);
        if (!target) continue;

        let property: 'translation' | 'rotation' | 'scale';
        switch (ch.target.path) {
            case 'translation':
                property = 'translation';
                break;
            case 'rotation':
                property = 'rotation';
                break;
            case 'scale':
                property = 'scale';
                break;
            default:
                continue; // skip 'weights' (morph targets)
        }

        const sampler = anim.samplers[ch.sampler];
        if (!sampler) continue;

        const interp = sampler.interpolation ?? 'LINEAR';
        if (interp !== 'LINEAR' && interp !== 'STEP' && interp !== 'CUBICSPLINE') continue;

        const times = readFloat32Accessor(accessors, views, bin, sampler.input, 'SCALAR');
        const valuesType: GltfAccessor['type'] = property === 'rotation' ? 'VEC4' : 'VEC3';
        const values = readFloat32Accessor(accessors, views, bin, sampler.output, valuesType);

        if (times.length > 0) {
            const last = times[times.length - 1]!;
            if (last > duration) duration = last;
        }

        channels.push({ target, property, interpolation: interp, times, values });
    }

    return { name, duration, channels };
}

/**
 * Unions every mesh AABB transformed by its owning node's accumulated world TRS. Iterates
 * parent-first (`sceneNodes` is DFS-ordered) so each node's world matrix is `parent.world * node.local`.
 */
function computeModelAabb(sceneNodes: ModelNode[]): Box3 {
    const worldByNode = new Map<ModelNode, ReturnType<typeof mat4.create>>();
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;

    for (const node of sceneNodes) {
        const local = mat4.fromRotationTranslationScale(mat4.create(), node.quaternion, node.position, node.scale);
        const parentWorld = node.parent ? worldByNode.get(node.parent) : null;
        const world = parentWorld ? mat4.multiply(mat4.create(), parentWorld, local) : local;
        worldByNode.set(node, world);

        const mesh = node.mesh;
        if (!mesh) continue;

        // transform the 8 corners of the mesh's local AABB and expand
        const [loX, loY, loZ, hiX, hiY, hiZ] = mesh.aabb;
        for (let c = 0; c < 8; c++) {
            const x = c & 1 ? hiX : loX;
            const y = c & 2 ? hiY : loY;
            const z = c & 4 ? hiZ : loZ;
            const wx = world[0] * x + world[4] * y + world[8] * z + world[12];
            const wy = world[1] * x + world[5] * y + world[9] * z + world[13];
            const wz = world[2] * x + world[6] * y + world[10] * z + world[14];
            if (wx < minX) minX = wx;
            if (wy < minY) minY = wy;
            if (wz < minZ) minZ = wz;
            if (wx > maxX) maxX = wx;
            if (wy > maxY) maxY = wy;
            if (wz > maxZ) maxZ = wz;
        }
    }

    if (!Number.isFinite(minX)) return [0, 0, 0, 0, 0, 0];
    return [minX, minY, minZ, maxX, maxY, maxZ];
}
