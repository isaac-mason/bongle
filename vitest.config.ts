import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // shakeup is a link: dep whose exports point at raw .ts source — inline it so vitest
        // transforms it rather than externalizing to node (which can't import .ts).
        server: { deps: { inline: [/shakeup/] } },
        projects: [
            {
                test: {
                    name: 'unit',
                    include: ['tst/unit/**/*.test.ts'],
                    // benchmark.include is a SEPARATE glob from test.include and defaults to
                    // `**/*.bench.ts`, so without this every project picks up every bench and
                    // `vitest bench` runs each one once per project. benches live in the
                    // dedicated `bench` project below.
                    benchmark: { include: [] },
                },
            },
            {
                test: {
                    name: 'integration',
                    include: ['tst/integration/**/*.test.ts'],
                    benchmark: { include: [] },
                },
            },
            {
                // a project is its own vite config — the root-level resolve/deps above don't reach
                // it, and e2e is where a split between `bongle` and `./src` actually bites (the
                // harness boots the server from ./src while the tests drive it through `bongle`).
                resolve: { conditions: ['source'] },
                test: {
                    name: 'e2e',
                    include: ['tst/e2e/**/*.test.ts'],
                    environment: 'happy-dom',
                    setupFiles: ['tst/e2e/setup.ts'],
                    testTimeout: 30_000,
                    fileParallelism: false,
                    server: { deps: { inline: [/shakeup/, /^bongle(\/|$)/] } },
                    benchmark: { include: [] },
                },
            },
            {
                // benches run once, in plain node. they measure engine internals (diff,
                // fan-out, meshing, lighting), so the e2e project's happy-dom + webgpu stub
                // would only add noise. `test.include: []` keeps `vitest run` out of here.
                test: {
                    name: 'bench',
                    include: [],
                    benchmark: { include: ['tst/**/*.bench.ts'] },
                },
            },
        ],
    },
});
