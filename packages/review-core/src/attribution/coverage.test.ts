import { describe, expect, it } from 'vitest';

import { buildChain, type Chain } from './chain.js';
import { attribute, type AttributeInput, isExcludedPath, type LineOwner } from './coverage.js';

const ISO = '2026-07-06T00:00:00.000Z';

// A review diff exercising every verdict: a clean checkpoint hunk, a mixed
// hunk (checkpoint + gap), an unscoped gap hunk, an excluded path, and binary.
const DIFF = [
  'diff --git a/src/feature.ts b/src/feature.ts',
  '--- a/src/feature.ts',
  '+++ b/src/feature.ts',
  '@@ -4,3 +4,6 @@',
  ' line4',
  '+added5',
  '+added6',
  '+added7',
  ' line5',
  ' line6',
  'diff --git a/src/drift.ts b/src/drift.ts',
  '--- a/src/drift.ts',
  '+++ b/src/drift.ts',
  '@@ -1,1 +1,3 @@',
  ' keep1',
  '+add2',
  '+add3',
  'diff --git a/src/unscoped.ts b/src/unscoped.ts',
  '--- /dev/null',
  '+++ b/src/unscoped.ts',
  '@@ -0,0 +1,1 @@',
  '+brandnew',
  'diff --git a/.orcaops/reviews/x.json b/.orcaops/reviews/x.json',
  '--- /dev/null',
  '+++ b/.orcaops/reviews/x.json',
  '@@ -0,0 +1,1 @@',
  '+{"stale":true}',
  'diff --git a/logo.png b/logo.png',
  'index 0000000..1111111 100644',
  'Binary files a/logo.png and b/logo.png differ',
  '',
].join('\n');

// Chain: cp1 (segment 0) then a trailing worktree-drift gap (segment 1).
const CHAIN: Chain = buildChain({
  base: 'B',
  worktree: 'W',
  checkpoints: [
    { artifact: 'a', n: 1, openTreeSha: 'B', closeTreeSha: 'M', closedAt: ISO, status: 'closed' },
  ],
});

// feature: all cp1 → clean MATCHED. drift: cp1 + gap → MATCHED (≥1 owned slice). unscoped: gap → UNEXPLAINED.
const LINE_OWNERS: LineOwner[] = [
  { file: 'src/feature.ts', side: 'add', line: 5, segment: 0 },
  { file: 'src/feature.ts', side: 'add', line: 6, segment: 0 },
  { file: 'src/feature.ts', side: 'add', line: 7, segment: 0 },
  { file: 'src/drift.ts', side: 'add', line: 2, segment: 0 },
  { file: 'src/drift.ts', side: 'add', line: 3, segment: 1 },
  { file: 'src/unscoped.ts', side: 'add', line: 1, segment: 1 },
];

function baseInput(overrides: Partial<AttributeInput> = {}): AttributeInput {
  return {
    chain: CHAIN,
    reviewDiff: new TextEncoder().encode(DIFF),
    reviewDiffTruncated: false,
    reviewMaxDiffBytes: 2_000_000,
    lineOwners: LINE_OWNERS,
    rungInputs: [
      { artifact: 'a', cp: 1, hasBoundaryTrees: true, hasManifest: true, hasFilesChanged: true },
    ],
    ...overrides,
  };
}

describe('attribute — verdict rollup', () => {
  it('classifies each hunk and rolls up the summary', async () => {
    const result = await attribute(baseInput());
    const byFile = new Map(result.coverage.items.map((i) => [i.file, i]));

    // The verdict is a pure rollup over units: ≥1 owned slice → MATCHED.
    expect(byFile.get('src/feature.ts')?.verdict).toBe('MATCHED');
    expect(byFile.get('src/feature.ts')?.units).toMatchObject([
      { kind: 'owned_slice', owner: { kind: 'checkpoint', artifact: 'a', cp: 1 } },
    ]);
    // A mixed hunk (cp1 + trailing gap) still reads MATCHED — the gap run is
    // its own unit, visible at slice grain rather than as a parent flag.
    expect(byFile.get('src/drift.ts')?.verdict).toBe('MATCHED');
    expect(byFile.get('src/drift.ts')?.units.map((u) => u.kind)).toEqual([
      'owned_slice',
      'gap_slice',
    ]);
    // All-gap → UNEXPLAINED.
    expect(byFile.get('src/unscoped.ts')?.verdict).toBe('UNEXPLAINED');
    expect(byFile.get('src/unscoped.ts')?.units).toMatchObject([
      { kind: 'gap_slice', owner: { kind: 'gap' } },
    ]);
    expect(byFile.get('.orcaops/reviews/x.json')).toMatchObject({
      verdict: 'EXCLUDED',
      units: [],
    });
    expect(byFile.get('logo.png')).toMatchObject({ verdict: 'UNREVIEWABLE', units: [] });

    expect(result.coverage.summary).toEqual({
      excluded: 1,
      unreviewable: 1,
      // Row grain over the unit partition: 4 checkpoint-owned changed rows
      // (feature ×3 + drift's add2), 2 gap rows (drift's add3 + unscoped).
      matched_rows: 4,
      unexplained_rows: 2,
      ambiguous_rows: 0,
      reviewable_rows: 6,
    });
  });

  it('emits a distinct, stable hunkKey per hunk', async () => {
    const result = await attribute(baseInput());
    const keys = result.coverage.items.map((i) => i.hunkKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => k.startsWith('hunk_'))).toBe(true);
    // Deterministic across runs.
    const again = await attribute(baseInput());
    expect(again.coverage.items.map((i) => i.hunkKey)).toEqual(keys);
  });

  it('emits per-line attribution for every resolved line owner', async () => {
    const result = await attribute(baseInput());
    expect(result.attribution.lines).toHaveLength(6);
    expect(result.attribution.lines).toContainEqual({
      file: 'src/drift.ts',
      side: 'add',
      line: 3,
      owner: { kind: 'gap', segment: `a:cp1->worktree` },
    });
    expect(result.attribution.activeRung).toBe('snapshot_chain');
  });
});

