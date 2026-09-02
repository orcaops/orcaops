import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@orcaops/evaluator-runner',
    include: ['src/**/*.test.ts'],
  },
});
