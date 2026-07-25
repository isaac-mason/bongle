// internal api, exposes engine internals needed by the cli, asset pipeline, and
// other tooling that runs outside the normal client/server paths.

import type { ModelHandle } from './core/models/handle';
import type { SceneHandle } from './core/scene/scene-handle';
import type { Blocks } from './core/voxels/block-registry';
import type { BlockTextureDef } from './core/voxels/blocks';

// Asset-pipeline view: the small slice of registry state the bake builders read.
// Materialized by `runAssetPipelinePass` from the singleton's per-kind maps
// before dispatching to the per-asset builders.
export type ModuleVersion = {
    blocks: Blocks;
    blockTextures: Map<string, BlockTextureDef>;
    models: Map<string, ModelHandle>;
    scenes: Map<string, SceneHandle>;
};

// registerModel / registerScene / registerSound: registration primitives the
// generated codegen barrels import to stamp one handle/payload into the singleton
// registry (see asset-pipeline/bake/{models,scenes,audio}.ts). Sorted apart by path.
export { _registerScenePayload as registerScene } from './api/scenes';
export { _registerModelHandle as registerModel } from './core/models/models';
// The shared registry singleton. The asset-pipeline realm fetches this by the
// `bongle/internal` specifier at runtime so it reads the SAME instance the
// user declarations populated (a static import would get an empty copy).
export { registry } from './core/registry';
export { _registerSoundHandle as registerSound } from './core/sounds/sounds';
// block registry builder: pure data computation over the raw registry maps,
// consumed by the pipeline pass to assemble a partial ModuleVersion view.
export { buildBlockRegistry } from './core/voxels/block-registry';
// __bongle, runtime namespace called by bongle-generated code (dev transform +
// build prelude/postlude, model + scene codegen barrels, realm boot entries).
// See src/internal-runtime.ts for the full surface + injection sites.
export { __bongle } from './internal-runtime';
