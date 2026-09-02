import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@orcaops/adapters',
    include: ['src/**/*.test.ts'],
  },
});
