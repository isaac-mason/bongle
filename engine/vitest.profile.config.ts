import { defineConfig } from 'vitest/config';

// one-off config used to profile the bench. invoked via:
//   pnpm vitest bench --run --config vitest.profile.config.ts \
//     src/core/physics/vcc.bench.ts -t "tickLike.*16 static"
// the cpuprofile lands in ./.profiles relative to the worker cwd.
export default defineConfig({
    test: {
        pool: 'forks',
        poolOptions: {
            forks: {
                singleFork: true,
                execArgv: [
                    '--cpu-prof',
                    '--cpu-prof-dir=.profiles',
                    '--cpu-prof-interval=100',
                ],
            },
        },
    },
});
