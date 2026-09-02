// The outline mints the identity that ALL reviewer coverage hangs off. Until
// now it had no direct test — `buildThreads` was only ever exercised
// incidentally through assembly.test.ts, which asserts titles and ordering and
// never once asks whether a key survives the one event that happens constantly
// in production: an agent closing another checkpoint.
//
// keys.test.ts calls its stability test "Re-compose: rebuilt independently,
// members in a different order" and asserts the key holds. But it only ever
// RE-SHUFFLES the same three checkpoint refs. Reordering is not what regenerates
// a floor — *adding a checkpoint* is, and that moves the key. The suite proved
// the invariant that never fires and left the one that fires every day untested.
//
// So these tests assert the OBSERVABLE consequence — what the reviewer's covered
// rows do — not the key's value. A key is an implementation detail; losing a
// reviewer's progress is the bug.

import { describe, expect, it } from 'vitest';

import {
  COMPLETION_STATE,
  type CurrentThreadManifest,
  effectiveThreadCoverage,
  type JournalEvent,
  prepareReviewCoverageEvent,
  replayReviewLedgerV2,
  type ReviewedRow,
  reviewedRowsDigest,
} from '@orcaops/review-core';

import type { CapturedFingerprintInputs, ReviewArtifact, ReviewCheckpoint } from './model.js';
import { buildThreads, type OutlineLinks } from './outline.js';

const ARTIFACT = '019f5978-1111-7000-8000-000000000001';
const OTHER_ARTIFACT = '019f587c-1111-7000-8000-000000000001';

const iso = (min: number): string => `2026-07-13T0${min}:00:00.000Z`;

const capturedFingerprint: CapturedFingerprintInputs = {
  loadState: 'not-captured',
  openTreeSha: null,
  closeTreeSha: null,
  maxDiffBytes: null,
  diffOptions: null,
};

function cp(artifact: string, n: number): ReviewCheckpoint {
  return {
    artifact,
    n,
    closedAt: iso(n),
    status: 'closed',
    openTreeSha: `open${n}`,
    closeTreeSha: `close${n}`,
    headSha: `head${n}`,
    summary: `checkpoint ${n}`,
    filesChanged: [],
    completedStepIds: [],
    declaredStepIds: [],
    decisions: [],
    uncertainty: [],
    doneCriteria: [],
    verification: [],
    manifestHash: `mh${n}`,
    manifestTruncated: false,
    capturedFingerprint,
    derivedManifestHash: null,
    overlapAmbiguousFiles: [],
    windowOverlap: undefined,
    attributionDegraded: undefined,
  };
}

/** An artifact (thread) carrying exactly `cpCount` closed checkpoints. */
function thread(id: string, cpCount: number): ReviewArtifact {
  return {
    id,
    branch: 'demo',
    label: 'Restore the reading experience',
    task: 'restore',
    baseSha: 'base',
    startedAt: iso(1),
    firstActivityAt: iso(1),
    planSteps: [],
    nonGoals: [],
    planDecisions: [],
    summaryText: null,
    evaluatorRuns: [],
    planRevisions: 0,
    checkpoints: Array.from({ length: cpCount }, (_unused, index) => cp(id, index + 1)),
  };
}

const NO_LINKS: OutlineLinks = { sliceRefsByCp: new Map(), citationIdsByCp: new Map() };

/** One reviewable row per checkpoint, so "the thread grew" is visible in the rows. */
function rowsFor(cpCount: number): ReviewedRow[] {
  return Array.from({ length: cpCount }, (_unused, index) => ({
    file: `src/cp${index + 1}.ts`,
    side: 'add' as const,
    line: 1,
    lineHash: `lh_cp${index + 1}`,
    hunkKey: `hunk_cp${index + 1}`,
  }));
}

async function manifestFor(threadKey: string, cpCount: number): Promise<CurrentThreadManifest> {
  const rows = rowsFor(cpCount);
  return { threadKey, rows, digest: await reviewedRowsDigest(rows) };
}

async function threadKeyOf(artifact: ReviewArtifact): Promise<string> {
  const sections = await buildThreads([artifact], NO_LINKS);
  expect(sections).toHaveLength(1);
  return sections[0]!.threadKey;
}

