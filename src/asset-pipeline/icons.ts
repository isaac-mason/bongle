// Icon rendering for the pipeline worker. The bake is a pure data step; icons
// are a GPU render step that runs after it, in the same realm, so it draws
// against the registry the user code populated. Grouped here (not in the bake)
// because both are the pipeline's concern once it owns a headless renderer.
//
// The heavy lifting lives in client/: `createHeadlessRenderContext` +
// `buildRenderDeps` stand up a canvas-less render stack, and the same
// `renderBlockIconAtlas` / `renderPrefabIcon` the live client uses draw the
// icons through the shared `RenderRoomDeps` seam.

export { renderBlockIconAtlas } from '../client/block-icons';
export type { BlockIconAtlas } from '../client/block-icons';
export { buildRenderDeps, createHeadlessRenderContext } from '../client/headless-render';
export type { HeadlessRenderContext } from '../client/headless-render';
export { renderPrefabIcon } from '../client/prefab-icons';
export type { PrefabIcon } from '../client/prefab-icons';
