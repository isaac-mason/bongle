// model pipeline.
//
// for each `model('id', { src })` declared in user code:
//   - reads the source gltf via gltf-transform
//   - projects it onto the engine's ModelBin schema (meshes + clips + images)
//   - packs twice, server bin (no images) + client bin (with images)
//   - writes client bin to resources/client/models/<id>.<hash8>.client.bin
//     (kit serves resources/client/* in dev and copies it into dist/client/
//     at build time; reachable at /models/...)
//   - writes server bin to resources/server/models/<id>.<hash8>.server.bin
//     (kit's build copies project's resources/server/ into dist/server/resources/,
//     so the server bin ships with the bundle and never leaks into the client output)
// then writes a single barrel src/generated/models.ts with every model's
// scene + handle constructed inline (each model wrapped in an IIFE so
// per-model locals, _node_*, _clip_*, _scene, don't collide).
//
// single-file rationale: cold start writes one file instead of N+1,
// eliminating HMR-wall noise when many models are declared. The barrel
// also declaration-merges `ModelHandleMap` and seeds the registry via
// `__kit.registerModel(id, handle)`, same wire as before.
//
// incrementality: an in-memory `Map<id, ModelsCacheEntry>` owned by the
// pipeline orchestrator (`PipelineState.modelsCache`) carries srcHash +
// bin paths across calls within a session. cache hit + bins still on disk
// → skip pack+write, reuse cached outputs; the barrel is always re-emitted
// (cheap, keeps generated types in sync). cross-process warmth is
// intentionally not preserved, every fresh process pays a cold pack.

import { type Document, type Node as GltfNode, Logger, type Texture, WebIO } from '@gltf-transform/core';
import { dedup, reorder, weld } from '@gltf-transform/functions';
import { type Box3, mat4 } from 'mathcat';
import { MeshoptEncoder } from 'meshoptimizer';
import type { ResourceLoader } from '../../../src/core/resource-loader';
import {
    type ModelBinChannel,
    type ModelBinClip,
    type ModelBinImage,
    type ModelBinMesh,
    type ModuleVersion,
    packModelBin,
} from '../../../src/internal';
import type { Filesystem } from '../../fs';
import { sha256Hex } from './raster';

// ── paths ──────────────────────────────────────────────────────────

// URL prefixes (bundle-relative, engine resolves via `assetUrl()` which
// either prefixes the bundle's import.meta.url in prod or the dev origin
// root in dev). Not filesystem paths.
const CLIENT_URL_PREFIX = 'models';
const SERVER_URL_PREFIX = 'models';

// output locations, project-relative on the ctx Filesystem.
const CLIENT_BIN_DIR = 'resources/client/models';
const SERVER_BIN_DIR = 'resources/server/models';
const BARREL_PATH = 'src/generated/models.ts';

/** per-id record of the last successful build for this model. Owned by
 *  the pipeline orchestrator (`PipelineState.modelsCache`) and threaded
 *  in via `BuildModelsOptions.cache`; this module mutates it in place. */
export type ModelsCacheEntry = {
    srcHash: string;
    hash8: string;
    clientBin: string;
    serverBin: string;
};

export type BuildModelsOptions = {
    /** session-scoped incremental cache, mutated in place per call. Owned
     *  by `PipelineState`. Lost on process restart by design, cross-process
     *  warm starts aren't supported. */
    cache: Map<string, ModelsCacheEntry>;
    /** bake-input byte loader (host-provided; see pipeline InitCtx). */
    loader: ResourceLoader;
    /** the editor project filesystem bins + barrel write into
     *  (host-provided; see pipeline InitCtx). */
    fs: Filesystem;
};

// ── types: per-model build outputs ─────────────────────────────────

type SceneNodeInfo = {
    /** unique within model (deduped via numeric suffix). */
    name: string;
    /** index of parent in the flat array, or -1 for roots. */
    parent: number;
    position: [number, number, number];
    quaternion: [number, number, number, number];
    scale: [number, number, number];
    /** unique mesh name attached to this node, or null. */
    meshName: string | null;
};

type ModelMeshInfo = {
    name: string;
    /** local-space AABB. */
    aabb: Box3;
};

type ModelPayload = {
    sceneNodes: SceneNodeInfo[];
    /** every unique node name (for `ModelHandle.nodes` index). */
    nodeNames: string[];
    /** mesh-bearing entries, name + local AABB, in stable order. */
    meshes: ModelMeshInfo[];
    /** animation clip names. */
    clipNames: string[];
    /** node names referenced by at least one clip channel. lets the codegen
     *  skip emitting `addTrait(_, TransformTrait, ...)` for nodes that are
     *  identity + non-mesh + non-animated (the runtime's `parent transform`
     *  walk skips trait-less nodes, so those are pure overhead). */
    animatedNodeNames: string[];
    /** bind-pose AABB in root-local space, union of mesh AABBs transformed by their node's TRS chain. */
    aabb: Box3;
};

