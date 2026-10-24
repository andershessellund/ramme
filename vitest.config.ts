import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ramme's own suites; packages/eslint-plugin-ramme runs its tests itself (`pnpm check:plugin`).
    include: ['src/**/*.test.ts'],
    // Context storage is module state registered once per process; per-file
    // isolation keeps suites honest about it (storage.test.ts runs without an
    // adapter, D-57).
    isolate: true,
    pool: 'forks',
    // globalThis.gc for the collection tests (managed.test.ts).
    execArgv: ['--expose-gc'],
    // The unhandled-rejection guard (I10).
    setupFiles: ['./src/test/setup.ts'],
  },
});
