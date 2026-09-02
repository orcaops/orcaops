import { describe, expect, it } from 'vitest';

import { adjudicateOverlapGroups, type AdjudicationCheckpoint } from './overlap-adjudication.js';
import type { WindowOverlap } from '../schema/checkpoint.js';

const emptyOverlap = (overrides: Partial<WindowOverlap> = {}): WindowOverlap => ({
  siblings: [],
  cross_artifact_siblings: [],
  pending: false,
  dropped_files: [],
  rejected_claims: [],
  ambiguous_files: [],
  mixed_segment: [],
  own_claim_pending: [],
  segment_attributed: [],
  unattributed_in_window: [],
  degradations: [],
  ...overrides,
});

const pair = (f: string) => ({ file_before: f, file_after: f });

describe('adjudicateOverlapGroups — first-close/last-close read model', () => {
  // A (n=1) closes FIRST claiming f.ts while B (n=2) is open: A records
  // own_claim_pending. The fold's answer then depends on B.

  const aRecord = emptyOverlap({
    siblings: [2],
    pending: true,
    own_claim_pending: [pair('f.ts')],
  });

  it("read BETWEEN the closes: F is A's-with-pending-siblings (provisional, not weak)", () => {
    const cps: AdjudicationCheckpoint[] = [
      { n: 1, status: 'closed', filesChanged: ['f.ts'], windowOverlap: aRecord },
      { n: 2, status: 'open', filesChanged: [] },
    ];
    const adj = adjudicateOverlapGroups(cps).get(1);
    expect(adj?.ownClaimPending).toEqual([pair('f.ts')]);
    expect(adj?.ambiguous).toEqual([]);
    expect(adj?.finalized).toBe(false);
  });

  it("B closes WITHOUT claiming F → F lifts to A's, clean, no flags", () => {
    const cps: AdjudicationCheckpoint[] = [
      { n: 1, status: 'closed', filesChanged: ['f.ts'], windowOverlap: aRecord },
      {
        n: 2,
        status: 'closed',
        filesChanged: ['other.ts'],
        windowOverlap: emptyOverlap({ siblings: [1] }),
      },
    ];
    const adj = adjudicateOverlapGroups(cps).get(1);
    expect(adj?.ownClaimPending).toEqual([]);
    expect(adj?.ambiguous).toEqual([]);
    expect(adj?.finalized).toBe(true);
  });

  it("B later ALSO claims F → BOTH report F ambiguous; A's record was never rewritten", () => {
    // B's close (the later one) recorded the ambiguity; A's persisted
    // record still says own_claim_pending — the fold reconciles both.
    const bRecord = emptyOverlap({
      siblings: [1],
      ambiguous_files: [pair('f.ts')],
    });
    const cps: AdjudicationCheckpoint[] = [
      { n: 1, status: 'closed', filesChanged: ['f.ts'], windowOverlap: aRecord },
      { n: 2, status: 'closed', filesChanged: ['f.ts'], windowOverlap: bRecord },
    ];
    const all = adjudicateOverlapGroups(cps);
    expect(all.get(1)?.ambiguous).toEqual([pair('f.ts')]);
    expect(all.get(1)?.ownClaimPending).toEqual([]);
    expect(all.get(2)?.ambiguous).toEqual([pair('f.ts')]);
    expect(all.get(1)?.finalized).toBe(true);
  });

  it('resolves sibling_pending drops: sibling-claimed when claimed, unclaimed (and loud) when not', () => {
    const record = emptyOverlap({
      siblings: [2],
      pending: true,
      dropped_files: [
        { file_before: 'theirs.ts', file_after: 'theirs.ts', status: 'sibling_pending' },
        { file_before: 'nobody.ts', file_after: 'nobody.ts', status: 'sibling_pending' },
      ],
    });
    const cps: AdjudicationCheckpoint[] = [
      { n: 1, status: 'closed', filesChanged: ['a.ts'], windowOverlap: record },
      {
        n: 2,
        status: 'closed',
        filesChanged: ['theirs.ts'],
        windowOverlap: emptyOverlap({ siblings: [1] }),
      },
    ];
    const adj = adjudicateOverlapGroups(cps).get(1);
    expect(adj?.dropped).toEqual([
      { file_before: 'theirs.ts', file_after: 'theirs.ts', status: 'sibling-claimed' },
      { file_before: 'nobody.ts', file_after: 'nobody.ts', status: 'unclaimed' },
    ]);
    expect(adj?.unattributedInWindow).toEqual(['nobody.ts']);
  });

  it('keeps mixed_segment as weak evidence through the fold (under-reported exclusive owner)', () => {
    const record = emptyOverlap({
      siblings: [2],
      mixed_segment: [pair('both.ts')],
    });
    const cps: AdjudicationCheckpoint[] = [
      { n: 1, status: 'closed', filesChanged: [], windowOverlap: record },
      {
        n: 2,
        status: 'closed',
        filesChanged: ['both.ts'],
        windowOverlap: emptyOverlap({ siblings: [1] }),
      },
    ];
    const adj = adjudicateOverlapGroups(cps).get(1);
    // Stays in n=1's sets on segment evidence — never migrates to a drop.
    expect(adj?.mixedSegment).toEqual([pair('both.ts')]);
    expect(adj?.dropped).toEqual([]);
  });

  it('cross-artifact: pending while the sibling artifact is unknown/open, finalized after its close', () => {
    const record = emptyOverlap({
      cross_artifact_siblings: [{ artifact_id: 'other', n: 1 }],
      pending: true,
      own_claim_pending: [pair('mine.ts')],
      dropped_files: [
        { file_before: 'foreign.ts', file_after: 'foreign.ts', status: 'sibling_pending' },
      ],
    });
    const cps: AdjudicationCheckpoint[] = [
      { n: 1, status: 'closed', filesChanged: ['mine.ts'], windowOverlap: record },
    ];

    // Sibling artifact not loaded → conservatively pending.
    const before = adjudicateOverlapGroups(cps).get(1);
    expect(before?.ownClaimPending).toEqual([pair('mine.ts')]);
    expect(before?.finalized).toBe(false);

    // Sibling artifact closed claiming foreign.ts → finalized: mine.ts
    // lifts clean, foreign.ts resolves sibling-claimed.
    const after = adjudicateOverlapGroups(
      cps,
      new Map([['other', [{ n: 1, status: 'closed' as const, filesChanged: ['foreign.ts'] }]]])
    ).get(1);
    expect(after?.finalized).toBe(true);
    expect(after?.ownClaimPending).toEqual([]);
    expect(after?.ambiguous).toEqual([]);
    expect(after?.dropped).toEqual([
      { file_before: 'foreign.ts', file_after: 'foreign.ts', status: 'sibling-claimed' },
    ]);
  });

  it('an unreadable cross-artifact sibling folds like a still-open one, and is named', () => {
    const record = emptyOverlap({
      cross_artifact_siblings: [{ artifact_id: 'rotted', n: 1 }],
      pending: true,
      own_claim_pending: [pair('mine.ts')],
    });
    const cps: AdjudicationCheckpoint[] = [
      { n: 1, status: 'closed', filesChanged: ['mine.ts'], windowOverlap: record },
    ];
    const adj = adjudicateOverlapGroups(cps, new Map(), new Set(['rotted'])).get(1);
    // Nothing finalizes, nothing lifts to clean — but the omission is
    // structural so consumers can disclose it.
    expect(adj?.finalized).toBe(false);
    expect(adj?.ownClaimPending).toEqual([pair('mine.ts')]);
    expect(adj?.unreadableSiblingArtifacts).toEqual(['rotted']);
  });

  it('returns no entry for checkpoints without window_overlap', () => {
    const cps: AdjudicationCheckpoint[] = [
      { n: 1, status: 'closed', filesChanged: ['a.ts'] },
      { n: 2, status: 'open', filesChanged: [] },
    ];
    expect(adjudicateOverlapGroups(cps).size).toBe(0);
  });
});
