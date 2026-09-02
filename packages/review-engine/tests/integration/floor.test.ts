// End-to-end floor assembly over a REAL captured fixture — the first test that
// chains temp repo → checkpoint snapshots → ArtifactStore → resolveScope's git
// path → buildFloor. Everything else in this package tests pure layers against
// hand-authored floors; this file is where the git-touching pipeline (scope
// resolution, merge-base choice, synthesized-lineage blame, fingerprint-fed
// rungs) is proven on a capture that actually happened.
//
// Determinism: commit dates are pinned via GIT_AUTHOR_DATE/GIT_COMMITTER_DATE
// so tree/commit shas are stable given content; `buildFloor` injects `now`.
// The store stamps checkpoint `closed_at` from the wall clock (not injectable),
// so `first_activity_at` is asserted by shape, and byte-stability is proven by
// building the floor TWICE from the same store and comparing bytes.

import { cp, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildDiffFingerprintManifest,
  captureCheckpointSnapshot,
  computeWindowSegments,
  diffSnapshotTrees,
  loadConfig,
  Repo,
  type WindowSegment,
} from '@orcaops/core';
import {
  COVERAGE_VERDICT,
  DISCLOSURE_CODE,
  type Floor,
  FLOOR_SCHEMA_VERSION,
  slugifyBranch,
} from '@orcaops/review-core';
import {
  ArtifactStore,
  type Config,
  CURRENT_VERSION,
  SchemaAheadError,
  UnsupportedSchemaVersionError,
} from '@orcaops/storage';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { saveBlameCache } from '../../src/blameCache.js';
import { loadCheckpointClaims } from '../../src/claimLedgerCli.js';
import { buildFloor, FLOOR_PRODUCER_VERSION } from '../../src/floor.js';
import { runGit } from '../../src/git.js';
import { runReview } from '../../src/run.js';
import { resolveScopeInputs } from '../../src/scope.js';
import { clearStickyBase, readStickyBase, writeStickyBase } from '../../src/stickyBase.js';

const BRANCH = 'feat/fixture';
const ARTIFACT = 'fixt-e2e-0001';
const NOW = '2026-03-01T00:00:00.000Z';
const PINNED_DATE = '2026-01-02T03:04:05Z';
const STEP_1 = '01HXFIX0000000000000STEP1';
const STEP_2 = '01HXFIX0000000000000STEP2';
const STEP_3 = '01HXFIX0000000000000STEP3';
const CRIT_1 = '01HXFIX0000000000000CRIT1';

const APP_BASE = [
  'export function app(): string {',
  "  const alpha = 'alpha';",
  "  const beta = 'beta';",
  "  const gamma = 'gamma';",
  "  return 'joined';",
  '}',
  '',
].join('\n');

const KEEP_BASE = [
  'export const keep1 = 1;',
  'export const keep2 = 2;',
  'export const keep3 = 3;',
  '',
].join('\n');

const APP_AFTER_CP1 = APP_BASE.replace(
  "  const alpha = 'alpha';",
  "  const alpha = 'alpha';\n  const delta = 'delta';"
);

// cp2 deletes the beta/gamma lines (pure delete-side edit inside app.ts).
const APP_AFTER_CP2 = APP_AFTER_CP1.replace("  const beta = 'beta';\n", '').replace(
  "  const gamma = 'gamma';\n",
  ''
);

const FEATURE_TS = [
  'export function greet(name: string): string {',
  '  return `hello ${name}`;',
  '}',
  '',
].join('\n');

const GAP_TS = [
  "export const gap1 = 'uncaptured-1';",
  "export const gap2 = 'uncaptured-2';",
  '',
].join('\n');

// Base file cp1 deletes a line from — the FIRST-SEGMENT deletion endpoint:
// the line's last-containing commit is the synthesized BASE commit itself
// (chain position 0), so the deleting segment is position 0's child.
const FIRST_BASE = [
  "export const first1 = 'one';",
  "export const first2 = 'two';",
  "export const first3 = 'three';",
  '',
].join('\n');
const FIRST_AFTER_CP1 = FIRST_BASE.replace("export const first2 = 'two';\n", '');

// Base file cp2 RENAMES with a line dropped — delete-side positions carry the
// OLD path for blame while the engine keys the hunk by the NEW path.
const LEGACY_BASE = [
  "export const legacyA = 'a';",
  "export const legacyB = 'b';",
  "export const legacyC = 'c';",
  "export const legacyD = 'd';",
  '',
].join('\n');
const LEGACY2_AFTER_CP2 = LEGACY_BASE.replace("export const legacyB = 'b';\n", '');

// Base file BOTH checkpoints delete from, in one contiguous hunk — cp1 drops
// m2, cp2 drops m3+m4, so the hunk carries two delete-side owned slices
// (the delete-side mixed-ownership case).
const MIX_BASE = [
  'export const m1 = 1;',
  'export const m2 = 2;',
  'export const m3 = 3;',
  'export const m4 = 4;',
  'export const m5 = 5;',
  '',
].join('\n');
const MIX_AFTER_CP1 = MIX_BASE.replace('export const m2 = 2;\n', '');
const MIX_AFTER_CP2 = MIX_AFTER_CP1.replace('export const m3 = 3;\n', '').replace(
  'export const m4 = 4;\n',
  ''
);

interface Fixture {
  repo: TempRepo;
  config: Config;
  baseSha: string;
  cp1Sha: string;
  cp2Sha: string;
  cp1CloseTree: string;
  cp2CloseTree: string;
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const res = await runGit(root, args, {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: PINNED_DATE,
      GIT_COMMITTER_DATE: PINNED_DATE,
    },
  });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.toString('utf8').trim();
}

interface CloseSpec {
  summary: string;
  files_changed: string[];
  completed_step_ids: string[];
  decisions?: {
    decision: string;
    reason: string;
    alternatives_considered?: { option: string; rejected_because: string }[];
  }[];
  uncertainty?: string[];
  done_criteria?: { criterion_id: string; evidence: string }[];
}

/**
 * Open a checkpoint with a REAL snapshot callback — the same wiring the CLI
 * supplies. Failures throw: a fixture with degraded boundaries would silently
 * test the wrong rung.
 */
async function openCp(opts: {
  store: ArtifactStore;
  repo: Repo;
  artifactId: string;
  n: number;
  declared: string[];
}): Promise<{ openTree: string }> {
  const { store, repo, artifactId, n } = opts;
  let openTree = '';
  await store.writeCheckpointOpened(
    { artifact_id: artifactId, declared_step_ids: opts.declared },
    {
      idempotencyKey: `${artifactId}-cp-${n}-open`,
      headSha: await repo.getHeadSha(),
      snapshotCallbacks: {
        captureOpenSnapshot: async ({ artifact_id, n: cpN }) => {
          const snap = await captureCheckpointSnapshot({
            repo,
            artifactId: artifact_id,
            checkpointN: cpN,
            phase: 'open',
          });
          if (!snap.ok) throw new Error(`open snapshot failed: ${snap.error_reason}`);
          openTree = snap.tree_sha;
          return {
            boundary: {
              snapshot_ref: snap.ref,
              tree_sha: snap.tree_sha,
              snapshot_commit_sha: snap.commit_sha,
              snapshot_error_reason: null,
            },
          };
        },
      },
    }
  );
  return { openTree };
}

/**
 * Close a checkpoint with real snapshot + fingerprint callbacks, INCLUDING the
 * CLI's overlap branch: when the store detects a sibling window overlap it
 * passes the boundary list, and the callback computes per-segment file-sets
 * via `computeWindowSegments` — that evidence is what the store's partition
 * turns into the persisted `window_overlap` record the floor reads.
 * `tamperManifestHash` simulates capture-time corruption for the integrity
 * cross-check: the STORED summary hash is flipped while the trees stay real,
 * so the sidecar's fresh re-derive cannot reproduce it.
 */
async function closeCp(opts: {
  store: ArtifactStore;
  repo: Repo;
  config: Config;
  artifactId: string;
  n: number;
  close: CloseSpec;
  tamperManifestHash?: boolean;
}): Promise<{ closeTree: string }> {
  const { store, repo, config, artifactId, n } = opts;
  let closeTree = '';
  await store.writeCheckpointClosed(
    {
      artifact_id: artifactId,
      n,
      summary: opts.close.summary,
      files_changed: opts.close.files_changed,
      decisions: opts.close.decisions ?? [],
      uncertainty: opts.close.uncertainty ?? [],
      done_criteria: opts.close.done_criteria ?? [],
      verification: [{ command: 'fixture verification', exit_code: 0 }],
      completed_step_ids: opts.close.completed_step_ids,
      head_sha: await repo.getHeadSha(),
    },
    {
      idempotencyKey: `${artifactId}-cp-${n}-close`,
      snapshotCallbacks: {
        captureCloseFingerprint: async ({ openCheckpoint, closeContext, overlap }) => {
          const snap = await captureCheckpointSnapshot({
            repo,
            artifactId: closeContext.artifact_id,
            checkpointN: closeContext.n,
            phase: 'close',
          });
          if (!snap.ok) throw new Error(`close snapshot failed: ${snap.error_reason}`);
          closeTree = snap.tree_sha;
          const openTreeSha = openCheckpoint.open_snapshot.tree_sha;
          if (openTreeSha === null) throw new Error('fixture invariant: open tree missing');
          const diff = await diffSnapshotTrees({
            repo,
            openTreeSha,
            closeTreeSha: snap.tree_sha,
            maxDiffBytes: config.diff_fingerprint.max_diff_bytes,
          });
          if (!diff.ok) throw new Error('fixture invariant: boundary diff failed');
          const built = await buildDiffFingerprintManifest({
            artifactId: closeContext.artifact_id,
            checkpointN: closeContext.n,
            openTreeSha,
            closeTreeSha: snap.tree_sha,
            diffBytes: diff.diff,
            truncated: diff.truncated,
            maxDiffBytes: config.diff_fingerprint.max_diff_bytes,
          });
          let segmentEvidence: WindowSegment[] | undefined;
          if (overlap !== undefined) {
            segmentEvidence = await computeWindowSegments({
              repo,
              boundaries: [
                ...overlap.boundaries,
                {
                  eventIdx: overlap.currentCloseIdx,
                  n: closeContext.n,
                  phase: 'close',
                  treeSha: snap.tree_sha,
                },
              ],
            });
          }
          const summary =
            opts.tamperManifestHash === true && built.summary.manifest_hash !== null
              ? {
                  ...built.summary,
                  manifest_hash: [...built.summary.manifest_hash].reverse().join(''),
                }
              : built.summary;
          return {
            boundary: {
              snapshot_ref: snap.ref,
              tree_sha: snap.tree_sha,
              snapshot_commit_sha: snap.commit_sha,
              snapshot_error_reason: null,
            },
            summary,
            manifest: built.manifest,
            ...(segmentEvidence !== undefined ? { segment_evidence: segmentEvidence } : {}),
          };
        },
      },
    }
  );
  return { closeTree };
}

/** Linear open → mutate → close, the main fixture's shape. */
async function capturedCheckpoint(opts: {
  store: ArtifactStore;
  repo: Repo;
  config: Config;
  n: number;
  declared: string[];
  mutate: () => Promise<void>;
  close: CloseSpec;
}): Promise<{ openTree: string; closeTree: string }> {
  const { openTree } = await openCp({
    store: opts.store,
    repo: opts.repo,
    artifactId: ARTIFACT,
    n: opts.n,
    declared: opts.declared,
  });
  await opts.mutate();
  const { closeTree } = await closeCp({
    store: opts.store,
    repo: opts.repo,
    config: opts.config,
    artifactId: ARTIFACT,
    n: opts.n,
    close: opts.close,
  });
  return { openTree, closeTree };
}