type BuildEntry = {
    id: string;
    srcRel: string;
    srcHash: string;
    hash8: string;
    clientBinPath: string;
    serverBinPath: string;
    clientBinUrl: string;
    serverBinUrl: string;
    fresh: boolean;
    payload: ModelPayload;
};

// ── public api ─────────────────────────────────────────────────────

const io = new WebIO();

export async function buildModels(module: ModuleVersion, opts: BuildModelsOptions): Promise<boolean> {
    const projectFs = opts.fs;
    const models = module.models;
    const cache = opts.cache;

    if (models.size === 0) {
        // no declarations, emit empty barrel + GC any leftover bins
        await projectFs.writeIfChanged(BARREL_PATH, EMPTY_BARREL);
        await gcOrphanBins(projectFs, new Set());
        cache.clear();
        return false;
    }

    const buildStart = performance.now();
    const entries: BuildEntry[] = [];
    let anyFresh = false;

    for (const [id, def] of models) {
        let e: BuildEntry | null;
        try {
            e = await processModel(id, def.src, cache, opts.loader, projectFs);
        } catch (err) {
            // a single unparseable/unfetchable model must not fail the whole
            // bake — warn and skip it (its barrel entry is just absent).
            console.warn(`[bongle] model "${id}" (${def.src}) failed to bake: ${(err as Error).message} — skipping`);
            continue;
        }
        if (!e) continue;
        entries.push(e);
        if (e.fresh) anyFresh = true;
    }

    // single barrel, re-emit unconditionally so the typed signatures stay
    // in sync with current handle metadata.
    await projectFs.writeIfChanged(BARREL_PATH, renderBarrel(entries));

    // rewrite cache in place to mirror the current build, drop ids no
    // longer present, refresh entries for current ids.
    cache.clear();
    for (const e of entries) {
        cache.set(e.id, {
            srcHash: e.srcHash,
            hash8: e.hash8,
            clientBin: e.clientBinUrl,
            serverBin: e.serverBinUrl,
        });
    }

    // GC: any bin not produced by this run
    const liveBins = new Set<string>();
    for (const e of entries) {
        liveBins.add(e.clientBinPath.split('/').pop()!);
        liveBins.add(e.serverBinPath.split('/').pop()!);
    }
    await gcOrphanBins(projectFs, liveBins);

    if (anyFresh) {
        const fresh = entries.filter((e) => e.fresh).length;
        const cached = entries.length - fresh;
        console.log(
            `[bongle] models built: ${fresh} fresh, ${cached} cached in ${(performance.now() - buildStart).toFixed(0)}ms`,
        );
    }

    return anyFresh;
}

// ── per-model processing ───────────────────────────────────────────

/**
 * Read a gltf source and run the optimization passes used at every emit:
 * weld → dedup → reorder. Skip Draco (300KB decoder is overkill for our
 * tiny assets) and skip KTX2/BasisU on textures (would smear pixel atlases,
 * leave as PNG/JPEG). reorder uses 'performance' because we ship a custom
 * packcat bin (not GLB), so vertex cache locality is what matters; transmission
 * size is handled at the bin level.
 */
async function loadAndOptimize(srcBytes: Uint8Array, srcRel: string, loader: ResourceLoader): Promise<Document> {
    const doc = isGlb(srcBytes) ? await io.readBinary(srcBytes) : await readGltfJson(srcBytes, srcRel, loader);
    // silence per-transform "Removed types... Accessor (N)" cleanup logs
    doc.setLogger(new Logger(Logger.Verbosity.WARN));
    await MeshoptEncoder.ready;
    await doc.transform(weld(), dedup(), reorder({ encoder: MeshoptEncoder, target: 'performance' }));
    return doc;
}

/** GLB starts with the little-endian 'glTF' magic; anything else is JSON glTF. */
function isGlb(bytes: Uint8Array): boolean {
    return bytes.length >= 4 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
}

/** Read a JSON `.gltf`: parse it, then load any EXTERNAL (non-data:) buffer /
 *  image resources through the loader (data: URIs are decoded by
 *  gltf-transform itself). Resource URIs resolve relative to the model src. */
