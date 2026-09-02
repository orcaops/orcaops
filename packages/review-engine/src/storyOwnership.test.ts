import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  attribute,
  type AttributionResult,
  buildChain,
  type CheckpointDescriptor,
  type LineOwner,
  type OverlapSegment,
} from '@orcaops/review-core';

import {
  derivePartOwnership,
  PartOwnershipInvariantError,
  type PartTopology,
} from './storyOwnership.js';

// Real end-to-end proof: the fixture holds attribute() INPUTS (chain + diff +
// per-line owners), not pre-baked coverage. We run the genuine attribution
// pipeline once here, then assert the Part fold over its output. Hand-feeding a
// correct CoverageItem[] would only exercise the grouping — this exercises
// multi-thread attribution end to end.

const SCENARIO_URL = new URL('../fixtures/story-ownership/scenario.json', import.meta.url);

interface Scenario {
  base: string;
  worktree: string;
  checkpoints: CheckpointDescriptor[];
  overlapSegments: OverlapSegment[];
  diffLines: string[];
  lineOwners: LineOwner[];
  topology: PartTopology;
}

let scenario: Scenario;
let coverage: AttributionResult['coverage'];

beforeAll(async () => {
  scenario = JSON.parse(await readFile(SCENARIO_URL, 'utf8')) as Scenario;
  const chain = buildChain({
    base: scenario.base,
    worktree: scenario.worktree,
    checkpoints: scenario.checkpoints,
  });
  const result = await attribute({
    chain,
    reviewDiff: new TextEncoder().encode(scenario.diffLines.join('\n')),
    reviewDiffTruncated: false,
    reviewMaxDiffBytes: 2_000_000,
    lineOwners: scenario.lineOwners,
    overlapSegments: scenario.overlapSegments,
  });
  coverage = result.coverage;
});

describe('fixture wiring — the real attribute() pipeline ran', () => {
  it('excludes the abandoned checkpoint from the chain', () => {
    const chain = buildChain({
      base: scenario.base,
      worktree: scenario.worktree,
      checkpoints: scenario.checkpoints,
    });
    expect(chain.excluded).toContainEqual({ artifact: 'a2', n: 2, reason: 'abandoned' });
    // …and no segment owns it, so it can never appear as an owned slice.
    const owners = chain.segments
      .filter((s) => s.kind === 'checkpoint')
      .map((s) => `${s.owner.artifact}:cp${s.owner.cp}`);
    expect(owners).not.toContain('a2:cp2');
  });

  it('produces the hand-computed coverage summary', () => {
    expect(coverage.summary).toEqual({
      excluded: 0,
      unreviewable: 0,
      matched_rows: 9,
      unexplained_rows: 4,
      ambiguous_rows: 5,
      reviewable_rows: 18,
    });
  });

  it('downgrades both concurrent-overlap files to a real ambiguous_hunk with candidates', () => {
    const byFile = new Map(coverage.items.map((i) => [i.file, i]));
    expect(byFile.get('src/contested.ts')?.units).toMatchObject([
      { kind: 'ambiguous_hunk', lines: 3 },
    ]);
    expect(byFile.get('src/samepart_amb.ts')?.units).toMatchObject([
      { kind: 'ambiguous_hunk', lines: 2 },
    ]);
    // Candidates are real (not empty) — the fold decides Part-spanning from them.
    const contested = byFile.get('src/contested.ts')?.units[0];
    expect(contested?.kind === 'ambiguous_hunk' && contested.candidates.length).toBe(2);
  });
});

