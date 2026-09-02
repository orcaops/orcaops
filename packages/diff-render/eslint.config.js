import serverConfig from '@orcaops/eslint-config/server.js';

export default [
  {
    // Vendored third-party files (see LICENSE + the per-file provenance headers)
    // are NEVER linted or auto-fixed — keeping them out is what keeps them
    // verbatim. The `ignores` list below is the exclusion set; the
    // orcaops-authored modules and the `*.test.ts` files are linted.
    ignores: [
      'dist/**',
      'node_modules/**',
      'src/core/**',
      'src/lib/**',
      'src/ui/lib/**',
      'src/ui/components/**',
      'src/ui/themes.ts',
      'src/ui/themes/**',
      'src/ui/diff/pierre.ts',
      'src/ui/diff/renderRows.tsx',
      'src/ui/diff/rowStyle.ts',
      'src/ui/diff/useHighlightedDiff.ts',
      'src/ui/diff/useHighlightedSource.ts',
      'src/ui/diff/codeColumns.ts',
      'src/ui/diff/expandCollapsedRows.ts',
    ],
  },
  ...serverConfig,
];