async function readGltfJson(bytes: Uint8Array, srcRel: string, loader: ResourceLoader): Promise<Document> {
    const json = JSON.parse(new TextDecoder().decode(bytes)) as {
        buffers?: { uri?: string }[];
        images?: { uri?: string }[];
    };
    const resources: Record<string, Uint8Array<ArrayBuffer>> = {};
    const uris = [...(json.buffers ?? []), ...(json.images ?? [])]
        .map((r) => r.uri)
        .filter((u): u is string => !!u && !u.startsWith('data:'));
    for (const uri of new Set(uris)) {
        const bytes = await loader.loadBytes(resolveResourceUri(uri, srcRel));
        resources[uri] = new Uint8Array(bytes) as Uint8Array<ArrayBuffer>;
    }
    return io.readJSON({ json: json as never, resources });
}

/** resolve a glTF resource uri relative to the model src (a URL for engine
 *  builtins, a project-relative path for user models). */
function resolveResourceUri(uri: string, srcRel: string): string {
    if (/^https?:\/\//.test(srcRel)) return new URL(uri, srcRel).href;
    const dir = srcRel.slice(0, srcRel.lastIndexOf('/'));
    return dir ? `${dir}/${uri}` : uri;
}

async function processModel(
    id: string,
    srcRel: string,
    cache: Map<string, ModelsCacheEntry>,
    loader: ResourceLoader,
    projectFs: Filesystem,
): Promise<BuildEntry | null> {
    let srcBytes: Uint8Array;
    try {
        srcBytes = await loader.loadBytes(srcRel);
    } catch {
        console.warn(`[bongle] model source not found: ${srcRel} (skipping "${id}")`);
        return null;
    }
    const srcHash = await sha256Hex(srcBytes);

    // cache hit path, skip pack + write, but still parse + optimize the doc
    // to derive structural payload for the sidecar. transforms must run here
    // too: dedup() can collapse identical meshes, so projecting the
    // unoptimized doc would emit sidecar references the bin doesn't contain.
    const cached = cache.get(id);
    if (cached && cached.srcHash === srcHash) {
        const clientBinPath = `${CLIENT_BIN_DIR}/${cached.clientBin.split('/').pop()!}`;
        const serverBinPath = `${SERVER_BIN_DIR}/${cached.serverBin.split('/').pop()!}`;
        if ((await projectFs.exists(clientBinPath)) && (await projectFs.exists(serverBinPath))) {
            const doc = await loadAndOptimize(srcBytes, srcRel, loader);
            const { payload } = await projectDocument(doc);
            return {
                id,
                srcRel,
                srcHash,
                hash8: cached.hash8,
                clientBinPath,
                serverBinPath,
                clientBinUrl: cached.clientBin,
                serverBinUrl: cached.serverBin,
                fresh: false,
                payload,
            };
        }
    }

    // cold path, load + optimize, project, then pack + write.
    const doc = await loadAndOptimize(srcBytes, srcRel, loader);
    const { payload, meshes, clips, images } = await projectDocument(doc);

    // share the scene-tree section across both bins. runtime models
    // (.glb uploads) carry the same fields in their parsed ModelBin so
    // the runtime hydrator works format-agnostically; declared models
    // still source their authoritative handle from the codegen barrel
    // (see `renderModelConstruction` below), these fields are the
    // engine's fallback / parity story, not the primary path.
    const sceneNodes = payload.sceneNodes.map((sn) => ({
        name: sn.name,
        parent: sn.parent,
        position: sn.position,
        quaternion: sn.quaternion,
        scale: sn.scale,
        meshName: sn.meshName ?? undefined,
    }));
    const rootIndices: number[] = [];
    for (let i = 0; i < payload.sceneNodes.length; i++) {
        if (payload.sceneNodes[i]!.parent < 0) rootIndices.push(i);
    }
    const binCommon = {
        meshes,
        clips,
        sceneNodes,
        rootIndices,
        animatedNodeNames: payload.animatedNodeNames,
        aabb: payload.aabb,
    };
    const serverBytes = packModelBin({ ...binCommon, images: undefined });
    const clientBytes = packModelBin({ ...binCommon, images });

    const hash8 = (await sha256Hex(clientBytes)).slice(0, 8);
    const clientFilename = `${id}.${hash8}.client.bin`;
    const serverFilename = `${id}.${hash8}.server.bin`;
    const clientBinPath = `${CLIENT_BIN_DIR}/${clientFilename}`;
    const serverBinPath = `${SERVER_BIN_DIR}/${serverFilename}`;

    await projectFs.write(clientBinPath, clientBytes);
    await projectFs.write(serverBinPath, serverBytes);

    return {
        id,
        srcRel,
        srcHash,
        hash8,
        clientBinPath,
        serverBinPath,
        clientBinUrl: `${CLIENT_URL_PREFIX}/${clientFilename}`,
        serverBinUrl: `${SERVER_URL_PREFIX}/${serverFilename}`,
        fresh: true,
        payload,
    };
}

// ── projection: gltf Document → bin payload + sidecar info ─────────

type ProjectedDocument = {
    payload: ModelPayload;
    meshes: ModelBinMesh[];
    clips: ModelBinClip[];
    images: ModelBinImage[];
};

async function projectDocument(doc: Document): Promise<ProjectedDocument> {
    const root = doc.getRoot();

    // ── images (must precede mesh extraction; meshes resolve their first
    //          primitive's baseColorTexture via this map) ──────────────
    const images: ModelBinImage[] = [];
    /** texture object → index into `images`. multiple Textures sharing the
     *  same image bytes collapse to one entry via hash dedup. */
    const imageIndexByTexture = new Map<Texture, number>();
    const imageIndexByHash = new Map<string, number>();
    for (const tex of root.listTextures()) {
        const data = tex.getImage();
        if (!data) continue;
        // fast non-crypto dedup key over the image bytes (collision here only
        // costs a wrongly-shared texture, so fnv1a is plenty; the stable
        // content-addressed hashes elsewhere stay SHA-256).
        const h = fnv1aHex(data);
        let idx = imageIndexByHash.get(h);
        if (idx === undefined) {
            idx = images.length;
            imageIndexByHash.set(h, idx);
            images.push({
                mimeType: tex.getMimeType() || 'image/png',
                bytes: data,
            });
        }
        imageIndexByTexture.set(tex, idx);
    }

    // depth-first flatten, same traversal used for sidecar + clip channels.
    const flat: { node: GltfNode; parentIndex: number }[] = [];
    function flatten(n: GltfNode, parentIdx: number) {
        const idx = flat.length;
        flat.push({ node: n, parentIndex: parentIdx });
        for (const c of n.listChildren()) flatten(c, idx);
    }
    for (const scene of root.listScenes()) {
        for (const child of scene.listChildren()) flatten(child, -1);
    }

    // dedupe node names, first occurrence keeps bare name, suffix the rest.
    const usedNodeNames = new Set<string>();
    function uniqueNodeName(base: string): string {
        if (!usedNodeNames.has(base)) {
            usedNodeNames.add(base);
            return base;
        }
        let n = 1;
        while (usedNodeNames.has(`${base}${n}`)) n++;
        const out = `${base}${n}`;
        usedNodeNames.add(out);
        return out;
    }

    // dedupe mesh names independently (a gltf mesh shared across nodes
    // contributes once; same name twice → suffix).
    const usedMeshNames = new Set<string>();
    function uniqueMeshName(base: string): string {
        if (!usedMeshNames.has(base)) {
            usedMeshNames.add(base);
            return base;
        }
        let n = 1;
        while (usedMeshNames.has(`${base}${n}`)) n++;
        const out = `${base}${n}`;
        usedMeshNames.add(out);
        return out;
    }

    const sceneNodes: SceneNodeInfo[] = [];
    const nodeIdToUniqueName = new Map<GltfNode, string>();
    /** maps gltf Mesh object → the unique meshName we assign it. */
    const meshObjToName = new Map<object, string>();
    const meshes: ModelBinMesh[] = [];

    for (const { node, parentIndex } of flat) {
        const base = node.getName() || `node_${sceneNodes.length}`;
        const uname = uniqueNodeName(base);
        nodeIdToUniqueName.set(node, uname);

        const t = node.getTranslation();
        const r = node.getRotation();
        const s = node.getScale();
        const mesh = node.getMesh();

        let meshName: string | null = null;
        if (mesh) {
            // share data across nodes that reference the same mesh object
            const existing = meshObjToName.get(mesh);
            if (existing !== undefined) {
                meshName = existing;
            } else {
                const baseMeshName = mesh.getName() || uname;
                meshName = uniqueMeshName(baseMeshName);
                meshObjToName.set(mesh, meshName);
                meshes.push(extractMesh(mesh, meshName, imageIndexByTexture));
            }
        }

        sceneNodes.push({
            name: uname,
            parent: parentIndex,
            position: [t[0], t[1], t[2]],
            quaternion: [r[0], r[1], r[2], r[3]],
            scale: [s[0], s[1], s[2]],
            meshName,
        });
    }

    // ── animations ──────────────────────────────────────────────────
    const clips: ModelBinClip[] = [];
    const usedClipNames = new Set<string>();
    function uniqueClipName(base: string): string {
        if (!usedClipNames.has(base)) {
            usedClipNames.add(base);
            return base;
        }
        let n = 1;
        while (usedClipNames.has(`${base}${n}`)) n++;
        const out = `${base}${n}`;
        usedClipNames.add(out);
        return out;
    }

    for (const anim of root.listAnimations()) {
        const baseName = anim.getName() || `clip_${clips.length}`;
        const clipName = uniqueClipName(baseName);

        let duration = 0;
        const channels: ModelBinChannel[] = [];

        for (const ch of anim.listChannels()) {
            const target = ch.getTargetNode();
            const targetPath = ch.getTargetPath();
            const sampler = ch.getSampler();
            if (!target || !targetPath || !sampler) continue;

            const nodeName = nodeIdToUniqueName.get(target);
            if (!nodeName) continue;

            let property: 'translation' | 'rotation' | 'scale';
            switch (targetPath) {
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
                    continue; // skip 'weights' (morph targets), out of scope
            }

            const interp = sampler.getInterpolation();
            let interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
            if (interp === 'STEP') interpolation = 'STEP';
            else if (interp === 'CUBICSPLINE') interpolation = 'CUBICSPLINE';
            else interpolation = 'LINEAR';

            const inputAcc = sampler.getInput();
            const outputAcc = sampler.getOutput();
            if (!inputAcc || !outputAcc) continue;

            const timesSrc = inputAcc.getArray();
            const valuesSrc = outputAcc.getArray();
            if (!timesSrc || !valuesSrc) continue;

            const keyframeCount = inputAcc.getCount();
            const stride = property === 'rotation' ? 4 : 3;

            const times = new Float32Array(keyframeCount);
            for (let k = 0; k < keyframeCount; k++) times[k] = timesSrc[k]!;

            const valuesLen = keyframeCount * stride * (interpolation === 'CUBICSPLINE' ? 3 : 1);
            const values = new Float32Array(valuesLen);
            for (let k = 0; k < valuesLen; k++) values[k] = valuesSrc[k]!;

            if (keyframeCount > 0) {
                const last = times[keyframeCount - 1]!;
                if (last > duration) duration = last;
            }

            channels.push({ nodeName, property, interpolation, times, values });
        }

        clips.push({ name: clipName, duration, channels });
    }

    const meshByName = new Map(meshes.map((m) => [m.name, m]));
    const aabb = computeModelAabb(sceneNodes, meshByName);

    const animatedNodeNames = new Set<string>();
    for (const c of clips) for (const ch of c.channels) animatedNodeNames.add(ch.nodeName);

    return {
        payload: {
            sceneNodes,
            nodeNames: sceneNodes.map((n) => n.name),
            meshes: meshes.map((m) => ({ name: m.name, aabb: m.aabb })),
            clipNames: clips.map((c) => c.name),
            animatedNodeNames: Array.from(animatedNodeNames),
            aabb,
        },
        meshes,
        clips,
        images,
    };
}

// ── model AABB ─────────────────────────────────────────────────────

/**
 * union every mesh AABB transformed by its node's accumulated world TRS.
 * iterates parent-first (sceneNodes is already DFS-ordered) so each node's
 * world matrix is just `parent.world * node.local`.
 */
function computeModelAabb(sceneNodes: SceneNodeInfo[], meshes: Map<string, ModelBinMesh>): Box3 {
    const worldMats: ReturnType<typeof mat4.create>[] = [];
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;

    for (let i = 0; i < sceneNodes.length; i++) {
        const sn = sceneNodes[i]!;
        const local = mat4.fromRotationTranslationScale(mat4.create(), sn.quaternion, sn.position, sn.scale);
        const world = sn.parent < 0 ? local : mat4.multiply(mat4.create(), worldMats[sn.parent]!, local);
        worldMats.push(world);

        if (!sn.meshName) continue;
        const mesh = meshes.get(sn.meshName);
        if (!mesh) continue;

        // transform 8 corners of the mesh's local AABB and expand
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

    if (!Number.isFinite(minX)) {
        // no meshes, empty model. zero box at origin.
        return [0, 0, 0, 0, 0, 0];
    }
    return [minX, minY, minZ, maxX, maxY, maxZ];
}

function extractMesh(
    mesh: ReturnType<GltfNode['getMesh']> & {},
    name: string,
    imageIndexByTexture: Map<Texture, number>,
): ModelBinMesh {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    let baseVertex = 0;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    /** first primitive's baseColor texture wins (importer flattens primitives,
     *  see model-bin.ts comment). undefined if no primitive has one. */
    let imageIndex: number | undefined;

    for (const prim of mesh.listPrimitives()) {
        const posAcc = prim.getAttribute('POSITION');
        if (!posAcc) continue;
        const normAcc = prim.getAttribute('NORMAL');
        const uvAcc = prim.getAttribute('TEXCOORD_0');
        const idxAcc = prim.getIndices();

        if (imageIndex === undefined) {
            const tex = prim.getMaterial()?.getBaseColorTexture();
            if (tex) imageIndex = imageIndexByTexture.get(tex);
        }

        const vc = posAcc.getCount();

        for (let v = 0; v < vc; v++) {
            const e = posAcc.getElement(v, [0, 0, 0]);
            positions.push(e[0]!, e[1]!, e[2]!);
            if (e[0]! < minX) minX = e[0]!;
            if (e[1]! < minY) minY = e[1]!;
            if (e[2]! < minZ) minZ = e[2]!;
            if (e[0]! > maxX) maxX = e[0]!;
            if (e[1]! > maxY) maxY = e[1]!;
            if (e[2]! > maxZ) maxZ = e[2]!;
        }

        if (normAcc) {
            for (let v = 0; v < vc; v++) {
                const e = normAcc.getElement(v, [0, 0, 0]);
                normals.push(e[0]!, e[1]!, e[2]!);
            }
        } else {
            for (let v = 0; v < vc; v++) normals.push(0, 1, 0);
        }

        if (uvAcc) {
            for (let v = 0; v < vc; v++) {
                const e = uvAcc.getElement(v, [0, 0]);
                uvs.push(e[0]!, e[1]!);
            }
        } else {
            for (let v = 0; v < vc; v++) uvs.push(0, 0);
        }

        if (idxAcc) {
            const arr = idxAcc.getArray()!;
            const ic = idxAcc.getCount();
            for (let i = 0; i < ic; i++) indices.push(arr[i]! + baseVertex);
        } else {
            for (let v = 0; v < vc; v++) indices.push(baseVertex + v);
        }

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
        imageIndex,
    };
}

// ── codegen: single-file barrel ────────────────────────────────────

function renderBarrel(entries: BuildEntry[]): string {
    if (entries.length === 0) return EMPTY_BARREL;

    assertNoIdentCollisions(entries.map((e) => e.id));

    const lines: string[] = [];
    lines.push(`// auto-generated by asset pipeline — do not edit`);
    lines.push(``);
    lines.push(`import { type ClipDef, type ModelHandle, MeshTrait, TransformTrait } from 'bongle';`);
    // `__kit` is provided in module scope by the kit Vite plugin's
    // prelude (see kit/src/vite/plugin.ts), re-importing it here would
    // collide with the prelude's top-level `import { __kit }` and parse
    // as "Identifier '__kit' has already been declared".
    lines.push(`import { addChild, addTrait, createNode } from 'bongle/internal';`);
    lines.push(``);

    // each model wrapped in an IIFE so per-model locals (_node_*, _clip_*,
    // _scene) don't collide across models in this shared module scope.
    for (const e of entries) {
        renderModelConstruction(e, lines);
        lines.push(``);
    }

    lines.push(`declare module 'bongle' {`);
    lines.push(`    interface ModelHandleMap {`);
    for (const e of entries) {
        lines.push(`        ${JSON.stringify(e.id)}: typeof ${sanitizeIdent(e.id)};`);
    }
    lines.push(`    }`);
    lines.push(`}`);
    lines.push(``);

    for (const e of entries) {
        lines.push(`__kit.registerModel(${JSON.stringify(e.id)}, ${sanitizeIdent(e.id)});`);
    }
    lines.push(``);
    lines.push(`export {};`);
    lines.push(``);
    return lines.join('\n');
}

/**
 * Emit `const <id> = (() => { ...; return handle; })();` for one model.
 * The IIFE scopes per-model locals (_node_…, _clip_…, _scene) so a
 * multi-model barrel doesn't collide on them.
 */
function renderModelConstruction(e: BuildEntry, lines: string[]): void {
    const { id, srcRel, payload, clientBinUrl, serverBinUrl } = e;
    const { sceneNodes, nodeNames, meshes, clipNames, animatedNodeNames } = payload;

    const constId = sanitizeIdent(id);

    // variable names embed the gltf-derived name for grep-ability; the
    // trailing index keeps emission deterministic when two names sanitize
    // to the same identifier. user-facing lookup (`handle.nodes['Foo']`)
    // uses the deduped human name, not these locals.
    const nodeVar = (i: number) => `_node_${sanitizeIdent(sceneNodes[i]!.name)}_${i}`;
    const clipVar = (i: number) => `_clip_${sanitizeIdent(clipNames[i]!)}_${i}`;

    // gate for skipping `addTrait(_, TransformTrait, ...)` on nodes that
    // contribute nothing to world composition: identity TRS, no mesh, and
    // no animation channel targets them. the runtime's `parent transform`
    // walk skips trait-less nodes so descendants compose correctly.
    const animated = new Set(animatedNodeNames);

    // type params: union of gltf-derived node names / mesh names / clip names.
    // Empty unions become `never`. lifted into named aliases so the const
    // declaration stays scannable when a model has dozens of nodes/clips.
    const nodeUnion = nodeNames.length > 0 ? nodeNames.map((n) => JSON.stringify(n)).join(' | ') : 'never';
    const meshUnion = meshes.length > 0 ? meshes.map((m) => JSON.stringify(m.name)).join(' | ') : 'never';
    const clipUnion = clipNames.length > 0 ? clipNames.map((n) => JSON.stringify(n)).join(' | ') : 'never';

    lines.push(`// source: ${srcRel}`);
    lines.push(`type ${constId}Nodes = ${nodeUnion};`);
    lines.push(`type ${constId}Meshes = ${meshUnion};`);
    lines.push(`type ${constId}Clips = ${clipUnion};`);
    lines.push(`const ${constId}: ModelHandle<${constId}Nodes, ${constId}Meshes, ${constId}Clips> = (() => {`);
    lines.push(`    const MODEL_ID = ${JSON.stringify(id)};`);

    for (let i = 0; i < sceneNodes.length; i++) {
        const sn = sceneNodes[i]!;
        lines.push(`    const ${nodeVar(i)} = createNode({ name: ${JSON.stringify(sn.name)} });`);
        const needsTransform = sn.meshName !== null || animated.has(sn.name) || !isIdentityTRS(sn);
        if (needsTransform) {
            lines.push(
                `    addTrait(${nodeVar(i)}, TransformTrait, { position: ${vec3Lit(sn.position)}, quaternion: ${vec4Lit(sn.quaternion)}, scale: ${vec3Lit(sn.scale)} });`,
            );
        }
        if (sn.meshName) {
            lines.push(
                `    addTrait(${nodeVar(i)}, MeshTrait, { meshId: { modelId: MODEL_ID, meshName: ${JSON.stringify(sn.meshName)} } });`,
            );
        }
    }

    for (let i = 0; i < sceneNodes.length; i++) {
        const sn = sceneNodes[i]!;
        if (sn.parent >= 0) {
            lines.push(`    addChild(${nodeVar(sn.parent)}, ${nodeVar(i)});`);
        }
    }

    // scene root: if the gltf has exactly one top-level node, use it
    // directly; otherwise wrap multiple roots under a synthetic detached
    // node named after the model id. The synthetic wrapper isn't added to
    // `nodes` (no name to give it that wouldn't risk colliding with a
    // real gltf node), user reaches it via `handle.scene`.
    const rootIndices: number[] = [];
    for (let i = 0; i < sceneNodes.length; i++) {
        if (sceneNodes[i]!.parent < 0) rootIndices.push(i);
    }
    if (rootIndices.length === 1) {
        lines.push(`    const _scene = ${nodeVar(rootIndices[0]!)};`);
    } else {
        lines.push(`    const _scene = createNode({ name: MODEL_ID });`);
        for (const r of rootIndices) {
            lines.push(`    addChild(_scene, ${nodeVar(r)});`);
        }
    }

    for (let i = 0; i < clipNames.length; i++) {
        lines.push(`    const ${clipVar(i)}: ClipDef = { name: ${JSON.stringify(clipNames[i])}, modelId: MODEL_ID };`);
    }

    lines.push(`    return {`);
    lines.push(`        modelId: MODEL_ID,`);
    lines.push(`        name: MODEL_ID,`);
    lines.push(`        dependency: { registry: 'models', id: MODEL_ID },`);
    lines.push(`        src: ${JSON.stringify(srcRel)},`);
    lines.push(`        bin: {`);
    lines.push(`            client: ${JSON.stringify(clientBinUrl)},`);
    lines.push(`            server: ${JSON.stringify(serverBinUrl)},`);
    lines.push(`        },`);
    lines.push(`        scene: _scene,`);
    lines.push(`        aabb: ${box3Lit(payload.aabb)},`);
    lines.push(`        nodes: {`);
    for (let i = 0; i < sceneNodes.length; i++) {
        lines.push(`            ${JSON.stringify(sceneNodes[i]!.name)}: ${nodeVar(i)},`);
    }
    lines.push(`        },`);
    lines.push(`        meshes: {`);
    for (const m of meshes) {
        lines.push(
            `            ${JSON.stringify(m.name)}: { id: { modelId: MODEL_ID, meshName: ${JSON.stringify(m.name)} }, aabb: ${box3Lit(m.aabb)} },`,
        );
    }
    lines.push(`        },`);
    lines.push(`        animations: {`);
    for (let i = 0; i < clipNames.length; i++) {
        lines.push(`            ${JSON.stringify(clipNames[i])}: ${clipVar(i)},`);
    }
    lines.push(`        },`);
    lines.push(`        version: 0,`);
    lines.push(`    };`);
    lines.push(`})();`);
}

const EMPTY_BARREL = `// auto-generated by asset pipeline — do not edit
export {};
`;

// ── GC ─────────────────────────────────────────────────────────────

async function gcOrphanBins(projectFs: Filesystem, live: Set<string>): Promise<void> {
    for (const dir of [CLIENT_BIN_DIR, SERVER_BIN_DIR]) {
        for (const entry of await projectFs.list(dir)) {
            if (entry.kind !== 'file' || !entry.path.endsWith('.bin')) continue;
            const name = entry.path.split('/').pop()!;
            if (live.has(name)) continue;
            await projectFs.remove(entry.path);
        }
    }
}

// ── helpers ────────────────────────────────────────────────────────

/** fast non-crypto 32-bit FNV-1a over bytes, hex. dedup keys only. */
function fnv1aHex(bytes: Uint8Array): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i]!;
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
}

