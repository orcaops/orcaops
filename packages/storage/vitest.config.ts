import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@orcaops/storage',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
