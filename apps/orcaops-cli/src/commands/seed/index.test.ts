import { afterEach, describe, expect, it } from 'vitest';

import { Repo } from '@orcaops/core';
import type { ArtifactOrigin, Checkpoint } from '@orcaops/storage';
import { createHistoryRepo, type HistoryRepo } from '@orcaops/test-harness';

import {
  buildSeedJobLedger,
  collectArtifactCoverage,
  expandCoveredRanges,
  hasGitBackfillCommand,
  importSupersedesArea,
  partialCloneWarning,
  PRE_LEDGER_JOB_ID,
  renderSeedResult,
  seedJobKind,
  type SeedJobLedgerSource,
  shouldShowCommitGraphHint,
} from './index.js';

describe('hasGitBackfillCommand', () => {
  it('detects the subcommand listing without inferring support from the Git version', () => {
    expect(hasGitBackfillCommand('   backfill     Download missing objects\n')).toBe(true);
    expect(hasGitBackfillCommand('git version 2.55.0\n')).toBe(false);
  });
});

describe('partialCloneWarning', () => {
  it('recommends the detected backfill subcommand with its correct introduction version', () => {
    expect(partialCloneWarning(true)).toContain(
      '`git backfill` is available to download missing objects (introduced in Git 2.49).'
    );
  });

  it('recommends a plain full fetch when the backfill subcommand is absent', () => {
    expect(partialCloneWarning(false)).toContain(
      '`git backfill` is unavailable; use a plain full fetch to download missing objects.'
    );
  });
});

describe('shouldShowCommitGraphHint', () => {
  const largeHistory = { suggestCommitGraph: true };

  it('shows the hint once on a full run and records nothing for small histories', () => {
    expect(shouldShowCommitGraphHint(largeHistory, {}, {})).toBe(true);
    expect(shouldShowCommitGraphHint({ suggestCommitGraph: false }, {}, {})).toBe(false);
  });

  it('never nags on targeted runs or after the journal recorded it', () => {
    expect(shouldShowCommitGraphHint(largeHistory, { commit: 'abc1234' }, {})).toBe(false);
    expect(shouldShowCommitGraphHint(largeHistory, { path: 'src' }, {})).toBe(false);
    expect(shouldShowCommitGraphHint(largeHistory, {}, { commit_graph_hint_shown: true })).toBe(
      false
    );
  });
});

function closedCheckpoint(fields: { head_sha: string; open_head_sha?: string }): Checkpoint {
  return { status: 'closed', ...fields } as unknown as Checkpoint;
}

describe('collectArtifactCoverage', () => {
  it('covers only the close head for a closed checkpoint without a recorded open head', () => {
    const covered = new Set<string>();
    const ranges = new Map<string, { base: string; head: string }>();
    collectArtifactCoverage([closedCheckpoint({ head_sha: 'close-head' })], null, covered, ranges);
    expect([...covered]).toEqual(['close-head']);
    expect(ranges.size).toBe(0);
  });

  it('queues an open-to-close range when the open head is recorded', () => {
    const covered = new Set<string>();
    const ranges = new Map<string, { base: string; head: string }>();
    collectArtifactCoverage(
      [closedCheckpoint({ head_sha: 'close-head', open_head_sha: 'open-head' })],
      null,
      covered,
      ranges
    );
    expect([...ranges.values()]).toEqual([{ base: 'open-head', head: 'close-head' }]);
  });
});

