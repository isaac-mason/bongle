import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name: 'unit',
                    include: ['tst/unit/**/*.test.ts'],
                },
            },
            {
                test: {
                    name: 'kit',
                    include: ['kit/**/*.test.ts'],
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
