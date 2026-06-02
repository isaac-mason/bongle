/**
 * Node-side icon-hash computation. Lifted from inside the offline-renderer
 * task fns so the orchestrator can hash-gate render verbs before dispatching
 * them. The task fns now always render; gating lives exclusively here.
 *
 * Hash version constants stay aligned with the originals — bumping either
 * side independently would re-render every icon on next boot.
 */

import { createHash } from 'node:crypto';
import type { PipelineInternal } from '../asset-pipeline/pipeline';

const BLOCK_HASH_VERSION = 4;
const PREFAB_HASH_VERSION = 3;
const SCENE_HASH_VERSION = 3;

const BLOCK_ICON_PX = 128;
const PREFAB_ICON_PX = 256;
const SCENE_ICON_PX = 256;

/** djb2 of Function.prototype.toString — same shape the previous
 *  per-task hash relied on for `prefab.apply` body. Not cryptographic; we
 *  just need a stable string the hash mixes in. */
function fnToHashable(fn: unknown): string {
    return typeof fn === 'function' ? fn.toString() : String(fn);
}

function sha256Json(input: unknown): string {
    return createHash('sha256').update(JSON.stringify(input, stableReplacer)).digest('hex');
}

function stableReplacer(_key: string, value: unknown): unknown {
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
        return Array.from(value as unknown as Iterable<number>);
    }
    if (value instanceof Map) {
        const entries = Array.from(value.entries()).sort((a, b) =>
            String(a[0]).localeCompare(String(b[0])),
        );
        return { __map: entries };
    }
    if (value instanceof Set) {
        const items = Array.from(value).sort();
        return { __set: items };
    }
    return value;
}

function blockRegistrySlice(reg: PipelineInternal['registry']['blockRegistry']) {
    return {
        totalStates: reg.totalStates,
        stateToKey: reg.stateToKey,
        modelType: reg.modelType,
        cubeTexIndices: reg.cubeTexIndices,
        meshId: reg.meshId,
        meshQuads: reg.meshQuads.slice(1),
        meshTexIndices: reg.meshTexIndices.slice(1),
        meshQuadMaterials: reg.meshQuadMaterials.slice(1),
        material: reg.material,
        vertexAnimation: reg.vertexAnimation,
        emissive: reg.emissive,
    };
}

function modelsSlice(internal: PipelineInternal): Array<{ id: string; bin: string; version: number }> {
    return Array.from(internal.registry.models.byId.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, h]) => ({ id, bin: h.payload.bin.client, version: h.payload.version }));
}

export function computeBlockIconsHash(internal: PipelineInternal, atlasHash: string | null): string {
    const reg = internal.registry.blockRegistry;
    return sha256Json({
        v: BLOCK_HASH_VERSION,
        ICON_PX: BLOCK_ICON_PX,
        atlasHash,
        ...blockRegistrySlice(reg),
    });
}

export function computePrefabIconsHash(internal: PipelineInternal, atlasHash: string | null): string {
    const reg = internal.registry.blockRegistry;
    const prefabs = Array.from(internal.registry.prefabs.byId.values())
        .map((h) => h.payload)
        .sort((a, b) => a.id.localeCompare(b.id));
    return sha256Json({
        v: PREFAB_HASH_VERSION,
        PREFAB_ICON_PX,
        atlasHash,
        registry: blockRegistrySlice(reg),
        prefabs: prefabs.map((p) => ({
            id: p.id,
            deps: p.deps.map((d) => `${d.registry}:${d.id}`),
            type: p.type,
            argsDefault: p.args?.default ?? null,
            node: p.node ?? null,
            apply: fnToHashable(p.apply),
        })),
        scenes: Array.from(internal.registry.scenes.byId.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([id, h]) => ({ id, version: h.payload.version })),
        models: modelsSlice(internal),
    });
}

/** Pure function of `(diskCorpus, atlasHash, blockRegistrySlice, models)`.
 *  Disk is the source of truth for which scenes exist — the gameServer's
 *  `registry.scenes` is a derived view that only catches up to new
 *  filesystem-discovered blueprints once the codegen barrel re-emits.
 *  Routing icons through it would race that codegen, so we walk disk
 *  directly (corpus comes from `scanScenes` in the orchestrator). */
export function computeSceneIconHashes(
    internal: PipelineInternal,
    atlasHash: string | null,
    corpus: ReadonlyArray<{ id: string; bytesHash: string }>,
): Array<{ id: string; hash: string }> {
    const reg = internal.registry.blockRegistry;
    const sceneRegistrySlice = {
        modelType: reg.modelType,
        cubeTexIndices: reg.cubeTexIndices,
        material: reg.material,
        vertexAnimation: reg.vertexAnimation,
        emissive: reg.emissive,
        stateToKey: reg.stateToKey,
    };
    const models = modelsSlice(internal);
    const out: Array<{ id: string; hash: string }> = [];
    for (const { id, bytesHash } of corpus) {
        const hash = sha256Json({
            v: SCENE_HASH_VERSION,
            SCENE_ICON_PX,
            id,
            atlasHash,
            bytesHash,
            registry: sceneRegistrySlice,
            models,
        });
        out.push({ id, hash });
    }
    return out;
}
