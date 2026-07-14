// The pipeline realm's entry: the data baker plus icon rendering.
//
//  - `AssetPipeline`: init(ctx) / run(state) / dispose. A pure data baker
//    (atlas / sprites / models / scenes barrels / audio) that writes into the
//    project Filesystem.
//  - `Icons`: the GPU render step that runs after a bake to produce block /
//    prefab icon images, against the same realm registry the bake read.

export * as AssetPipeline from './pipeline';
export * as Icons from './icons';