describe('attribute — overlap downgrade', () => {
  it('downgrades concurrent-window files to one ambiguous hunk and discloses', async () => {
    const result = await attribute(
      baseInput({ overlapSegments: [{ kind: 'concurrent', changedFiles: ['src/feature.ts'] }] })
    );
    const feature = result.coverage.items.find((i) => i.file === 'src/feature.ts');
    expect(result.disclosures.some((d) => d.code === 'overlap_downgrade')).toBe(true);
    // The file is NEVER owner-sliced: one whole-hunk ambiguous unit whose
    // candidates are evidence, and its rows count only as ambiguous — so the
    // parent rolls up UNEXPLAINED (no asserted checkpoint ownership).
    expect(feature?.verdict).toBe('UNEXPLAINED');
    expect(feature?.units).toEqual([
      {
        kind: 'ambiguous_hunk',
        lines: 3,
        candidates: [{ kind: 'checkpoint', artifact: 'a', cp: 1 }],
      },
    ]);
    expect(result.coverage.summary.ambiguous_rows).toBe(3);
    expect(result.coverage.summary.matched_rows).toBe(1); // drift.ts add2 only
  });

  it('ignores exclusive segments', async () => {
    const result = await attribute(
      baseInput({ overlapSegments: [{ kind: 'exclusive', changedFiles: ['src/feature.ts'] }] })
    );
    const feature = result.coverage.items.find((i) => i.file === 'src/feature.ts');
    expect(feature?.verdict).toBe('MATCHED');
    expect(feature?.units.map((u) => u.kind)).toEqual(['owned_slice']);
    expect(result.disclosures.some((d) => d.code === 'overlap_downgrade')).toBe(false);
  });
});

describe('attribute — integrity + truncation disclosures', () => {
  it('passes integrity when derived reproduces stored, discloses a mismatch', async () => {
    const ok = await attribute(
      baseInput({
        integrity: [{ artifact: 'a', cp: 1, storedManifestHash: 'H', derivedManifestHash: 'H' }],
      })
    );
    expect(ok.integrity[0].verified).toBe(true);
    expect(ok.disclosures.some((d) => d.code === 'integrity_mismatch')).toBe(false);

    const drift = await attribute(
      baseInput({
        integrity: [
          { artifact: 'a', cp: 1, storedManifestHash: 'H', derivedManifestHash: 'DIFFERENT' },
        ],
      })
    );
    expect(drift.integrity[0].verified).toBe(false);
    expect(drift.disclosures.some((d) => d.code === 'integrity_mismatch')).toBe(true);
  });

  it('names review.max_diff_bytes and states the cap in bytes', async () => {
    const result = await attribute(baseInput({ reviewDiffTruncated: true }));
    const d = result.disclosures.find((x) => x.code === 'live_diff_truncated');
    expect(d).toBeDefined();
    // The reader's next move is to turn this setting up, so name it exactly.
    expect(d!.message).toContain('exceeded the review.max_diff_bytes cap (2,000,000 bytes)');
    expect(d!.message).toContain('coverage exists only for the explicitly retained complete hunks');
  });

  it('does NOT name the checkpoint fingerprint cap — that is a different setting', async () => {
    const result = await attribute(baseInput({ reviewDiffTruncated: true }));
    const d = result.disclosures.find((x) => x.code === 'live_diff_truncated');
    expect(d!.message).not.toContain('diff_fingerprint');
    // A 2_000_000-byte cap divided by 1 MiB renders as "1.9MB", which matches
    // nothing a user could type into the config.
    expect(d!.message).not.toContain('1.9MB');
  });

  it('reports the cap the diff was actually collected under, not a constant', async () => {
    const result = await attribute(
      baseInput({ reviewDiffTruncated: true, reviewMaxDiffBytes: 600_000 })
    );
    const d = result.disclosures.find((x) => x.code === 'live_diff_truncated');
    expect(d!.message).toContain('(600,000 bytes)');
  });

  it('appends exact fair-allocation detail when supplied', async () => {
    const result = await attribute(
      baseInput({
        reviewDiffTruncated: true,
        truncationDetail: 'incomplete paths: archive.md (retained 0/41,200 rows)',
      })
    );
    const d = result.disclosures.find((x) => x.code === 'live_diff_truncated');
    expect(d!.message).toContain('; incomplete paths: archive.md (retained 0/41,200 rows)');
  });
});