describe('thread identity is stable across checkpoint growth', () => {
  it('keeps a thread key fixed when an agent closes another checkpoint on it', async () => {
    const beforeKey = await threadKeyOf(thread(ARTIFACT, 1));
    const afterKey = await threadKeyOf(thread(ARTIFACT, 2));

    // The thread is the same thread: same artifact, more work inside it. Its
    // identity is the artifact's, so the bucket that stores reviewer state
    // must not move.
    expect(afterKey).toBe(beforeKey);
  });

  it('still distinguishes two different threads', async () => {
    // Stability must not be bought with collision — the guard on the fix above.
    const a = await threadKeyOf(thread(ARTIFACT, 2));
    const b = await threadKeyOf(thread(OTHER_ARTIFACT, 2));
    expect(a).not.toBe(b);
  });

  it('keys each checkpoint independently of its siblings', async () => {
    // The checkpoint key hashes a single ref, so adding cp2 must not disturb
    // cp1's key. This one already holds — it is here so a future "simplification"
    // that unifies the two recipes cannot quietly take it away.
    const one = await buildThreads([thread(ARTIFACT, 1)], NO_LINKS);
    const two = await buildThreads([thread(ARTIFACT, 2)], NO_LINKS);

    expect(two[0]!.checkpoints[0]!.checkpointKey).toBe(one[0]!.checkpoints[0]!.checkpointKey);
    expect(two[0]!.checkpoints[1]!.checkpointKey).not.toBe(two[0]!.checkpoints[0]!.checkpointKey);
    expect(two[0]!.checkpoints.map((sub) => sub.checkpoint.cp)).toEqual([1, 2]);
  });

  it('carries the full checkpoint-close summary instead of only a truncated label', async () => {
    const [built] = await buildThreads([thread(ARTIFACT, 1)], NO_LINKS);
    expect(built!.checkpoints[0]!.summary).toBe('checkpoint 1');
  });
});

describe('reviewer coverage survives a new checkpoint', () => {
  it('keeps covered rows covered, leaves the new rows uncovered, and reads stale', async () => {
    // 1. A one-checkpoint thread, fully reviewed.
    const beforeKey = await threadKeyOf(thread(ARTIFACT, 1));
    const before = await manifestFor(beforeKey, 1);

    const prepared = await prepareReviewCoverageEvent({
      floorInputHash: 'floor_v1',
      ledgerGeneration: 'gen_v1',
      priorCoverage: [],
      currentThreads: [before],
      partRowsByThread: new Map([[beforeKey, before.rows!]]),
      now: iso(3),
    });
    expect(prepared.status).toBe('ready');
    const events: JournalEvent[] = [prepared.event!];

    const reviewed = await replayReviewLedgerV2({ events, currentThreads: [before] });
    expect(
      effectiveThreadCoverage({
        coverage: reviewed.coverage.find((entry) => entry.threadKey === beforeKey),
        current: before,
      })
    ).toEqual({ state: COMPLETION_STATE.REVIEWED });

    // 2. The agent closes a second checkpoint. The floor is rebuilt; the thread
    //    now owns one more row. NOTHING the reviewer did is retracted — the
    //    journal is unchanged, replayed verbatim against the NEW floor.
    const afterKey = await threadKeyOf(thread(ARTIFACT, 2));
    const after = await manifestFor(afterKey, 2);

    const replayed = await replayReviewLedgerV2({ events, currentThreads: [after] });
    const coverage = replayed.coverage.find((entry) => entry.threadKey === afterKey);

    // The reviewer's work is still there, still attached to this thread.
    expect(coverage).toBeDefined();
    expect(coverage!.coveredRows.map((row) => row.file)).toEqual(['src/cp1.ts']);

    // The grown thread is stale rather than fully reviewed or reset to unread,
    // preserving the reviewer's prior coverage while exposing the new row.
    expect(effectiveThreadCoverage({ coverage, current: after })).toEqual({
      state: 'stale',
      newRows: 1,
    });
  });

  it('re-marks the grown thread back to fully reviewed without re-reviewing cp1', async () => {
    // The other half of the contract: prior coverage is a floor to build on, so
    // covering only the NEW row completes the thread.
    const key = await threadKeyOf(thread(ARTIFACT, 2));
    const grown = await manifestFor(key, 2);
    const priorRows = rowsFor(1);

    const prepared = await prepareReviewCoverageEvent({
      floorInputHash: 'floor_v2',
      ledgerGeneration: 'gen_v2',
      priorCoverage: [
        {
          threadKey: key,
          coveredRows: priorRows,
          coveredRowsDigest: await reviewedRowsDigest(priorRows),
          ts: iso(3),
          fullCoverageRows: priorRows,
          fullCoverageRowsDigest: await reviewedRowsDigest(priorRows),
          fullCoverageTs: iso(3),
        },
      ],
      currentThreads: [grown],
      // The reviewer marks ONLY cp2's row — cp1 is already behind them.
      partRowsByThread: new Map([[key, rowsFor(2).slice(1)]]),
      now: iso(4),
    });
    expect(prepared.status).toBe('ready');

    const covered = prepared.event!.threads[0]!;
    expect(covered.coveredRows.map((row) => row.file)).toEqual(['src/cp1.ts', 'src/cp2.ts']);
    // Union reached the whole manifest → this is a full-coverage milestone.
    expect(covered.completedRows).toBeDefined();

    const replayed = await replayReviewLedgerV2({
      events: [prepared.event!],
      currentThreads: [grown],
    });
    expect(
      effectiveThreadCoverage({
        coverage: replayed.coverage.find((entry) => entry.threadKey === key),
        current: grown,
      })
    ).toEqual({ state: COMPLETION_STATE.REVIEWED });
  });
});
