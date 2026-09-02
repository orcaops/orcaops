import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The real @opentui packages import `bun:`-protocol modules at load, which
    // the node ESM loader running vitest cannot resolve. The layout tests import
    // `DiffSlice`, which reaches measured geometry through the @orcaops/diff-render
    // barrel, and that vendored chain names a handful of OpenTUI exports it only
    // touches lazily — the stub carries exactly those.
    // Exact-match regexes: the jsx runtimes (react re-exports) stay real.
    alias: [
      {
        find: /^@opentui\/core$/,
        replacement: path.resolve(__dirname, 'tests/support/opentuiStub.ts'),
      },
      {
        find: /^@opentui\/react$/,
        replacement: path.resolve(__dirname, 'tests/support/opentuiStub.ts'),
      },
    ],
  },
  test: {
    name: '@orcaops/watch',
    // Only the pure UI reducers / data-parse helpers are unit-tested here; the
    // OpenTUI render layer is exercised by running the app, not by Vitest.
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    pool: 'forks',
    // The core engine/snapshot tests build real archive fixtures, so
    // they need the hermetic ORCAOPS_* scrub + throwaway data/cache dirs.
    setupFiles: ['./vitest.watch-setup.ts'],
  },
});
