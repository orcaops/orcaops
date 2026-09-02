import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@orcaops/review-core',
    include: ['src/**/*.test.ts'],
  },
});
