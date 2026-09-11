// Headless round-trip for the `review journal` verb over the canonical store:
// append + replay → ledger, the schema reason-gate, the generation guards, the
// finish gate, and the stdin transport (`--input -`) for events too large for
// argv. Every review here is a real capture whose floor is published as
// retained evidence, so the coverage and lifecycle events are the ones a
// reviewer could actually author.

import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type Floor,
  lineHash,
  prepareReviewCoverageEvent,
  type ReviewedRow,
  reviewedRowsDigest,
  type ReviewLedgerV2,
} from '@orcaops/review-core';
import { uuidv7 } from '@orcaops/storage';

import { applyDatabaseReviewComments } from './database/comment-command.js';
import { readDatabaseReviewFloor } from './database/floors.js';
import { readDatabaseReviewContext } from './database/read-context.js';
import {
  finalizeCanonicalRun,
  readCanonicalRun,
  startCanonicalRun,
  submitCanonicalLane,
} from './database/run-command.js';
import {
  WORKFLOW_STALE_FLOOR_MESSAGE,
  WORKFLOW_STALE_LEDGER_MESSAGE,
  WORKFLOW_STALE_STORY_MESSAGE,
} from './database/workflow.js';
import { JOURNAL_STDIN_CAP_BYTES, runJournal } from './journal.js';
import { parsePatchHunks } from './patchHunks.js';
import {
  buildCurrentGapRows,
  buildCurrentThreadManifests,
  buildEligibleNarrativeTargets,
} from './reviewTargets.js';
import type { ReviewArgs } from './run.js';
import { parseStoryReviewModel, STORY_REVIEW_MODEL_FILE } from './storyReviewModel.js';
import { renderAccountRoutineMd, renderForensicRoutineMd } from './twolaneRunCli.js';
import {
  type CapturedArtifactSpec,
  type CapturedReviewFixture,
  capturedReviewFixture,
} from '../tests/capturedReviewFixture.js';

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const args = (branch: string, addEvent?: string): ReviewArgs => ({
  cmd: 'review',
  sub: 'journal',
  branch,
  json: true,
  ...(addEvent !== undefined ? { addEvent } : {}),
});

const stdinArgs = (branch: string): ReviewArgs => ({
  cmd: 'review',
  sub: 'journal',
  branch,
  json: true,
  input: '-',
});

function lastLedger(): ReviewLedgerV2 {
  return JSON.parse(out[out.length - 1]!) as ReviewLedgerV2;
}

function lastLedgerGeneration(): string {
  return (JSON.parse(out[out.length - 1]!) as { ledger_generation: string }).ledger_generation;
}

/** A synthetic row-coverage event large enough to require stdin transport. */
async function bigCoverageEvent(
  rowCount: number,
  floorInputHash: string,
  ledgerGeneration: string,
  threadKey: string
): Promise<{ event: Record<string, unknown>; rows: ReviewedRow[]; digest: string }> {
  const rows: ReviewedRow[] = Array.from({ length: rowCount }, (_, i) => ({
    file: `src/pkg/module-${i % 50}/deeply/nested/path/file-${String(i % 500).padStart(4, '0')}.ts`,
    side: i % 2 === 0 ? ('add' as const) : ('delete' as const),
    lineHash: `lh_${'0123456789abcdef'.repeat(3)}_${i}`,
    line: (i % 5000) + 1,
    hunkKey: `hk:${i % 300}`,
  }));
  const digest = await reviewedRowsDigest(rows);
  return {
    event: {
      type: 'review_coverage',
      ts: '2026-07-09T00:00:00.000Z',
      action: 'RECORD_REVIEW_COVERAGE',
      floor_input_hash: floorInputHash,
      ledger_generation: ledgerGeneration,
      threads: [{ threadKey, coveredRows: rows, coveredRowsDigest: digest }],
    },
    rows,
    digest,
  };
}

const FORENSIC = JSON.stringify({
  findings: [
    {
      claim: 'The limiter has no shared clock across processes.',
      file: 'src/limiter.ts',
      related_files: [],
      severity: 'CAUTION',
      confidence: 'HIGH',
    },
  ],
  questions: [],
});

const EXECUTION_PROFILE = {
  host: null,
  host_version: null,
  model: null,
  effort: null,
  launcher_mode: null,
  instruction_hash: null,
};

interface PublishedReview {
  fixture: CapturedReviewFixture;
  reviewId: string;
  floor: Floor;
  floorInputHash: string;
  branch: string;
  root: string;
  threadKeys: string[];
}

/**
 * A captured review with its floor published as retained evidence. Every case
 * builds its own: a review's workflow history is append-only, so a shared
 * fixture would make each lifecycle case depend on the one before it.
 */
async function publishedReview(
  options: { artifacts?: CapturedArtifactSpec[]; strayCommit?: Record<string, string> } = {}
): Promise<PublishedReview> {
  const fixture = await capturedReviewFixture(
    options.artifacts === undefined ? {} : { artifacts: options.artifacts }
  );
  if (options.strayCommit !== undefined)
    await fixture.commit(options.strayCommit, 'changes no checkpoint claims');
  vi.stubEnv('ORCAOPS_DATA_DIR', fixture.dataRoot);
  const published = await fixture.publishFloor();
  return {
    fixture,
    reviewId: published.review_id,
    floor: published.floor,
    floorInputHash: published.floor.input_hash,
    branch: fixture.branch,
    root: fixture.gitRoot,
    threadKeys: published.floor.outline.threads.map((thread) => thread.threadKey),
  };
}

/** Republish after the reviewed worktree moved; returns the new floor. */
async function republish(review: PublishedReview): Promise<Floor> {
  return (await review.fixture.publishFloor()).floor;
}

const locatorFor = (review: PublishedReview) => ({
  branch: review.branch,
  root: review.root,
  dataRoot: review.fixture.dataRoot,
  projectId: review.fixture.projectId,
});

/**
 * Mint a run, submit both lanes and seal it, so the review carries a selected
 * Story. Returns its generation — the identity a STORY-basis lifecycle event
 * pins, which is the Story's content and not the run that published it.
 */