async function buildFixture(): Promise<Fixture> {
  const repo = await createTempRepo({ initialBranch: 'main' });
  const root = repo.path;

  // Base content on main, then branch. The branch point is the merge-base the
  // clean-branch scope path must find.
  const write = async (rel: string, content: string): Promise<void> => {
    const abs = path.join(root, rel);
    await writeFile(abs, content, 'utf8');
  };
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(root, 'src'), { recursive: true });
  // Mirror the CLI's managed gitignore block (ORCAOPS_BASE_GITIGNORE): the
  // volatile store subdirs are ignored, but NOT the whole `.orcaops/` — a
  // fully-gitignored store breaks snapshot capture's add-time exclude
  // pathspec (documented at snapshots.ts step 8), exactly like real installs.
  await write(
    '.gitignore',
    [
      '**/.orcaops/',
      '!/.orcaops/',
      '.orcaops/artifacts/',
      '.orcaops/cache/',
      '.orcaops/index.sqlite',
      '.orcaops/reviews/',
      '.orcaops/usage/',
      '.orcaops/install.local.json',
      '',
    ].join('\n')
  );
  await write('src/app.ts', APP_BASE);
  await write('src/keep.ts', KEEP_BASE);
  await write('src/first.ts', FIRST_BASE);
  await write('src/legacy.ts', LEGACY_BASE);
  await write('src/mix.ts', MIX_BASE);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'base content']);
  const baseSha = await git(root, ['rev-parse', 'HEAD']);
  await git(root, ['checkout', '-b', BRANCH]);

  const config = await loadConfig(root);
  const gitRepo = new Repo(root);
  const store = new ArtifactStore({ repoRoot: root, config });
  try {
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: ARTIFACT,
        branch: BRANCH,
        base_sha: baseSha,
        agent: 'claude-code',
        agent_session_id: null,
        task: 'fixture: feature module, then trim dead code',
        label: 'fixture capture',
        plan_steps: [
          {
            step_id: STEP_1,
            text: 'add the feature module',
            label: 'feature module',
            acceptance_criteria: [{ criterion_id: CRIT_1, text: 'feature.ts exists with greet()' }],
          },
          {
            step_id: STEP_2,
            text: 'trim app.ts and remove keep.ts',
            label: 'trim dead code',
            acceptance_criteria: [],
          },
          {
            step_id: STEP_3,
            text: 'wire the feature into the CLI',
            label: 'CLI wiring (unclaimed)',
            acceptance_criteria: [],
          },
        ],
        touched_scope: ['fixture'],
        non_goals: [],
        started_at: '2026-01-02T03:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        decisions: [],
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: 'plan-1' }
    );

    const cp1 = await capturedCheckpoint({
      store,
      repo: gitRepo,
      config,
      n: 1,
      declared: [STEP_1],
      mutate: async () => {
        await write('src/feature.ts', FEATURE_TS);
        await write('src/app.ts', APP_AFTER_CP1);
        await write('src/first.ts', FIRST_AFTER_CP1);
        await write('src/mix.ts', MIX_AFTER_CP1);
      },
      close: {
        summary: 'added feature module and the delta constant; dropped first2 and m2',
        files_changed: ['src/feature.ts', 'src/app.ts', 'src/first.ts', 'src/mix.ts'],
        completed_step_ids: [STEP_1],
        decisions: [
          {
            decision: 'greet() returns a template literal',
            reason: 'simplest formatting that reads well',
            alternatives_considered: [
              { option: 'string concatenation', rejected_because: 'less readable for no gain' },
            ],
          },
        ],
        uncertainty: ['greeting format may need i18n later'],
        done_criteria: [{ criterion_id: CRIT_1, evidence: 'src/feature.ts added with greet()' }],
      },
    });
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-m', 'cp1: feature module']);
    const cp1Sha = await git(root, ['rev-parse', 'HEAD']);

    // Uncaptured gap work between cp1 close and cp2 open — the lines the
    // attribution floor must call UNEXPLAINED with a gap owner.
    await write('src/gap.ts', GAP_TS);

    const cp2 = await capturedCheckpoint({
      store,
      repo: gitRepo,
      config,
      n: 2,
      declared: [STEP_2],
      mutate: async () => {
        await write('src/app.ts', APP_AFTER_CP2);
        await unlink(path.join(root, 'src/keep.ts'));
        // Rename with a dropped line — 75% similar, well over the detection bar.
        await unlink(path.join(root, 'src/legacy.ts'));
        await write('src/legacy2.ts', LEGACY2_AFTER_CP2);
        await write('src/mix.ts', MIX_AFTER_CP2);
      },
      close: {
        summary: 'trimmed beta/gamma constants, deleted keep.ts, renamed legacy.ts, dropped m3/m4',
        files_changed: [
          'src/app.ts',
          'src/keep.ts',
          'src/legacy.ts',
          'src/legacy2.ts',
          'src/mix.ts',
        ],
        completed_step_ids: [STEP_2],
        decisions: [
          {
            decision: 'delete keep.ts outright',
            reason: 'dead module with no consumers',
            alternatives_considered: [
              {
                option: 'deprecate first',
                rejected_because: 'nothing imports it; staging a removal is ceremony',
              },
            ],
          },
        ],
        uncertainty: ['keep.ts removal assumes no out-of-repo consumers'],
      },
    });
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-m', 'cp2: trim dead code']);
    const cp2Sha = await git(root, ['rev-parse', 'HEAD']);

    return {
      repo,
      config,
      baseSha,
      cp1Sha,
      cp2Sha,
      cp1CloseTree: cp1.closeTree,
      cp2CloseTree: cp2.closeTree,
    };
  } finally {
    store.close();
  }
}

let fx: Fixture;

async function copyFixtureRepo(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'orcaops-floor-mutable-'));
  const root = path.join(scratch, 'repo');
  await cp(fx.repo.path, root, { recursive: true });
  return {
    root,
    cleanup: () => rm(scratch, { recursive: true, force: true }),
  };
}

beforeAll(async () => {
  fx = await buildFixture();
}, 60_000);

afterAll(async () => {
  await fx.repo.cleanup();
});

