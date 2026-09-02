import serverConfig from '@orcaops/eslint-config/server.js';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'bin/**', 'verify-*'],
  },
  ...serverConfig,
  {
    // Build/dev tooling scripts may log to the console.
    files: ['scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // OpenTUI/React may only be imported from src/tui/**. The data layer
    // (src/data/**, the Node sidecar) and `src/core/**`, which runs under Node
    // via the sidecar and the one-shot path, must stay renderer-free.
    files: ['src/core/**/*.{ts,tsx}', 'src/data/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@opentui/*', 'react', 'react/*', 'react-dom', 'react-dom/*'],
              message:
                'OpenTUI/React may only be imported from src/tui/** — src/core/** and src/data/** must stay renderer-free (they run under Node).',
            },
          ],
        },
      ],
    },
  },
];