describe('expandCoveredRanges', () => {
  let history: HistoryRepo | null = null;

  afterEach(async () => {
    await history?.cleanup();
    history = null;
  });

  async function divergedHistory(): Promise<HistoryRepo> {
    history = await createHistoryRepo([
      { type: 'commit', label: 'root', subject: 'feat: root', files: { 'root.ts': 'root\n' } },
      { type: 'branch', name: 'feature', from: 'root' },
      { type: 'commit', label: 'old1', subject: 'feat: old1', files: { 'old1.ts': 'old1\n' } },
      { type: 'commit', label: 'old2', subject: 'feat: old2', files: { 'old2.ts': 'old2\n' } },
      { type: 'checkout', branch: 'feature' },
      { type: 'commit', label: 'stray', subject: 'feat: stray', files: { 'stray.ts': 'stray\n' } },
    ]);
    return history;
  }

  it('covers the commits between an open head and its descendant close head', async () => {
    const { path, shas } = await divergedHistory();
    const covered = new Set<string>();
    await expandCoveredRanges(new Repo(path), [{ base: shas.root!, head: shas.old2! }], covered);
    expect(covered).toEqual(new Set([shas.old1, shas.old2]));
  });

  it('leaves unrelated history uncovered when the open head is not an ancestor of the close head', async () => {
    const { path, shas } = await divergedHistory();
    const covered = new Set<string>();
    // stray..old2 rev-lists old1 and old2 — history this checkpoint never
    // touched. The guard must keep both uncovered so their clusters import.
    await expandCoveredRanges(new Repo(path), [{ base: shas.stray!, head: shas.old2! }], covered);
    expect(covered.size).toBe(0);
  });

  it('leaves unrelated history uncovered when the open head is missing from the repository', async () => {
    const { path, shas } = await divergedHistory();
    const covered = new Set<string>();
    await expandCoveredRanges(
      new Repo(path),
      [{ base: 'f'.repeat(40), head: shas.old2! }],
      covered
    );
    expect(covered.size).toBe(0);
  });
});

describe('importSupersedesArea', () => {
  // One cluster, selected for `.github`, carrying a commit that also edited
  // the docs and types trees.
  const written = ['.github/workflows/ci.yml', 'docs/Style-Guide.md', 'types/index.d.ts'];

  it('supersedes every area an untargeted run wrote', () => {
    expect(importSupersedesArea('docs', written, {})).toBe(true);
    expect(importSupersedesArea('.github', written, {})).toBe(true);
    expect(importSupersedesArea('src', written, {})).toBe(false);
  });

  it('supersedes only the areas overlapping the targeted path', () => {
    expect(importSupersedesArea('.github', written, { path: '.github' })).toBe(true);
    // Files the `.github` cluster carried incidentally: the user never aimed
    // the import at these areas, so their suppression stands.
    expect(importSupersedesArea('docs', written, { path: '.github' })).toBe(false);
    expect(importSupersedesArea('types', written, { path: '.github' })).toBe(false);
  });

  it('supersedes an area nested either side of the targeted path', () => {
    expect(importSupersedesArea('docs', written, { path: 'docs/Reference' })).toBe(true);
    expect(
      importSupersedesArea('docs/Reference', ['docs/Reference/api.md'], { path: 'docs' })
    ).toBe(true);
    // Siblings share a prefix without overlapping. Both sides must be written
    // for this to exercise the path comparison rather than the written guard.
    expect(
      importSupersedesArea('docs', ['docs/guide.md', 'docs-site/index.md'], { path: 'docs-site' })
    ).toBe(false);
    expect(
      importSupersedesArea('docs-site', ['docs/guide.md', 'docs-site/index.md'], { path: 'docs' })
    ).toBe(false);
  });

  it('supersedes nothing when the targeted area had no files written', () => {
    // Every cluster for the target was already imported, so the run wrote
    // nothing; the decline stands until an import actually lands.
    expect(importSupersedesArea('docs', [], { path: 'docs' })).toBe(false);
  });

  it('treats an empty flag value as the untargeted run it actually imports', () => {
    // An unset shell variable reaching `--path "$DIR"` selects every cluster,
    // so the clear must not silently take the targeted lane.
    expect(importSupersedesArea('docs', written, { path: '' })).toBe(true);
    expect(importSupersedesArea('docs', written, { commit: '' })).toBe(true);
  });

  it('normalizes both sides before comparing them', () => {
    expect(importSupersedesArea('./docs/', written, { path: './docs/' })).toBe(true);
  });

  it('treats a root-normalized target as the whole-repo import it runs', () => {
    // git reads the pathspec, and `-- .` is every file, so this selects the
    // same clusters a bare run does and must clear the same suppressions.
    expect(importSupersedesArea('docs', written, { path: '.' })).toBe(true);
    expect(importSupersedesArea('.github', written, { path: './' })).toBe(true);
  });

  it('supersedes the root area from files with no directory component', () => {
    const rootWritten = ['README.md', 'docs/guide.md'];
    expect(importSupersedesArea('.', rootWritten, {})).toBe(true);
    expect(importSupersedesArea('.', rootWritten, { path: '.' })).toBe(true);
    // A run aimed at docs carried a root file only incidentally.
    expect(importSupersedesArea('.', rootWritten, { path: 'docs' })).toBe(false);
    // No root-level file written, so nothing supersedes the root area.
    expect(importSupersedesArea('.', ['docs/guide.md'], {})).toBe(false);
  });

  it('supersedes nothing for a single-commit import', () => {
    expect(importSupersedesArea('docs', written, { commit: 'abc1234' })).toBe(false);
  });
});

