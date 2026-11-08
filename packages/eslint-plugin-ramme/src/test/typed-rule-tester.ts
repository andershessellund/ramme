// The RuleTester of the type-aware rule tests: typescript-eslint's parser with
// a `project`, the fixture program in ./fixture (its tsconfig, a placeholder
// file.ts, and ramme.d.ts, the declarations of `ramme` the rules read). Each
// case lints `typedFile`, the program's file, with its own code in place of
// the placeholder, so the rules see the case's types.

import { fileURLToPath } from 'node:url';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';

const fixture = fileURLToPath(new URL('./fixture/', import.meta.url));

/** The file a type-aware case is linted as: `{ filename: typedFile, code }`. */
export const typedFile = `${fixture}file.ts`;

export const typedRuleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 'latest',
    sourceType: 'module',
    // Each case lints the one file with different code, so the program must be rebuilt per case: under `CI=true`
    // typescript-eslint would otherwise infer a single run, build the program once, and lint later cases in an
    // isolated program without ramme.d.ts.
    parserOptions: { project: './tsconfig.json', tsconfigRootDir: fixture, disallowAutomaticSingleRunInference: true },
  },
});
