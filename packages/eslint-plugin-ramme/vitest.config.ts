import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ESLint's RuleTester builds its suites with the global `describe` and `it`.
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});
