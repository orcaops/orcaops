import serverConfig from '@orcaops/eslint-config/server.js';

export default [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  ...serverConfig,
];