async function sealStory(review: PublishedReview): Promise<string> {
  const locator = locatorFor(review);
  const started = await startCanonicalRun({
    ...locator,
    profile: 'routine',
    createdAt: '2026-07-20T00:00:00.000Z',
    runtimeIdentity: null,
    executionProfile: EXECUTION_PROFILE,
    operationId: uuidv7(),
    secretAllow: [],
  });
  const minted = (await readCanonicalRun({ ...locator, runId: started.runId }))!;
  renderForensicRoutineMd(minted.dossierInputs.forensicInput);
  const forensic = await submitCanonicalLane({
    ...locator,
    runId: started.runId,
    lane: 'forensic',
    at: '2026-07-20T00:01:00.000Z',
    isolation: 'sequential',
    usageTokens: null,
    usageSource: null,
    runtimeIdentity: null,
    rawSubmission: FORENSIC,
    operationId: uuidv7(),
    secretAllow: [],
  });
  expect(forensic.accepted, JSON.stringify(forensic.diagnostics)).toBe(true);

  const served = (await readCanonicalRun({ ...locator, runId: started.runId }))!;
  const markdown = renderAccountRoutineMd(served.dossierInputs.projection, {
    runId: started.runId,
    baseSha: served.dossierInputs.forensicInput.baseSha ?? null,
    floorInputHash: served.dossierInputs.projection.floor_input_hash,
    eligibleFiles: served.dossierInputs.forensicInput.metrics.eligibleFiles,
    eligibleDiffBytes: served.dossierInputs.forensicInput.metrics.eligibleDiffBytes,
    excludedFiles: served.dossierInputs.forensicInput.metrics.excludedFiles,
    unreviewableFiles: served.dossierInputs.forensicInput.metrics.unreviewableFiles,
    policyStubFiles: 0,
    policyStubRows: 0,
    latencyTier: '<250KB → 180s',
  });
  const checkpoints = [...markdown.matchAll(/^#### (k\d+) ·/gm)].map((match) => match[1]!);
  const citation = /\[(c\d+)\]/.exec(markdown)?.[1];
  expect(checkpoints.length).toBeGreaterThan(0);
  expect(citation).toBeDefined();
  const account = await submitCanonicalLane({
    ...locator,
    runId: started.runId,
    lane: 'account',
    at: '2026-07-20T00:02:00.000Z',
    isolation: 'sequential',
    usageTokens: null,
    usageSource: null,
    runtimeIdentity: null,
    rawSubmission: JSON.stringify({
      schema_version: 1,
      overview: {
        text: 'The captured checkpoints carry one bounded feature from intent to code.',
        citations: [citation],
      },
      acts: [
        {
          title: 'Carry the feature',
          interpretation: 'Every captured checkpoint lands in one act.',
          parts: [
            {
              title: 'Captured work',
              checkpoints,
              interpretation: 'The changed files implement the captured checkpoints.',
              citations: [citation],
            },
          ],
        },
      ],
      questions: [],
    }),
    operationId: uuidv7(),
    secretAllow: [],
  });
  expect(account.accepted, JSON.stringify(account.diagnostics)).toBe(true);

  const sealed = await finalizeCanonicalRun({
    ...locator,
    runId: started.runId,
    finalizedAt: '2026-07-20T00:03:00.000Z',
    runtimeIdentity: null,
    operationId: uuidv7(),
    secretAllow: [],
  });
  expect(sealed.outcome).not.toBe('FAILED');
  expect(sealed.storyGeneration).not.toBeNull();
  return sealed.storyGeneration!;
}

/** The retained floor bundle: the floor and the diff it was derived from. */
async function retainedBundle(review: PublishedReview): Promise<{ floor: Floor; diff: string }> {
  const retained = await readDatabaseReviewFloor({
    authority: review.fixture.authority,
    reviewId: review.reviewId,
  });
  return {
    floor: retained.value!.floor as Floor,
    diff: Buffer.from(retained.value!.diffBytes).toString('utf8'),
  };
}

/**
 * Cover every reviewable row on the branch — what a reviewer who actually read
 * every checkpoint leaves behind. Built with the PRODUCTION preparer over the
 * RETAINED floor and diff, so the event is one Watch could have written.
 */
async function coverEveryRow(review: PublishedReview): Promise<void> {
  const { floor, diff } = await retainedBundle(review);
  const targets = await buildEligibleNarrativeTargets(floor, diff);
  const currentThreads = await buildCurrentThreadManifests(floor, targets);
  const partRowsByThread = new Map<string, readonly ReviewedRow[]>();
  for (const manifest of currentThreads)
    if (manifest.rows !== null && manifest.rows.length > 0)
      partRowsByThread.set(manifest.threadKey, manifest.rows);
  expect(partRowsByThread.size, 'the published floor must carry rows to cover').toBeGreaterThan(0);

  out = [];
  expect(await runJournal(args(review.branch), review.root)).toBe(0);
  const prepared = await prepareReviewCoverageEvent({
    floorInputHash: floor.input_hash,
    ledgerGeneration: lastLedgerGeneration(),
    priorCoverage: [],
    currentThreads,
    partRowsByThread,
    now: '2026-07-12T00:00:00.000Z',
  });
  expect(prepared.status).toBe('ready');
  expect(await runJournal(args(review.branch, JSON.stringify(prepared.event)), review.root)).toBe(
    0
  );
}

/** Every gap row on the branch, inspected — the unassigned half of the gate. */
async function inspectEveryGapRow(review: PublishedReview): Promise<void> {
  const { floor, diff } = await retainedBundle(review);
  const gapRows = await buildCurrentGapRows(floor, diff);
  const events: unknown[] = [];
  if (gapRows.length > 0)
    events.push({
      type: 'unassigned',
      ts: '2026-07-12T00:00:30.000Z',
      action: 'MARK_INSPECTED',
      target: {
        kind: 'GAP_ROWS',
        coveredRows: gapRows,
        coveredRowsDigest: await reviewedRowsDigest(gapRows),
      },
    });
  for (const hunkKey of floor.outline.unassigned.ambiguous.hunkKeys)
    events.push({
      type: 'unassigned',
      ts: '2026-07-12T00:00:31.000Z',
      action: 'MARK_INSPECTED',
      target: { kind: 'AMBIGUOUS_HUNK', hunkKey },
    });
  if (events.length === 0) return;
  expect(await runJournal(args(review.branch, JSON.stringify(events)), review.root)).toBe(0);
}

/**
 * Discharge every finish-gate obligation on a review whose Story is sealed: the
 * floor coverage, the gap rows, each captured uncertainty, and the Story's own
 * required findings and questions. A COMPLETE lands only after all of them, so
 * a lifecycle case that means to test COMPLETE must clear the real gate rather
 * than a loosened one.
 */
async function dischargeStoryObligations(review: PublishedReview): Promise<void> {
  await coverEveryRow(review);
  await inspectEveryGapRow(review);

  const context = await readDatabaseReviewContext({
    branch: review.branch,
    cwd: review.root,
    dataRoot: review.fixture.dataRoot,
    projectId: review.fixture.projectId,
  });

  const dispositions: unknown[] = [];
  for (const citation of (context.floor!.floor as Floor).citations)
    if (citation.kind === 'CHECKPOINT_UNCERTAINTY')
      dispositions.push({
        type: 'uncertainty',
        ts: '2026-07-19T00:00:00.000Z',
        citationId: citation.id,
        action: 'ACKNOWLEDGE',
      });

  const storyMember = context.story?.publications
    .find((publication) => publication.kind === 'story')
    ?.members.find((member) => member.name === STORY_REVIEW_MODEL_FILE);
  if (storyMember) {
    const model = parseStoryReviewModel(JSON.parse(storyMember.bytes.toString('utf8')));
    for (const finding of model.findings)
      if (finding.required)
        dispositions.push({
          type: 'finding',
          ts: '2026-07-19T00:00:01.000Z',
          findingKey: finding.id,
          action: 'RESOLVE',
        });
    for (const question of model.questions)
      if (question.required)
        dispositions.push({
          type: 'prompt',
          ts: '2026-07-19T00:00:02.000Z',
          promptKey: question.id,
          action: 'ACKNOWLEDGE',
        });
  }

  if (dispositions.length > 0)
    expect(await runJournal(args(review.branch, JSON.stringify(dispositions)), review.root)).toBe(
      0
    );
}

const storyLifecycleEvent = (
  action: 'COMPLETE' | 'PARTIAL' | 'REOPEN',
  generation: { floorInputHash: string; storyGeneration: string | null },
  ledgerGeneration: string,
  remainingWork?: string
) => ({
  type: 'review_lifecycle',
  ts: '2026-07-12T00:00:00.000Z',
  action,
  review_basis: 'STORY',
  floor_input_hash: generation.floorInputHash,
  story_generation: generation.storyGeneration,
  ledger_generation: ledgerGeneration,
  actor: 'REVIEWER',
  source: 'WATCH',
  ...(remainingWork === undefined ? {} : { remaining_work: remainingWork }),
});

const floorOnlyLifecycleEvent = (
  action: 'COMPLETE' | 'PARTIAL' | 'REOPEN',
  floorInputHash: string,
  ledgerGeneration: string,
  remainingWork?: string
) => ({
  type: 'review_lifecycle',
  ts: '2026-07-12T00:00:00.000Z',
  action,
  review_basis: 'FLOOR_ONLY',
  floor_input_hash: floorInputHash,
  story_generation: null,
  ledger_generation: ledgerGeneration,
  actor: 'REVIEWER',
  source: 'WATCH',
  ...(remainingWork === undefined ? {} : { remaining_work: remainingWork }),
});

describe('review journal — append + replay round-trip', () => {
  it('appends a valid event and emits the replayed ledger', async () => {
    const review = await publishedReview();
    const threadKey = review.threadKeys[0]!;
    const section = (ts: string, action: string, reason?: string) =>
      JSON.stringify({
        type: 'section',
        ts,
        threadKey,
        action,
        ...(reason === undefined ? {} : { reason }),
      });

    expect(
      await runJournal(
        args(review.branch, section('2026-07-09T00:00:00.000Z', 'VISIT')),
        review.root
      )
    ).toBe(0);
    expect(lastLedger().sections).toEqual([
      { threadKey, state: 'visited', reason: null, ts: '2026-07-09T00:00:00.000Z' },
    ]);

    // The retained event replays on a later read; the ledger is derived, not stored.
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    expect(lastLedger().sections).toHaveLength(1);

    expect(
      await runJournal(
        args(review.branch, section('2026-07-09T00:00:01.000Z', 'PARTIAL', 'work remains')),
        review.root
      )
    ).toBe(0);
    expect(lastLedger().sections[0]?.state).toBe('partial');

    // VISIT on re-open never downgrades the explicit disposition.
    expect(
      await runJournal(
        args(review.branch, section('2026-07-09T00:00:02.000Z', 'VISIT')),
        review.root
      )
    ).toBe(0);
    expect(lastLedger().sections[0]?.state).toBe('partial');
  }, 300_000);

  it('rejects a reason-gated event (finding DISMISS without reason) with exit 1', async () => {
    const review = await publishedReview();
    const dismiss = JSON.stringify({
      type: 'finding',
      ts: '2026-07-09T00:00:00.000Z',
      findingKey: 'F1',
      action: 'DISMISS',
    });
    expect(await runJournal(args(review.branch, dismiss), review.root)).toBe(1);
    expect(err.join('')).toContain('requires a reason');
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    expect(lastLedger().findings).toEqual([]);
  }, 300_000);

  it('rejects unknown event fields without retaining a normalized event', async () => {
    const review = await publishedReview();
    const event = JSON.stringify({
      type: 'finding',
      ts: '2026-07-09T00:00:00.000Z',
      findingKey: 'F1',
      action: 'ACKNOWLEDGE',
      unexpected: true,
    });
    expect(await runJournal(args(review.branch, event), review.root)).toBe(1);
    expect(err.join('')).toContain('unexpected');
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    expect(lastLedger().findings).toEqual([]);
  }, 300_000);

  it('requires --branch', async () => {
    expect(await runJournal({ cmd: 'review', sub: 'journal', json: true }, process.cwd())).toBe(1);
    expect(err.join('')).toContain('--branch');
  });

  it('refuses an event whose section is absent from the selected floor', async () => {
    const review = await publishedReview();
    const visit = JSON.stringify({
      type: 'section',
      ts: '2026-07-09T00:00:00.000Z',
      threadKey: 'a-thread-the-floor-does-not-carry',
      action: 'VISIT',
    });
    expect(await runJournal(args(review.branch, visit), review.root)).toBe(1);
    expect(JSON.parse(err.join(''))).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    expect(lastLedger().sections).toEqual([]);
  }, 300_000);

  it('appends a batch (JSON array) atomically: all events land, shared ts/reason preserved', async () => {
    const review = await publishedReview();
    const citations = review.floor.citations
      .filter((citation) => citation.kind === 'CHECKPOINT_UNCERTAINTY')
      .map((citation) => citation.id);
    expect(citations.length, 'the capture carries an uncertainty to disposition').toBeGreaterThan(
      0
    );
    const ts = '2026-07-09T00:00:00.000Z';
    const reason = 'triaged together at the end of the pass';
    const batch = citations.map((citationId) => ({
      type: 'uncertainty',
      ts,
      citationId,
      action: 'ACKNOWLEDGE',
      reason,
    }));
    expect(await runJournal(args(review.branch, JSON.stringify(batch)), review.root)).toBe(0);
    const ledger = lastLedger();
    expect(ledger.uncertainties).toHaveLength(citations.length);
    for (const entry of ledger.uncertainties) {
      expect(entry.state).toBe('ACKNOWLEDGED');
      expect(entry.ts).toBe(ts);
      expect(entry.reason).toBe(reason);
    }
  }, 300_000);

  it('one invalid event in a batch appends NOTHING (all-or-nothing) with exit 1', async () => {
    const review = await publishedReview();
    const ts = '2026-07-09T00:00:00.000Z';
    const batch = JSON.stringify([
      { type: 'uncertainty', ts, citationId: 'cite:art1:cp1:uncertainty:0', action: 'ACKNOWLEDGE' },
      // Reason-gated: finding DISMISS without a reason poisons the whole batch.
      { type: 'finding', ts, findingKey: 'F1', action: 'DISMISS' },
    ]);
    expect(await runJournal(args(review.branch, batch), review.root)).toBe(1);
    expect(err.join('')).toContain('invalid event at index 1');
    expect(err.join('')).toContain('requires a reason');
    expect(err.join('')).toContain('nothing appended');
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    expect(lastLedger().uncertainties).toEqual([]);
  }, 300_000);

  it('rejects an empty batch — an empty array has nothing to append', async () => {
    const review = await publishedReview();
    expect(await runJournal(args(review.branch, '[]'), review.root)).toBe(1);
    expect(err.join('')).toContain('event array is empty');
  }, 300_000);
});

describe('review journal — atomic RECORD_REVIEW_COVERAGE guards', () => {
  it('appends one multi-section event as one retained event when both generations match', async () => {
    const review = await publishedReview();
    expect(review.threadKeys.length).toBeGreaterThan(1);
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    const generation = lastLedgerGeneration();
    const rowFor = (name: string) => ({
      file: `src/${name}.ts`,
      side: 'add' as const,
      lineHash: `h_${name}`,
      line: 1,
    });
    const threads = await Promise.all(
      review.threadKeys.slice(0, 2).map(async (threadKey, index) => {
        const rows = [rowFor(`t${index}`)];
        return { threadKey, coveredRows: rows, coveredRowsDigest: await reviewedRowsDigest(rows) };
      })
    );
    const event = {
      type: 'review_coverage',
      ts: '2026-07-12T00:00:00.000Z',
      action: 'RECORD_REVIEW_COVERAGE',
      floor_input_hash: review.floorInputHash,
      ledger_generation: generation,
      threads,
    };
    expect(await runJournal(args(review.branch, JSON.stringify(event)), review.root)).toBe(0);
    const coverage = lastLedger().coverage;
    // Coverage is keyed by threadKey and read back unordered relative to the event's
    // thread array; consumers resolve entries by key (`.find`), never by position, so
    // the retained set is what matters, not its order.
    expect(new Set(coverage.map((entry) => entry.threadKey))).toEqual(
      new Set(threads.map((t) => t.threadKey))
    );
  }, 300_000);

  it('retains nothing on a stale floor generation', async () => {
    const review = await publishedReview();
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    const rows = [{ file: 'a', side: 'add' as const, lineHash: 'h', line: 1 }];
    const event = {
      type: 'review_coverage',
      ts: '2026-07-12T00:00:00.000Z',
      action: 'RECORD_REVIEW_COVERAGE',
      floor_input_hash: 'older_floor',
      ledger_generation: lastLedgerGeneration(),
      threads: [
        {
          threadKey: review.threadKeys[0]!,
          coveredRows: rows,
          coveredRowsDigest: await reviewedRowsDigest(rows),
        },
      ],
    };
    expect(await runJournal(args(review.branch, JSON.stringify(event)), review.root)).toBe(1);
    expect(JSON.parse(err.join(''))).toMatchObject({
      ok: false,
      code: 'STALE_FLOOR',
      message: WORKFLOW_STALE_FLOOR_MESSAGE,
    });
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    expect(lastLedger().coverage).toEqual([]);
  }, 300_000);

  it('retains nothing when another action advanced the ledger generation', async () => {
    const review = await publishedReview();
    const threadKey = review.threadKeys[0]!;
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    const staleGeneration = lastLedgerGeneration();
    const visit = { type: 'section', ts: '2026-07-12T00:00:00.000Z', threadKey, action: 'VISIT' };
    expect(await runJournal(args(review.branch, JSON.stringify(visit)), review.root)).toBe(0);
    const rows = [{ file: 'src/limiter.ts', side: 'add' as const, lineHash: 'h', line: 1 }];
    const coverage = {
      type: 'review_coverage',
      ts: '2026-07-12T00:00:01.000Z',
      action: 'RECORD_REVIEW_COVERAGE',
      floor_input_hash: review.floorInputHash,
      ledger_generation: staleGeneration,
      threads: [
        { threadKey, coveredRows: rows, coveredRowsDigest: await reviewedRowsDigest(rows) },
      ],
    };
    expect(await runJournal(args(review.branch, JSON.stringify(coverage)), review.root)).toBe(1);
    expect(JSON.parse(err.join(''))).toMatchObject({
      ok: false,
      code: 'STALE_LEDGER',
      message: WORKFLOW_STALE_LEDGER_MESSAGE,
    });
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    expect(lastLedger().coverage).toEqual([]);
    expect(lastLedger().sections).toHaveLength(1);
  }, 300_000);

  it('rejects mixed batches and invalid later sections before retaining anything', async () => {
    const review = await publishedReview();
    const threadKey = review.threadKeys[0]!;
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    const generation = lastLedgerGeneration();
    const rows = [{ file: 'a', side: 'add' as const, lineHash: 'h', line: 1 }];
    const digest = await reviewedRowsDigest(rows);
    const coverage = {
      type: 'review_coverage',
      ts: '2026-07-12T00:00:00.000Z',
      action: 'RECORD_REVIEW_COVERAGE',
      floor_input_hash: review.floorInputHash,
      ledger_generation: generation,
      threads: [{ threadKey, coveredRows: rows, coveredRowsDigest: digest }],
    };
    const visit = { type: 'section', ts: coverage.ts, threadKey, action: 'VISIT' };
    const cases: unknown[] = [
      [coverage, visit],
      {
        ...coverage,
        threads: [
          ...coverage.threads,
          { threadKey: review.threadKeys[1] ?? threadKey, coveredRows: [], coveredRowsDigest: 'x' },
        ],
      },
      { ...coverage, threads: [{ ...coverage.threads[0]!, threadKey: 'sec_unknown' }] },
      { ...coverage, threads: [{ ...coverage.threads[0]!, coveredRowsDigest: 'not-the-digest' }] },
    ];
    for (const candidate of cases) {
      err = [];
      expect(await runJournal(args(review.branch, JSON.stringify(candidate)), review.root)).toBe(1);
    }
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    expect(lastLedger().coverage).toEqual([]);
    expect(lastLedger().sections).toEqual([]);
  }, 300_000);
});

describe('review journal — generation-guarded lifecycle', () => {
  it('persists COMPLETE and reconstructs the same state on a fresh read', async () => {
    const review = await publishedReview();
    const storyGeneration = await sealStory(review);
    await dischargeStoryObligations(review);
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    const event = storyLifecycleEvent(
      'COMPLETE',
      { floorInputHash: review.floorInputHash, storyGeneration },
      lastLedgerGeneration()
    );
    expect(await runJournal(args(review.branch, JSON.stringify(event)), review.root)).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({ state: 'COMPLETE', stale: false });

    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({ state: 'COMPLETE', stale: false });
    expect(lastLedger().lifecycle.history).toHaveLength(1);
  }, 300_000);

  it('requires PARTIAL remaining work and preserves it after reload', async () => {
    const review = await publishedReview();
    const storyGeneration = await sealStory(review);
    const generation = { floorInputHash: review.floorInputHash, storyGeneration };
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    const ledgerGeneration = lastLedgerGeneration();
    expect(
      await runJournal(
        args(
          review.branch,
          JSON.stringify(storyLifecycleEvent('PARTIAL', generation, ledgerGeneration))
        ),
        review.root
      )
    ).toBe(1);
    expect(err.join('')).toContain('PARTIAL requires a remaining-work note');

    const partial = storyLifecycleEvent(
      'PARTIAL',
      generation,
      ledgerGeneration,
      'Re-read the limiter checkpoints.'
    );
    expect(await runJournal(args(review.branch, JSON.stringify(partial)), review.root)).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({
      state: 'PARTIAL',
      stale: false,
      current: { remainingWork: 'Re-read the limiter checkpoints.' },
    });

    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    expect(lastLedger().lifecycle.current).toMatchObject({
      remainingWork: 'Re-read the limiter checkpoints.',
    });
  }, 300_000);

  it('rejects stale floor, Story and ledger generations under their own codes', async () => {
    const review = await publishedReview();
    const storyGeneration = await sealStory(review);
    const generation = { floorInputHash: review.floorInputHash, storyGeneration };
    await coverEveryRow(review);
    await inspectEveryGapRow(review);
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    const ledgerGeneration = lastLedgerGeneration();
    const staleCases = [
      {
        event: storyLifecycleEvent(
          'COMPLETE',
          { ...generation, floorInputHash: 'older-floor' },
          ledgerGeneration
        ),
        code: 'STALE_FLOOR',
        message: WORKFLOW_STALE_FLOOR_MESSAGE,
      },
      {
        event: storyLifecycleEvent(
          'COMPLETE',
          { ...generation, storyGeneration: 'older-story' },
          ledgerGeneration
        ),
        code: 'STALE_STORY',
        message: WORKFLOW_STALE_STORY_MESSAGE,
      },
      {
        event: storyLifecycleEvent('COMPLETE', generation, 'older-ledger'),
        code: 'STALE_LEDGER',
        message: WORKFLOW_STALE_LEDGER_MESSAGE,
      },
    ];
    for (const { event, code, message } of staleCases) {
      err = [];
      expect(await runJournal(args(review.branch, JSON.stringify(event)), review.root)).toBe(1);
      expect(JSON.parse(err.join(''))).toMatchObject({ ok: false, code, message });
    }
    // Nothing was appended: the lifecycle is still open.
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    expect(lastLedger().lifecycle.state).toBe('OPEN');
  }, 300_000);

  it('pins the Story by its generation, not by the run that published it', async () => {
    const review = await publishedReview();
    const first = await sealStory(review);
    const second = await sealStory(review);
    // Two sealed runs over the same floor: the review's selected Story is the
    // newest, and a lifecycle event pins the generation the reviewer read.
    expect(second).toEqual(expect.any(String));
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    const event = storyLifecycleEvent(
      'PARTIAL',
      { floorInputHash: review.floorInputHash, storyGeneration: second },
      lastLedgerGeneration(),
      'Finish the remaining evidence.'
    );
    expect(await runJournal(args(review.branch, JSON.stringify(event)), review.root)).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({
      state: 'PARTIAL',
      stale: false,
      current: { storyGeneration: second },
    });
    // The earlier run's generation is no longer the one selected, whether or
    // not its content happened to be identical.
    err = [];
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    const stale = storyLifecycleEvent(
      'PARTIAL',
      { floorInputHash: review.floorInputHash, storyGeneration: `${first}-not-selected` },
      lastLedgerGeneration(),
      'Finish the remaining evidence.'
    );
    expect(await runJournal(args(review.branch, JSON.stringify(stale)), review.root)).toBe(1);
    expect(JSON.parse(err.join(''))).toMatchObject({ ok: false, code: 'STALE_STORY' });
  }, 600_000);

  it('treats a Story sealed against another floor as absent from the lifecycle domain', async () => {
    const review = await publishedReview();
    await sealStory(review);
    await review.fixture.commit(
      { 'src/limiter.ts': 'export const allow = (): boolean => true;\n' },
      'move the reviewed tree'
    );
    const moved = await republish(review);
    expect(moved.input_hash).not.toBe(review.floorInputHash);

    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    const event = floorOnlyLifecycleEvent(
      'PARTIAL',
      moved.input_hash,
      lastLedgerGeneration(),
      'Regenerate the Story for the moved tree.'
    );
    expect(await runJournal(args(review.branch, JSON.stringify(event)), review.root)).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({
      state: 'PARTIAL',
      stale: false,
      current: { reviewBasis: 'FLOOR_ONLY', storyGeneration: null },
    });
  }, 600_000);

  it('reopens append-only, retains completion history, and rejects duplicate transitions', async () => {
    const review = await publishedReview();
    const storyGeneration = await sealStory(review);
    const generation = { floorInputHash: review.floorInputHash, storyGeneration };
    await dischargeStoryObligations(review);
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    expect(
      await runJournal(
        args(
          review.branch,
          JSON.stringify(storyLifecycleEvent('COMPLETE', generation, lastLedgerGeneration()))
        ),
        review.root
      )
    ).toBe(0);
    const finished = lastLedgerGeneration();
    expect(
      await runJournal(
        args(review.branch, JSON.stringify(storyLifecycleEvent('COMPLETE', generation, finished))),
        review.root
      )
    ).toBe(1);
    expect(err.join('')).toContain('already finished');
    err = [];

    expect(
      await runJournal(
        args(review.branch, JSON.stringify(storyLifecycleEvent('REOPEN', generation, finished))),
        review.root
      )
    ).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({ state: 'OPEN', stale: false });
    expect(lastLedger().lifecycle.history.map((entry) => entry.action)).toEqual([
      'COMPLETE',
      'REOPEN',
    ]);

    expect(
      await runJournal(
        args(
          review.branch,
          JSON.stringify(storyLifecycleEvent('REOPEN', generation, lastLedgerGeneration()))
        ),
        review.root
      )
    ).toBe(1);
    expect(err.join('')).toContain('already open');
  }, 300_000);
});

describe('review journal — floor-only finish', () => {
  it('records a COMPLETE with no current Story, and it survives a reload non-stale', async () => {
    const review = await publishedReview();
    await coverEveryRow(review);
    await inspectEveryGapRow(review);
    // A review with no sealed run is a FLOOR_ONLY review: the reviewer read the
    // captured checkpoints, and no Story exists to have read.
    const dispositions: unknown[] = [];
    for (const citation of review.floor.citations)
      if (citation.kind === 'CHECKPOINT_UNCERTAINTY')
        dispositions.push({
          type: 'uncertainty',
          ts: '2026-07-19T00:00:00.000Z',
          citationId: citation.id,
          action: 'ACKNOWLEDGE',
        });
    if (dispositions.length > 0)
      expect(await runJournal(args(review.branch, JSON.stringify(dispositions)), review.root)).toBe(
        0
      );

    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    const event = floorOnlyLifecycleEvent(
      'COMPLETE',
      review.floorInputHash,
      lastLedgerGeneration()
    );
    expect(await runJournal(args(review.branch, JSON.stringify(event)), review.root)).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({
      state: 'COMPLETE',
      stale: false,
      current: { reviewBasis: 'FLOOR_ONLY', storyGeneration: null },
    });

    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({ state: 'COMPLETE', stale: false });
  }, 300_000);

  it('goes stale on a material floor change — and not on a rebuild that changes nothing', async () => {
    const review = await publishedReview();
    await coverEveryRow(review);
    await inspectEveryGapRow(review);
    const dispositions = review.floor.citations
      .filter((citation) => citation.kind === 'CHECKPOINT_UNCERTAINTY')
      .map((citation) => ({
        type: 'uncertainty',
        ts: '2026-07-19T00:00:00.000Z',
        citationId: citation.id,
        action: 'ACKNOWLEDGE',
      }));
    if (dispositions.length > 0)
      expect(await runJournal(args(review.branch, JSON.stringify(dispositions)), review.root)).toBe(
        0
      );
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    expect(
      await runJournal(
        args(
          review.branch,
          JSON.stringify(
            floorOnlyLifecycleEvent('COMPLETE', review.floorInputHash, lastLedgerGeneration())
          )
        ),
        review.root
      )
    ).toBe(0);

    // Republish over the unchanged tree: input_hash is content-addressed, so the
    // floor is byte-identical and the completion still stands.
    const rebuilt = await republish(review);
    expect(rebuilt.input_hash).toBe(review.floorInputHash);
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({ state: 'COMPLETE', stale: false });

    // The reviewed tree moves: a genuinely different floor stales the completion.
    await review.fixture.commit(
      { 'src/limiter.ts': 'export const allow = (): boolean => true;\n' },
      'move the reviewed tree'
    );
    const moved = await republish(review);
    expect(moved.input_hash).not.toBe(review.floorInputHash);
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({ state: 'COMPLETE', stale: true });
  }, 300_000);

  it('binds review_basis to story_generation in the schema, both directions', async () => {
    const review = await publishedReview();
    const storyGeneration = await sealStory(review);
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    const ledgerGeneration = lastLedgerGeneration();
    const base = {
      type: 'review_lifecycle',
      ts: '2026-07-12T00:00:00.000Z',
      action: 'COMPLETE',
      floor_input_hash: review.floorInputHash,
      ledger_generation: ledgerGeneration,
      actor: 'REVIEWER',
      source: 'WATCH',
    };

    err = [];
    expect(
      await runJournal(
        args(
          review.branch,
          JSON.stringify({ ...base, review_basis: 'FLOOR_ONLY', story_generation: storyGeneration })
        ),
        review.root
      )
    ).toBe(1);
    expect(err.join('')).toContain('FLOOR_ONLY pins no Story generation');

    err = [];
    expect(
      await runJournal(
        args(
          review.branch,
          JSON.stringify({ ...base, review_basis: 'STORY', story_generation: null })
        ),
        review.root
      )
    ).toBe(1);
    expect(err.join('')).toContain('STORY requires the Story generation');

    err = [];
    expect(
      await runJournal(
        args(review.branch, JSON.stringify({ ...base, story_generation: storyGeneration })),
        review.root
      )
    ).toBe(1);
    expect(err.join('')).toContain('review_basis');
  }, 300_000);
});

describe('review journal — the finish gate is enforced at the transport', () => {
  async function attemptFloorOnlyComplete(review: PublishedReview): Promise<number> {
    out = [];
    err = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    const event = floorOnlyLifecycleEvent(
      'COMPLETE',
      review.floorInputHash,
      lastLedgerGeneration()
    );
    return runJournal(args(review.branch, JSON.stringify(event)), review.root);
  }

  it('refuses a COMPLETE while any floor row is uncovered', async () => {
    const review = await publishedReview();
    // No coverage event at all — the reviewer read nothing.
    expect(await attemptFloorOnlyComplete(review)).toBe(1);
    expect(err.join('')).toContain('row(s) not covered');
  }, 300_000);

  it('refuses a COMPLETE while an unexplained row is uninspected', async () => {
    // A stray commit is code on the branch that no checkpoint claims. Finishing
    // over it files the review as done having never looked at the one part of
    // the change nobody explained.
    const review = await publishedReview({
      strayCommit: { 'src/nobody-claimed.ts': 'export const orphan = 1;\n' },
    });
    await coverEveryRow(review);
    const dispositions = review.floor.citations
      .filter((citation) => citation.kind === 'CHECKPOINT_UNCERTAINTY')
      .map((citation) => ({
        type: 'uncertainty',
        ts: '2026-07-19T00:00:00.000Z',
        citationId: citation.id,
        action: 'ACKNOWLEDGE',
      }));
    if (dispositions.length > 0)
      expect(await runJournal(args(review.branch, JSON.stringify(dispositions)), review.root)).toBe(
        0
      );
    expect(await attemptFloorOnlyComplete(review)).toBe(1);
    expect(err.join('')).toContain('unexplained row(s) not inspected');
  }, 300_000);

  it('refuses a COMPLETE while the reviewer has an open comment on the branch', async () => {
    const review = await publishedReview();
    await coverEveryRow(review);
    await inspectEveryGapRow(review);
    const dispositions = review.floor.citations
      .filter((citation) => citation.kind === 'CHECKPOINT_UNCERTAINTY')
      .map((citation) => ({
        type: 'uncertainty',
        ts: '2026-07-19T00:00:00.000Z',
        citationId: citation.id,
        action: 'ACKNOWLEDGE',
      }));
    if (dispositions.length > 0)
      expect(await runJournal(args(review.branch, JSON.stringify(dispositions)), review.root)).toBe(
        0
      );

    // The agent's half of the loop has not arrived: the reviewer's own question
    // hangs unanswered, so COMPLETE is refused.
    const { floor, diff } = await retainedBundle(review);
    const hunks = parsePatchHunks(diff, new Set(floor.coverage.items.map((item) => item.file)));
    const anchored = hunks
      .flatMap((hunk) => hunk.lines.map((line) => ({ hunk, line })))
      .find((entry) => entry.line.side === 'add' && entry.line.body.trim().length > 0)!;
    const item = floor.coverage.items.find((entry) => entry.file === anchored.hunk.file)!;
    const commentId = uuidv7();
    await applyDatabaseReviewComments({
      branch: review.branch,
      cwd: review.root,
      dataRoot: review.fixture.dataRoot,
      projectId: review.fixture.projectId,
      operationId: uuidv7(),
      events: [
        {
          type: 'add',
          comment_id: commentId,
          ts: '2026-07-12T00:00:00.000Z',
          author: 'reviewer',
          body: 'why is this unbounded?',
          anchor: {
            kind: 'DIFF_LINE',
            file: anchored.hunk.file,
            side: 'add',
            line: anchored.line.new!,
            lineHash: await lineHash('add', new TextEncoder().encode(anchored.line.body)),
            hunkKey: item.hunkKey,
          },
        },
      ],
      secretAllow: [],
    });
    expect(await attemptFloorOnlyComplete(review)).toBe(1);
    expect(err.join('')).toContain('open reviewer comment(s)');

    // Resolving it clears the gate.
    await applyDatabaseReviewComments({
      branch: review.branch,
      cwd: review.root,
      dataRoot: review.fixture.dataRoot,
      projectId: review.fixture.projectId,
      operationId: uuidv7(),
      events: [
        {
          type: 'status',
          comment_id: commentId,
          ts: '2026-07-12T01:00:00.000Z',
          author: 'reviewer',
          status: 'resolved',
        },
      ],
      secretAllow: [],
    });
    expect(await attemptFloorOnlyComplete(review)).toBe(0);
  }, 300_000);

  it('refuses a COMPLETE while a captured uncertainty is undispositioned', async () => {
    // The capture's checkpoints carry an uncertainty. It is a floor citation, so
    // no Story is involved in raising it or clearing it.
    const review = await publishedReview();
    const uncertainties = review.floor.citations.filter(
      (citation) => citation.kind === 'CHECKPOINT_UNCERTAINTY'
    );
    expect(uncertainties.length, 'the capture carries an uncertainty').toBeGreaterThan(0);
    await coverEveryRow(review);
    await inspectEveryGapRow(review);

    expect(await attemptFloorOnlyComplete(review)).toBe(1);
    expect(err.join('')).toContain('not dispositioned');

    // Disposition it and the same COMPLETE lands.
    expect(
      await runJournal(
        args(
          review.branch,
          JSON.stringify(
            uncertainties.map((citation) => ({
              type: 'uncertainty',
              ts: '2026-07-12T01:00:00.000Z',
              citationId: citation.id,
              action: 'ACKNOWLEDGE',
            }))
          )
        ),
        review.root
      )
    ).toBe(0);
    expect(await attemptFloorOnlyComplete(review)).toBe(0);
  }, 300_000);

  it('enforces the same gate on the STORY basis — a Story excuses nothing', async () => {
    // The obligations are facts about the branch. Composing a Story around an
    // uncovered row does not review it.
    const review = await publishedReview();
    const storyGeneration = await sealStory(review);
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    err = [];
    expect(
      await runJournal(
        args(
          review.branch,
          JSON.stringify(
            storyLifecycleEvent(
              'COMPLETE',
              { floorInputHash: review.floorInputHash, storyGeneration },
              lastLedgerGeneration()
            )
          )
        ),
        review.root
      )
    ).toBe(1);
    expect(err.join('')).toContain('row(s) not covered');
  }, 300_000);

  it('rejects required Story items by exact id until every one is dispositioned', async () => {
    const review = await publishedReview();
    const storyGeneration = await sealStory(review);
    await coverEveryRow(review);
    await inspectEveryGapRow(review);
    const uncertainties = review.floor.citations
      .filter((citation) => citation.kind === 'CHECKPOINT_UNCERTAINTY')
      .map((citation) => ({
        type: 'uncertainty',
        ts: '2026-07-19T00:00:00.000Z',
        citationId: citation.id,
        action: 'ACKNOWLEDGE',
      }));
    if (uncertainties.length > 0)
      expect(
        await runJournal(args(review.branch, JSON.stringify(uncertainties)), review.root)
      ).toBe(0);

    const context = await readDatabaseReviewContext({
      branch: review.branch,
      cwd: review.root,
      dataRoot: review.fixture.dataRoot,
      projectId: review.fixture.projectId,
    });
    const storyMember = context
      .story!.publications.find((publication) => publication.kind === 'story')!
      .members.find((member) => member.name === STORY_REVIEW_MODEL_FILE)!;
    const model = parseStoryReviewModel(JSON.parse(storyMember.bytes.toString('utf8')));
    const requiredFindings = model.findings.filter((finding) => finding.required);
    const requiredQuestions = model.questions.filter((question) => question.required);
    expect(requiredFindings.length + requiredQuestions.length).toBeGreaterThan(0);

    const generation = { floorInputHash: review.floorInputHash, storyGeneration };
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    err = [];
    expect(
      await runJournal(
        args(
          review.branch,
          JSON.stringify(storyLifecycleEvent('COMPLETE', generation, lastLedgerGeneration()))
        ),
        review.root
      )
    ).toBe(1);
    expect(err.join('')).toContain('required Story item(s)');

    const dispositions = [
      ...requiredFindings.map((finding) => ({
        type: 'finding',
        ts: '2026-07-23T11:01:00.000Z',
        findingKey: finding.id,
        action: 'RESOLVE',
      })),
      ...requiredQuestions.map((question) => ({
        type: 'prompt',
        ts: '2026-07-23T11:02:00.000Z',
        promptKey: question.id,
        action: 'ACKNOWLEDGE',
      })),
    ];
    expect(await runJournal(args(review.branch, JSON.stringify(dispositions)), review.root)).toBe(
      0
    );
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    expect(
      await runJournal(
        args(
          review.branch,
          JSON.stringify(storyLifecycleEvent('COMPLETE', generation, lastLedgerGeneration()))
        ),
        review.root
      )
    ).toBe(0);
  }, 300_000);

  it('lets PARTIAL and REOPEN through — the gate is about calling it DONE', async () => {
    const review = await publishedReview();
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    expect(
      await runJournal(
        args(
          review.branch,
          JSON.stringify(
            floorOnlyLifecycleEvent(
              'PARTIAL',
              review.floorInputHash,
              lastLedgerGeneration(),
              'checkpoints unread'
            )
          )
        ),
        review.root
      )
    ).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({
      state: 'PARTIAL',
      current: { reviewBasis: 'FLOOR_ONLY', remainingWork: 'checkpoints unread' },
    });
    expect(
      await runJournal(
        args(
          review.branch,
          JSON.stringify(
            floorOnlyLifecycleEvent('REOPEN', review.floorInputHash, lastLedgerGeneration())
          )
        ),
        review.root
      )
    ).toBe(0);
    expect(lastLedger().lifecycle.state).toBe('OPEN');
  }, 300_000);
});

describe('review journal — stdin transport (--input -)', () => {
  it('round-trips a multi-MB coverage event: append via stdin → store → replay', async () => {
    const review = await publishedReview();
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    const { event, rows, digest } = await bigCoverageEvent(
      40_000,
      review.floorInputHash,
      lastLedgerGeneration(),
      review.threadKeys[0]!
    );
    const json = JSON.stringify(event);
    // The payload class this transport exists for: bigger than a typical argv
    // limit AND the old 4MB execFile stdout cap.
    expect(json.length).toBeGreaterThan(5 * 1024 * 1024);

    expect(
      await runJournal(stdinArgs(review.branch), review.root, process.env, Readable.from([json]))
    ).toBe(0);

    // Replayed ledger: current coverage carries the full manifest, untruncated.
    const entry = lastLedger().coverage[0]!;
    expect(entry.coveredRows).toHaveLength(rows.length);
    expect(entry.coveredRows[0]).toEqual(rows[0]);
    expect(entry.coveredRows[rows.length - 1]).toEqual(rows[rows.length - 1]);
    expect(entry.coveredRowsDigest).toBe(digest);
  }, 300_000);

  it('rejects an over-cap stdin payload loudly and appends nothing', async () => {
    const review = await publishedReview();
    // Stream past the cap in 8MB chunks — the reader must reject on total size,
    // never truncate into a half-parsed event.
    const chunk = Buffer.alloc(8 * 1024 * 1024, 0x78);
    const chunks = Array.from({ length: 9 }, () => chunk); // 72MB > 64MB cap
    expect(
      await runJournal(stdinArgs(review.branch), review.root, process.env, Readable.from(chunks))
    ).toBe(1);
    expect(err.join('')).toContain('64MB cap');
    expect(err.join('')).toContain(String(JOURNAL_STDIN_CAP_BYTES));
    expect(err.join('')).toContain('nothing appended');
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    expect(lastLedger().coverage).toEqual([]);
  }, 300_000);

  it('keeps batch all-or-nothing semantics identical over stdin', async () => {
    const review = await publishedReview();
    const ts = '2026-07-09T00:00:00.000Z';
    const batch = JSON.stringify([
      { type: 'uncertainty', ts, citationId: 'cite:art1:cp1:uncertainty:0', action: 'ACKNOWLEDGE' },
      { type: 'finding', ts, findingKey: 'F1', action: 'DISMISS' }, // reason-gated
    ]);
    expect(
      await runJournal(stdinArgs(review.branch), review.root, process.env, Readable.from([batch]))
    ).toBe(1);
    expect(err.join('')).toContain('invalid event at index 1');
    expect(err.join('')).toContain('nothing appended');
    out = [];
    expect(await runJournal(args(review.branch), review.root)).toBe(0);
    expect(lastLedger().uncertainties).toEqual([]);
  }, 300_000);

  it("rejects --input values other than '-'", async () => {
    const bad: ReviewArgs = {
      cmd: 'review',
      sub: 'journal',
      branch: 'demo',
      json: true,
      input: 'x',
    };
    expect(await runJournal(bad, process.cwd(), process.env, Readable.from(['']))).toBe(1);
    expect(err.join('')).toContain("only '-'");
  });

  it('rejects --add combined with --input', async () => {
    const both: ReviewArgs = {
      cmd: 'review',
      sub: 'journal',
      branch: 'demo',
      json: true,
      input: '-',
      addEvent: '{}',
    };
    expect(await runJournal(both, process.cwd(), process.env, Readable.from(['{}']))).toBe(1);
    expect(err.join('')).toContain('not both');
  });
});
