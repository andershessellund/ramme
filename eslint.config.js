import tseslint from 'typescript-eslint';

export default tseslint.config({ ignores: ['dist/'] }, ...tseslint.configs.recommended, {
  rules: {
    // Context/ContextImpl casts at the public boundary and the contract-key
    // map erase generics deliberately; `any` at those seams is localized.
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  },
});