describe('derivePartOwnership — multi-thread fold', () => {
  it('routes every owned slice to its Part and unions the multi-checkpoint Part', () => {
    const out = derivePartOwnership(coverage, scenario.topology);
    const parts = new Map(out.parts.map((p) => [p.partId, p]));

    expect(parts.get('P1')?.changedRows).toBe(3);
    expect(parts.get('P2')?.changedRows).toBe(2);

    // P3 unions slices owned by TWO different artifacts' checkpoints.
    const p3 = parts.get('P3')!;
    expect(p3.changedRows).toBe(4);
    expect(p3.segments).toHaveLength(2);
    const p3Owners = p3.segments.map((s) => `${s.owner.artifact}:cp${s.owner.cp}`).sort();
    expect(p3Owners).toEqual(['a1:cp2', 'a3:cp1']);
    // Both segments are on the same file (gamma), proving a hunk contributes
    // slices to one Part across members rather than being owned whole.
    expect(p3.segments.every((s) => s.file === 'src/gamma.ts')).toBe(true);
  });

  it('renders same-Part ambiguity inside the Part, flagged; abandoned cp owns zero rows', () => {
    const out = derivePartOwnership(coverage, scenario.topology);
    const p3 = out.parts.find((p) => p.partId === 'P3')!;
    expect(p3.ambiguous).toHaveLength(1);
    expect(p3.ambiguous[0]).toMatchObject({ file: 'src/samepart_amb.ts', lines: 2 });
    expect(p3.ambiguousRows).toBe(2);

    // The abandoned a2:cp2 owns nothing anywhere in the derived view.
    const allOwners = out.parts
      .flatMap((p) => p.segments)
      .map((s) => `${s.owner.artifact}:cp${s.owner.cp}`);
    expect(allOwners).not.toContain('a2:cp2');
  });

  it('routes cross-Part ambiguity to contested with cross-refs to both Parts', () => {
    const out = derivePartOwnership(coverage, scenario.topology);
    expect(out.contested).toHaveLength(1);
    expect(out.contested[0]).toMatchObject({
      file: 'src/contested.ts',
      lines: 3,
      partIds: ['P1', 'P2'],
    });
    // The candidates cross-referenced are the two checkpoints, one per Part.
    const cand = out.contested[0].candidates
      .filter((c) => c.kind === 'checkpoint')
      .map((c) => (c.kind === 'checkpoint' ? `${c.artifact}:cp${c.cp}` : ''))
      .sort();
    expect(cand).toEqual(['a1:cp1', 'a2:cp1']);
  });

  it('collects gap and genuinely-unowned rows as unattributed', () => {
    const out = derivePartOwnership(coverage, scenario.topology);
    const rows = out.unattributed.reduce((n, u) => n + u.lines, 0);
    expect(rows).toBe(4);
    const kinds = out.unattributed.map((u) => u.kind).sort();
    expect(kinds).toEqual(['gap', 'unowned']);
  });

  it('reports capture-quality metrics matching the hand-computed goldens', () => {
    const out = derivePartOwnership(coverage, scenario.topology);
    expect(out.metrics).toEqual({
      reviewableRows: 18,
      attributedRows: 9,
      attributedPct: 50,
      ambiguousRows: 2,
      contestedRows: 3,
      unattributedRows: 4,
      contributingThreads: 3,
      contributingCheckpoints: 4,
    });
  });

  it('places every changed row in exactly one bucket (reconciled with the summary)', () => {
    const out = derivePartOwnership(coverage, scenario.topology);
    const partSegmentRows = out.parts.reduce((n, p) => n + p.changedRows, 0);
    const inPartAmbiguous = out.parts.reduce((n, p) => n + p.ambiguousRows, 0);
    const contestedRows = out.contested.reduce((n, c) => n + c.lines, 0);
    const unattributedRows = out.unattributed.reduce((n, u) => n + u.lines, 0);
    const total = partSegmentRows + inPartAmbiguous + contestedRows + unattributedRows;
    expect(total).toBe(coverage.summary.reviewable_rows);
    expect(total).toBe(18);
  });
});

describe('derivePartOwnership — fails closed', () => {
  it('throws when an owning checkpoint is not grouped by any Part', () => {
    // Drop P2, so a2:cp1's owned slice (in src/beta.ts) has no home.
    const partial: PartTopology = {
      parts: scenario.topology.parts.filter((p) => p.id !== 'P2'),
    };
    expect(() => derivePartOwnership(coverage, partial)).toThrow(PartOwnershipInvariantError);
  });

  it('throws when a checkpoint is claimed by two Parts', () => {
    const doubled: PartTopology = {
      parts: [
        ...scenario.topology.parts,
        { id: 'P4', checkpoint_refs: ['a1:cp1'] }, // also claimed by P1
      ],
    };
    expect(() => derivePartOwnership(coverage, doubled)).toThrow(/exclusive/);
  });

  it('throws on a malformed checkpoint ref', () => {
    const bad: PartTopology = { parts: [{ id: 'P1', checkpoint_refs: ['a1-cp1'] }] };
    expect(() => derivePartOwnership(coverage, bad)).toThrow(/malformed/);
  });
});
