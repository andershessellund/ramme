import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Context storage and the contract resolver are module state registered
    // once per process; per-file isolation keeps suites honest about it.
    isolate: true,
  },
});
