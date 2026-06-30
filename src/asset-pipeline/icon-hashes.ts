/**
 * Node-side icon-hash computation. Lifted from inside the asset-pipeline
 * task fns so the orchestrator can hash-gate render verbs before dispatching
 * them. The task fns now always render; gating lives exclusively here.
 *
 * Hash version constants stay aligned with the originals, bumping either
 * side independently would re-render every icon on next boot.
 */

import { createHash } from 'node:crypto';
import type { PipelineInternal } from './bake/pass';
import { closureVersionDigest, iconDepClosure } from './icon-deps';

const BLOCK_HASH_VERSION = 4;
const PREFAB_HASH_VERSION = 4;
const SCENE_HASH_VERSION = 4;

const BLOCK_ICON_PX = 128;
const PREFAB_ICON_PX = 256;
const SCENE_ICON_PX = 256;

function sha256Json(input: unknown): string {
    return createHash('sha256').update(JSON.stringify(input, stableReplacer)).digest('hex');
}

function stableReplacer(_key: string, value: unknown): unknown {
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
        return Array.from(value as unknown as Iterable<number>);
    }
    if (value instanceof Map) {
        const entries = Array.from(value.entries()).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
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

/** Per-prefab icon hashes (one PNG per prefab). Each prefab's hash is a pure
 *  function of its own registry `version` plus the versions of its transitive
 *  dependency closure (other prefabs/scenes it pulls in, see icon-deps), so
 *  editing one prefab re-renders only the icons that actually depend on it.
 *  Block + model inputs stay coarse (atlasHash / registry slice / modelsSlice):
 *  a block-atlas or model edit re-renders all icons. */
export function computePrefabIconHashes(
    internal: PipelineInternal,
    atlasHash: string | null,
): Array<{ id: string; hash: string }> {
    const registry = blockRegistrySlice(internal.registry.blockRegistry);
    const models = modelsSlice(internal);
    const prefabs = Array.from(internal.registry.prefabs.byId.entries()).sort(([a], [b]) => a.localeCompare(b));
    return prefabs.map(([id, handle]) => {
        const closure = iconDepClosure(internal, { registry: 'prefabs', id });
        const hash = sha256Json({
            v: PREFAB_HASH_VERSION,
            PREFAB_ICON_PX,
            id,
            atlasHash,
            registry,
            selfVersion: handle.version,
            closure: closureVersionDigest(internal, closure),
            models,
        });
        return { id, hash };
    });
}

/** Per-scene icon hashes. Self-identity is the disk `bytesHash` (the server
 *  `registry.scenes` is a derived view that lags codegen for new
 *  filesystem-discovered blueprints, so disk stays the source of truth for
 *  *which* scenes exist + their authored bytes, corpus comes from `scanScenes`
 *  in the orchestrator). On top of that we fold in the scene's transitive
 *  dependency closure (the prefabs it embeds + their deps, see icon-deps), so
 *  editing an embedded prefab re-renders the scene icon even though its bytes
 *  didn't move. Block + model inputs stay coarse. */
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
        const closure = iconDepClosure(internal, { registry: 'scenes', id });
        const hash = sha256Json({
            v: SCENE_HASH_VERSION,
            SCENE_ICON_PX,
            id,
            atlasHash,
            bytesHash,
            registry: sceneRegistrySlice,
            closure: closureVersionDigest(internal, closure),
            models,
        });
        out.push({ id, hash });
    }
    return out;
}
