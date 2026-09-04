import { defineConfig } from '@pmndrs/labs';

export default defineConfig({
    benchDir: '.',
    benchMatch: '**/*.bench.ts',

    // Tuned for comparison verdicts rather than quick looks. Resolution scales as
    // `2.8 * spread * sqrt(2 / blocks)`, so tripling the default 8 blocks roughly halves
    // the minimum detectable effect; `maxCpuTime` is raised alongside because a multi-block
    // pilot only gets `maxCpuTime / blocks` to plan with, and at 24 blocks the default 5s
    // would starve it below `minCpuTime`.
    blocks: 24,
    minCpuTime: 0.5,
    maxCpuTime: 24,
    adaptive: 0.015,

    // The transform work being judged here lands in the 2-9% range. At the default 0.05
    // every one of those reads "neutral" no matter how tight the resolution, which hides
    // the difference between "no effect" and "effect too small to be worth code".
    minDelta: 0.02,
});
