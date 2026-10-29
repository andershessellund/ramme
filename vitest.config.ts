import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ramme's own suites; packages/eslint-plugin-ramme runs its tests itself (`pnpm check:plugin`).
    include: ['src/**/*.test.ts'],
    // The current-node slot is module state (D41); per-file isolation keeps
    // each suite's module graph its own.
    isolate: true,
    pool: 'forks',
    // globalThis.gc for the collection tests (driver.test.ts, invariants.test.ts).
    execArgv: ['--expose-gc'],
    // The unhandled-rejection guard (I10).
    setupFiles: ['./src/test/setup.ts'],
    // src/ compiled for this run, which the browser checks read instead of a dist/ that may be missing or stale.
    globalSetup: ['./src/test/build.ts'],
  },
});
