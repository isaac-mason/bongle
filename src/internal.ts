// internal api, exposes engine internals needed by the cli, asset pipeline, and
// other tooling that runs outside the normal client/server paths.

import type { ModelHandle } from './core/models/handle';
import type { SceneHandle } from './core/scene/scene-handle';
import type { Blocks } from './core/voxels/block-registry';
import type { BlockTextureDef } from './core/voxels/blocks';

export type ModuleVersion = {
    blocks: Blocks;
    blockTextures: Map<string, BlockTextureDef>;
    models: Map<string, ModelHandle>;
    scenes: Map<string, SceneHandle>;
};

export { _registerScenePayload as registerScene } from './api/scenes';
export type { Region } from './core/atlas/skyline';
export { addSkylineLevel, emptySkyline, findBestFit } from './core/atlas/skyline';
export type { ModelHandle } from './core/models/handle';
export type { ModelBinChannel, ModelBinClip, ModelBinImage, ModelBinMesh } from './core/models/model-bin';
export { pack as packModelBin } from './core/models/model-bin';
export { _registerModelHandle as registerModel } from './core/models/models';
export type { Registry, RegistryStore as KindStore } from './core/registry';
export { registry } from './core/registry';
export type { SceneHandle } from './core/scene/scene-handle';
export type { SoundHandle } from './core/sounds/sounds';
export { _registerSoundHandle as registerSound } from './core/sounds/sounds';
export type { DrawSource, NormalizedImageSource, SpriteHandle } from './core/sprites/sprites';
export type { Blocks } from './core/voxels/block-registry';
export { buildBlockRegistry } from './core/voxels/block-registry';
export type { BlockDef, BlockHandle, BlockTextureDef } from './core/voxels/blocks';
export { __bongle } from './internal-runtime';
