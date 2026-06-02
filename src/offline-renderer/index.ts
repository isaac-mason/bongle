// offline renderer entry point — re-exports the individual task fns.
// The orchestrator (kit/pipeline/orchestrator.ts) drives them directly,
// one verb per artifact. The previous `runTasks` wrapper is gone: hash
// gating, task ordering, and scene seeding now live Node-side.

export { runBlockIcons, type BlockIconAtlasResult } from './tasks/block-icons';
export { runPrefabIcons, type PrefabIconAtlasResult } from './tasks/prefab-icons';
export { runSceneIcon, type SceneIconResult } from './tasks/scene-icon';
