// The RuleTester every rule test uses: typescript-eslint's parser, modules,
// the latest syntax. RuleTester builds its suites with vitest's global
// `describe` and `it` (`globals: true` in vitest.config.ts).

import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';

export const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
});

/** Every invalid case names its message, so a rule reporting the wrong thing fails. */
export const assertionOptions = { requireMessage: true } as const;
