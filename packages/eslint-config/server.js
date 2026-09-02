import baseConfig from './index.js';

export default [
  ...baseConfig,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // Permit intentionally ignored callback parameters and locals.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
];
