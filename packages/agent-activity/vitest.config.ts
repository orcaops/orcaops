import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@orcaops/agent-activity',
    include: ['src/**/*.test.ts'],
  },
});
