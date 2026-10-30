import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// `pnpm test:browser`: the smoke test (src/test/browser-smoke.test.ts) run unchanged in headless Chromium, the browser
// the core and `ramme/platform` target (D41, decisions 18 and 19; D43). Only that file: every other suite reads
// Node's `process` (src/test/setup.ts's unhandled-rejection guard) or the file system, so none of vitest.config.ts's
// setup is used here. Chromium comes from Playwright: `pnpm exec playwright install chromium` once (CI: the workflow's
// `browser` job).
export default defineConfig({
  test: {
    include: ['src/test/browser-smoke.test.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
