import tseslint from 'typescript-eslint';

// The one ESLint config of the repository. ESLint looks a config up from each
// linted file's directory, so packages/eslint-plugin-ramme has none of its own:
// its `lint` script resolves to this file, and so does the root `pnpm lint`.
// `dist/` matches only the root's build output.
export default tseslint.config({ ignores: ['dist/', 'packages/*/dist/'] }, ...tseslint.configs.recommended, {
  rules: {
    // Context/ContextImpl casts at the public boundary and the contract-key
    // map erase generics deliberately; `any` at those seams is localized.
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  },
});

