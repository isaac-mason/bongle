import type { SceneHandle, SceneOptions } from '../core/scene/scene-handle';

/**
 * declares a scene resource at module scope, returning a stable `SceneHandle`
 * whose `node`/`voxels`/`version` fields are mutated in place when the scene
 * loads or reloads. `scene(id, { client: false })` loads server-only,
 * `{ server: false }` loads client-only; the unloaded side's handle stays
 * empty (`version: 0`, empty node, null voxels).
 */

export { scene } from '../core/registry';
export { cloneVoxels, copyVoxels } from '../core/voxels/voxels';
export type { SceneHandle, SceneOptions };
