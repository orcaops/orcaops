import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@orcaops/history-convert',
    include: ['src/**/*.test.ts'],
  },
});
