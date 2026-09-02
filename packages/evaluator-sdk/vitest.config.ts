import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@orcaops/evaluator-sdk',
    include: ['src/**/*.test.ts'],
  },
});
