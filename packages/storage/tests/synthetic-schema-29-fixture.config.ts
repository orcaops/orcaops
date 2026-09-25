import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/synthetic-schema-29-fixture.generate.ts'] },
});
