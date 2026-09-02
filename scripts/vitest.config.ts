import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The repo-root guardrail scripts are not a workspace, so `pnpm test` (turbo
// over workspaces) never reaches them. They run via `pnpm test:dependency-guardrails`
// against this config, and register with root/IDE discovery through the
// projects list in ../vitest.config.ts.
//
// `root` is pinned to this directory because the two entry points disagree
// otherwise: `--config scripts/vitest.config.ts` resolves globs against the
// caller's cwd (the repo root), while loading it as a project resolves them
// against the config's own directory.
export default defineConfig({
  test: {
    name: 'dependency-guardrails',
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['*.test.mjs'],
  },
});
