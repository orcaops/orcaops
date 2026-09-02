import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The real @opentui/core imports `bun:`-protocol modules at load, which
    // the node ESM loader running vitest cannot resolve. The stub carries the
    // two lazily-used exports the vendored theme chain names, so geometry
    // tests can import through pierre.ts/themes.ts (still no render tests).
    // Exact-match regex: subpaths (e.g. a jsx runtime) must not be captured.
    alias: [
      {
        find: /^@opentui\/core$/,
        replacement: path.resolve(__dirname, 'src/test/opentuiCoreStub.ts'),
      },
    ],
  },
  test: {
    name: '@orcaops/diff-render',
    // Only pure-node modules are testable here: the package barrel (and the
    // UI layer generally) imports `bun:`-protocol modules via OpenTUI, which
    // the node ESM loader running vitest cannot resolve. Tests import their
    // module directly, never `src/index.ts`.
    include: ['src/**/*.test.ts'],
  },
});
