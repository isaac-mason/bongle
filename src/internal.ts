// internal api — not for end users.
// exposes engine internals needed by the cli, asset pipeline, and
// other tooling that runs outside the normal client/server paths.

export type { Handle, KindStore, PrefabDef, Registry } from './core/registry';
export { registry } from './core/registry';

import type { ModelHandle as ModelHandleType } from './core/models/handle';
import type { SceneHandle as SceneHandleType } from './core/scene/scene-handle';
import type { BlockRegistry as BlockRegistryType } from './core/voxels/block-registry';
// Asset-pipeline view: the small slice of registry state the kit
// builders read. Materialized by `runAssetPipelinePass` from the
// singleton's per-kind maps before dispatching to the per-asset
// builders.
import type { BlockTextureDef } from './core/voxels/blocks';
export type ModuleVersion = {
    blocks: BlockRegistryType;
    blockTextures: Map<string, BlockTextureDef>;
    models: Map<string, ModelHandleType>;
    scenes: Map<string, SceneHandleType>;
};
export type { SpawnOpts } from './client/particles/particles';
export { allocateSlot, init, update } from './client/particles/particles';
// Skyline atlas core — pure algorithm + types, consumed by both the
// runtime model atlas (`client/models/model-atlas.ts`) and the bake-time
// sprite-atlas pass in `lib/kit/src/asset-pipeline/sprite-atlas.ts`.
export type { Region, SkylineNode } from './core/atlas/skyline';
export { addSkylineLevel, emptySkyline, findBestFit } from './core/atlas/skyline';
// dependency graph — on-demand reads for tooling that walks a consumer's
// closure itself (e.g. the offline icon pipeline's selective re-render gating).
export type { DepKey } from './core/capture/dep-graph';
export { directProducersOf } from './core/capture/dep-graph';
export type { ScenePayload } from './core/content/scene-store';
export type { MatchmakingConfig } from './core/matchmaking';
export type { ModelHandle } from './core/models/handle';
export type { ModelBin, ModelBinChannel, ModelBinClip, ModelBinImage, ModelBinMesh } from './core/models/model-bin';
export { modelBinSchema, pack as packModelBin, unpack as unpackModelBin } from './core/models/model-bin';
export type { ParticleHandle, ParticleOptions, ParticlePlayback, ParticlePool, UpdateFn } from './core/particles/particles';
export { particle } from './core/particles/particles';
// detached-node primitives for codegen sidecars. the public scene-graph
// versions in `api/scene-graph.ts` take ScriptContext for parity with
// other script apis; these are the raw underlying functions, suitable
// for module-scope codegen that operates on detached nodes.
export { addChild, addTrait, createNode } from './core/scene/nodes';
export type { SceneHandle } from './core/scene/scene-handle';
export { extractScenePrefabDeps } from './core/scene/scene-handle';
export type { SoundHandle, SoundOptions } from './core/sounds/sounds';
export type {
    DrawFn,
    DrawInputs,
    DrawParams,
    DrawSource,
    ImageSource,
    NormalizedImageSource,
    SpriteHandle,
    SpriteOptions,
} from './core/sprites/sprites';
export { draw, normalizeImageSource } from './core/sprites/sprites';
export type { BlockRegistry } from './core/voxels/block-registry';
// block registry builder — pure data computation that takes the raw
// BlockDef / BlockHandle / BlockTextureDef maps and produces the flat
// lookup tables consumed by the voxel mesher + ResourceManager. The
// asset-pipeline plugin handler calls this to assemble a partial
// ProjectModule view from the typed registries.
export { buildBlockRegistry } from './core/voxels/block-registry';
export type { BlockDef, BlockHandle, BlockTextureDef } from './core/voxels/blocks';
// __kit — runtime namespace called by kit-generated code (Vite transform
// prelude/postlude, model + scene codegen barrels, kit boot entries).
// See engine/src/__kit.ts for the full surface + injection sites.
export { __kit } from './kit';
