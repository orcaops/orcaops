import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@orcaops/test-harness',
    include: ['src/**/*.test.ts'],
  },
});
