// The one asset pipeline: init(ctx) / run(state) / dispose. A pure data
// baker (atlas / sprites / models / scenes barrels / audio) that writes into
// the project Filesystem. No icon rendering (the editor client draws those),
// so no GPU / render engine here.

export * as AssetPipeline from './pipeline';
