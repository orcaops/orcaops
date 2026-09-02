import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@orcaops/llm',
    // tests/external holds real-agent tests (Claude/Codex); they stay
    // collected here but self-skip unless RUN_LLM_TESTS / RUN_REAL_USAGE_TESTS
    // is set.
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
