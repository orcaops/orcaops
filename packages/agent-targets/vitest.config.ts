import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@orcaops/agent-targets',
    include: ['src/**/*.test.ts'],
  },
});
