import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@orcaops/watch-data',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    pool: 'forks',
    // The engine/snapshot tests build real archive fixtures, so they need the
    // hermetic ORCAOPS_* scrub and throwaway data/cache dirs.
    setupFiles: ['./vitest.setup.ts'],
  },
});
