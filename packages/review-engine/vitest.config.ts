import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@orcaops/review-engine',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
