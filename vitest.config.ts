import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Context storage is module state registered once per process; per-file
    // isolation keeps suites honest about it (storage.test.ts runs without an
    // adapter, D-57).
    isolate: true,
    pool: 'forks',
    // globalThis.gc for the collection tests (managed.test.ts, freeze-gc.test.ts).
    execArgv: ['--expose-gc'],
    // The unhandled-rejection guard (I10).
    setupFiles: ['./src/test/setup.ts'],
  },
});
