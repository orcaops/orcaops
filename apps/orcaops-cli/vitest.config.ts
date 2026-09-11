import { defineConfig } from 'vitest/config';

// Test taxonomy (see TESTING.md): directory placement carries the category.
//   • Colocated module tests: `src/**/name.test.ts`, beside the module
//     they prove. Run in the `cli` project.
//   • Integration: `tests/integration/` — in-process workflows spanning
//     modules (harness-driven CLI runs, storage, test repos). Also in
//     the `cli` project, with fixture tests under `tests/fixtures/`.
//   • Smoke: `tests/smoke/` — spawn the real `bin/orcaops.js`; reserved
//     for surface that only spawn can observe (stdin pipes, exit codes
//     from the real process, human-format flush). Run in `smoke`.
//   • Packaged: `tests/packaged/` — spawn `bin/orcaops.js` and the
//     compiled Watch sidecar and drive real OS-level suspension, death
//     and concurrency against them. Run in `packaged`, single-worker,
//     because the scenarios are contention experiments whose oracle is
//     which process is blocked on which lock.
//
// `pool: 'forks'` is vitest's default but pinned explicitly so the
// in-process harness's global `process.stdout.write` patches stay safe
// within a single file (each file gets its own worker).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'cli',
          include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
          exclude: ['tests/smoke/**', 'tests/packaged/**', 'node_modules/**', 'dist/**'],
          // Workflows initialize durable Git and SQLite state; coverage and concurrent
          // CI need headroom for those filesystem operations, including fixture setup.
          testTimeout: 30_000,
          hookTimeout: 30_000,
          pool: 'forks',
          setupFiles: ['./vitest.cli-setup.ts'],
        },
      },
      {
        test: {
          name: 'smoke',
          include: ['tests/smoke/**/*.test.ts'],
          exclude: ['node_modules/**', 'dist/**'],
          setupFiles: ['./vitest.cli-setup.ts'],
          // Smoke tests spawn `bin/orcaops.js` per call, so they need a
          // generous timeout.
          testTimeout: 30_000,
          pool: 'forks',
        },
      },
      {
        test: {
          name: 'packaged',
          include: ['tests/packaged/**/*.test.ts'],
          exclude: ['node_modules/**', 'dist/**'],
          setupFiles: ['./vitest.cli-setup.ts'],
          // The scenarios drive real suspension, death and multi-process
          // contention against one disposable store each. Two of them
          // running at once would contend on the machine rather than on
          // the lock under test, so the project is pinned to one worker
          // in-config — `--maxWorkers=1` on the command line is then a
          // restatement, not the thing that makes it correct.
          maxWorkers: 1,
          minWorkers: 1,
          fileParallelism: false,
          // ceilings.testTimeoutMs. Every other fixed ceiling the
          // scenarios use lives in tests/packaged/support/ceilings.ts so
          // the boundaries report can name each one and its source.
          testTimeout: 60_000,
          hookTimeout: 60_000,
          pool: 'forks',
        },
      },
    ],
    // Coverage settings apply across both projects when invoked with
    // `vitest run --coverage`. Reporter `json-summary` is what the
    // coverage parity gate (root `test:ci`) consumes; `text` is for
    // local readers.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/commands/plan/review/test-helpers.ts'],
      // Hand-maintained minimums, checked read-only: `test:coverage` fails
      // below a floor and never rewrites this file. The numbers record the
      // measured floor at the last deliberate raise; raising them means
      // writing CLI tests, then editing this block in the same change.
      thresholds: {
        lines: 85.59,
        statements: 84.38,
        functions: 88.04,
        branches: 75.85,
      },
    },
  },
});