describe('seedJobKind', () => {
  const fresh = { clusters: {} };

  it('names the lane a scoped flag selected', () => {
    expect(seedJobKind({ commit: 'abc' }, fresh)).toBe('commit');
    expect(seedJobKind({ path: 'src' }, fresh)).toBe('path');
    expect(seedJobKind({ importance: true }, fresh)).toBe('importance');
    // A scoped flag wins over prior-apply evidence — the lane is what it says.
    expect(seedJobKind({ commit: 'abc' }, { clusters: { a: { status: 'complete' } } })).toBe(
      'commit'
    );
  });

  it('calls the first plain apply initial and any later one a resume', () => {
    expect(seedJobKind({}, fresh)).toBe('initial');
    // Legacy journals (written before previews stopped persisting) can
    // carry pending/covered entries; neither is evidence of an apply.
    expect(
      seedJobKind({}, { clusters: { a: { status: 'pending' }, b: { status: 'covered' } } })
    ).toBe('initial');
    for (const status of ['complete', 'writing', 'failed']) {
      expect(seedJobKind({}, { clusters: { a: { status } } })).toBe('resume');
    }
    expect(seedJobKind({}, { clusters: {}, jobs: { 'job-1': {} } })).toBe('resume');
  });
});

describe('buildSeedJobLedger', () => {
  const origin = (
    importedAt: string,
    job?: { job_id: string; kind: 'initial' | 'commit' },
    enrichedAt: string | null = null
  ): ArtifactOrigin => ({
    kind: 'git-import',
    imported_at: importedAt,
    tool_version: '0.0.5',
    source_range: 'main~1..main',
    authors: ['dev@example.com'],
    enriched_at: enrichedAt,
    ...(job ? { job } : {}),
  });

  const source = (
    rows: Array<{ id: string; origin_kind?: string | null; origin?: ArtifactOrigin }>
  ): SeedJobLedgerSource => ({
    listArtifacts: () => rows.map(({ id, origin_kind }) => ({ id, origin_kind })),
    readPlan: async (artifactId) => {
      const row = rows.find((candidate) => candidate.id === artifactId);
      return row?.origin ? { origin: row.origin } : null;
    },
  });

  it('groups by job, counts enrichment, and buckets imports written before the ledger', async () => {
    const ledger = await buildSeedJobLedger(
      source([
        {
          id: 'a',
          origin_kind: 'git-import',
          origin: origin('2026-02-01T00:00:00.000Z', { job_id: 'job-1', kind: 'initial' }),
        },
        {
          id: 'b',
          origin_kind: 'git-import',
          origin: origin(
            '2026-02-01T01:00:00.000Z',
            { job_id: 'job-1', kind: 'initial' },
            '2026-02-01T02:00:00.000Z'
          ),
        },
        {
          id: 'c',
          origin_kind: 'git-import',
          origin: origin('2026-03-01T00:00:00.000Z', { job_id: 'job-2', kind: 'commit' }),
        },
        { id: 'd', origin_kind: 'git-import', origin: origin('2026-01-01T00:00:00.000Z') },
        { id: 'e', origin_kind: null },
      ]),
      {}
    );

    expect(ledger).toEqual([
      {
        job_id: PRE_LEDGER_JOB_ID,
        kind: null,
        artifacts: 1,
        enriched: 0,
        first_imported_at: '2026-01-01T00:00:00.000Z',
        last_imported_at: '2026-01-01T00:00:00.000Z',
      },
      {
        job_id: 'job-1',
        kind: 'initial',
        artifacts: 2,
        enriched: 1,
        first_imported_at: '2026-02-01T00:00:00.000Z',
        last_imported_at: '2026-02-01T01:00:00.000Z',
      },
      {
        job_id: 'job-2',
        kind: 'commit',
        artifacts: 1,
        enriched: 0,
        first_imported_at: '2026-03-01T00:00:00.000Z',
        last_imported_at: '2026-03-01T00:00:00.000Z',
      },
    ]);
  });

  it('merges journal run extras when the cache still has them', async () => {
    const rows = [
      {
        id: 'a',
        origin_kind: 'git-import',
        origin: origin('2026-02-01T00:00:00.000Z', { job_id: 'job-1', kind: 'initial' }),
      },
    ];
    const withExtras = await buildSeedJobLedger(source(rows), {
      'job-1': {
        kind: 'initial',
        started_at: '2026-02-01T00:00:00.000Z',
        wall_time_ms: 1234,
        budget: { max_commits: 500, selected_commits: 12 },
        skipped_covered: 3,
        skips: [{ cluster_key: 'run:abc', reason: 'covered-by-captured-work' }],
      },
      // Extras for a job whose artifacts are gone add no row of their own.
      'job-9': { kind: 'commit', started_at: '2026-02-02T00:00:00.000Z' },
    });
    expect(withExtras).toHaveLength(1);
    expect(withExtras[0]).toMatchObject({
      wall_time_ms: 1234,
      budget: { max_commits: 500, selected_commits: 12 },
      skipped_covered: 3,
      skips: [{ cluster_key: 'run:abc', reason: 'covered-by-captured-work' }],
    });

    const withoutExtras = await buildSeedJobLedger(source(rows), {});
    expect(withoutExtras[0]).not.toHaveProperty('wall_time_ms');
  });
});

