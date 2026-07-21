// internal api, not for end users.
// exposes engine internals needed by the cli, asset pipeline, and
// other tooling that runs outside the normal client/server paths.

export type { EntryMeta, RegistryStore as KindStore, PrefabDef, Registry } from './core/registry';
export { registry } from './core/registry';

import type { ModelHandle as ModelHandleType } from './core/models/handle';
import type { SceneHandle as SceneHandleType } from './core/scene/scene-handle';
import type { Blocks as BlockRegistryType } from './core/voxels/block-registry';
// Asset-pipeline view: the small slice of registry state the bake
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
// Skyline atlas core, pure algorithm + types, consumed by both the
// runtime model atlas (`render/models/model-atlas.ts`) and the bake-time
// sprite-atlas pass in `src/asset-pipeline/bake`.
export type { Region, SkylineNode } from './core/atlas/skyline';
export { addSkylineLevel, emptySkyline, findBestFit } from './core/atlas/skyline';
// dependency graph, on-demand reads for tooling that walks a consumer's
// closure itself (e.g. the offline icon pipeline's selective re-render gating).
export type { DepKey } from './core/capture/dep-graph';
export { directProducersOf } from './core/capture/dep-graph';
export type { ScenePayload } from './core/content/scene-store';
export type { MatchmakingConfig } from './core/matchmaking';
export { migrateScene, SCENE_LATEST } from './migrations/scene';
export type { ModelHandle } from './core/models/handle';
export type { ModelBin, ModelBinChannel, ModelBinClip, ModelBinImage, ModelBinMesh } from './core/models/model-bin';
export { modelBinSchema, pack as packModelBin, unpack as unpackModelBin } from './core/models/model-bin';
export type { ParticleHandle, ParticleOptions, ParticlePlayback, ParticlePool, UpdateFn } from './core/particles/particles';
export { particle } from './core/particles/particles';
// detached-node primitives for codegen sidecars. the public scene-tree
// versions in `api/scene-tree.ts` take ScriptContext for parity with
// other script apis; these are the raw underlying functions, suitable
// for module-scope codegen that operates on detached nodes.
export { addChild, addTrait, createNode } from './core/scene/scene-tree';
// registration primitives for the generated codegen barrels: stamp a per-entry
// handle/payload into the singleton registry. Called DIRECTLY by the generated
// model/scene/sound barrels (real imports, like the detached-node primitives
// above), see src/asset-pipeline/bake/{models,scenes,audio}.ts.
export { _registerModelHandle as registerModel } from './core/models/models';
export { _registerScenePayload as registerScene } from './api/scenes';
export { _registerSoundHandle as registerSound } from './core/sounds/sounds';
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
export { draw } from './core/sprites/sprites';
export type { Blocks as BlockRegistry } from './core/voxels/block-registry';
// block registry builder, pure data computation that takes the raw
// BlockDef / BlockHandle / BlockTextureDef maps and produces the flat
// lookup tables consumed by the voxel mesher + ResourceManager. The
// asset-pipeline plugin handler calls this to assemble a partial
// ProjectModule view from the typed registries.
export { buildBlockRegistry } from './core/voxels/block-registry';
export type { BlockDef, BlockHandle, BlockTextureDef } from './core/voxels/blocks';
// __bongle, runtime namespace called by bongle-generated code (dev transform +
// build prelude/postlude, model + scene codegen barrels, realm boot entries).
// See src/internal-runtime.ts for the full surface + injection sites.
export { __bongle } from './internal-runtime';
export type { SpawnOpts } from './render/particles/particles';
export { allocateSlot, init, update } from './render/particles/particles';
