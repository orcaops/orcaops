# Testing

> Tests focused on a single module are colocated as `name.test.ts`. Tests
> spanning modules, crossing a process boundary, or touching real external
> systems live in categorized `tests/` directories owned by their workspace.
> Classification is based on the boundary under test, not the suffix or
> execution mechanism.

## Categories

**Colocated module tests** — `src/path/name.test.ts` beside
`src/path/name.ts`. The test proves one module's contract. Real filesystem
I/O against a temp dir does not disqualify colocation; what matters is that
a single production boundary is under test.

**Integration** — `<workspace>/tests/integration/`. In-process workflows
spanning multiple production modules, commands, storage layers, or internal
subsystems. Example: the CLI harness driving complete command workflows
through the program, invocation context, storage, and a temp repository.

**Smoke** — `<workspace>/tests/smoke/`. Tests that exercise the packaged
executable or process boundary: real exit codes, stdin piping,
stdout/stderr flushing, spawning `bin/orcaops.js`. A spawned process is the
point of the test, not an implementation detail. Build first — smoke tests
run the compiled `dist`/`bin` output.

**External** — `<workspace>/tests/external/`. Tests requiring a real
external tool, installed agent, network service, or credentials. They are
collected by default but self-skip unless explicitly opted in:

```bash
RUN_LLM_TESTS=1 pnpm --filter @orcaops/llm test          # real Claude/Codex agents
RUN_REAL_USAGE_TESTS=1 pnpm --filter @orcaops/llm test   # reads real ~/.codex/sessions
```

These cost money and/or need logged-in agents; never enable them casually.

**Fixtures and support** — `tests/fixtures/` holds assets and fake systems
consumed by tests (e.g. the CLI's mock OAuth server and the synthetic
evaluator `test-pack/`); a test _of_ a fixture sits beside the fixture.
`tests/support/` holds workspace-wide harness helpers (e.g. the CLI's
`test-agent.ts`). Support files must never ship in production output.
Narrow helpers used only by colocated sibling tests may stay adjacent in
`src/`, build-excluded (see `src/commands/plan/review/test-helpers.ts`).

The evaluator-pack `packs/*/runtime/*.fixture.test.ts` files are not test
infrastructure — they are colocated tests of declarative pack fixtures and
stay with the packs.

## Naming

Directory placement carries the category, so files end plainly in
`.test.ts`/`.test.tsx` — no `.e2e`/`.cli`/`.smoke` suffixes. Names state
what a thing is or does, never what produced it: no plan steps, ticket
numbers, dates, or migration labels.

## Running

```bash
pnpm test                              # all workspaces via turbo
pnpm --filter <workspace> test         # one workspace
pnpm --filter @orcaops/cli test:cli    # CLI in-process project only
pnpm --filter @orcaops/cli test:smoke  # CLI smoke project only
pnpm --filter @orcaops/cli test:coverage
pnpm typecheck:tests                   # typecheck test files, mirrors CI
```

## Adding or moving a test

A test outside `src/` is only covered if both of these see it — a green
run proves nothing about files a glob silently dropped:

1. **Vitest discovery** — the workspace `vitest.config.ts` include globs
   (`tests/**/*.test.ts` plus `src/**/*.test.ts`).
2. **`typecheck:tests`** — the workspace `tsconfig.tests.json` must include
   `tests/**/*` and set `"rootDir": "."` (the main configs use
   `rootDir: "src"`, which errors on files outside it).

A workspace with only colocated tests may instead typecheck them through
its main `tsconfig.json`; today `apps/orcaops-watch`,
`packages/diff-render`, and `packages/evaluator-pack` do this, so they
are intentionally absent from the root `typecheck:tests` task — their
tests are covered by `pnpm typecheck`.