describe('buildFloor e2e over a real capture', () => {
  it('rebuilds an older cache only when review data is explicitly authorized', async () => {
    const isolated = await copyFixtureRepo();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const stale = new ArtifactStore({ repoRoot: isolated.root, config: fx.config });
      stale.store.db
        .prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'")
        .run(String(CURRENT_VERSION - 1));
      stale.close();

      await expect(
        runReview(['review', 'data', '--branch', BRANCH], process.env, isolated.root)
      ).rejects.toBeInstanceOf(UnsupportedSchemaVersionError);
      expect(
        await runReview(
          ['review', 'data', '--branch', BRANCH, '--rebuild-cache'],
          process.env,
          isolated.root
        )
      ).toBe(0);

      const rebuilt = new ArtifactStore({ repoRoot: isolated.root, config: fx.config });
      expect(
        rebuilt.store.db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get()
      ).toEqual({ value: String(CURRENT_VERSION) });
      rebuilt.close();
    } finally {
      stdout.mockRestore();
      await isolated.cleanup();
    }
  });

  it('refuses to rebuild a cache created by a newer binary', async () => {
    const isolated = await copyFixtureRepo();
    try {
      const ahead = new ArtifactStore({ repoRoot: isolated.root, config: fx.config });
      ahead.store.db
        .prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'")
        .run(String(CURRENT_VERSION + 1));
      ahead.close();

      await expect(
        runReview(
          ['review', 'data', '--branch', BRANCH, '--rebuild-cache'],
          process.env,
          isolated.root
        )
      ).rejects.toBeInstanceOf(SchemaAheadError);
    } finally {
      await isolated.cleanup();
    }
  });

  it('reports a degraded projection when an authorized upgrade finds malformed history', async () => {
    const isolated = await copyFixtureRepo();
    const eventLog = path.join(isolated.root, '.orcaops', 'artifacts', ARTIFACT, 'events.ndjson');
    try {
      const stale = new ArtifactStore({ repoRoot: isolated.root, config: fx.config });
      stale.store.db
        .prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'")
        .run(String(CURRENT_VERSION - 1));
      stale.close();
      await writeFile(eventLog, `not-json\n${await readFile(eventLog, 'utf8')}`, 'utf8');

      await expect(
        runReview(
          ['review', 'data', '--branch', BRANCH, '--rebuild-cache'],
          process.env,
          isolated.root
        )
      ).rejects.toMatchObject({
        code: 'REVIEW_PROJECTION_INCOMPLETE',
        preparation: {
          projectionHealth: 'degraded',
          rebuild: { skipped_artifacts: 1 },
        },
      });

      const degraded = new ArtifactStore({ repoRoot: isolated.root, config: fx.config });
      expect(degraded.store.projectionHealth).toBe('degraded');
      expect(degraded.store.projectionSkippedArtifacts).toBe(1);
      degraded.close();
    } finally {
      await isolated.cleanup();
    }
  });

  it('rebuilds review data from a schema-4 worktree config', async () => {
    const isolated = await copyFixtureRepo();
    const configPath = path.join(isolated.root, '.orcaops', 'config.json');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          schema_version: 4,
          llm: { default_timeout_ms: 30_000 },
          artifacts: { path: '.orcaops/artifacts', gitignore: true },
          cache: { path: '.orcaops/cache/orcaops.db' },
          diff_fingerprint: { enabled: true, max_diff_bytes: 2_000_000 },
          review: { max_diff_bytes: 10_000_000, include_untracked: [], stub_paths: [] },
        }),
        'utf8'
      );

      await expect(loadConfig(isolated.root)).rejects.toThrow(/requires 6/);
      expect(
        await runReview(
          ['review', 'data', '--branch', BRANCH, '--json'],
          process.env,
          isolated.root
        )
      ).toBe(0);
      const floor = JSON.parse(
        await readFile(
          path.join(isolated.root, '.orcaops', 'reviews', slugifyBranch(BRANCH), 'floor.json'),
          'utf8'
        )
      ) as { schema_version: number };
      expect(floor.schema_version).toBe(FLOOR_SCHEMA_VERSION);
    } finally {
      stdout.mockRestore();
      await isolated.cleanup();
    }
  });

  it('refuses a degraded projection before review scope or claim-ledger reads', async () => {
    const isolated = await copyFixtureRepo();
    try {
      expect(
        await runReview(
          ['review', 'data', '--branch', BRANCH, '--json'],
          process.env,
          isolated.root
        )
      ).toBe(0);
      const store = new ArtifactStore({ repoRoot: isolated.root, config: fx.config });
      store.store.setProjectionHealth('degraded', { skippedArtifacts: 1 });
      store.close();

      await expect(
        resolveScopeInputs({ root: isolated.root, branch: BRANCH })
      ).rejects.toMatchObject({
        code: 'REVIEW_PROJECTION_INCOMPLETE',
        operation: 'review scope',
      });
      await expect(loadCheckpointClaims(isolated.root, BRANCH, [ARTIFACT])).rejects.toMatchObject({
        code: 'REVIEW_PROJECTION_INCOMPLETE',
        operation: 'claim ledger',
      });

      const ledgerPath = path.join(
        isolated.root,
        '.orcaops',
        'reviews',
        slugifyBranch(BRANCH),
        'ledger-v1.json'
      );
      await rm(ledgerPath, { force: true });
      expect(
        await runReview(
          ['review', 'ledger', '--branch', BRANCH, '--json'],
          process.env,
          isolated.root
        )
      ).toBe(1);
      await expect(readFile(ledgerPath, 'utf8')).rejects.toThrow();
    } finally {
      await isolated.cleanup();
    }
  });

  it('excludes and names non-ignored untracked evidence without hiding tracked review rows', async () => {
    const before = await buildFloor({ root: fx.repo.path, branch: BRANCH, now: NOW });
    const reportPath = path.join(fx.repo.path, 'local-review-report.md');
    await writeFile(reportPath, 'large local report that is not branch evidence\n');
    try {
      const result = await buildFloor({ root: fx.repo.path, branch: BRANCH, now: NOW });
      expect(Buffer.from(result.reviewDiff).toString('utf8')).not.toContain(
        'local-review-report.md'
      );
      const disclosure = result.floor.disclosure.find(
        (entry) => entry.code === DISCLOSURE_CODE.UNTRACKED_EVIDENCE_EXCLUDED
      );
      expect(disclosure?.message).toContain('local-review-report.md');
      expect(disclosure?.message).toMatch(/\d+ bytes; 1 rows/);
      expect(result.floor.coverage.summary.reviewable_rows).toBeGreaterThan(0);
      expect(result.floor.input_hash).toBe(before.floor.input_hash);
    } finally {
      await rm(reportPath, { force: true });
    }
  });

  it('includes only explicit untracked source opt-ins and discloses that evidence class', async () => {
    const sourcePath = path.join(fx.repo.path, 'intentional-untracked.ts');
    const ignoredPath = path.join(fx.repo.path, '.orcaops', 'reviews', 'generated-evidence.txt');
    const configPath = path.join(fx.repo.path, '.orcaops', 'config.json');
    let priorConfig: string | null = null;
    try {
      priorConfig = await readFile(configPath, 'utf8');
    } catch {
      priorConfig = null;
    }
    await mkdir(path.dirname(ignoredPath), { recursive: true });
    await writeFile(sourcePath, 'export const intentionalEvidence = true;\n');
    await writeFile(ignoredPath, 'generated review output\n');
    const config = await loadConfig(fx.repo.path);
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          ...config,
          review: {
            ...config.review,
            include_untracked: [
              'intentional-untracked.ts',
              '.orcaops/reviews/generated-evidence.txt',
            ],
          },
        },
        null,
        2
      )}\n`
    );
    try {
      const result = await buildFloor({ root: fx.repo.path, branch: BRANCH, now: NOW });
      expect(Buffer.from(result.reviewDiff).toString('utf8')).toContain('intentional-untracked.ts');
      const disclosure = result.floor.disclosure.find(
        (entry) => entry.code === DISCLOSURE_CODE.UNTRACKED_EVIDENCE_INCLUDED
      );
      expect(disclosure?.message).toContain('intentional-untracked.ts');
      expect(disclosure?.message).toMatch(/\d+ bytes; 1 rows/);
      const rejected = result.floor.disclosure.find(
        (entry) => entry.code === DISCLOSURE_CODE.UNTRACKED_EVIDENCE_REJECTED
      );
      expect(rejected?.message).toContain('.orcaops/reviews/generated-evidence.txt');
      expect(Buffer.from(result.reviewDiff).toString('utf8')).not.toContain(
        'generated-evidence.txt'
      );
    } finally {
      await rm(sourcePath, { force: true });
      await rm(ignoredPath, { force: true });
      if (priorConfig === null) await rm(configPath, { force: true });
      else await writeFile(configPath, priorConfig);
    }
  });

  // Sticky base: an explicit `--base` recorded via
  // `review data` is reused by a bare rebuild with a disclosure, and
  // `--base auto` clears it. The trap this prevents: a bare `review data`
  // silently re-derived against the default branch and drifted the session.
  it(
    'sticky base: an explicit --base survives a bare rebuild and clears with --base auto',
    { timeout: 10_000 },
    async () => {
      const slug = slugifyBranch(BRANCH);
      try {
        // Explicit --base through the real data command records the sticky ref.
        expect(
          await runReview(
            ['review', 'data', '--branch', BRANCH, '--base', fx.baseSha, '--json'],
            process.env,
            fx.repo.path
          )
        ).toBe(0);
        const recorded = await readStickyBase(fx.repo.path, slug);
        expect(recorded).toMatchObject({
          schema_version: 1,
          branch: BRANCH,
          baseRef: fx.baseSha,
          pinnedSha: fx.baseSha,
        });

        // A bare rebuild reuses it — same base, disclosed, never silently re-derived.
        const bare = await buildFloor({ root: fx.repo.path, branch: BRANCH, now: NOW });
        expect(bare.floor.scope.base_sha).toBe(fx.baseSha);
        const disclosure = bare.floor.disclosure.find(
          (entry) => entry.code === DISCLOSURE_CODE.STICKY_BASE_REUSED
        );
        expect(disclosure?.message).toContain(fx.baseSha);
        expect(disclosure?.message).toContain('--base auto');

        // `--base auto` clears the record and derivation returns to normal.
        expect(
          await runReview(
            ['review', 'data', '--branch', BRANCH, '--base', 'auto', '--json'],
            process.env,
            fx.repo.path
          )
        ).toBe(0);
        expect(await readStickyBase(fx.repo.path, slug)).toBeNull();
        const rederived = await buildFloor({ root: fx.repo.path, branch: BRANCH, now: NOW });
        expect(
          rederived.floor.disclosure.some(
            (entry) => entry.code === DISCLOSURE_CODE.STICKY_BASE_REUSED
          )
        ).toBe(false);
      } finally {
        await clearStickyBase(fx.repo.path, slug);
      }
    }
  );

  // A stale sticky ref (rebased away) must not hard-fail a bare rebuild — it
  // is disclosed and derivation proceeds.
  it('sticky base: an unresolvable recorded ref is disclosed and ignored', async () => {
    const slug = slugifyBranch(BRANCH);
    try {
      await writeStickyBase(fx.repo.path, slug, {
        schema_version: 1,
        branch: BRANCH,
        baseRef: 'no-such-ref-anymore',
        pinnedSha: 'deadbeef',
        recordedAt: '2026-07-17T00:00:00.000Z',
      });
      const result = await buildFloor({ root: fx.repo.path, branch: BRANCH, now: NOW });
      const disclosure = result.floor.disclosure.find(
        (entry) => entry.code === DISCLOSURE_CODE.STICKY_BASE_REUSED
      );
      expect(disclosure?.message).toContain('no longer resolves');
      // Derivation fell back to the real merge-base path.
      expect(result.floor.scope.base_sha).toBe(fx.baseSha);
    } finally {
      await clearStickyBase(fx.repo.path, slug);
    }
  });

  // The drift case the sticky mechanism EXISTS to prevent: an operator pins
  // `--base main`, then main advances. The bare rebuild must keep using the
  // sha main resolved to at record time — never silently track the moved ref —
  // and must disclose the drift.
  it('sticky base: a moved symbolic ref does not move the pinned base', async () => {
    const slug = slugifyBranch(BRANCH);
    const mainShaBefore = (await runGit(fx.repo.path, ['rev-parse', 'main'])).stdout
      .toString('utf8')
      .trim();
    try {
      expect(
        await runReview(
          ['review', 'data', '--branch', BRANCH, '--base', 'main', '--json'],
          process.env,
          fx.repo.path
        )
      ).toBe(0);
      const recorded = await readStickyBase(fx.repo.path, slug);
      expect(recorded).toMatchObject({ baseRef: 'main', pinnedSha: mainShaBefore });

      // Advance main without checking it out.
      const mainTree = (await runGit(fx.repo.path, ['rev-parse', 'main^{tree}'])).stdout
        .toString('utf8')
        .trim();
      const advanced = (
        await runGit(fx.repo.path, [
          'commit-tree',
          mainTree,
          '-p',
          'main',
          '-m',
          'advance main past the pinned base',
        ])
      ).stdout
        .toString('utf8')
        .trim();
      await runGit(fx.repo.path, ['branch', '-f', 'main', advanced]);

      const bare = await buildFloor({ root: fx.repo.path, branch: BRANCH, now: NOW });
      // Authority is the pinned sha, not the moved ref.
      expect(bare.floor.scope.base_sha).toBe(mainShaBefore);
      const disclosure = bare.floor.disclosure.find(
        (entry) => entry.code === DISCLOSURE_CODE.STICKY_BASE_REUSED
      );
      expect(disclosure?.message).toContain(mainShaBefore);
    } finally {
      await runGit(fx.repo.path, ['branch', '-f', 'main', mainShaBefore]);
      await clearStickyBase(fx.repo.path, slug);
    }
  });

  // Claim ledger over a real capture: cp1/cp2 claim completed steps but
  // record no verification commands, and gap.ts is
  // unaccounted drift — the ledger must confront both, deterministically,
  // with zero model calls, and persist its artifact.
  it(
    'scope resolution and the claim ledger fail closed on an unreadable artifact',
    { timeout: 120_000 },
    async () => {
      // Fresh fixture: this test rots the artifact, which must not leak
      // into the shared one.
      const own = await buildFixture();
      try {
        expect(
          await runReview(
            ['review', 'data', '--branch', BRANCH, '--json'],
            process.env,
            own.repo.path
          )
        ).toBe(0);

        // Rot a close line and delete its projection: the recovery-aware
        // checkpoint read refuses, and everything downstream must refuse
        // with it — a review targeting an older tree or a ledger claiming
        // zero claims would misstate the account.
        const aDir = path.join(own.repo.path, '.orcaops', 'artifacts', ARTIFACT);
        const aLog = path.join(aDir, 'events.ndjson');
        const lines = (await readFile(aLog, 'utf8')).split('\n');
        const i = lines.findIndex((l) => l.includes('"checkpoint_closed"'));
        lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
        await writeFile(aLog, lines.join('\n'), 'utf8');
        await rm(path.join(aDir, 'checkpoint-1.json'), { force: true });

        await expect(resolveScopeInputs({ root: own.repo.path, branch: BRANCH })).rejects.toThrow(
          /cannot read artifact/
        );

        expect(
          await runReview(
            ['review', 'ledger', '--branch', BRANCH, '--json'],
            process.env,
            own.repo.path
          )
        ).toBe(1);
        const ledgerPath = path.join(
          own.repo.path,
          '.orcaops',
          'reviews',
          slugifyBranch(BRANCH),
          'ledger-v1.json'
        );
        await expect(readFile(ledgerPath, 'utf8')).rejects.toThrow();
      } finally {
        await own.repo.cleanup();
      }
    }
  );

  it('review ledger confronts the real capture and persists ledger-v1.json', async () => {
    expect(
      await runReview(['review', 'data', '--branch', BRANCH, '--json'], process.env, fx.repo.path)
    ).toBe(0);
    expect(
      await runReview(['review', 'ledger', '--branch', BRANCH, '--json'], process.env, fx.repo.path)
    ).toBe(0);
    const ledgerPath = path.join(
      fx.repo.path,
      '.orcaops',
      'reviews',
      slugifyBranch(BRANCH),
      'ledger-v1.json'
    );
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      schema_version: number;
      branch: string;
      entries: Array<{ kind: string; anchors: string[]; message: string }>;
    };
    expect(ledger.schema_version).toBe(1);
    expect(ledger.branch).toBe(BRANCH);
    const kinds = new Set(ledger.entries.map((entry) => entry.kind));
    expect(kinds).not.toContain('VERIFICATION_GAP');
    // gap.ts drift: unaccounted rows are a coverage-gap entry with the file
    // anchored (no non-goals or untracked litter exist in this fixture, so
    // SCOPE_HYGIENE stays silent — correctly).
    expect(kinds).toContain('COVERAGE_GAP');
    expect(
      ledger.entries.some(
        (entry) => entry.kind === 'COVERAGE_GAP' && entry.anchors.includes('src/gap.ts')
      )
    ).toBe(true);
    // Determinism at the CLI boundary: a second run differs only in its
    // timestamp.
    expect(
      await runReview(['review', 'ledger', '--branch', BRANCH, '--json'], process.env, fx.repo.path)
    ).toBe(0);
    const second = JSON.parse(await readFile(ledgerPath, 'utf8')) as { entries: unknown };
    expect(JSON.stringify(second.entries)).toBe(JSON.stringify(ledger.entries));
  });

  // Verb-level pin for the scratchpad-cwd trap: any review verb driven from a
  // stray cwd must work via --root (central resolution before dispatch — the
  // same path every supported review verb takes).
  it('review verbs run from a stray cwd via --root', async () => {
    const stray = await mkdtemp(path.join(tmpdir(), 'orcaops-stray-verb-'));
    expect(
      await runReview(
        ['review', 'data', '--branch', BRANCH, '--root', fx.repo.path, '--json'],
        {},
        stray
      )
    ).toBe(0);
  });

  // Tracked-but-uncommitted drift: a tracked file modified after every
  // checkpoint closed, committed by nobody, claimed by no attribution window.
  // The floor must surface it as UNEXPLAINED gap rows; the ledger turns that
  // raw signal into a scope-hygiene entry. (The untracked half of the same
  // litter shape is covered by the two untracked-evidence tests above.)
  it('tracked-but-uncommitted drift surfaces as UNEXPLAINED gap rows', async () => {
    // Vitest does not cancel an async test when its timeout fires. Keep this
    // deliberate worktree mutation on a disposable copy so a late finally
    // cannot overlap the following byte-stability test on the shared fixture.
    const isolated = await copyFixtureRepo();
    const appPath = path.join(isolated.root, 'src', 'app.ts');
    const sharedAppPath = path.join(fx.repo.path, 'src', 'app.ts');
    const original = await readFile(appPath, 'utf8');
    const sharedOriginal = await readFile(sharedAppPath, 'utf8');
    const before = await buildFloor({ root: isolated.root, branch: BRANCH, now: NOW });
    try {
      await writeFile(appPath, `${original}export const litter = 'agent tooling debris';\n`);
      expect(await readFile(sharedAppPath, 'utf8')).toBe(sharedOriginal);
      // This opt-in delay lets the isolation test reproduce a runner timeout
      // whose dirty asynchronous body continues executing during teardown.
      const timeoutProbeMs = Number(process.env.ORCAOPS_FLOOR_MUTATION_TIMEOUT_PROBE_MS ?? 0);
      if (Number.isFinite(timeoutProbeMs) && timeoutProbeMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, timeoutProbeMs));
      }
      const result = await buildFloor({ root: isolated.root, branch: BRANCH, now: NOW });
      // The drift changes the floor identity — staleness is honest.
      expect(result.floor.input_hash).not.toBe(before.floor.input_hash);
      // More unexplained work than the committed gap fixture alone.
      expect(result.floor.coverage.summary.unexplained_rows).toBeGreaterThan(
        before.floor.coverage.summary.unexplained_rows
      );
      // The litter rows themselves are gap units — visible, owned by nobody.
      // (They can merge into an adjacent MATCHED parent hunk, so assert at
      // unit grain, not parent verdict.)
      const appItems = result.floor.coverage.items.filter((item) => item.file === 'src/app.ts');
      const appUnits = appItems.flatMap((item) => item.units);
      expect(appUnits.some((unit) => unit.kind !== 'owned_slice')).toBe(true);
      // And it lands in the deterministic Unassigned surface beside gap.ts.
      const gapFiles = result.floor.outline.unassigned.gap.files.map((entry) => entry.file);
      expect(gapFiles).toContain('src/app.ts');
      expect(gapFiles).toContain('src/gap.ts');
    } finally {
      await isolated.cleanup();
    }
  });

  it(
    'assembles a byte-stable floor through the clean-branch (non-degenerate merge-base) path',
    { timeout: 30_000 },
    async () => {
      const a = await buildFloor({ root: fx.repo.path, branch: BRANCH, now: NOW });
      const scopeInputs = await resolveScopeInputs({ root: fx.repo.path, branch: BRANCH });
      const b = await buildFloor({
        root: fx.repo.path,
        branch: BRANCH,
        now: NOW,
        scopeInputs,
      });

      // Byte-stable assembly: a direct build and the cache-miss path that reuses
      // its captured preamble must produce the identical installed bundle.
      expect(JSON.stringify(a.floor)).toBe(JSON.stringify(b.floor));
      expect(b.reviewDiff).toEqual(a.reviewDiff);
      expect(b.attributionLines).toEqual(a.attributionLines);
      expect(b.fingerprint).toBe(a.fingerprint);

      const floor = a.floor;

      // Scope: the REAL merge-base path — base is the branch point, target is
      // the on-branch worktree tree (== cp2 close tree; worktree is clean).
      expect(floor.scope.branch).toBe(BRANCH);
      expect(floor.scope.branch_slug).toBe(slugifyBranch(BRANCH));
      expect(floor.scope.base_sha).toBe(fx.baseSha);
      expect(floor.scope.pinned_tree_sha).toBe(fx.cp2CloseTree);
      expect(floor.scope.default_branch).toBe('main');
      expect(floor.scope.artifact_ids).toEqual([ARTIFACT]);
      expect(floor.scope.threads).toHaveLength(1);
      expect(floor.scope.threads[0].first_activity_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // No disclosures on the clean path: not degenerate, not truncated, no
      // large gaps, lineage healthy.
      expect(floor.disclosure).toEqual([]);

      // Boundary trees + manifests present on every closed cp → chain rung.
      expect(floor.attribution.active_rung).toBe('snapshot_chain');

      // Coverage ground truth per file.
      const byFile = new Map<string, (typeof floor.coverage.items)[number][]>();
      for (const item of floor.coverage.items) {
        const list = byFile.get(item.file) ?? [];
        list.push(item);
        byFile.set(item.file, list);
      }

      // Every owned slice of one parent, as `{cp, kind}` pairs (order preserved).
      const sliceOwners = (
        items: (typeof floor.coverage.items)[number][]
      ): Array<{ kind: string; cp?: number }> =>
        items[0].units.map((u) =>
          u.kind === 'owned_slice' ? { kind: u.kind, cp: u.owner.cp } : { kind: u.kind }
        );

      // cp1's new file: MATCHED — one slice, owned by cp1.
      const feature = byFile.get('src/feature.ts') ?? [];
      expect(feature).toHaveLength(1);
      expect(feature[0].verdict).toBe(COVERAGE_VERDICT.MATCHED);
      expect(sliceOwners(feature)).toEqual([{ kind: 'owned_slice', cp: 1 }]);

      // Gap work: UNEXPLAINED — one gap slice, the honest capture gap.
      const gap = byFile.get('src/gap.ts') ?? [];
      expect(gap).toHaveLength(1);
      expect(gap[0].verdict).toBe(COVERAGE_VERDICT.UNEXPLAINED);

      // app.ts: a mixed hunk — cp1 added the delta line, cp2 deleted beta and
      // gamma. Both checkpoints' runs are separate owned slices; the parent
      // rolls up MATCHED (≥1 owned slice).
      const app = byFile.get('src/app.ts') ?? [];
      expect(app).toHaveLength(1);
      expect(app[0].verdict).toBe(COVERAGE_VERDICT.MATCHED);

      // keep.ts: a PURE-DELETION hunk — delete-side blame attributes it to the
      // checkpoint that deleted it; otherwise deletion hunks have no owner at
      // all.
      const keep = byFile.get('src/keep.ts') ?? [];
      expect(keep).toHaveLength(1);
      expect(keep[0].verdict).toBe(COVERAGE_VERDICT.MATCHED);
      expect(sliceOwners(keep)).toEqual([{ kind: 'owned_slice', cp: 2 }]);

      // first.ts: the FIRST-SEGMENT deletion endpoint — first2's last-containing
      // commit is the synthesized base itself (position 0); its child is cp1.
      const first = byFile.get('src/first.ts') ?? [];
      expect(first).toHaveLength(1);
      expect(first[0].verdict).toBe(COVERAGE_VERDICT.MATCHED);
      expect(sliceOwners(first)).toEqual([{ kind: 'owned_slice', cp: 1 }]);

      // legacy.ts → legacy2.ts: rename-with-deletion. The hunk is keyed by the
      // NEW path (file_after) while blame ran on the OLD path — the
      // coverageFile threading. cp2 owns the dropped line.
      expect(byFile.has('src/legacy.ts')).toBe(false);
      const legacy2 = byFile.get('src/legacy2.ts') ?? [];
      expect(legacy2).toHaveLength(1);
      expect(legacy2[0].verdict).toBe(COVERAGE_VERDICT.MATCHED);
      expect(sliceOwners(legacy2)).toEqual([{ kind: 'owned_slice', cp: 2 }]);

      // The floor inlines NO per-line table — it lives in the NDJSON sibling
      // (asserted in the review-data chain test). Both sides still flow
      // through the BuildFloorResult for persistence.
      expect(floor.attribution).not.toHaveProperty('lines');
      expect(a.attributionLines.length).toBeGreaterThan(0);
      const sides = new Set(a.attributionLines.map((l) => l.side));
      expect(sides).toEqual(new Set(['add', 'delete']));
      // The delete-side rows land under the coverage path for renames.
      const legacyDeletes = a.attributionLines.filter(
        (l) => l.side === 'delete' && l.file === 'src/legacy2.ts'
      );
      expect(legacyDeletes).toHaveLength(1);
      expect(legacyDeletes[0].owner).toEqual({ kind: 'checkpoint', artifact: ARTIFACT, cp: 2 });

      // mix.ts rolls up like app.ts: both checkpoints' runs, parent MATCHED.
      const mix = byFile.get('src/mix.ts') ?? [];
      expect(mix).toHaveLength(1);
      expect(mix[0].verdict).toBe(COVERAGE_VERDICT.MATCHED);

      // Slice partition on the real capture: app.ts's mixed hunk carries cp1's
      // ADD run (the delta line) and cp2's DELETE run as separate owned slices;
      // mix.ts carries cp1's and cp2's delete-side runs; gap.ts is one gap
      // slice, visible in unassigned.gap.
      const ownersOf = (items: (typeof floor.coverage.items)[number][]): number[] =>
        items[0].units.flatMap((u) => (u.kind === 'owned_slice' ? [u.owner.cp] : []));
      expect(new Set(ownersOf(app))).toEqual(new Set([1, 2]));
      const appCp1 = app[0].units.find((u) => u.kind === 'owned_slice' && u.owner.cp === 1);
      expect(appCp1?.kind === 'owned_slice' && appCp1.add_range !== null).toBe(true);
      // mix.ts — cp1's DELETED m2 line is its own delete-side slice beside cp2's.
      expect(new Set(ownersOf(mix))).toEqual(new Set([1, 2]));
      const mixCp1 = mix[0].units.find((u) => u.kind === 'owned_slice' && u.owner.cp === 1);
      expect(mixCp1?.kind === 'owned_slice' ? mixCp1.del_range : null).toEqual({
        start: 2,
        end: 2,
      });
      expect(gap[0].units).toHaveLength(1);
      expect(gap[0].units[0].kind).toBe('gap_slice');
      expect(floor.outline.unassigned.gap.files.map((f) => f.file)).toEqual(['src/gap.ts']);

      // Integrity: both checkpoints re-derive to their stored manifest hashes.
      expect(floor.integrity).toEqual([
        { artifact: ARTIFACT, cp: 1, verified: true },
        { artifact: ARTIFACT, cp: 2, verified: true },
      ]);

      // Citations carry cp decisions + uncertainty; plan coverage sees crit-1.
      const citationKinds = new Set(floor.citations.map((c) => c.kind));
      expect(citationKinds.has('CHECKPOINT_DECISION')).toBe(true);
      expect(citationKinds.has('CHECKPOINT_UNCERTAINTY')).toBe(true);
      // RULED-OUT transport: each fixture decision carries one rejected
      // alternative — stable per-cp ids, verbatim option + rejection text.
      const alts = floor.citations.filter((c) => c.kind === 'CHECKPOINT_ALTERNATIVE');
      expect(alts.map((c) => c.id).sort()).toEqual([
        `cite:${ARTIFACT}:cp1:alternative:0`,
        `cite:${ARTIFACT}:cp2:alternative:0`,
      ]);
      expect(alts.find((c) => c.cp === 1)?.text).toBe(
        'string concatenation\n↳ less readable for no gain'
      );
      const step1 = floor.plan_coverage.find((s) => s.step_id === STEP_1);
      expect(step1?.claimed_by).toEqual([{ artifact: ARTIFACT, cp: 1 }]);
      const step3 = floor.plan_coverage.find((s) => s.step_id === STEP_3);
      expect(step3?.unclaimed).toBe(true);

      // Outline: one artifact, two chapters; with deletions now owned, only
      // the gap work remains unassigned.
      const chapters = floor.outline.threads.flatMap((s) => s.checkpoints);
      expect(chapters.map((c) => c.checkpoint.cp).sort()).toEqual([1, 2]);
      expect(floor.outline.unassigned.gap.sliceRefs).toHaveLength(1);
    }
  );

  it('reverse blame: surviving lines report the tip; a bogus path degrades to empty', async () => {
    const { blameFileReverse } = await import('../../src/git.js');
    const root = fx.repo.path;
    // Real branch commits (not the synthesized chain): base app.ts line 2 is
    // alpha (survives to tip → reports the range tip), line 3 is beta (last
    // contained by cp1's commit — its child cp2 is the deleter).
    const { ok, map } = await blameFileReverse(root, fx.baseSha, fx.cp2Sha, 'src/app.ts');
    expect(ok).toBe(true);
    expect(map.get(2)).toBe(fx.cp2Sha); // alpha survives — the tip-skip case
    expect(map.get(3)).toBe(fx.cp1Sha); // beta's last-containing commit
    // Silent degrade: a path git can't blame yields ok:false + empty map, not a throw.
    const bogus = await blameFileReverse(root, fx.baseSha, fx.cp2Sha, 'src/nope.ts');
    expect(bogus.ok).toBe(false);
    expect(bogus.map.size).toBe(0);
  });

  it(
    'discloses DEGENERATE_SCOPE for a foreign branch with no capture (scope.ts site)',
    { timeout: 30_000 },
    async () => {
      const res = await buildFloor({ root: fx.repo.path, branch: 'feat/ghost', now: NOW });
      const codes = res.floor.disclosure.map((d) => d.code);
      expect(codes).toContain(DISCLOSURE_CODE.DEGENERATE_SCOPE);
      expect(
        res.floor.disclosure.find((d) => d.code === DISCLOSURE_CODE.DEGENERATE_SCOPE)?.message
      ).toContain('no captured checkpoint');
    }
  );

  it(
    'whole-floor cache: serves a hit without rebuilding, misses when the marker is gone',
    { timeout: 60_000 },
    async () => {
      const scope = await import('../../src/scope.js');
      const resolveInputs = vi.spyOn(scope, 'resolveScopeInputs');
      const so = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderr: string[] = [];
      const se = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
      try {
        const env = {
          ...process.env,
          ORCAOPS_ROOT: fx.repo.path,
          ORCAOPS_REVIEW_TIMINGS: '1',
        } as NodeJS.ProcessEnv;
        const dir = path.join(fx.repo.path, '.orcaops', 'reviews', slugifyBranch(BRANCH));
        const attribution = path.join(dir, 'attribution.ndjson');
        const markerPath = path.join(dir, 'floor-cache.json');
        const ino = async (p: string): Promise<bigint> => (await stat(p, { bigint: true })).ino;

        // Force a clean miss: drop any marker a prior test installed.
        await rm(markerPath, { force: true });
        expect(await runReview(['review', 'data', '--branch', BRANCH], env)).toBe(0);
        const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
          producerVersion: string;
          floorFingerprint: string;
        };
        expect(marker.producerVersion).toBe(FLOOR_PRODUCER_VERSION);
        expect(marker.floorFingerprint).toMatch(/.+/);
        const builtIno = await ino(attribution);
        const floor1 = JSON.parse(await readFile(path.join(dir, 'floor.json'), 'utf8')) as Floor;

        // HIT: nothing changed → attribution.ndjson is NOT rewritten (a rebuild
        // renames a fresh temp over it, changing the inode); the served floor
        // matches except the refreshed live generation stamp.
        expect(await runReview(['review', 'data', '--branch', BRANCH], env)).toBe(0);
        expect(await ino(attribution)).toBe(builtIno);
        const floor2 = JSON.parse(await readFile(path.join(dir, 'floor.json'), 'utf8')) as Floor;
        expect(floor2.input_hash).toBe(floor1.input_hash);
        expect(floor2.coverage).toEqual(floor1.coverage);

        // MISS: marker gone → rebuild (new attribution inode) + marker reinstalled.
        await rm(markerPath, { force: true });
        expect(await runReview(['review', 'data', '--branch', BRANCH], env)).toBe(0);
        expect(await ino(attribution)).not.toBe(builtIno);
        expect(
          (JSON.parse(await readFile(markerPath, 'utf8')) as { producerVersion: string })
            .producerVersion
        ).toBe(FLOOR_PRODUCER_VERSION);

        const diagnostics = stderr
          .flatMap((chunk) => chunk.split('\n'))
          .filter((line) => line.startsWith('review data timing: '))
          .map(
            (line) =>
              JSON.parse(line.slice('review data timing: '.length)) as {
                schema: string;
                outcome: 'built' | 'cache_hit';
                attempts: number;
                total_ms: number;
                stages: Array<{ attempt: number; stage: string; duration_ms: number }>;
              }
          );
        expect(diagnostics).toHaveLength(3);
        expect(diagnostics.map((entry) => entry.outcome)).toEqual(['built', 'cache_hit', 'built']);
        expect(diagnostics[0]).toMatchObject({
          schema: 'orcaops.review-data-timing/v1',
          attempts: 1,
        });
        expect(diagnostics[0]!.stages.map((entry) => entry.stage)).toEqual(
          expect.arrayContaining([
            'scope_preamble',
            'cache_lookup',
            'scope_diff_manifest',
            'lineage_blame',
            'attribution',
            'outline',
            'assembly',
            'build_total',
            'recheck_install',
          ])
        );
        expect(
          diagnostics.every(
            (entry) =>
              entry.total_ms >= 0 &&
              entry.stages.every(
                (stage) => stage.attempt >= 1 && Number.isFinite(stage.duration_ms)
              )
          )
        ).toBe(true);
        // Two misses pay preamble + commit recheck; the hit pays only preamble.
        // buildFloor must not perform a third full scope-input load on either miss.
        expect(resolveInputs).toHaveBeenCalledTimes(5);
      } finally {
        resolveInputs.mockRestore();
        so.mockRestore();
        se.mockRestore();
      }
    }
  );

  it(
    'whole-floor cache: a v3/producer-10 floor rebuilds without resetting reviewer state',
    { timeout: 60_000 },
    async () => {
      const so = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        const env = { ...process.env, ORCAOPS_ROOT: fx.repo.path } as NodeJS.ProcessEnv;
        const dir = path.join(fx.repo.path, '.orcaops', 'reviews', slugifyBranch(BRANCH));
        const attribution = path.join(dir, 'attribution.ndjson');
        const floorPath = path.join(dir, 'floor.json');
        const markerPath = path.join(dir, 'floor-cache.json');
        const statePath = path.join(dir, 'review-state.json');
        const ino = async (p: string): Promise<bigint> => (await stat(p, { bigint: true })).ino;

        await rm(markerPath, { force: true });
        expect(await runReview(['review', 'data', '--branch', BRANCH], env)).toBe(0);
        const builtIno = await ino(attribution);

        // Install the exact predecessor pair. The cache marker misses before
        // the v3 floor can be served, then the current producer rebuilds it.
        const m = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
        const v3 = JSON.parse(await readFile(floorPath, 'utf8')) as Record<string, unknown>;
        v3.schema_version = 3;
        (v3.attribution as Record<string, unknown>).lines = [];
        await writeFile(floorPath, JSON.stringify(v3), 'utf8');
        await writeFile(markerPath, JSON.stringify({ ...m, producerVersion: '10' }), 'utf8');
        const reviewerStateBefore = await readFile(statePath, 'utf8');
        expect(await runReview(['review', 'data', '--branch', BRANCH], env)).toBe(0);
        expect(await ino(attribution)).not.toBe(builtIno);
        const rebuilt = JSON.parse(await readFile(floorPath, 'utf8')) as Record<string, unknown>;
        expect(rebuilt.schema_version).toBe(FLOOR_SCHEMA_VERSION);
        expect(rebuilt.attribution).not.toHaveProperty('lines');
        expect(
          (JSON.parse(await readFile(markerPath, 'utf8')) as { producerVersion: string })
            .producerVersion
        ).toBe(FLOOR_PRODUCER_VERSION);
        expect(await readFile(statePath, 'utf8')).toBe(reviewerStateBefore);
      } finally {
        so.mockRestore();
      }
    }
  );

  it(
    'blame cache: a warm rebuild is byte-identical to a cold build (equivalence)',
    { timeout: 60_000 },
    async () => {
      const cacheDir = await mkdtemp(path.join(tmpdir(), 'orcaops-blame-eq-'));
      try {
        // Cold: empty cache → every changed file is blamed from scratch.
        const cold = await buildFloor({
          root: fx.repo.path,
          branch: BRANCH,
          now: NOW,
          blameCacheDir: cacheDir,
        });
        expect(cold.nextBlameCache).not.toBeNull();
        await saveBlameCache(cacheDir, cold.nextBlameCache!, cacheDir);

        // Warm: same inputs, populated cache → stable-path files reuse cached
        // blame, rename-involved files recompute. The floor MUST be byte-identical.
        const warm = await buildFloor({
          root: fx.repo.path,
          branch: BRANCH,
          now: NOW,
          blameCacheDir: cacheDir,
        });
        expect(JSON.stringify(warm.floor)).toBe(JSON.stringify(cold.floor));
        expect(warm.attributionLines).toEqual(cold.attributionLines);
      } finally {
        await rm(cacheDir, { recursive: true, force: true });
      }
    }
  );

  it(
    'blame cache: a warm rebuild reuses cached blame instead of re-running git blame',
    { timeout: 60_000 },
    async () => {
      const git = await import('../../src/git.js');
      const cacheDir = await mkdtemp(path.join(tmpdir(), 'orcaops-blame-reuse-'));
      try {
        // Cold build under a spy: count every real blame invocation.
        const fwdCold = vi.spyOn(git, 'blameFile');
        const revCold = vi.spyOn(git, 'blameFileReverse');
        const cold = await buildFloor({
          root: fx.repo.path,
          branch: BRANCH,
          now: NOW,
          blameCacheDir: cacheDir,
        });
        const coldCalls = fwdCold.mock.calls.length + revCold.mock.calls.length;
        fwdCold.mockRestore();
        revCold.mockRestore();
        await saveBlameCache(cacheDir, cold.nextBlameCache!, cacheDir);

        // Warm build: only rename/copy-involved files (the fixture renames
        // legacy.ts) recompute; every stable-path file is served from cache, so
        // the blame count drops strictly.
        const fwdWarm = vi.spyOn(git, 'blameFile');
        const revWarm = vi.spyOn(git, 'blameFileReverse');
        await buildFloor({
          root: fx.repo.path,
          branch: BRANCH,
          now: NOW,
          blameCacheDir: cacheDir,
        });
        const warmCalls = fwdWarm.mock.calls.length + revWarm.mock.calls.length;
        fwdWarm.mockRestore();
        revWarm.mockRestore();

        expect(coldCalls).toBeGreaterThan(0);
        expect(warmCalls).toBeLessThan(coldCalls);
      } finally {
        await rm(cacheDir, { recursive: true, force: true });
      }
    }
  );

  it(
    'blame cache: a failed blame is never cached and marks the build degraded',
    { timeout: 60_000 },
    async () => {
      const git = await import('../../src/git.js');
      const cacheDir = await mkdtemp(path.join(tmpdir(), 'orcaops-blame-fail-'));
      const fwd = vi
        .spyOn(git, 'blameFile')
        .mockResolvedValue({ ok: false, map: new Map<number, string>() });
      const rev = vi
        .spyOn(git, 'blameFileReverse')
        .mockResolvedValue({ ok: false, map: new Map<number, string>() });
      try {
        const res = await buildFloor({
          root: fx.repo.path,
          branch: BRANCH,
          now: NOW,
          blameCacheDir: cacheDir,
        });
        // A transient blame failure must NOT poison the cache with empty results,
        // and it marks the build non-cacheable at the whole-floor level.
        expect(res.cacheHealth.blameFailed).toBe(true);
        expect(res.nextBlameCache).not.toBeNull();
        expect(res.nextBlameCache!.size).toBe(0);
      } finally {
        fwd.mockRestore();
        rev.mockRestore();
        await rm(cacheDir, { recursive: true, force: true });
      }
    }
  );

  it(
    'whole-floor cache: a built-fingerprint drift retries instead of installing stale',
    { timeout: 60_000 },
    async () => {
      const floor = await import('../../src/floor.js');
      const scope = await import('../../src/scope.js');
      const so = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const dir = path.join(fx.repo.path, '.orcaops', 'reviews', slugifyBranch(BRANCH));
      await rm(path.join(dir, 'floor-cache.json'), { force: true });

      // Real fingerprinting throughout. run.ts's pre-build + recheck read the true
      // (A) inputs via resolveScopeInputs, but we make buildFloor's resolved scope
      // report a fingerprint-affecting drift on the FIRST build. This retains the
      // defensive invariant even though normal builds consume preamble A.
      // reviewMaxDiffBytes is a fingerprint input but NOT a floor field, so a +1
      // tweak shifts the built fingerprint without perturbing assembly or the
      // schema. (It also leaves the collected diff identical at this size, so the
      // drift is purely in the fingerprint — exactly what this test wants.)
      const originalResolveScope = scope.resolveScope;
      let buildScopeCall = 0;
      const scopeSpy = vi.spyOn(scope, 'resolveScope').mockImplementation(async (opts) => {
        buildScopeCall += 1;
        const real = await originalResolveScope(opts);
        return buildScopeCall === 1
          ? { ...real, reviewMaxDiffBytes: real.reviewMaxDiffBytes + 1 }
          : real;
      });
      const build = vi.spyOn(floor, 'buildFloor');
      try {
        const env = { ...process.env, ORCAOPS_ROOT: fx.repo.path } as NodeJS.ProcessEnv;
        expect(await runReview(['review', 'data', '--branch', BRANCH], env)).toBe(0);
        // The recheck (A) ≠ the first build's fingerprint (B) → that build is
        // discarded and a second, clean build runs. A recheck against the
        // pre-build fingerprint (also A) would instead install on
        // attempt 1 — a single build pairing an A marker with the stale B floor.
        expect(build).toHaveBeenCalledTimes(2);
      } finally {
        scopeSpy.mockRestore();
        build.mockRestore();
        so.mockRestore();
      }
    }
  );

  it(
    'whole-floor cache: a blame-cache write failure does not abort review data',
    { timeout: 60_000 },
    async () => {
      const blameCache = await import('../../src/blameCache.js');
      const so = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const save = vi
        .spyOn(blameCache, 'saveBlameCache')
        .mockRejectedValue(new Error('simulated disk-full'));
      try {
        const env = { ...process.env, ORCAOPS_ROOT: fx.repo.path } as NodeJS.ProcessEnv;
        const dir = path.join(fx.repo.path, '.orcaops', 'reviews', slugifyBranch(BRANCH));
        await rm(path.join(dir, 'floor-cache.json'), { force: true });

        // The optional blame-cache write throws, but the floor bundle is the real
        // output: review data still succeeds and installs floor.json + the marker.
        // (An un-caught throw here would abort review data after a partial install.)
        expect(await runReview(['review', 'data', '--branch', BRANCH], env)).toBe(0);
        expect(save).toHaveBeenCalled();
        await expect(stat(path.join(dir, 'floor.json'))).resolves.toBeDefined();
        await expect(stat(path.join(dir, 'floor-cache.json'))).resolves.toBeDefined();
      } finally {
        save.mockRestore();
        so.mockRestore();
      }
    }
  );

  it(
    'whole-floor cache: concurrent review data installs one consistent bundle',
    { timeout: 60_000 },
    async () => {
      const so = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        const env = { ...process.env, ORCAOPS_ROOT: fx.repo.path } as NodeJS.ProcessEnv;
        const dir = path.join(fx.repo.path, '.orcaops', 'reviews', slugifyBranch(BRANCH));
        await rm(path.join(dir, 'floor-cache.json'), { force: true });

        // Two racers: both miss, both build OUTSIDE the lock, then the short
        // commit lock serializes the install — the loser rechecks the marker and
        // reuses the winner's generation. Neither returns a torn bundle.
        const [a, b] = await Promise.all([
          runReview(['review', 'data', '--branch', BRANCH], env),
          runReview(['review', 'data', '--branch', BRANCH], env),
        ]);
        expect(a).toBe(0);
        expect(b).toBe(0);

        // One consistent generation is installed: the marker is present with the
        // current producer version, floor.json parses, and the diff sibling exists.
        const marker = JSON.parse(await readFile(path.join(dir, 'floor-cache.json'), 'utf8')) as {
          producerVersion: string;
          floorFingerprint: string;
        };
        expect(marker.producerVersion).toBe(FLOOR_PRODUCER_VERSION);
        const floor = JSON.parse(await readFile(path.join(dir, 'floor.json'), 'utf8')) as Floor;
        expect(floor.scope.branch).toBe(BRANCH);
        await expect(stat(path.join(dir, 'diff.patch'))).resolves.toBeDefined();
      } finally {
        so.mockRestore();
      }
    }
  );

  it(
    'whole-floor cache: a degraded build (blame failure) serves but writes no marker',
    { timeout: 60_000 },
    async () => {
      const git = await import('../../src/git.js');
      const so = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const fwd = vi
        .spyOn(git, 'blameFile')
        .mockResolvedValue({ ok: false, map: new Map<number, string>() });
      const rev = vi
        .spyOn(git, 'blameFileReverse')
        .mockResolvedValue({ ok: false, map: new Map<number, string>() });
      try {
        const env = { ...process.env, ORCAOPS_ROOT: fx.repo.path } as NodeJS.ProcessEnv;
        const dir = path.join(fx.repo.path, '.orcaops', 'reviews', slugifyBranch(BRANCH));
        await rm(path.join(dir, 'floor-cache.json'), { force: true });

        // Every blame fails → the floor is still built + served (honesty), but the
        // health gate blocks the marker, so the next run retries instead of
        // serving the degraded floor forever.
        expect(await runReview(['review', 'data', '--branch', BRANCH], env)).toBe(0);
        await expect(stat(path.join(dir, 'floor.json'))).resolves.toBeDefined();
        await expect(stat(path.join(dir, 'floor-cache.json'))).rejects.toThrow();
      } finally {
        fwd.mockRestore();
        rev.mockRestore();
        so.mockRestore();
      }
    }
  );

  it(
    'whole-floor cache: concurrent hits refresh consistently under the lock',
    { timeout: 60_000 },
    async () => {
      const so = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        const env = { ...process.env, ORCAOPS_ROOT: fx.repo.path } as NodeJS.ProcessEnv;
        const dir = path.join(fx.repo.path, '.orcaops', 'reviews', slugifyBranch(BRANCH));
        // Warm the cache so both racers HIT rather than build.
        await rm(path.join(dir, 'floor-cache.json'), { force: true });
        expect(await runReview(['review', 'data', '--branch', BRANCH], env)).toBe(0);

        // Two concurrent hits both rewrite floor.json (the head_sha/generated_at
        // refresh) under the same per-slug lock, so the serialized rewrites never
        // tear the file. (The full paused-mid-refresh interleave is enforced
        // structurally — the refresh runs inside the held lock — not simulated.)
        const [a, b] = await Promise.all([
          runReview(['review', 'data', '--branch', BRANCH], env),
          runReview(['review', 'data', '--branch', BRANCH], env),
        ]);
        expect(a).toBe(0);
        expect(b).toBe(0);
        const floor = JSON.parse(await readFile(path.join(dir, 'floor.json'), 'utf8')) as Floor;
        expect(floor.scope.branch).toBe(BRANCH);
        const marker = JSON.parse(await readFile(path.join(dir, 'floor-cache.json'), 'utf8')) as {
          producerVersion: string;
        };
        expect(marker.producerVersion).toBe(FLOOR_PRODUCER_VERSION);
      } finally {
        so.mockRestore();
      }
    }
  );

  it(
    'feeds integrity + overlap: tampered manifest discloses, concurrent-window files drift',
    { timeout: 60_000 },
    async () => {
      // A second, self-contained fixture: two checkpoints with OVERLAPPING
      // windows both editing shared.ts inside the concurrent segment, plus a
      // tampered stored manifest hash on cp1. The close callbacks supply real
      // segment evidence (computeWindowSegments), so the store's partition
      // persists window_overlap — which is what the floor reads.
      const OVL = 'ovlp-e2e-0001';
      const SA = '01HXOVL0000000000000STEPA';
      const SB = '01HXOVL0000000000000STEPB';
      const SC = '01HXOVL0000000000000STEPC';
      const BR = 'feat/overlap';
      const repo2 = await createTempRepo({ initialBranch: 'main' });
      const root = repo2.path;
      try {
        const w = (rel: string, c: string) => writeFile(path.join(root, rel), c, 'utf8');
        const { mkdir } = await import('node:fs/promises');
        await mkdir(path.join(root, 'src'), { recursive: true });
        await w(
          '.gitignore',
          '.orcaops/artifacts/\n.orcaops/cache/\n.orcaops/reviews/\n.orcaops/usage/\n'
        );
        const SHARED = ['export const s1 = 1;', 'export const s2 = 2;', ''].join('\n');
        await w('src/shared.ts', SHARED);
        await git(root, ['add', '-A']);
        await git(root, ['commit', '-m', 'base']);
        await git(root, ['checkout', '-b', BR]);

        const config = await loadConfig(root);
        const gitRepo = new Repo(root);
        const store = new ArtifactStore({ repoRoot: root, config });
        try {
          await store.writePlan(
            {
              schema_version: 4,
              artifact_id: OVL,
              branch: BR,
              base_sha: await git(root, ['rev-parse', 'HEAD']),
              agent: 'claude-code',
              agent_session_id: null,
              task: 'overlap fixture: two concurrent checkpoints share a file',
              label: 'overlap fixture',
              plan_steps: [
                {
                  step_id: SA,
                  text: 'edit shared from agent A',
                  label: 'agent A edit',
                  acceptance_criteria: [],
                },
                {
                  step_id: SB,
                  text: 'edit shared from agent B',
                  label: 'agent B edit',
                  acceptance_criteria: [],
                },
                {
                  step_id: SC,
                  text: 'follow-up tweak (tampered capture)',
                  label: 'tampered cp',
                  acceptance_criteria: [],
                },
              ],
              touched_scope: ['fixture'],
              non_goals: [],
              started_at: '2026-01-02T04:00:00.000Z',
              revision_n: 0,
              revised_at: null,
              rationale: null,
              decisions: [],
              step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
              criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
              prior_plan_event_id: null,
            },
            { idempotencyKey: 'ovlp-plan' }
          );

          // Both windows open BEFORE either edit: every change below lands in
          // the concurrent segment.
          await openCp({ store, repo: gitRepo, artifactId: OVL, n: 1, declared: [SA] });
          await openCp({ store, repo: gitRepo, artifactId: OVL, n: 2, declared: [SB] });
          await w('src/shared.ts', `${SHARED}export const fromA = 'a';\n`);
          await w('src/only1.ts', 'export const only1 = 1;\n');
          await w(
            'src/shared.ts',
            `${SHARED}export const fromA = 'a';\nexport const fromB = 'b';\n`
          );
          await w('src/only2.ts', 'export const only2 = 2;\n');
          await closeCp({
            store,
            repo: gitRepo,
            config,
            artifactId: OVL,
            n: 1,
            close: {
              summary: 'agent A: shared + only1',
              files_changed: ['src/shared.ts', 'src/only1.ts'],
              completed_step_ids: [SA],
            },
          });
          await closeCp({
            store,
            repo: gitRepo,
            config,
            artifactId: OVL,
            n: 2,
            close: {
              summary: 'agent B: shared + only2',
              files_changed: ['src/shared.ts', 'src/only2.ts'],
              completed_step_ids: [SB],
            },
          });

          // A THIRD, non-overlapping checkpoint carries the tamper: an
          // overlap-partitioned close re-hashes its filtered manifest in the
          // store (repairing any callback tamper), but a linear close persists
          // the callback's summary verbatim — capture-time corruption the
          // fresh re-derive must expose.
          await openCp({ store, repo: gitRepo, artifactId: OVL, n: 3, declared: [SC] });
          await w('src/only3.ts', 'export const only3 = 3;\n');
          await closeCp({
            store,
            repo: gitRepo,
            config,
            artifactId: OVL,
            n: 3,
            tamperManifestHash: true,
            close: {
              summary: 'follow-up tweak with a corrupted stored fingerprint',
              files_changed: ['src/only3.ts'],
              completed_step_ids: [SC],
            },
          });

          const res = await buildFloor({ root, branch: BR, now: NOW });
          const floor = res.floor;

          // Integrity: the two overlap-partitioned cps re-derive clean (the
          // replay reproduces their FILTERED stored manifests); cp3's stored
          // hash was tampered at capture, so its fresh re-derive exposes it.
          expect(floor.integrity).toEqual([
            { artifact: OVL, cp: 1, verified: true },
            { artifact: OVL, cp: 2, verified: true },
            { artifact: OVL, cp: 3, verified: false },
          ]);
          const mismatch = floor.disclosure.find(
            (d) => d.code === DISCLOSURE_CODE.INTEGRITY_MISMATCH
          );
          expect(mismatch).toBeDefined();
          expect(mismatch?.artifact).toBe(OVL);
          expect(mismatch?.cp).toBe(3);

          // Overlap: shared.ts was claimed by both cps inside the concurrent
          // segment — the persisted window_overlap flags it, the floor
          // downgrades it to hunk grain and discloses.
          const overlapDisc = floor.disclosure.find(
            (d) => d.code === DISCLOSURE_CODE.OVERLAP_DOWNGRADE
          );
          expect(overlapDisc).toBeDefined();
          expect(overlapDisc?.message).toContain('src/shared.ts');
          const sharedItems = floor.coverage.items.filter((i) => i.file === 'src/shared.ts');
          expect(sharedItems.length).toBeGreaterThanOrEqual(1);
          // Downgraded to hunk grain: one whole-hunk ambiguous unit per hunk,
          // never owner-sliced — so the parents roll up UNEXPLAINED.
          for (const item of sharedItems) {
            expect(item.verdict).toBe(COVERAGE_VERDICT.UNEXPLAINED);
            expect(item.units.map((u) => u.kind)).toEqual(['ambiguous_hunk']);
          }
          expect(floor.outline.unassigned.ambiguous.hunkKeys).toEqual(
            sharedItems.map((i) => i.hunkKey)
          );
        } finally {
          store.close();
        }
      } finally {
        await repo2.cleanup();
      }
    }
  );

  it(
    'VERIFIES a truncated checkpoint under a changed cap — re-derives from the cap the manifest recorded',
    { timeout: 60_000 },
    async () => {
      // A self-contained fixture with ONE closed checkpoint whose STORED
      // fingerprint was captured under a TINY max_diff_bytes (256): its manifest
      // hash is taken over a truncated prefix, so it is cap-dependent. The
      // ArtifactStore + buildFloor run under the NORMAL 2MB cap.
      //
      // Re-deriving under the live config's 2MB cap would hash the FULL diff and
      // read the difference as tampering. Skipping the comparison to avoid that
      // false mismatch would buy it with a hole: a truncated checkpoint would
      // never be integrity-checked at all.
      //
      // The engine instead re-derives from the cap the MANIFEST RECORDED
      // (limits.max_diff_bytes = 256) rather than the cap the config currently
      // holds. Same trees + same cap ⇒ the same truncated byte prefix ⇒ the same
      // hash. So the comparison is not merely safe to run, it PASSES — no hole,
      // and the cap is free to move without touching stored identity.
      const TRUNC = 'trunc-e2e-0001';
      const TS1 = '01HXTRN0000000000000STEP1';
      const BR = 'feat/trunc';
      const repo2 = await createTempRepo({ initialBranch: 'main' });
      const root = repo2.path;
      try {
        const w = (rel: string, c: string) => writeFile(path.join(root, rel), c, 'utf8');
        const { mkdir } = await import('node:fs/promises');
        await mkdir(path.join(root, 'src'), { recursive: true });
        await w(
          '.gitignore',
          '.orcaops/artifacts/\n.orcaops/cache/\n.orcaops/reviews/\n.orcaops/usage/\n'
        );
        await w('src/seed.ts', 'export const seed = 0;\n');
        await git(root, ['add', '-A']);
        await git(root, ['commit', '-m', 'base']);
        await git(root, ['checkout', '-b', BR]);

        // loadConfig + the store stay on the NORMAL cap (2MB) — buildFloor
        // re-derives under THIS cap, a different one than capture used.
        const config = await loadConfig(root);
        const gitRepo = new Repo(root);
        const store = new ArtifactStore({ repoRoot: root, config });
        try {
          await store.writePlan(
            {
              schema_version: 4,
              artifact_id: TRUNC,
              branch: BR,
              base_sha: await git(root, ['rev-parse', 'HEAD']),
              agent: 'claude-code',
              agent_session_id: null,
              task: 'truncation-boundary fixture: a large diff fingerprinted under a tiny cap',
              label: 'truncation fixture',
              plan_steps: [
                {
                  step_id: TS1,
                  text: 'add a big module',
                  label: 'big module',
                  acceptance_criteria: [],
                },
              ],
              touched_scope: ['fixture'],
              non_goals: [],
              started_at: '2026-01-02T05:00:00.000Z',
              revision_n: 0,
              revised_at: null,
              rationale: null,
              decisions: [],
              step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
              criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
              prior_plan_event_id: null,
            },
            { idempotencyKey: 'trunc-plan' }
          );

          // The STORED fingerprint truncates: closeCp builds its manifest with
          // THIS config's cap, so a clone with a tiny max_diff_bytes makes the
          // stored manifest hash a prefix hash (summary.truncated === true).
          const tinyConfig: Config = {
            ...config,
            diff_fingerprint: { ...config.diff_fingerprint, max_diff_bytes: 256 },
          };

          await openCp({ store, repo: gitRepo, artifactId: TRUNC, n: 1, declared: [TS1] });
          // ~100 lines ⇒ a few-KB diff: comfortably over the 256B tiny cap (the
          // STORED hash truncates) yet far under the 2MB normal cap (the
          // re-derive does NOT truncate) — exactly the boundary the fix guards.
          const big = `${Array.from({ length: 100 }, (_, i) => `export const big${i} = ${i};`).join('\n')}\n`;
          await w('src/big.ts', big);
          await closeCp({
            store,
            repo: gitRepo,
            config: tinyConfig,
            artifactId: TRUNC,
            n: 1,
            close: {
              summary: 'added a big module fingerprinted under a tiny cap',
              files_changed: ['src/big.ts'],
              completed_step_ids: [TS1],
            },
          });

          // Precondition: the STORED fingerprint really truncated under the tiny
          // cap. If the diff ever shrinks below the cap this catches the fixture
          // rotting into a no-op (a passing test that proves nothing).
          const storedCps = await store.readCheckpointsRecovered(TRUNC);
          const storedCp1 = storedCps.find((c) => c.n === 1);
          expect(storedCp1?.status).toBe('closed');
          if (storedCp1?.status === 'closed') {
            expect(storedCp1.diff_fingerprint_summary.truncated).toBe(true);
            expect(storedCp1.diff_fingerprint_summary.manifest_hash).not.toBeNull();
          }

          const res = await buildFloor({ root, branch: BR, now: NOW });
          const floor = res.floor;

          // Still no false mismatch — that was never negotiable…
          expect(
            floor.disclosure.find((d) => d.code === DISCLOSURE_CODE.INTEGRITY_MISMATCH)
          ).toBeUndefined();
          // …and nothing is disclosed as uncheckable: the manifest loaded and its
          // recorded inputs were reproducible.
          expect(
            floor.disclosure.find((d) => d.code === DISCLOSURE_CODE.INTEGRITY_UNAVAILABLE)
          ).toBeUndefined();

          // The real gain: the cp is no longer DROPPED from integrity. It is present
          // and it VERIFIED — re-derived under the manifest's own recorded 256B cap,
          // reproducing the identical truncated prefix and hash, even though the live
          // config says 2MB. Under the old skip-based behavior this list was empty.
          const entry = floor.integrity.find((e) => e.cp === 1);
          expect(entry).toBeDefined();
          expect(entry?.verified).toBe(true);
        } finally {
          store.close();
        }
      } finally {
        await repo2.cleanup();
      }
    }
  );

  it(
    'raising diff_fingerprint.max_diff_bytes does NOT falsely flag an UNTRUNCATED checkpoint',
    { timeout: 60_000 },
    async () => {
      // The headline of the cap split, as a regression test.
      //
      // The capture-time cap is not merely a limit — it is DATA inside the manifest
      // (`limits.max_diff_bytes`) and `computeDiffFingerprintManifestHash` hashes the
      // whole manifest. So the hash moves when the cap moves, for a diff that never
      // came close to truncating.
      //
      // The two guards that predate this change (`if (cp.manifestTruncated)` and
      // `if (diff.truncated)`) both check TRUNCATION, and neither fires here — the
      // diff is tiny. So the old engine re-derived under the LIVE cap, produced a
      // manifest whose `limits` said 4MB against a stored one that said 2MB, and
      // reported INTEGRITY_MISMATCH: an accusation of content drift, aimed at a repo
      // whose only crime was editing a config value.
      //
      // That latent trap is why the review cap had to be split out before it could
      // ever be raised. The engine now re-derives from the manifest's OWN recorded
      // cap, so the live value is irrelevant and the checkpoint verifies.
      const CAPC = 'capchg-e2e-001';
      const CS1 = '01HXCAP0000000000000STEP1';
      const BR = 'feat/capchange';
      const repo2 = await createTempRepo({ initialBranch: 'main' });
      const root = repo2.path;
      try {
        const w = (rel: string, c: string) => writeFile(path.join(root, rel), c, 'utf8');
        const { mkdir } = await import('node:fs/promises');
        await mkdir(path.join(root, 'src'), { recursive: true });
        await w(
          '.gitignore',
          '.orcaops/artifacts/\n.orcaops/cache/\n.orcaops/reviews/\n.orcaops/usage/\n'
        );
        await w('src/seed.ts', 'export const seed = 0;\n');
        await git(root, ['add', '-A']);
        await git(root, ['commit', '-m', 'base']);
        await git(root, ['checkout', '-b', BR]);

        // Capture under the DEFAULT 2MB cap. The diff is a few hundred bytes, so it
        // does not truncate — the old truncation guards are both inert here.
        const config = await loadConfig(root);
        const gitRepo = new Repo(root);
        const store = new ArtifactStore({ repoRoot: root, config });
        try {
          await store.writePlan(
            {
              schema_version: 4,
              artifact_id: CAPC,
              branch: BR,
              base_sha: await git(root, ['rev-parse', 'HEAD']),
              agent: 'claude-code',
              agent_session_id: null,
              task: 'cap-change fixture: an untruncated capture under a cap that later moves',
              label: 'cap change fixture',
              plan_steps: [
                {
                  step_id: CS1,
                  text: 'add a small module',
                  label: 'small module',
                  acceptance_criteria: [],
                },
              ],
              touched_scope: ['fixture'],
              non_goals: [],
              started_at: '2026-01-02T05:00:00.000Z',
              revision_n: 0,
              revised_at: null,
              rationale: null,
              decisions: [],
              step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
              criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
              prior_plan_event_id: null,
            },
            { idempotencyKey: 'capchg-plan' }
          );

          await openCp({ store, repo: gitRepo, artifactId: CAPC, n: 1, declared: [CS1] });
          await w('src/small.ts', 'export const small = 1;\nexport const smaller = 2;\n');
          await closeCp({
            store,
            repo: gitRepo,
            config, // the 2MB default
            artifactId: CAPC,
            n: 1,
            close: {
              summary: 'added a small module under the default cap',
              files_changed: ['src/small.ts'],
              completed_step_ids: [CS1],
            },
          });

          // Precondition: this capture did NOT truncate. If it ever did, the old
          // truncation guards would mask the bug and this test would prove nothing.
          const storedCps = await store.readCheckpointsRecovered(CAPC);
          const storedCp1 = storedCps.find((c) => c.n === 1);
          expect(storedCp1?.status).toBe('closed');
          if (storedCp1?.status === 'closed') {
            expect(storedCp1.diff_fingerprint_summary.truncated).toBe(false);
            expect(storedCp1.diff_fingerprint_summary.manifest_hash).not.toBeNull();
          }
        } finally {
          store.close();
        }

        // Now the user raises the CAPTURE cap.
        await mkdir(path.join(root, '.orcaops'), { recursive: true });
        await w(
          '.orcaops/config.json',
          `${JSON.stringify({ schema_version: 5, diff_fingerprint: { enabled: true, max_diff_bytes: 4_000_000 } }, null, 2)}\n`
        );
        expect((await loadConfig(root)).diff_fingerprint.max_diff_bytes).toBe(4_000_000);

        const floor = (await buildFloor({ root, branch: BR, now: NOW })).floor;

        // No accusation of drift. Nothing changed but a config number.
        expect(
          floor.disclosure.find((d) => d.code === DISCLOSURE_CODE.INTEGRITY_MISMATCH)
        ).toBeUndefined();
        // And not quietly swept under "cannot check", either — it genuinely verified.
        expect(
          floor.disclosure.find((d) => d.code === DISCLOSURE_CODE.INTEGRITY_UNAVAILABLE)
        ).toBeUndefined();
        const entry = floor.integrity.find((e) => e.cp === 1);
        expect(entry).toBeDefined();
        expect(entry?.verified).toBe(true);
      } finally {
        await repo2.cleanup();
      }
    }
  );

  it(
    'delete-side blame follows a two-hop rename (A→B→C) to the deleting checkpoint',
    { timeout: 60_000 },
    async () => {
      // Reverse blame must chase the deleted `beta` line across BOTH renames —
      // src/hop.ts (base) → src/hop2.ts (cp1) → src/hop3.ts (cp2) — to land the
      // deletion on cp2, the checkpoint that dropped it. The intermediate paths
      // vanish from coverage; the hunk keys under the final path, and the one
      // delete-side attribution row is owned by cp2.
      const HOP = 'hop-e2e-0001';
      const H1 = '01HXHOP0000000000000STEP1';
      const H2 = '01HXHOP0000000000000STEP2';
      const BR = 'feat/hop';
      const repo2 = await createTempRepo({ initialBranch: 'main' });
      const root = repo2.path;
      try {
        const w = (rel: string, c: string) => writeFile(path.join(root, rel), c, 'utf8');
        const { mkdir } = await import('node:fs/promises');
        await mkdir(path.join(root, 'src'), { recursive: true });
        await w(
          '.gitignore',
          '.orcaops/artifacts/\n.orcaops/cache/\n.orcaops/reviews/\n.orcaops/usage/\n'
        );
        const HOP_BASE = [
          'export const alpha = 1;',
          'export const beta = 2;',
          'export const gamma = 3;',
          '',
        ].join('\n');
        await w('src/hop.ts', HOP_BASE);
        await git(root, ['add', '-A']);
        await git(root, ['commit', '-m', 'base']);
        await git(root, ['checkout', '-b', BR]);

        const config = await loadConfig(root);
        const gitRepo = new Repo(root);
        const store = new ArtifactStore({ repoRoot: root, config });
        try {
          await store.writePlan(
            {
              schema_version: 4,
              artifact_id: HOP,
              branch: BR,
              base_sha: await git(root, ['rev-parse', 'HEAD']),
              agent: 'claude-code',
              agent_session_id: null,
              task: 'two-hop rename fixture: rename twice, dropping a line on the last hop',
              label: 'two-hop rename fixture',
              plan_steps: [
                {
                  step_id: H1,
                  text: 'first rename hop.ts → hop2.ts',
                  label: 'rename 1',
                  acceptance_criteria: [],
                },
                {
                  step_id: H2,
                  text: 'second rename hop2.ts → hop3.ts, drop beta',
                  label: 'rename 2 + delete',
                  acceptance_criteria: [],
                },
              ],
              touched_scope: ['fixture'],
              non_goals: [],
              started_at: '2026-01-02T06:00:00.000Z',
              revision_n: 0,
              revised_at: null,
              rationale: null,
              decisions: [],
              step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
              criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
              prior_plan_event_id: null,
            },
            { idempotencyKey: 'hop-plan' }
          );

          // cp1: first rename, content otherwise unchanged (100% similar).
          await openCp({ store, repo: gitRepo, artifactId: HOP, n: 1, declared: [H1] });
          await git(root, ['mv', 'src/hop.ts', 'src/hop2.ts']);
          await closeCp({
            store,
            repo: gitRepo,
            config,
            artifactId: HOP,
            n: 1,
            close: {
              summary: 'rename hop.ts → hop2.ts',
              files_changed: ['src/hop.ts', 'src/hop2.ts'],
              completed_step_ids: [H1],
            },
          });
          await git(root, ['add', '-A']);
          await git(root, ['commit', '-m', 'cp1: first rename']);

          // cp2: second rename AND drop the beta line (alpha + gamma survive).
          await openCp({ store, repo: gitRepo, artifactId: HOP, n: 2, declared: [H2] });
          await git(root, ['mv', 'src/hop2.ts', 'src/hop3.ts']);
          await w(
            'src/hop3.ts',
            ['export const alpha = 1;', 'export const gamma = 3;', ''].join('\n')
          );
          await closeCp({
            store,
            repo: gitRepo,
            config,
            artifactId: HOP,
            n: 2,
            close: {
              summary: 'rename hop2.ts → hop3.ts and drop beta',
              files_changed: ['src/hop2.ts', 'src/hop3.ts'],
              completed_step_ids: [H2],
            },
          });
          await git(root, ['add', '-A']);
          await git(root, ['commit', '-m', 'cp2: second rename + delete']);

          const res = await buildFloor({ root, branch: BR, now: NOW });
          const floor = res.floor;

          const byFile = new Map<string, (typeof floor.coverage.items)[number][]>();
          for (const item of floor.coverage.items) {
            const list = byFile.get(item.file) ?? [];
            list.push(item);
            byFile.set(item.file, list);
          }
          // The intermediate paths are gone; the hunk keys under the FINAL path.
          expect(byFile.has('src/hop.ts')).toBe(false);
          expect(byFile.has('src/hop2.ts')).toBe(false);
          const hop3 = byFile.get('src/hop3.ts') ?? [];
          expect(hop3.length).toBeGreaterThanOrEqual(1);

          // Reverse blame chased hop.ts → hop2.ts → hop3.ts: the ONE deleted
          // line (beta) is attributed to cp2, the checkpoint that deleted it.
          const hop3Deletes = res.attributionLines.filter(
            (l) => l.side === 'delete' && l.file === 'src/hop3.ts'
          );
          expect(hop3Deletes).toHaveLength(1);
          expect(hop3Deletes[0].owner).toEqual({ kind: 'checkpoint', artifact: HOP, cp: 2 });
        } finally {
          store.close();
        }
      } finally {
        await repo2.cleanup();
      }
    }
  );

  it(
    'layered fixture: per-line attribution is complete while the outline projection drops layered work',
    { timeout: 60_000 },
    async () => {
      // The slice-native regression anchor. Three checkpoints layer edits onto
      // files earlier checkpoints created (all new on the branch → each file is
      // ONE whole-file hunk in the base→tip diff), plus one uncaptured changed
      // row inside an existing hunk region. Per-line attribution truth:
      //   cp1 owns rows in a/b/c (3 files), cp2 in a/b/c/d (4), cp3 in a/d (2),
      //   and the gap owns exactly one row inside a.ts.
      // The slice-native outline pins exactly that: every chapter lists the
      // files its checkpoint owns rows in (3/4/2), and the gap row is visible
      // in unassigned.gap — what no parent-grain projection could show.
      const LAYER = 'layr-e2e-0001';
      const L1 = '01HXLAY0000000000000STEP1';
      const L2 = '01HXLAY0000000000000STEP2';
      const L3 = '01HXLAY0000000000000STEP3';
      const BR = 'feat/layered';
      const seq = (prefix: string, from: number, to: number): string[] =>
        Array.from(
          { length: to - from + 1 },
          (_, i) => `export const ${prefix}${String(from + i).padStart(2, '0')} = ${from + i};`
        );
      const body = (lines: string[]): string => `${lines.join('\n')}\n`;

      const A_CP1 = body(seq('a', 1, 20));
      const A_CP2 = body([...seq('a', 1, 10), ...seq('x', 1, 25), ...seq('a', 11, 20)]);
      const A_GAP = A_CP2.replace('export const a05 = 5;', 'export const a05 = 505;');
      const A_CP3 = A_GAP.replace(
        'export const x10 = 10;',
        'export const x10 = 1010;\nexport const x10b = 1011;'
      );
      const B_CP1 = body(seq('b', 1, 10));
      const B_CP2 = body([...seq('b', 1, 5), ...seq('y', 1, 15), ...seq('b', 6, 10)]);
      const C_CP1 = body(seq('c', 1, 10));
      const C_CP2 = body([...seq('c', 1, 5), ...seq('z', 1, 3), ...seq('c', 6, 10)]);
      const D_CP2 = body(seq('d', 1, 15));
      const D_CP3 = D_CP2.replace(
        'export const d10 = 10;',
        'export const d10 = 1010;\nexport const d10b = 1011;'
      );

      const repo2 = await createTempRepo({ initialBranch: 'main' });
      const root = repo2.path;
      try {
        const w = (rel: string, c: string) => writeFile(path.join(root, rel), c, 'utf8');
        const { mkdir } = await import('node:fs/promises');
        await mkdir(path.join(root, 'src'), { recursive: true });
        await w(
          '.gitignore',
          '.orcaops/artifacts/\n.orcaops/cache/\n.orcaops/reviews/\n.orcaops/usage/\n'
        );
        await w('src/readme.md', 'layered fixture base\n');
        await git(root, ['add', '-A']);
        await git(root, ['commit', '-m', 'base']);
        await git(root, ['checkout', '-b', BR]);

        const config = await loadConfig(root);
        const gitRepo = new Repo(root);
        const store = new ArtifactStore({ repoRoot: root, config });
        try {
          await store.writePlan(
            {
              schema_version: 4,
              artifact_id: LAYER,
              branch: BR,
              base_sha: await git(root, ['rev-parse', 'HEAD']),
              agent: 'claude-code',
              agent_session_id: null,
              task: 'layered fixture: three checkpoints layering edits on shared files',
              label: 'layered fixture',
              plan_steps: [
                { step_id: L1, text: 'scaffold a/b/c', label: 'scaffold', acceptance_criteria: [] },
                {
                  step_id: L2,
                  text: 'extend a/b/c, add d',
                  label: 'extend',
                  acceptance_criteria: [],
                },
                {
                  step_id: L3,
                  text: 'surgical tweaks to a and d',
                  label: 'tweaks',
                  acceptance_criteria: [],
                },
              ],
              touched_scope: ['fixture'],
              non_goals: [],
              started_at: '2026-01-02T05:00:00.000Z',
              revision_n: 0,
              revised_at: null,
              rationale: null,
              decisions: [],
              step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
              criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
              prior_plan_event_id: null,
            },
            { idempotencyKey: 'layr-plan' }
          );

          const cpAndCommit = async (
            n: number,
            declared: string[],
            mutate: () => Promise<void>,
            summary: string,
            files: string[]
          ): Promise<void> => {
            await openCp({ store, repo: gitRepo, artifactId: LAYER, n, declared });
            await mutate();
            await closeCp({
              store,
              repo: gitRepo,
              config,
              artifactId: LAYER,
              n,
              close: { summary, files_changed: files, completed_step_ids: declared },
            });
            await git(root, ['add', '-A']);
            await git(root, ['commit', '-m', `cp${n}`]);
          };

          await cpAndCommit(
            1,
            [L1],
            async () => {
              await w('src/a.ts', A_CP1);
              await w('src/b.ts', B_CP1);
              await w('src/c.ts', C_CP1);
            },
            'scaffolded a/b/c',
            ['src/a.ts', 'src/b.ts', 'src/c.ts']
          );
          await cpAndCommit(
            2,
            [L2],
            async () => {
              await w('src/a.ts', A_CP2);
              await w('src/b.ts', B_CP2);
              await w('src/c.ts', C_CP2);
              await w('src/d.ts', D_CP2);
            },
            'extended a/b/c, added d',
            ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']
          );
          // Uncaptured changed row INSIDE the a.ts hunk region — between cp2
          // close and cp3 open, so it lands in a gap segment.
          await w('src/a.ts', A_GAP);
          await cpAndCommit(
            3,
            [L3],
            async () => {
              await w('src/a.ts', A_CP3);
              await w('src/d.ts', D_CP3);
            },
            'surgical tweaks to a and d',
            ['src/a.ts', 'src/d.ts']
          );

          const a = await buildFloor({ root, branch: BR, now: NOW });
          const b = await buildFloor({ root, branch: BR, now: NOW });
          // Byte-stable double build; parent hunkKeys deterministic.
          expect(JSON.stringify(a.floor)).toBe(JSON.stringify(b.floor));
          expect(a.floor.coverage.items.map((i) => i.hunkKey)).toEqual(
            b.floor.coverage.items.map((i) => i.hunkKey)
          );
          const floor = a.floor;

          // ---- Per-line attribution TRUTH (add side; all files are new). ----
          const filesOwnedBy = (cp: number): string[] => {
            const files = new Set<string>();
            for (const l of a.attributionLines) {
              if (l.owner.kind === 'checkpoint' && l.owner.cp === cp) files.add(l.file);
            }
            return [...files].sort();
          };
          expect(filesOwnedBy(1)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
          expect(filesOwnedBy(2)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
          expect(filesOwnedBy(3)).toEqual(['src/a.ts', 'src/d.ts']);

          // The uncaptured row is a CHANGED row with a gap owner — present in
          // the per-line table (context rows never appear there), at the exact
          // replaced position (line 5 of the final a.ts).
          const gapRows = a.attributionLines.filter(
            (l) => l.owner.kind === 'gap' && l.file === 'src/a.ts'
          );
          expect(gapRows).toHaveLength(1);
          expect(gapRows[0].side).toBe('add');
          expect(gapRows[0].line).toBe(5);

          // ---- The slice-native outline projection: every checkpoint's ----
          // chapter lists exactly the files it owns rows in, and the gap row
          // inside the cp2-dominated a.ts hunk is visible in unassigned.gap.
          const byKey = new Map(floor.coverage.items.map((i) => [i.hunkKey, i.file]));
          const chapterFiles = (cp: number): string[] => {
            const sub = floor.outline.threads
              .flatMap((s) => s.checkpoints)
              .find((c) => c.checkpoint.cp === cp);
            const files = new Set<string>();
            for (const ref of sub?.sliceRefs ?? []) {
              const file = byKey.get(ref.hunkKey);
              if (file !== undefined) files.add(file);
            }
            return [...files].sort();
          };
          expect(chapterFiles(1)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
          expect(chapterFiles(2)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
          expect(chapterFiles(3)).toEqual(['src/a.ts', 'src/d.ts']);
          const gapFiles = floor.outline.unassigned.gap.sliceRefs.map((r) => byKey.get(r.hunkKey));
          expect(gapFiles).toEqual(['src/a.ts']);
          expect(floor.outline.unassigned.gap.files).toEqual([
            { file: 'src/a.ts', slice_count: 1, added_rows: 1, removed_rows: 0 },
          ]);
          expect(floor.outline.unassigned.ambiguous.hunkKeys).toEqual([]);
          // Every reviewable changed row lands in exactly one unit.
          for (const item of floor.coverage.items) {
            const unitRows = item.units.reduce((n, u) => n + u.lines, 0);
            expect(unitRows).toBe(item.added_lines + item.removed_lines);
          }
        } finally {
          store.close();
        }
      } finally {
        await repo2.cleanup();
      }
    }
  );

  // LAST: mutates repo state (merges the branch) to reach chooseBase's
  // degenerate site — the merged-branch path.
  it(
    'discloses DEGENERATE_SCOPE once the branch is merged (chooseBase site)',
    { timeout: 30_000 },
    async () => {
      const root = fx.repo.path;
      await git(root, ['checkout', 'main']);
      await git(root, ['merge', '--no-ff', BRANCH, '-m', 'merge fixture branch']);

      const res = await buildFloor({ root, branch: BRANCH, now: NOW });
      const codes = res.floor.disclosure.map((d) => d.code);
      expect(codes).toContain(DISCLOSURE_CODE.DEGENERATE_SCOPE);
      // Off-branch with a captured close: the target pins to cp2's close tree.
      expect(res.floor.scope.pinned_tree_sha).toBe(fx.cp2CloseTree);
    }
  );
});
