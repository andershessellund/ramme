import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ramme's own suites; packages/eslint-plugin-ramme runs its tests itself (`pnpm check:plugin`).
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // The current-node slot is module state (D41); per-file isolation keeps
    // each suite's module graph its own.
    isolate: true,
    pool: 'forks',
    // globalThis.gc for the runtime collection tests and lifecycle invariants.
    execArgv: ['--expose-gc'],
    // The unhandled-rejection guard (I10).
    setupFiles: ['./tests/support/setup.ts'],
    // src/ compiled for this run, which the browser checks read instead of a dist/ that may be missing or stale.
    globalSetup: ['./tests/support/build.ts'],
  },
});
