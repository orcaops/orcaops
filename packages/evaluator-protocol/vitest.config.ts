import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@orcaops/evaluator-protocol',
    include: ['src/**/*.test.ts'],
  },
});
