import { defineConfig } from 'vitest/config';

import config from './vitest.config.js';

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    coverage: {
      ...config.test?.coverage,
      // Whole-suite thresholds are enforced after every shard's coverage is merged.
      thresholds: undefined,
      reporter: [],
    },
  },
});
