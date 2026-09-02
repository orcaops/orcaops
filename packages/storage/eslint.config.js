import serverConfig from '@orcaops/eslint-config/server.js';

export default [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  ...serverConfig,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // Same Effection-idiom exemption as @orcaops/core / @orcaops/llm.
      'require-yield': 'off',
    },
  },
];
