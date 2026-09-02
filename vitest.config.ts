import { defineConfig } from 'vitest/config';

// Root-level and IDE discovery only — `pnpm test` iterates workspaces via
// turbo and never reads this file. Globs so a workspace registers itself
// by having a vitest config; a hand-maintained list here drifts.
export default defineConfig({
  test: {
    projects: [
      'apps/*/vitest.config.ts',
      'packages/*/vitest.config.ts',
      // Not a workspace, so no glob reaches it — but omitting it here is what
      // hides a suite from bare-root and IDE discovery.
      'scripts/vitest.config.ts',
    ],
  },
});
