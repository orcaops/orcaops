import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@orcaops/evaluator-pack',
    include: ['src/**/*.test.ts', 'packs/**/*.test.ts'],
  },
});