describe('renderSeedResult', () => {
  function applyResult(failed: number): Record<string, unknown> {
    return {
      mode: 'apply',
      branch: { ref: 'origin/main', source: 'origin-head' },
      totals: { created: 3, resumed: 0, covered: 1, failed, covered_via_archive: 0 },
      preflight: { warnings: [] },
      seeded: [],
      notes: [],
      enrichment: {
        applied: 0,
        skeleton: 3,
        nomination_dispositions: null,
        invalid: [],
        unmatched: [],
        warnings: [],
      },
      truncation: {
        recency_commit_cap: false,
        recency_artifact_ceiling: false,
        importance: false,
        commits_beyond: 0,
        clusters_beyond: 0,
      },
      pending_importance: false,
    };
  }

  it('does not call an apply complete when clusters failed', () => {
    const rendered = renderSeedResult(applyResult(1));
    const headline = rendered.split('\n')[0]!;
    expect(headline).not.toContain('Seed complete');
    expect(headline).toBe('Seed finished with 1 failure — origin/main (origin-head)');
    expect(rendered).toContain('orcaops seed status --json');
    expect(rendered).toContain('`orcaops rebuild`');
  });

  it('pluralizes the failure count', () => {
    expect(renderSeedResult(applyResult(2)).split('\n')[0]).toBe(
      'Seed finished with 2 failures — origin/main (origin-head)'
    );
  });

  it('still calls a clean apply complete and carries no remedy line', () => {
    const rendered = renderSeedResult(applyResult(0));
    expect(rendered.split('\n')[0]).toBe('Seed complete — origin/main (origin-head)');
    expect(rendered).not.toContain('orcaops rebuild');
  });

  it('does not present a recovered recency cap as final truncation', () => {
    const result = applyResult(0);
    result.truncation = {
      recency_commit_cap: true,
      recency_artifact_ceiling: false,
      importance: false,
      mass_bearing_commits_beyond: 0,
      mass_bearing_clusters_beyond: 0,
    };
    expect(renderSeedResult(result)).not.toContain('budget-truncated');
  });
});