/**
 * Model ids must be unique AFTER `sanitizeIdent` because every id becomes
 * a top-level `const` name (plus `<id>Nodes`/`Meshes`/`Clips` type aliases)
 * in the generated barrel. Two ids that sanitize to the same identifier
 * (`'foo-bar'` and `'foo_bar'` → `foo_bar`) would silently produce
 * duplicate declarations and fail downstream with a cryptic TS error.
 * Surface the actual conflict here with the offending ids.
 */
function assertNoIdentCollisions(ids: string[]): void {
    const byIdent = new Map<string, string[]>();
    for (const id of ids) {
        const ident = sanitizeIdent(id);
        const bucket = byIdent.get(ident);
        if (bucket) bucket.push(id);
        else byIdent.set(ident, [id]);
    }
    const collisions = [...byIdent.entries()].filter(([, raw]) => raw.length > 1);
    if (collisions.length === 0) return;
    const detail = collisions.map(([ident, raw]) => `  '${ident}' ← ${raw.map((s) => `'${s}'`).join(', ')}`).join('\n');
    throw new Error(`[bongle] model ids collide after identifier sanitization (ids must be globally unique):\n${detail}`);
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function sanitizeIdent(id: string): string {
    if (IDENT_RE.test(id)) return id;
    // replace non-ident chars with underscore; prefix digit-leading with `_`
    let s = id.replace(/[^A-Za-z0-9_$]/g, '_');
    if (/^[0-9]/.test(s)) s = `_${s}`;
    return s;
}

/** TRS within `TRS_EPS` of identity, gltf bake noise absorbs the slack. */
const TRS_EPS = 1e-6;
function isIdentityTRS(sn: SceneNodeInfo): boolean {
    const [px, py, pz] = sn.position;
    const [qx, qy, qz, qw] = sn.quaternion;
    const [sx, sy, sz] = sn.scale;
    return (
        Math.abs(px) < TRS_EPS &&
        Math.abs(py) < TRS_EPS &&
        Math.abs(pz) < TRS_EPS &&
        Math.abs(qx) < TRS_EPS &&
        Math.abs(qy) < TRS_EPS &&
        Math.abs(qz) < TRS_EPS &&
        Math.abs(qw - 1) < TRS_EPS &&
        Math.abs(sx - 1) < TRS_EPS &&
        Math.abs(sy - 1) < TRS_EPS &&
        Math.abs(sz - 1) < TRS_EPS
    );
}

function vec3Lit(v: [number, number, number]): string {
    return `[${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])}]`;
}

function vec4Lit(v: [number, number, number, number]): string {
    return `[${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])}, ${fmt(v[3])}]`;
}

function box3Lit(v: Box3): string {
    return `[${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])}, ${fmt(v[3])}, ${fmt(v[4])}, ${fmt(v[5])}]`;
}

function fmt(n: number): string {
    if (Object.is(n, -0)) return '0';
    return Number.isInteger(n) ? n.toFixed(1) : String(n);
}
