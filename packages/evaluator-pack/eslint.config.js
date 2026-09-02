import serverConfig from '@orcaops/eslint-config/server.js';

export default [
  {
    ignores: ['dist/**', 'scripts/**', 'node_modules/**'],
  },
  ...serverConfig,
];
