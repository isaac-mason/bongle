// The pipeline realm's entry: the data baker, the icon renderer, and the edit-session.
//
//  - `AssetPipeline`: init(ctx) / run(state) / dispose. A pure, host-neutral data baker
//    (atlas / sprites / models / scenes barrels / audio) that writes into the project
//    Filesystem. Caps (raster/decodeAudio/loader) injected — node bake uses it directly.
//  - `Icons`: the GPU render step that runs after a bake to produce block / prefab icon
//    images, against the same realm registry the bake read.
//  - `EditPipeline`: the browser EDIT-MODE session the editor realm drives —
//    init({ fs, onBaked }, { mode, cache }) / run(state) / dispose. Wires the browser caps,
//    registers the flush (re-bake on re-declare, engine-internal), and owns the bake loop +
//    icon render, so the editor's pipeline-worker is a thin driver that never touches
//    bongle/internal.

export * as AssetPipeline from './pipeline';
export * as EditPipeline from './edit-session';
export * as Icons from './icons';
