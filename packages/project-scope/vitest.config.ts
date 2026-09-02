import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@orcaops/project-scope',
    include: ['src/**/*.test.ts'],
  },
});
