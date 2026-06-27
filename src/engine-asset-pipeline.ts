// The one asset pipeline — init(ctx) / run(state) / dispose / assetSources.
// This is the API the kit programs against: the dev plugin runs it on each
// settled flush (forwarding the RunResult to the browser), and the build runs
// it once. It lives in the engine because it uses the engine; reachable only
// here (edit + build), so its Node deps (sharp/skia/gltf/ffmpeg/Dawn) stay out
// of the play bundles. See llm/plan-asset-pipeline-unify-in-engine.md.

// Bake helpers the build path calls directly (the dev plugin goes through
// AssetPipeline). `excludeEditorIcons` filters editor-only icon dirs out of the
// shipped bundle; `resolveEngineRoot` locates the engine for the in-process bake.
export { excludeEditorIcons } from './asset-pipeline/bake/icons-write';
export { resolveEngineRoot } from './asset-pipeline/bake/run';
export * as AssetPipeline from './asset-pipeline/pipeline';
