import { defineConfig } from '@pmndrs/labs';

// Perf benches live in `bench/`, deliberately outside `tst/` so vitest's own
// `bench` project (which matches `tst/**/*.bench.ts`) doesn't try to run them
// with a different API. vitest benches stay for the older engine measurements;
// new ones go here, where a generator bench can do its setup outside the
// measured closure instead of having construction cost swamp the signal.
export default defineConfig({
    benchDir: './bench',
    benchMatch: '**/*.bench.ts',
});
