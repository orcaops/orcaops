import baseConfig from '@orcaops/eslint-config';

export default [
  {
    // apps/** and packages/diff-render/** are linted by their own package
    // configs (turbo run lint), not this root pass — diff-render additionally
    // carries vendored third-party files that must never be linted or fixed.
    ignores: [
      'eslint.config.js',
      'packages/eslint-config/**',
      'apps/**',
      'packages/diff-render/**',
    ],
  },
  ...baseConfig,
];