describe('attribute — slice partition (units)', () => {
  // One hunk exercising every run rule. patchRows in parentheses:
  //   ctx1(0) -oldA(1) -oldB(2) +newA(3) +newB(4) ctx2(5) +lone(6) ctx3(7)
  //   +gapA(8) +unowned(9) ctx4(10) -oldC(11) +newC(12) ctx5(13)
  const MIX_DIFF = [
    'diff --git a/src/mix.ts b/src/mix.ts',
    '--- a/src/mix.ts',
    '+++ b/src/mix.ts',
    '@@ -1,8 +1,11 @@',
    ' ctx1',
    '-oldA',
    '-oldB',
    '+newA',
    '+newB',
    ' ctx2',
    '+lone',
    ' ctx3',
    '+gapA',
    '+unowned',
    ' ctx4',
    '-oldC',
    '+newC',
    ' ctx5',
    '',
  ].join('\n');

  // cp1 (segment 0), cp2 (segment 1), trailing gap (segment 2).
  const TWO_CP_CHAIN: Chain = buildChain({
    base: 'B',
    worktree: 'W',
    checkpoints: [
      { artifact: 'a', n: 1, openTreeSha: 'B', closeTreeSha: 'M', closedAt: ISO, status: 'closed' },
      { artifact: 'a', n: 2, openTreeSha: 'M', closeTreeSha: 'N', closedAt: ISO, status: 'closed' },
    ],
  });

  const MIX_OWNERS: LineOwner[] = [
    { file: 'src/mix.ts', side: 'delete', line: 2, segment: 0 }, // oldA   cp1
    { file: 'src/mix.ts', side: 'delete', line: 3, segment: 0 }, // oldB   cp1
    { file: 'src/mix.ts', side: 'add', line: 2, segment: 0 }, //    newA   cp1
    { file: 'src/mix.ts', side: 'add', line: 3, segment: 0 }, //    newB   cp1
    { file: 'src/mix.ts', side: 'add', line: 5, segment: 0 }, //    lone   cp1
    { file: 'src/mix.ts', side: 'add', line: 7, segment: 2 }, //    gapA   gap
    // line 8 (+unowned) deliberately has NO owner entry.
    { file: 'src/mix.ts', side: 'delete', line: 7, segment: 1 }, // oldC   cp2
    { file: 'src/mix.ts', side: 'add', line: 10, segment: 0 }, //   newC   cp1
  ];

  function mixInput(overrides: Partial<AttributeInput> = {}): AttributeInput {
    return {
      chain: TWO_CP_CHAIN,
      reviewDiff: new TextEncoder().encode(MIX_DIFF),
      reviewDiffTruncated: false,
      reviewMaxDiffBytes: 2_000_000,
      lineOwners: MIX_OWNERS,
      ...overrides,
    };
  }

  it('partitions the hunk into consecutive-patchRow owner runs', async () => {
    const result = await attribute(mixInput());
    const item = result.coverage.items.find((i) => i.file === 'src/mix.ts');
    expect(item?.units).toEqual([
      // A plain -old/+new modify block by one owner is ONE two-sided slice.
      {
        kind: 'owned_slice',
        slice: 0,
        patch_row_start: 1,
        patch_row_end: 4,
        del_range: { start: 2, end: 3 },
        add_range: { start: 2, end: 3 },
        lines: 4,
        owner: { kind: 'checkpoint', artifact: 'a', cp: 1 },
      },
      // A context row splits a same-owner run — distant edits never collapse.
      {
        kind: 'owned_slice',
        slice: 1,
        patch_row_start: 6,
        patch_row_end: 6,
        del_range: null,
        add_range: { start: 5, end: 5 },
        lines: 1,
        owner: { kind: 'checkpoint', artifact: 'a', cp: 1 },
      },
      // Adjacent rows with different identities (gap vs unowned) never merge.
      {
        kind: 'gap_slice',
        slice: 2,
        patch_row_start: 8,
        patch_row_end: 8,
        del_range: null,
        add_range: { start: 7, end: 7 },
        lines: 1,
        owner: { kind: 'gap', segment: 'a:cp2->worktree' },
      },
      {
        kind: 'gap_slice',
        slice: 3,
        patch_row_start: 9,
        patch_row_end: 9,
        del_range: null,
        add_range: { start: 8, end: 8 },
        lines: 1,
        owner: null,
      },
      // A different-owner changed row breaks the run even with no context between.
      {
        kind: 'owned_slice',
        slice: 4,
        patch_row_start: 11,
        patch_row_end: 11,
        del_range: { start: 7, end: 7 },
        add_range: null,
        lines: 1,
        owner: { kind: 'checkpoint', artifact: 'a', cp: 2 },
      },
      {
        kind: 'owned_slice',
        slice: 5,
        patch_row_start: 12,
        patch_row_end: 12,
        del_range: null,
        add_range: { start: 10, end: 10 },
        lines: 1,
        owner: { kind: 'checkpoint', artifact: 'a', cp: 1 },
      },
    ]);
    // Exact partition: every changed row of the hunk in exactly one unit.
    const unitLines = (item?.units ?? []).reduce((n, u) => n + u.lines, 0);
    expect(unitLines).toBe((item?.added_lines ?? 0) + (item?.removed_lines ?? 0));
    // Row summary math.
    expect(result.coverage.summary.matched_rows).toBe(7);
    expect(result.coverage.summary.unexplained_rows).toBe(2);
    expect(result.coverage.summary.reviewable_rows).toBe(9);
  });

  it('is deterministic across runs (first-patchRow ordinals)', async () => {
    const a = await attribute(mixInput());
    const b = await attribute(mixInput());
    expect(JSON.stringify(a.coverage.items)).toBe(JSON.stringify(b.coverage.items));
  });

  it('never merges different gap segments', async () => {
    // cp1 (seg 0), interleaved gap M->N (seg 1), cp2 (seg 2), trailing gap (seg 3).
    const gappyChain = buildChain({
      base: 'B',
      worktree: 'W',
      checkpoints: [
        {
          artifact: 'a',
          n: 1,
          openTreeSha: 'B',
          closeTreeSha: 'M',
          closedAt: ISO,
          status: 'closed',
        },
        {
          artifact: 'a',
          n: 2,
          openTreeSha: 'N',
          closeTreeSha: 'P',
          closedAt: ISO,
          status: 'closed',
        },
      ],
    });
    const diff = [
      'diff --git a/src/g.ts b/src/g.ts',
      '--- a/src/g.ts',
      '+++ b/src/g.ts',
      '@@ -1,1 +1,3 @@',
      ' ctx',
      '+g1',
      '+g2',
      '',
    ].join('\n');
    const result = await attribute({
      chain: gappyChain,
      reviewDiff: new TextEncoder().encode(diff),
      reviewDiffTruncated: false,
      reviewMaxDiffBytes: 2_000_000,
      lineOwners: [
        { file: 'src/g.ts', side: 'add', line: 2, segment: 1 },
        { file: 'src/g.ts', side: 'add', line: 3, segment: 3 },
      ],
    });
    const units = result.coverage.items.find((i) => i.file === 'src/g.ts')?.units ?? [];
    expect(units).toHaveLength(2);
    expect(units.every((u) => u.kind === 'gap_slice')).toBe(true);
  });

  it('renders an ambiguous file as ONE whole-hunk unit with sorted candidates', async () => {
    const result = await attribute(
      mixInput({ overlapSegments: [{ kind: 'concurrent', changedFiles: ['src/mix.ts'] }] })
    );
    const item = result.coverage.items.find((i) => i.file === 'src/mix.ts');
    expect(item?.units).toEqual([
      {
        kind: 'ambiguous_hunk',
        lines: 9,
        candidates: [
          { kind: 'checkpoint', artifact: 'a', cp: 1 },
          { kind: 'checkpoint', artifact: 'a', cp: 2 },
          { kind: 'gap', segment: 'a:cp2->worktree' },
        ],
      },
    ]);
    expect(result.coverage.summary.ambiguous_rows).toBe(9);
    expect(result.coverage.summary.matched_rows).toBe(0);
  });
});

describe('isExcludedPath', () => {
  it('excludes capture internals and lockfiles, keeps real source', () => {
    expect(isExcludedPath('.orcaops/reviews/x.json')).toBe(true);
    expect(isExcludedPath('nested/.agent-trace/log')).toBe(true);
    expect(isExcludedPath('pnpm-lock.yaml')).toBe(true);
    expect(isExcludedPath('packages/app/pnpm-lock.yaml')).toBe(true);
    expect(isExcludedPath('src/feature.ts')).toBe(false);
  });
});
