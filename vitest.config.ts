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
                },
            },
            {
                test: {
                    name: 'integration',
                    include: ['tst/integration/**/*.test.ts'],
                },
            },
            {
                test: {
                    name: 'e2e',
                    include: ['tst/e2e/**/*.test.ts'],
                    environment: 'happy-dom',
                    setupFiles: ['tst/e2e/setup.ts'],
                    testTimeout: 30_000,
                    fileParallelism: false,
                },
            },
        ],
    },
});
