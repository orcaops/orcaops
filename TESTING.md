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

## Measurements

`apps/orcaops-cli/tests/measurements/` holds tests that record numbers rather than assert them.
They live in the `cli` project and run with it, except that the recording half is gated:
`capture-latency.measurement.test.ts` does nothing without `RUN_MEASUREMENTS=1`, and says so.
Timing the machine is what it does, so run it alone, on an idle machine, and expect about five
minutes:

```bash
RUN_MEASUREMENTS=1 pnpm --filter @orcaops/cli exec vitest run --project cli \
  tests/measurements/capture-latency.measurement.test.ts
```

It writes its numbers to standard output and to a file whose path it prints. The always-on
`capture-latency.invariant.test.ts` beside it asserts the structural rule those numbers illustrate,
with no timing threshold of its own. A number recorded on one machine is that machine's; re-record
deliberately rather than editing it.

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

## User storage isolation

CLI and Watch Vitest setup files give each test file temporary history and cache
directories and remove them during teardown. CLI setup also isolates state,
configuration, global installation, and agent directories. Keep these setup files
registered for integration and smoke projects; tests must never use real user
history or clean up existing user data.

The CLI integration `makeAgent` helper checks the merged invocation environment
before running a command. History, checkout cache, pin, and execution-focus paths
must resolve beneath `os.tmpdir()`, including through symlinks. Create overrides
with `mkdtemp` and register their cleanup. This guard applies to harness calls;
tests invoking actions directly or spawning binaries must supply isolated paths
themselves. Pure path-precedence tests should pass explicit fixture homes.

`scripts/test-environment.test.mjs` runs the actual setup files in child Vitest
workers to verify per-file isolation, inherited-path replacement, and teardown.
It runs in `pnpm test:dependency-guardrails` and CI.

## Linux project-history qualification

The project-history, CLI, and Watch overhaul passed local Linux x64/glibc validation at
runtime source `11ecfedad7e4337d1a21b1494498a2f6ab3db1c1`. The qualification ran
on Fedora 43, kernel `7.0.10-101.fc43.x86_64`, Btrfs, Node 22.21.1/ABI 127,
pnpm 10.18.2, Git 2.54.0, Bun 1.4.0, and SQLite 3.53.4. Both the workspace and
`TMPDIR=/var/tmp` were on Btrfs. Tests used disposable repositories and isolated
history, configuration, cache, and home directories.

The final validation comprised:

- `TMPDIR=/var/tmp NODE_DISABLE_COMPILE_CACHE=1 ORCAOPS_DISABLE_DRAIN=1 pnpm
test --force --exclude=@orcaops/watch-data`: 38 of 38 package tasks passed.
  This included CLI 345 files/3,138 tests, core 97/1,177, storage 162/2,572,
  history converter 22/221, and review engine 67/901.
- `TMPDIR=/var/tmp pnpm --filter @orcaops/watch-data exec vitest run
--maxWorkers=1`: 9 files/69 tests passed. The split run was necessary because
  the first all-package attempt made one Watch Data sidecar test exceed its
  unchanged 60-second ceiling under cross-package load; the isolated rerun
  completed without a product or assertion failure.
- The initializer replacement regression passed 30 sequential process runs. Four
  simultaneous packaged-initialization workers passed once, followed by five
  loaded repetitions per worker: 24 loaded runs in total.
- `pnpm release:cli` passed its clean global-install checks: the installed CLI
  reported `0.2.0-rc.2`, all runtime dependencies resolved, and the installed
  Watch data sidecar answered.
- `pnpm release:watch-platforms` built all four platform packages with Bun 1.4.0.
  The Linux x64 CLI and Watch packages installed together in a clean prefix, and
  `orcaops watch --selfcheck` returned `watch selfcheck ok`.

A subsequent hosted CI run found a race in the process-test pause handshake:
`SIGCONT` could arrive after the pause announcement but before `SIGSTOP`,
leaving the child stopped. Named release files now retain early resumes and keep
each release specific to its boundary. The process suite passes 8/8, and the
early-release and replacement tests passed ten consecutive paired runs alongside
a full core run (97 files, 1,178 tests). This harness-only follow-up does not
change the runtime source or artifact hashes below. Local results do not replace
the required hosted CI gates.

Final artifact SHA-256 values:

```text
704b4ee966ad0321b9ef7d9a4d84e53a0dbcd843d19f76e245f2a5ac28b2fefb  orcaops-cli-0.2.0-rc.2.tgz
9e8377252f92efc6de419c059b1ae2d357a76b8503ac77f63aaeabeab02dbb6c  orcaops-watch-linux-x64-0.2.0-rc.2.tgz
114c60904e0e43fd5ed7e3e45654c5c19b8fca1f42c94d9e69e7f5a776fe44cf  orcaops-watch-ui
2092f663fbea516d39e81515d1c1a65b70569a5ff18e344520ce6590bd14da27  sidecar.js
6fd4292c6c5f352436cd85c9e1cb286978efa43c20ae350973f83414ced9991d  better-sqlite3 linux-x64.node
```

This qualification covers Linux x64/glibc behavior, the real Node sidecar, and
the packaged Linux x64 Watch executable. Linux ARM64 was built but not executed;
musl, Darwin execution and signing, filesystem power-loss behavior, real cloud
credentials, and opted-in external-agent tests remain unqualified. Passing this
gate does not authorize real-data conversion, cleanup, publication, merge, or
release.
