# CI test performance

The test job spent about an hour running shared packages and CLI coverage one after
another. The delay is mostly test execution, with additional cache inefficiencies.

## Current hosted result

[CI run 34696951104](https://github.com/orcaops/orcaops-private/actions/runs/34696951104)
passed every required job at commit `4322b29d0`. The complete workflow took
10m00s, about 36% shorter than the first parallel run's 15m35s. All eight CLI
shards ran without test or build cache hits, covering all 348 files and 3,214
tests. The real merged coverage gate passed: 89.89% lines, 88.65% statements,
92.47% functions and 80.51% branches, with unchanged floors.

| Job                            | Duration |
| ------------------------------ | -------: |
| Longest CLI shard              |    8m37s |
| Review-engine                  |    9m50s |
| Storage                        |    6m27s |
| Shared suites and Watch checks |    6m26s |
| Core                           |    4m02s |
| History conversion             |    3m03s |
| Coverage merge                 |      31s |

The longest CLI shard fell from 15m24s to 8m37s (44% shorter). Review-engine
is now the limiting job; all 901 tests passed, with 511.87 seconds inside
Vitest. Timings are observations from individual hosted runs, not a guarantee
across runner hardware. The additional parallelism uses six more runners.

## Incremental cache reuse

The root package depended on both CLI and Watch. Turbo includes the source of
root workspace dependencies, including their transitive workspace dependencies,
in its global hash. Consequently a CLI-only or core-only edit invalidated every
task, including unrelated storage and rendering work. Restoring the Actions cache
could not help when every stored task hash differed.

The root now depends on a private, dependency-free `@orcaops/dev-cli` launcher.
It preserves `pnpm exec orcaops` by entering the existing application binary in
the same Node process. Arguments, exit behavior, the runtime version check and
pnpm's working-directory behavior remain intact. The CLI still declares its own
Watch development dependency, and live companion resolution continues to find
the workspace Watch build. The launcher must not acquire application dependencies:
that would reconnect application source to Turbo's global hash.

Dry runs against the original commit in a disposable source copy and the changed
repository produced these results for `pnpm exec turbo run test --dry=json`:

| Source edit | Invalidated tasks before | Invalidated tasks after | Retained after |
| ----------- | -----------------------: | ----------------------: | -------------: |
| CLI         |                       39 |                       2 |             37 |
| Core        |                       39 |                      12 |             27 |

These counts exclude all nonexistent task nodes, including the launcher's
build/test placeholders. The global hash stays stable for both edits
after the change. Real Turbo regression fixtures use the repository's internal
dependency graph and prove that upstream edits still invalidate dependent work,
while shared root tooling edits still invalidate globally.

An actual `pnpm test --only=@orcaops/storage schema.test.ts` run passed 219 tests
across 17 files in 52.08s, with all six tasks uncached. Repeating that command
after a temporary core source edit reused all six tasks and finished in 0.25s.
This measures incremental reuse of valid test evidence; it does not reduce the
execution time of tests that genuinely need to rerun. The initial dependency-graph
change itself invalidates existing caches once. No runners or test exclusions
were added.

## Git inspection overhead

A subsequent profile of the retained-checkpoint floor test found 103 invocations
of each administrative path query: `--show-toplevel`, `--absolute-git-dir`, and
`--git-common-dir`. Those 309 Git processes took about 1.18s of its 7.05s execution.
The test also closed 421 SQLite connections; disk flushes accounted for about
0.59s in a separate instrumented run, so disk speed alone does not explain its cost.

Repository inspection now asks Git for all three paths in one invocation. Every
inspection still observes fresh paths and validates directory identities, Git
pointers and linked-worktree backlinks. Because Git separates its output with
newlines, newline-containing paths fall back to individual queries. Regression
tests cover embedded and trailing newlines in both main and linked checkout paths,
fresh revalidation, and the existing replacement and broken-backlink checks.

Three local runs before and after the change selected the same two slow tests
with one worker and unchanged assertions:

| Measurement                    | Before median | After median |
| ------------------------------ | ------------: | -----------: |
| Command wall time              |        11.26s |        9.87s |
| Retained-checkpoint floor test |         7.13s |        6.25s |
| Run identity test              |         1.83s |        1.54s |

The command was 12.4% shorter in this sample. This is a local comparison, not a
whole-CI speedup claim; the hosted result above predates this additional change.
Worker counts, test sharding, coverage gates and durable writes are unchanged.

## Measured baseline

In [successful CI run 34543783373](https://github.com/orcaops/orcaops-private/actions/runs/34543783373),
the test job took 62m18s:

| Work                           | Elapsed time |
| ------------------------------ | -----------: |
| Shared packages                |       20m34s |
| CLI tests with coverage        |       39m17s |
| Watch PTY and benchmark checks |        1m56s |
| Checkout and dependency setup  |    About 25s |

The next observed run repeated this pattern: shared packages took 19m16s and CLI
coverage took 40m39s. Storage and review-engine were the largest shared packages in
the successful run, at 319s and 446s respectively. The hosted runner executed the
shared package suites sequentially under the existing concurrency policy.

Lint, typecheck and test also saved to the same immutable Actions cache key. The
successful test job failed to reserve its cache because another job had claimed
the key. Separately, Turbo includes forwarded test arguments in build dependency
hashes: adding `--coverage` changed all 22 CLI build-dependency hashes in a dry run.
That explains repeated builds between ordinary and coverage commands. The new
workflow removes that sequential shared-to-CLI rebuild from the critical path.
The follow-up also fixes argument forwarding through a test-only environment
input, preserving the complete dependency graph.

## Local profiling

The review-engine suite passed all 901 tests with two workers in 284s. Its slowest
files were `database/runs.test.ts` (109s), `database/floor-preparation.test.ts`
(104s), and `journal.test.ts` (96s). Many pure logic files completed in milliseconds.
The heavier tests exercise real Git repositories and durable database operations.
A short worker sample showed I/O waits and SQLite schema parsing; it does not
establish a precise cost breakdown for the entire suite.

A controlled selection of 80 CLI tests passed both normally and under coverage:
102.6s versus 110.9s, about 8% overhead in that sample. The partial coverage run
correctly failed the whole-suite thresholds. These observations suggest that the
integration workload itself deserves attention; coverage overhead alone does not
explain the hour-long job. Other agents were active on the local machine, so these
times are diagnostic observations, not hosted-runner benchmarks.

## Scheduling and cache changes

- Each job and matrix entry owns a separate Turbo cache namespace and restores
  its own prior cache first.
- The shared suite saves its successful results before running Watch checks. A
  later benchmark failure still fails CI but no longer discards that test cache.
- Storage, review-engine, core and history-convert run on independent runners. The remaining shared
  suite uses exclusions so newly added workspaces remain included automatically.
- Eight independent CLI runners retain the existing two-worker coverage limit,
  fork isolation and one-worker packaged project. No test assertions or deadlines
  change.
- Shards emit [Vitest blob reports](https://vitest.dev/guide/reporters.html#blob-reporter).
  Turbo caches those reports as task outputs so a cache hit can still upload its
  evidence. Every report is required before the coverage merge.
- The merge uses the normal CLI configuration and its existing thresholds:
  85.59% lines, 84.38% statements, 88.04% functions and 75.85% branches. The shard
  configuration defers thresholds until this merge. The required `check` job
  rejects failure, cancellation or skipping of any required job.

## First patch verification

Regression tests use Vitest discovery and its real sequencer to check that all
348 CLI files form a disjoint, complete partition. Four real fixture shards merge
to full coverage; removing one produces a below-threshold failure. Separate tests
exercise every missing or empty report and all unsuccessful required-job states.

An actual CLI shard passed through the root test runner. Removing its local blob
and repeating the command restored a byte-identical report with 19/19 Turbo cache
hits in 97ms. The root guardrail suite, formatter policy tests, focused lint and
type checks, and actionlint validate the local patch.

## First hosted result

[CI run 34670405856](https://github.com/orcaops/orcaops-private/actions/runs/34670405856)
completed in 15m35s. Its longest test job took 15m24s, approximately 75% shorter
than the earlier 62m18s test job. This run started without caches in the new Turbo
namespaces.

| Job                               | Duration | Result                                         |
| --------------------------------- | -------: | ---------------------------------------------- |
| CLI shard 1                       |   13m21s | Two existing smoke-test failures               |
| CLI shard 2                       |   15m24s | Passed                                         |
| CLI shard 3                       |   12m04s | Passed                                         |
| CLI shard 4                       |   13m57s | Passed                                         |
| Storage                           |    6m17s | 2,572 tests passed                             |
| Review-engine                     |    7m59s | 901 tests passed                               |
| Remaining shared suites and Watch |    8m42s | Suites and PTY passed; memory benchmark failed |

That first run was not green. Both failures also appear in the earlier
[CI run 34573918383](https://github.com/orcaops/orcaops-private/actions/runs/34573918383):

- Two `database-review-journal.test.ts` smoke cases fail with Git's
  `pathspec '.' did not match any file(s) known to git` during worktree capture.
- Watch fails `retainedRssWithinPremiumTarget`; its other robustness and latency
  checks pass.

The failed CLI shard correctly prevented the hosted coverage merge from running.
The three successful shards uploaded their reports and saved their independent
Turbo caches. The real fixture merge and threshold rejection are verified locally;
the complete hosted merge remains blocked by the pre-existing smoke failures.
The follow-up that saves shared test results before Watch checks is locally
verified and follows this measured run.

More concurrent runners trade some additional setup work and cache storage for
shorter elapsed time. The remaining per-test optimization opportunities are
repeated integration setup, Git/database operations, and module import overhead.

## Follow-up cost profile

The next hosted run reused successful CLI shard caches in 30–37 seconds. Its
shared job passed, including Watch, but took 11m53s. CLI shard 1 still failed,
so the complete hosted coverage merge was still unverified at that point.

The first run's blob reports identify these costly CLI files:

| File                                             | Test duration |
| ------------------------------------------------ | ------------: |
| `tests/integration/checkpoint-snapshot.test.ts`  |       236.78s |
| `tests/integration/checkpoint-lifecycle.test.ts` |          169s |
| `tests/integration/seed.test.ts`                 |          167s |

The slowest shard spent 792.47 seconds in Vitest and 86 seconds beforehand
in its Turbo task graph. Its cumulative import time was 197.45 seconds;
worker times overlap and must not be added to elapsed time.

A local profile of the snapshot suite's no-change open/close case counted 89
SQLite closes, 1,183 prepares and 125 Git spawns. That is a target for deeper
production profiling, not permission to cache authority checks or relax durable
writes. The isolated case passed in approximately 3.6 seconds of test execution.

A three-file comparison using Node to load built workspace dependencies reduced
cumulative imports from 2.94 to 1.49 seconds and elapsed Vitest time from 9.57 to
8.14 seconds; test execution stayed approximately 6.47 seconds. A focused compatibility check then failed 19 tests: native ESM exports cannot
be spied on, and external modules bypass internal mocked imports. The native
loading change was removed and its full-suite experiment stopped. Enabling
dependency optimization alone made no meaningful difference in a separate probe.

Turbo dry runs also confirm that forwarded test arguments alter dependency-build
hashes. Running with `--only` removes dependency hashes entirely, so that shortcut
would allow stale test results after dependency changes and is unsuitable here.

The retained changes move test arguments into a test-task environment input, so
Turbo still hashes the complete dependency graph but reuses builds across test
options. Real fixture tasks prove that options invalidate tests only, dependency
source changes invalidate dependent builds and tests, and changing the shared
Vitest launcher invalidates tests. All 18 dependency-build hashes in the actual
CLI graph now stay identical across coverage/shard options; only the CLI test
hash changes.

CLI distribution increases to eight shards at the same per-runner worker limit.
Core (183.65 seconds) and history-convert (124.70 seconds in the follow-up run)
join storage and review-engine as independent jobs. This uses six additional
runners and preserves every suite and coverage requirement. The current hosted result above verifies the actual elapsed-time improvement.

The two failing compiled-sidecar smoke cases now create and commit a README in
their fixture before producing a review. This avoids the Linux
`git add .` pathspec failure in an entirely empty repository while retaining the same review
assertions and real Git execution.

Local verification of the retained patch: all 362 root guardrail tests and all
seven test-policy checks pass. An actual small CLI coverage shard completed
19/19 Turbo tasks in 13.31 seconds; changing to another shard reused all 18 build
tasks and completed in 2.389 seconds. Both emitted their expected blob reports.
The repaired review-journal file passes all four smoke tests. Formatting, ESLint,
CLI test typechecking, actionlint and a frozen dependency install also pass.
