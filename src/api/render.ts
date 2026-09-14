// Per-game render pipeline overrides.
//
// The engine builds one render chain at boot and reuses it for every room:
// scene pass -> resolve -> tint -> overlay composite -> output. `setRenderPipeline`
// lets a game replace any of those stages while the engine keeps the structural
// parts it depends on - the two passes and their per-room scene swap, the scene
// depth that `dom-ui` samples for overlay occlusion, and termination of the graph.
//
// Stages are nodes, so they compile to both WGSL and GLSL. A game that reaches for
// compute or storage textures inside one will run on WebGPU and not on the WebGL2
// fallback, which the engine cannot warn about.

export { type RenderParts, type RenderStages, setRenderPipeline } from '../render/pipeline';
