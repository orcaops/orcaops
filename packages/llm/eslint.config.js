import serverConfig from '@orcaops/eslint-config/server.js';

export default [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  ...serverConfig,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // Effection idiom: generator functions can return without yielding
      // (they're treated as immediate-return Operations). The default
      // `require-yield` rule fights this pattern.
      'require-yield': 'off',
    },
  },
];
