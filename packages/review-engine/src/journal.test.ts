// Headless round-trip for the `review journal` verb: locked append + replay →
// ledger, the schema reason-gate, fail-closed malformed/torn state, and
// the stdin transport (`--input -`) for events too large for argv.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildReviewFloorFixture,
  floorSchema,
  prepareReviewCoverageEvent,
  type ReviewedRow,
  reviewedRowsDigest,
  type ReviewLedgerV2,
} from '@orcaops/review-core';
import {
  archiveProjectDir,
  archiveReviewPaths,
  ArtifactLock,
  ArtifactLockLeaseLostError,
} from '@orcaops/storage';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { REVIEW_ARCHIVE_WARNING_CODE } from './archive.js';
import { CURRENT_STORY_POINTER_FILE, publishCurrentStoryForRun } from './currentStory.js';
import { JOURNAL_STDIN_CAP_BYTES, runJournal } from './journal.js';
import { REVIEW_STATE_VERSION, reviewStateLockKey } from './reviewState.js';
import { buildCurrentThreadManifests, buildEligibleNarrativeTargets } from './reviewTargets.js';
import type { ReviewArgs } from './run.js';
import {
  serializeStoryReviewModel,
  STORY_REVIEW_MODEL_FILE,
  STORY_REVIEW_MODEL_SCHEMA_VERSION,
  storyReviewGeneration,
  type StoryReviewModel,
} from './storyReviewModel.js';
import { terminalRunFileSeed } from '../tests/support/twolaneRunFile.js';

let root: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'orcaops-journal-test-'));
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

/** A synthetic row-coverage event large enough to require stdin transport. */
async function bigCoverageEvent(
  rowCount: number,
  floorInputHash: string,
  ledgerGeneration: string
): Promise<{
  event: Record<string, unknown>;
  rows: ReviewedRow[];
  digest: string;
}> {
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
      threads: [{ threadKey: 'sec_a', coveredRows: rows, coveredRowsDigest: digest }],
    },
    rows,
    digest,
  };
}

const journalFile = (slug: string) =>
  path.join(root, '.orcaops', 'reviews', slug, 'journal.ndjson');

function lastLedger(): ReviewLedgerV2 {
  return JSON.parse(out[out.length - 1]!) as ReviewLedgerV2;
}

function lastLedgerGeneration(): string {
  return (JSON.parse(out[out.length - 1]!) as { ledger_generation: string }).ledger_generation;
}

/** The patch the `clean` golden floor's rows are cut from. */
const FIXTURE_DIFF = [
  'diff --git a/src/fixture.ts b/src/fixture.ts',
  '--- a/src/fixture.ts',
  '+++ b/src/fixture.ts',
  '@@ -1,0 +1 @@',
  '+stable fixture row',
  '',
].join('\n');

const reviewDir = (branch: string) =>
  path.join(root, '.orcaops', 'reviews', branch.replace('/', '%2F'));

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function storyModel(
  branch: string,
  floorInputHash: string,
  banner = 'code only',
  requiredStoryItems = false
): StoryReviewModel {
  return {
    schema_version: STORY_REVIEW_MODEL_SCHEMA_VERSION,
    branch,
    floor_input_hash: floorInputHash,
    label: 'CODE_ONLY',
    banner,
    overview: null,
    acts: [],
    parts: [],
    residue: { contested: [], unattributed: [], reviewableRows: 0, files: [] },
    metrics: {
      reviewableRows: 0,
      attributedRows: 0,
      attributedPct: 0,
      ambiguousRows: 0,
      contestedRows: 0,
      unattributedRows: 0,
      contributingThreads: 0,
      contributingCheckpoints: 0,
    },
    ledger: [],
    uncertainties: [],
    findings: requiredStoryItems
      ? [
          {
            id: 'finding:required-story',
            lane: 'forensic',
            text: 'The required Story finding remains open.',
            file: 'src/fixture.ts',
            relatedFiles: [],
            severity: 'CRITICAL',
            confidence: 'HIGH',
            citationsByLane: { account: [], forensic: [] },
            required: true,
          },
        ]
      : [],
    questions: requiredStoryItems
      ? [
          {
            id: 'question:required-story',
            lane: 'account',
            text: 'Has the required Story question been answered?',
            file: null,
            citationsByLane: { account: [], forensic: [] },
            required: true,
          },
        ]
      : [],
    citations: {},
    artifactAliases: {},
  };
}

async function installStory(input: {
  branch?: string;
  floorInputHash: string;
  runId?: string;
  finalizedAt?: string;
  banner?: string;
  requiredStoryItems?: boolean;
  point?: boolean;
}): Promise<string> {
  const branch = input.branch ?? 'demo';
  const runId = input.runId ?? '11111111-1111-4111-8111-111111111111';
  const finalizedAt = input.finalizedAt ?? '2026-07-23T10:00:00.000Z';
  const model = storyModel(
    branch,
    input.floorInputHash,
    input.banner,
    input.requiredStoryItems ?? false
  );
  const modelBytes = serializeStoryReviewModel(model);
  const modelSha = sha256(modelBytes);
  const dir = reviewDir(branch);
  const twolaneDir = path.join(dir, 'twolane');
  const runDir = path.join(twolaneDir, runId);
  const inputShas = { dossier: 'dossier', projection: 'projection' };
  await mkdir(runDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(runDir, STORY_REVIEW_MODEL_FILE), modelBytes),
    writeFile(
      path.join(runDir, 'run-v1.json'),
      `${JSON.stringify(terminalRunFileSeed({ runId, branch, finalizedAt, inputShas }))}\n`
    ),
    writeFile(
      path.join(runDir, 'run-record-v1.json'),
      `${JSON.stringify({
        schema_version: 1,
        run_id: runId,
        branch,
        input_shas: inputShas,
        finalized_at: finalizedAt,
        outcome: 'FULL',
        outputs: {
          story_review_model: STORY_REVIEW_MODEL_FILE,
          story_review_model_sha256: modelSha,
        },
      })}\n`
    ),
  ]);
  if (input.point !== false)
    await writeFile(
      path.join(twolaneDir, CURRENT_STORY_POINTER_FILE),
      `${JSON.stringify({
        schema_version: 1,
        run_id: runId,
        finalized_at: finalizedAt,
        floor_input_hash: input.floorInputHash,
        model_file: STORY_REVIEW_MODEL_FILE,
        model_sha256: modelSha,
      })}\n`
    );
  return storyReviewGeneration(model);
}

async function writeFloor(branch = 'demo'): Promise<{
  floorInputHash: string;
  storyGeneration: string;
}> {
  const fixture = buildReviewFloorFixture('clean');
  const floor = fixture.floor;
  floor.scope.branch = branch;
  floor.scope.branch_slug = branch.replace('/', '%2F');
  floor.outline.threads.push(
    { threadKey: 'sec_a', order: 2, title: 'A', artifact: 'artifact-a', checkpoints: [] },
    { threadKey: 'sec_b', order: 3, title: 'B', artifact: 'artifact-b', checkpoints: [] }
  );
  const dir = reviewDir(branch);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'review-state.json'),
    `${JSON.stringify({ review_state_version: REVIEW_STATE_VERSION })}\n`
  );
  await writeFile(path.join(dir, 'floor.json'), JSON.stringify(floor));
  // The patch is REQUIRED for the finish gate to derive anything: without it the
  // target build fails and the gate fails closed, which is itself a test below.
  await writeFile(path.join(dir, 'diff.patch'), FIXTURE_DIFF);
  return {
    floorInputHash: floor.input_hash,
    storyGeneration: await installStory({ branch, floorInputHash: floor.input_hash }),
  };
}

/** Remove only the authoritative pointer; orphaned immutable runs are not current. */
async function removeStory(branch = 'demo'): Promise<void> {
  await rm(path.join(reviewDir(branch), 'twolane', CURRENT_STORY_POINTER_FILE), { force: true });
}

/**
 * Cover every reviewable row on the branch — what a reviewer who actually read
 * every checkpoint leaves behind. Built with the PRODUCTION preparer, so a
 * coverage event this test writes is one Watch could have written.
 */
async function coverEveryRow(branch = 'demo'): Promise<void> {
  const dir = reviewDir(branch);
  const floor = floorSchema.parse(JSON.parse(await readFile(path.join(dir, 'floor.json'), 'utf8')));
  const diffText = await readFile(path.join(dir, 'diff.patch'), 'utf8');
  const targets = await buildEligibleNarrativeTargets(floor, diffText);
  const currentThreads = await buildCurrentThreadManifests(floor, targets);

  const partRowsByThread = new Map<string, readonly ReviewedRow[]>();
  for (const manifest of currentThreads) {
    if (manifest.rows !== null && manifest.rows.length > 0) {
      partRowsByThread.set(manifest.threadKey, manifest.rows);
    }
  }
  expect(partRowsByThread.size, 'the fixture floor must carry rows to cover').toBeGreaterThan(0);

  out = [];
  expect(await runJournal(args(branch), root)).toBe(0);
  const prepared = await prepareReviewCoverageEvent({
    floorInputHash: floor.input_hash,
    ledgerGeneration: lastLedgerGeneration(),
    priorCoverage: [],
    currentThreads,
    partRowsByThread,
    now: '2026-07-12T00:00:00.000Z',
  });
  expect(prepared.status).toBe('ready');
  expect(await runJournal(args(branch, JSON.stringify(prepared.event)), root)).toBe(0);
}

describe('review journal — append + replay round-trip', () => {
  it('refuses a final journal symlink without changing its external target', async () => {
    await writeFloor();
    const external = path.join(root, 'external-journal.ndjson');
    await writeFile(external, '');
    await symlink(external, journalFile('demo'));
    const visit = JSON.stringify({
      type: 'section',
      ts: '2026-07-09T00:00:00.000Z',
      threadKey: 'S1',
      action: 'VISIT',
    });

    await expect(runJournal(args('demo', visit), root)).rejects.toThrow(/symbolic link/u);
    await expect(readFile(external, 'utf8')).resolves.toBe('');
  });

  it('appends a valid event under the lock and emits the replayed ledger', async () => {
    const visit = JSON.stringify({
      type: 'section',
      ts: '2026-07-09T00:00:00.000Z',
      threadKey: 'S1',
      action: 'VISIT',
    });
    expect(await runJournal(args('demo', visit), root)).toBe(0);
    expect(lastLedger().sections).toEqual([
      {
        threadKey: 'S1',
        state: 'visited',
        reason: null,
        ts: '2026-07-09T00:00:00.000Z',
      },
    ]);

    // The file holds the schema-normalized line; a later read replays it.
    const onDisk = await readFile(journalFile('demo'), 'utf8');
    expect(onDisk.trim().split('\n')).toHaveLength(1);

    const partial = JSON.stringify({
      type: 'section',
      ts: '2026-07-09T00:00:01.000Z',
      threadKey: 'S1',
      action: 'PARTIAL',
      reason: 'work remains',
    });
    expect(await runJournal(args('demo', partial), root)).toBe(0);
    expect(lastLedger().sections[0]?.state).toBe('partial');

    // VISIT on re-open never downgrades the explicit disposition.
    const revisit = JSON.stringify({
      type: 'section',
      ts: '2026-07-09T00:00:02.000Z',
      threadKey: 'S1',
      action: 'VISIT',
    });
    expect(await runJournal(args('demo', revisit), root)).toBe(0);
    expect(lastLedger().sections[0]?.state).toBe('partial');
  });

  it('slugifies the branch for the journal path (slash-safe)', async () => {
    const visit = JSON.stringify({
      type: 'section',
      ts: '2026-07-09T00:00:00.000Z',
      threadKey: 'S1',
      action: 'VISIT',
    });
    expect(await runJournal(args('demo/x', visit), root)).toBe(0);
    await expect(readFile(journalFile('demo%2Fx'), 'utf8')).resolves.toContain('"S1"');
  });

  it('rejects a reason-gated event (finding DISMISS without reason) with exit 1', async () => {
    const dismiss = JSON.stringify({
      type: 'finding',
      ts: '2026-07-09T00:00:00.000Z',
      findingKey: 'F1',
      action: 'DISMISS',
    });
    expect(await runJournal(args('demo', dismiss), root)).toBe(1);
    expect(err.join('')).toContain('requires a reason');
    await expect(readFile(journalFile('demo'), 'utf8')).rejects.toThrow();
  });

  it('rejects unknown event fields without writing a normalized journal line', async () => {
    const event = JSON.stringify({
      type: 'finding',
      ts: '2026-07-09T00:00:00.000Z',
      findingKey: 'F1',
      action: 'ACKNOWLEDGE',
      unexpected: true,
    });

    expect(await runJournal(args('demo', event), root)).toBe(1);
    expect(err.join('')).toContain('unexpected');
    await expect(readFile(journalFile('demo'), 'utf8')).rejects.toThrow();
  });

  it('requires --branch', async () => {
    expect(await runJournal({ cmd: 'review', sub: 'journal', json: true }, root)).toBe(1);
    expect(err.join('')).toContain('--branch');
  });

  it('fails closed on a malformed line and refuses to append over it', async () => {
    const visit = JSON.stringify({
      type: 'section',
      ts: '2026-07-09T00:00:00.000Z',
      threadKey: 'S1',
      action: 'VISIT',
    });
    expect(await runJournal(args('demo', visit), root)).toBe(0);
    await appendFile(journalFile('demo'), 'NOT-JSON{{{\n', 'utf8');
    const skip = JSON.stringify({
      type: 'section',
      ts: '2026-07-09T00:00:01.000Z',
      threadKey: 'S1',
      action: 'SKIP',
      reason: 'covered elsewhere',
    });
    expect(await runJournal(args('demo', skip), root)).toBe(1);
    expect(err.join('')).toContain('JOURNAL_CORRUPT');
    const preserved = await readFile(journalFile('demo'), 'utf8');
    expect(preserved).toContain('"action":"VISIT"');
    expect(preserved).toContain('NOT-JSON');
    expect(preserved).not.toContain('covered elsewhere');
  });

  it('guards direct runJournal calls against v2 state before parsing any event', async () => {
    const dir = reviewDir('demo');
    const legacy = `${JSON.stringify({
      type: 'review_lifecycle',
      review_basis: 'NARRATIVE',
      narrative_generation: 'legacy',
    })}\n`;
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'review-state.json'),
      `${JSON.stringify({ review_state_version: 2 })}\n`
    );
    await writeFile(path.join(dir, 'journal.ndjson'), legacy);

    expect(await runJournal(args('demo'), root)).toBe(1);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({
      ok: false,
      health: { kind: 'REVIEW_STATE', status: 'UNSUPPORTED_SCHEMA', schemaVersion: 2 },
    });
    expect(await readFile(path.join(dir, 'journal.ndjson'), 'utf8')).toBe(legacy);

    err = [];
    expect(
      await runJournal(
        args(
          'demo',
          JSON.stringify({
            type: 'section',
            ts: '2026-07-09T00:00:00.000Z',
            threadKey: 'S1',
            action: 'VISIT',
          })
        ),
        root
      )
    ).toBe(1);
    expect(JSON.parse(err.join(''))).toMatchObject({
      code: 'DURABLE_STATE_UNHEALTHY',
    });
    expect(await readFile(path.join(dir, 'journal.ndjson'), 'utf8')).toBe(legacy);
  });

  it('appends a batch (JSON array) atomically: all events land, shared ts/reason preserved', async () => {
    const ts = '2026-07-09T00:00:00.000Z';
    const reason = 'triaged together at the end of the pass';
    const ack = (n: number) => ({
      type: 'uncertainty',
      ts,
      citationId: `cite:art1:cp1:uncertainty:${n}`,
      action: 'ACKNOWLEDGE',
      reason,
    });
    expect(await runJournal(args('demo', JSON.stringify([ack(0), ack(1), ack(2)])), root)).toBe(0);
    const ledger = lastLedger();
    // Replay shows all 3 dispositions, each carrying the batch's ts + reason.
    expect(ledger.uncertainties).toHaveLength(3);
    for (const u of ledger.uncertainties) {
      expect(u.state).toBe('ACKNOWLEDGED');
      expect(u.ts).toBe(ts);
      expect(u.reason).toBe(reason);
    }
    const onDisk = await readFile(journalFile('demo'), 'utf8');
    expect(onDisk.trim().split('\n')).toHaveLength(3);
  });

  it('one invalid event in a batch appends NOTHING (all-or-nothing) with exit 1', async () => {
    const ts = '2026-07-09T00:00:00.000Z';
    const batch = JSON.stringify([
      { type: 'uncertainty', ts, citationId: 'cite:art1:cp1:uncertainty:0', action: 'ACKNOWLEDGE' },
      // Reason-gated: finding DISMISS without a reason poisons the whole batch.
      { type: 'finding', ts, findingKey: 'F1', action: 'DISMISS' },
    ]);
    expect(await runJournal(args('demo', batch), root)).toBe(1);
    expect(err.join('')).toContain('invalid event at index 1');
    expect(err.join('')).toContain('requires a reason');
    expect(err.join('')).toContain('nothing appended');
    await expect(readFile(journalFile('demo'), 'utf8')).rejects.toThrow();
  });

  it('rejects an empty batch — an empty array has nothing to append', async () => {
    expect(await runJournal(args('demo', '[]'), root)).toBe(1);
    expect(err.join('')).toContain('event array is empty');
    await expect(readFile(journalFile('demo'), 'utf8')).rejects.toThrow();
  });

  it('a torn write blocks replay instead of silently dropping an obligation', async () => {
    const visit = JSON.stringify({
      type: 'section',
      ts: '2026-07-09T00:00:00.000Z',
      threadKey: 'S1',
      action: 'VISIT',
    });
    expect(await runJournal(args('demo', visit), root)).toBe(0);
    // Simulate a crash mid-appendFile: half an event, no trailing newline.
    await appendFile(journalFile('demo'), '{"type":"finding","ts":"2026-07-09T00', 'utf8');
    expect(await runJournal(args('demo'), root)).toBe(1);
    expect(JSON.parse(out.at(-1)!) as object).toMatchObject({
      ok: false,
      health: { kind: 'JOURNAL', status: 'CORRUPT' },
    });
    expect(await readFile(journalFile('demo'), 'utf8')).toContain(
      '{"type":"finding","ts":"2026-07-09T00'
    );
  });
});

describe('review journal — atomic RECORD_REVIEW_COVERAGE guards', () => {
  it('appends one multi-section event as one line when both generations match', async () => {
    await writeFloor();
    expect(await runJournal(args('demo'), root)).toBe(0);
    const generation = lastLedgerGeneration();
    const a = { file: 'src/a.ts', side: 'add' as const, lineHash: 'ha', line: 1 };
    const b = { file: 'src/b.ts', side: 'add' as const, lineHash: 'hb', line: 1 };
    const event = {
      type: 'review_coverage',
      ts: '2026-07-12T00:00:00.000Z',
      action: 'RECORD_REVIEW_COVERAGE',
      floor_input_hash: 'floor_hash_v2',
      ledger_generation: generation,
      threads: [
        {
          threadKey: 'sec_a',
          coveredRows: [a],
          coveredRowsDigest: await reviewedRowsDigest([a]),
        },
        {
          threadKey: 'sec_b',
          coveredRows: [b],
          coveredRowsDigest: await reviewedRowsDigest([b]),
        },
      ],
    };
    expect(await runJournal(args('demo', JSON.stringify(event)), root)).toBe(0);
    const lines = (await readFile(journalFile('demo'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: 'review_coverage',
      threads: [{ threadKey: 'sec_a' }, { threadKey: 'sec_b' }],
    });
  });

  it('leaves bytes unchanged on stale floor generation', async () => {
    await writeFloor();
    expect(await runJournal(args('demo'), root)).toBe(0);
    const before = await readFile(
      path.join(root, '.orcaops', 'reviews', 'demo', 'floor.json'),
      'utf8'
    );
    const event = {
      type: 'review_coverage',
      ts: '2026-07-12T00:00:00.000Z',
      action: 'RECORD_REVIEW_COVERAGE',
      floor_input_hash: 'older_floor',
      ledger_generation: lastLedgerGeneration(),
      threads: [
        {
          threadKey: 'sec_a',
          coveredRows: [{ file: 'a', side: 'add', lineHash: 'h', line: 1 }],
          coveredRowsDigest: 'digest',
        },
      ],
    };
    expect(await runJournal(args('demo', JSON.stringify(event)), root)).toBe(1);
    await expect(readFile(journalFile('demo'), 'utf8')).rejects.toThrow();
    expect(
      await readFile(path.join(root, '.orcaops', 'reviews', 'demo', 'floor.json'), 'utf8')
    ).toBe(before);
    expect(err.join('')).toContain('stale floor generation');
  });

  it('leaves journal bytes unchanged when another action advances the ledger generation', async () => {
    await writeFloor();
    expect(await runJournal(args('demo'), root)).toBe(0);
    const staleGeneration = lastLedgerGeneration();
    const visit = {
      type: 'section',
      ts: '2026-07-12T00:00:00.000Z',
      threadKey: 'sec_fixture',
      action: 'VISIT',
    };
    expect(await runJournal(args('demo', JSON.stringify(visit)), root)).toBe(0);
    const before = await readFile(journalFile('demo'), 'utf8');
    const coveredRows = [{ file: 'src/fixture.ts', side: 'add' as const, lineHash: 'h', line: 1 }];
    const coverage = {
      type: 'review_coverage',
      ts: '2026-07-12T00:00:01.000Z',
      action: 'RECORD_REVIEW_COVERAGE',
      floor_input_hash: 'floor_hash_v2',
      ledger_generation: staleGeneration,
      threads: [
        {
          threadKey: 'sec_fixture',
          coveredRows,
          coveredRowsDigest: await reviewedRowsDigest(coveredRows),
        },
      ],
    };
    expect(await runJournal(args('demo', JSON.stringify(coverage)), root)).toBe(1);
    expect(await readFile(journalFile('demo'), 'utf8')).toBe(before);
    expect(err.join('')).toContain('stale ledger generation');
  });

  it('rejects mixed batches and invalid later sections before writing anything', async () => {
    await writeFloor();
    expect(await runJournal(args('demo'), root)).toBe(0);
    const generation = lastLedgerGeneration();
    const coverage = {
      type: 'review_coverage',
      ts: '2026-07-12T00:00:00.000Z',
      action: 'RECORD_REVIEW_COVERAGE',
      floor_input_hash: 'floor_hash_v2',
      ledger_generation: generation,
      threads: [
        {
          threadKey: 'sec_a',
          coveredRows: [{ file: 'a', side: 'add', lineHash: 'h', line: 1 }],
          coveredRowsDigest: 'digest',
        },
      ],
    };
    const visit = { type: 'section', ts: coverage.ts, threadKey: 'sec_a', action: 'VISIT' };
    expect(await runJournal(args('demo', JSON.stringify([coverage, visit])), root)).toBe(1);
    await expect(readFile(journalFile('demo'), 'utf8')).rejects.toThrow();

    const invalid = {
      ...coverage,
      threads: [
        ...coverage.threads,
        { threadKey: 'sec_b', coveredRows: [], coveredRowsDigest: 'x' },
      ],
    };
    expect(await runJournal(args('demo', JSON.stringify(invalid)), root)).toBe(1);
    await expect(readFile(journalFile('demo'), 'utf8')).rejects.toThrow();

    const unknownSection = {
      ...coverage,
      threads: [{ ...coverage.threads[0], threadKey: 'sec_unknown' }],
    };
    expect(await runJournal(args('demo', JSON.stringify(unknownSection)), root)).toBe(1);
    await expect(readFile(journalFile('demo'), 'utf8')).rejects.toThrow();

    const badDigest = {
      ...coverage,
      threads: [{ ...coverage.threads[0], coveredRowsDigest: 'not-the-row-digest' }],
    };
    expect(await runJournal(args('demo', JSON.stringify(badDigest)), root)).toBe(1);
    await expect(readFile(journalFile('demo'), 'utf8')).rejects.toThrow();
  });
});

/** A STORY-basis lifecycle event: the reviewer read the routine Story. */
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

/** A FLOOR_ONLY lifecycle event: the reviewer read the captured checkpoints. */
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

describe('review journal — durable generation-guarded lifecycle', () => {
  const lifecycleEvent = storyLifecycleEvent;

  it('persists COMPLETE and reconstructs the same state on a fresh read', async () => {
    const generation = await writeFloor();
    await coverEveryRow();
    const event = lifecycleEvent('COMPLETE', generation, lastLedgerGeneration());
    expect(await runJournal(args('demo', JSON.stringify(event)), root)).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({ state: 'COMPLETE', stale: false });

    out = [];
    expect(await runJournal(args('demo'), root)).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({ state: 'COMPLETE', stale: false });
    expect(lastLedger().lifecycle.history).toHaveLength(1);
  });

  it('requires PARTIAL remaining work and preserves it after reload', async () => {
    const generation = await writeFloor();
    expect(await runJournal(args('demo'), root)).toBe(0);
    const ledgerGeneration = lastLedgerGeneration();
    expect(
      await runJournal(
        args('demo', JSON.stringify(lifecycleEvent('PARTIAL', generation, ledgerGeneration))),
        root
      )
    ).toBe(1);
    expect(err.join('')).toContain('PARTIAL requires a remaining-work note');
    const partial = lifecycleEvent(
      'PARTIAL',
      generation,
      ledgerGeneration,
      'Re-run the giant fixture.'
    );
    expect(await runJournal(args('demo', JSON.stringify(partial)), root)).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({
      state: 'PARTIAL',
      stale: false,
      current: { remainingWork: 'Re-run the giant fixture.' },
    });
  });

  it('rejects stale floor, Story, and ledger generations without appending', async () => {
    const generation = await writeFloor();
    await coverEveryRow();
    const ledgerGeneration = lastLedgerGeneration();
    const journalBefore = await readFile(journalFile('demo'), 'utf8');
    const staleCases = [
      {
        event: lifecycleEvent(
          'COMPLETE',
          { ...generation, floorInputHash: 'older-floor' },
          ledgerGeneration
        ),
        code: 'STALE_FLOOR',
      },
      {
        event: lifecycleEvent(
          'COMPLETE',
          { ...generation, storyGeneration: 'older-story' },
          ledgerGeneration
        ),
        code: 'STALE_STORY',
      },
      { event: lifecycleEvent('COMPLETE', generation, 'older-ledger'), code: 'STALE_LEDGER' },
    ];
    for (const { event, code } of staleCases) {
      err = [];
      expect(await runJournal(args('demo', JSON.stringify(event)), root)).toBe(1);
      // Nothing appended: the log is byte-for-byte what it was.
      expect(await readFile(journalFile('demo'), 'utf8')).toBe(journalBefore);
      expect(err.join('')).toMatch(/stale (floor|Story|ledger) generation/);
      expect(JSON.parse(err.join(''))).toMatchObject({ ok: false, code });
    }
  });

  it('accepts the same Story content from a different current run', async () => {
    const generation = await writeFloor();
    expect(await runJournal(args('demo'), root)).toBe(0);
    await installStory({
      floorInputHash: generation.floorInputHash,
      runId: '22222222-2222-4222-8222-222222222222',
      finalizedAt: '2026-07-23T11:00:00.000Z',
    });
    const event = storyLifecycleEvent(
      'PARTIAL',
      generation,
      lastLedgerGeneration(),
      'Finish the remaining evidence.'
    );
    expect(await runJournal(args('demo', JSON.stringify(event)), root)).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({
      state: 'PARTIAL',
      stale: false,
      current: { storyGeneration: generation.storyGeneration },
    });
  });

  it('fails closed when the current Story pointer is invalid or unsupported', async () => {
    const generation = await writeFloor();
    expect(await runJournal(args('demo'), root)).toBe(0);
    const event = storyLifecycleEvent(
      'PARTIAL',
      generation,
      lastLedgerGeneration(),
      'Resume after repairing Story state.'
    );
    const pointer = path.join(reviewDir('demo'), 'twolane', CURRENT_STORY_POINTER_FILE);
    for (const bytes of [
      '{broken pointer',
      JSON.stringify({
        schema_version: 1,
        run_id: '11111111-1111-4111-8111-111111111111',
        finalized_at: '2026-07-23T10:00:00.000Z',
        floor_input_hash: generation.floorInputHash,
        model_file: 'story-review-model-v3.json',
        model_sha256: 'a'.repeat(64),
      }),
    ]) {
      await writeFile(pointer, bytes);
      err = [];
      expect(await runJournal(args('demo', JSON.stringify(event)), root)).toBe(1);
      expect(JSON.parse(err.join(''))).toMatchObject({
        ok: false,
        code: 'DURABLE_STATE_UNHEALTHY',
      });
    }
  });

  it('treats a Story built for another floor as absent from the lifecycle domain', async () => {
    const generation = await writeFloor();
    const floorFile = path.join(reviewDir('demo'), 'floor.json');
    const floor = JSON.parse(await readFile(floorFile, 'utf8')) as { input_hash: string };
    floor.input_hash = 'new-floor';
    await writeFile(floorFile, JSON.stringify(floor));
    expect(await runJournal(args('demo'), root)).toBe(0);

    const event = floorOnlyLifecycleEvent(
      'PARTIAL',
      floor.input_hash,
      lastLedgerGeneration(),
      'Regenerate the stale Story.'
    );
    expect(await runJournal(args('demo', JSON.stringify(event)), root)).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({
      state: 'PARTIAL',
      stale: false,
      current: { reviewBasis: 'FLOOR_ONLY', storyGeneration: null },
    });
    expect(generation.storyGeneration).not.toBeNull();
  });

  it('serializes Story publication across lifecycle generation check and append', async () => {
    const generation = await writeFloor();
    expect(await runJournal(args('demo'), root)).toBe(0);
    const nextRunId = '33333333-3333-4333-8333-333333333333';
    await installStory({
      floorInputHash: generation.floorInputHash,
      runId: nextRunId,
      finalizedAt: '2026-07-23T12:00:00.000Z',
      banner: 'different Story content',
      point: false,
    });

    let reachedResolve!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedResolve = resolve;
    });
    let releaseResolve!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const event = storyLifecycleEvent(
      'PARTIAL',
      generation,
      lastLedgerGeneration(),
      'Continue after the concurrent publication.'
    );
    const append = runJournal(
      args('demo', JSON.stringify(event)),
      root,
      process.env,
      Readable.from([]),
      {
        afterLifecycleGenerationRead: async () => {
          reachedResolve();
          await release;
        },
      }
    );
    await reached;

    let publicationSettled = false;
    const publication = publishCurrentStoryForRun({
      reviewDir: reviewDir('demo'),
      locksDir: path.join(root, '.orcaops', 'tmp', 'locks'),
      containmentRoot: root,
      branch: 'demo',
      runId: nextRunId,
    }).then((value) => {
      publicationSettled = true;
      return value;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(publicationSettled).toBe(false);

    releaseResolve();
    expect(await append).toBe(0);
    expect((await publication).pointer.run_id).toBe(nextRunId);

    out = [];
    expect(await runJournal(args('demo'), root)).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({ state: 'PARTIAL', stale: true });
  });

  it('refuses journal publication after losing the review-state lease', async () => {
    const generation = await writeFloor();
    const visit = JSON.stringify({
      type: 'section',
      ts: '2026-07-23T11:00:00.000Z',
      threadKey: 'S1',
      action: 'VISIT',
    });
    expect(await runJournal(args('demo', visit), root)).toBe(0);
    const before = await readFile(journalFile('demo'), 'utf8');
    const event = storyLifecycleEvent(
      'PARTIAL',
      generation,
      lastLedgerGeneration(),
      'Continue after recovering the review lock.'
    );
    const locksDir = path.join(root, '.orcaops', 'tmp', 'locks');
    const lock = new ArtifactLock({ locksDir, containmentRoot: root });
    const stateLockPath = lock.lockPathFor(reviewStateLockKey('demo'));

    await expect(
      runJournal(args('demo', JSON.stringify(event)), root, process.env, Readable.from([]), {
        afterLifecycleGenerationRead: () => rm(stateLockPath, { recursive: true, force: true }),
      })
    ).rejects.toBeInstanceOf(ArtifactLockLeaseLostError);
    expect(await readFile(journalFile('demo'), 'utf8')).toBe(before);
  });

  it('reopens append-only, retains completion history, and rejects duplicate transitions', async () => {
    const generation = await writeFloor();
    await coverEveryRow();
    expect(
      await runJournal(
        args(
          'demo',
          JSON.stringify(lifecycleEvent('COMPLETE', generation, lastLedgerGeneration()))
        ),
        root
      )
    ).toBe(0);
    const finishedGeneration = lastLedgerGeneration();
    expect(
      await runJournal(
        args('demo', JSON.stringify(lifecycleEvent('COMPLETE', generation, finishedGeneration))),
        root
      )
    ).toBe(1);
    expect(err.join('')).toContain('already finished');
    err = [];

    expect(
      await runJournal(
        args('demo', JSON.stringify(lifecycleEvent('REOPEN', generation, finishedGeneration))),
        root
      )
    ).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({ state: 'OPEN', stale: false });
    expect(lastLedger().lifecycle.history.map((entry) => entry.action)).toEqual([
      'COMPLETE',
      'REOPEN',
    ]);

    expect(
      await runJournal(
        args('demo', JSON.stringify(lifecycleEvent('REOPEN', generation, lastLedgerGeneration()))),
        root
      )
    ).toBe(1);
    expect(err.join('')).toContain('already open');
  });
});

// ---------------------------------------------------------------------------
// The floor-only finish lifecycle
//
// ABSENT or floor-stale Story state is the valid deterministic domain. It records
// FLOOR_ONLY and remains current until the floor changes or a valid Story lands.
// ---------------------------------------------------------------------------
describe('review journal — floor-only finish', () => {
  it('records a COMPLETE with no current Story, and it survives a restart non-stale', async () => {
    const { floorInputHash } = await writeFloor();
    await removeStory();
    await coverEveryRow();

    const event = floorOnlyLifecycleEvent('COMPLETE', floorInputHash, lastLedgerGeneration());
    expect(await runJournal(args('demo', JSON.stringify(event)), root)).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({
      state: 'COMPLETE',
      stale: false,
      current: { reviewBasis: 'FLOOR_ONLY', storyGeneration: null },
    });

    // Restart: a fresh process, replaying only what is on disk.
    out = [];
    expect(await runJournal(args('demo'), root)).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({ state: 'COMPLETE', stale: false });
  });

  it('goes stale on a MATERIAL floor change — and not on a rebuild that changes nothing', async () => {
    const { floorInputHash } = await writeFloor();
    await removeStory();
    await coverEveryRow();
    expect(
      await runJournal(
        args(
          'demo',
          JSON.stringify(
            floorOnlyLifecycleEvent('COMPLETE', floorInputHash, lastLedgerGeneration())
          )
        ),
        root
      )
    ).toBe(0);

    // Re-run the sidecar over an unchanged tree. `input_hash` is content-addressed,
    // so the rebuilt floor is byte-identical and the completion still stands: the
    // rule is "the material generation changed", never "a rebuild happened".
    await writeFloor();
    await removeStory();
    out = [];
    expect(await runJournal(args('demo'), root)).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({ state: 'COMPLETE', stale: false });

    // Now the CONTENT moves.
    const floorFile = path.join(reviewDir('demo'), 'floor.json');
    const floor = JSON.parse(await readFile(floorFile, 'utf8')) as { input_hash: string };
    floor.input_hash = 'a-genuinely-different-tree';
    await writeFile(floorFile, JSON.stringify(floor));

    out = [];
    expect(await runJournal(args('demo'), root)).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({ state: 'COMPLETE', stale: true });
  });

  it('a Story landing mid-review stales FLOOR_ONLY and rejects a new floor-only event', async () => {
    // A Story landing mid-review means the reviewer's claim about what they
    // read is no longer true. The transport catches it; nothing is appended.
    const { floorInputHash } = await writeFloor();
    await removeStory();
    await coverEveryRow();

    const partial = floorOnlyLifecycleEvent(
      'PARTIAL',
      floorInputHash,
      lastLedgerGeneration(),
      'Read the Story that just arrived.'
    );
    expect(await runJournal(args('demo', JSON.stringify(partial)), root)).toBe(0);
    await installStory({ floorInputHash });
    out = [];
    expect(await runJournal(args('demo'), root)).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({ state: 'PARTIAL', stale: true });

    const event = floorOnlyLifecycleEvent('COMPLETE', floorInputHash, lastLedgerGeneration());
    err = [];
    expect(await runJournal(args('demo', JSON.stringify(event)), root)).toBe(1);
    expect(err.join('')).toContain('no longer floor-only');
    expect(JSON.parse(err.join(''))).toMatchObject({ code: 'STALE_STORY' });

    out = [];
    expect(await runJournal(args('demo'), root)).toBe(0);
    expect(lastLedger().lifecycle.state).toBe('PARTIAL');
  });

  it('rejects a STORY event when there is no current Story to have read', async () => {
    const { floorInputHash, storyGeneration } = await writeFloor();
    await removeStory();
    await coverEveryRow();

    const event = storyLifecycleEvent(
      'COMPLETE',
      { floorInputHash, storyGeneration },
      lastLedgerGeneration()
    );
    err = [];
    expect(await runJournal(args('demo', JSON.stringify(event)), root)).toBe(1);
    expect(err.join('')).toContain('no valid current Story');
  });

  it('binds review_basis to story_generation in the SCHEMA, both directions', async () => {
    const { floorInputHash, storyGeneration } = await writeFloor();
    expect(await runJournal(args('demo'), root)).toBe(0);
    const ledgerGeneration = lastLedgerGeneration();
    const base = {
      type: 'review_lifecycle',
      ts: '2026-07-12T00:00:00.000Z',
      action: 'COMPLETE',
      floor_input_hash: floorInputHash,
      ledger_generation: ledgerGeneration,
      actor: 'REVIEWER',
      source: 'WATCH',
    };

    // FLOOR_ONLY claiming a Story it did not read.
    err = [];
    expect(
      await runJournal(
        args(
          'demo',
          JSON.stringify({
            ...base,
            review_basis: 'FLOOR_ONLY',
            story_generation: storyGeneration,
          })
        ),
        root
      )
    ).toBe(1);
    expect(err.join('')).toContain('FLOOR_ONLY pins no Story generation');

    // STORY with nothing to pin — the shape that made the old contract's
    // staleness check meaningless.
    err = [];
    expect(
      await runJournal(
        args('demo', JSON.stringify({ ...base, review_basis: 'STORY', story_generation: null })),
        root
      )
    ).toBe(1);
    expect(err.join('')).toContain('STORY requires the Story generation');

    // And the basis is not optional: an event without one is not an event.
    err = [];
    expect(
      await runJournal(
        args('demo', JSON.stringify({ ...base, story_generation: storyGeneration })),
        root
      )
    ).toBe(1);
    expect(err.join('')).toContain('review_basis');
  });
});

// ---------------------------------------------------------------------------
// The canonical finish gate, RE-CHECKED under the engine lock
//
// This transport does not independently enforce Watch's
// completion model — it took Watch's word for it, so a durable COMPLETE was only
// ever as true as the reader that sent it. Every case below sends a COMPLETE
// that a lying (or merely stale) reader could send, and the transport refuses it.
//
// The obligations are facts about the FLOOR and the LEDGER, so they hold under
// either lens: the Story adds obligations, it never excuses these.
// ---------------------------------------------------------------------------
describe('review journal — the finish gate is enforced at the transport', () => {
  async function attemptFloorOnlyComplete(): Promise<number> {
    out = [];
    err = [];
    expect(await runJournal(args('demo'), root)).toBe(0);
    const floor = JSON.parse(
      await readFile(path.join(reviewDir('demo'), 'floor.json'), 'utf8')
    ) as { input_hash: string };
    const event = floorOnlyLifecycleEvent('COMPLETE', floor.input_hash, lastLedgerGeneration());
    return runJournal(args('demo', JSON.stringify(event)), root);
  }

  it('refuses a COMPLETE while any floor row is uncovered', async () => {
    await writeFloor();
    await removeStory();
    // No coverage event at all — the reviewer read nothing.
    expect(await attemptFloorOnlyComplete()).toBe(1);
    expect(err.join('')).toContain('row(s) not covered');
    await expect(readFile(journalFile('demo'), 'utf8')).rejects.toThrow();
  });

  it('refuses a COMPLETE while an unexplained row is uninspected', async () => {
    // `unassigned` carries a gap slice: code on the branch that no checkpoint
    // claims. Finishing over it would file the review as done having never looked
    // at the one part of the change nobody explained.
    const fixture = buildReviewFloorFixture('unassigned');
    const dir = reviewDir('demo');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'review-state.json'),
      `${JSON.stringify({ review_state_version: REVIEW_STATE_VERSION })}\n`
    );
    fixture.floor.scope.branch = 'demo';
    fixture.floor.scope.branch_slug = 'demo';
    await writeFile(path.join(dir, 'floor.json'), JSON.stringify(fixture.floor));
    await writeFile(
      path.join(dir, 'diff.patch'),
      [
        'diff --git a/src/fixture.ts b/src/fixture.ts',
        '--- a/src/fixture.ts',
        '+++ b/src/fixture.ts',
        '@@ -1,0 +1 @@',
        '+stable fixture row',
        'diff --git a/src/unassigned.ts b/src/unassigned.ts',
        '--- a/src/unassigned.ts',
        '+++ b/src/unassigned.ts',
        '@@ -1,0 +1,2 @@',
        '+nobody claimed this',
        '+nor this',
        '',
      ].join('\n')
    );
    await coverEveryRow();

    expect(await attemptFloorOnlyComplete()).toBe(1);
    expect(err.join('')).toContain('unexplained row(s) not inspected');
  });

  it('refuses a COMPLETE while the reviewer has an open comment anywhere on the branch', async () => {
    await writeFloor();
    await removeStory();
    await coverEveryRow();

    // The agent's half of the loop has not arrived. Finishing here files the
    // review as done with the reviewer's OWN question hanging unanswered.
    const comment = (id: string, author: 'reviewer' | 'agent') =>
      `${JSON.stringify({
        type: 'add',
        comment_id: id,
        ts: '2026-07-12T00:00:00.000Z',
        author,
        body: 'why is this unbounded?',
        anchor: { kind: 'DIFF_LINE', file: 'src/fixture.ts', side: 'add', line: 1, lineHash: 'lh' },
      })}\n`;
    const commentsFile = path.join(reviewDir('demo'), 'comments.ndjson');
    await writeFile(commentsFile, comment('cmt_1', 'reviewer'));

    expect(await attemptFloorOnlyComplete()).toBe(1);
    expect(err.join('')).toContain('open reviewer comment(s)');

    // Resolving it clears the gate — and an AGENT's own open comment never gated
    // it, because the obligation is the reviewer's unanswered question, not any
    // open thread. (`ownOpenCommentCount`'s semantics, minus the thread filter.)
    await writeFile(
      commentsFile,
      [
        comment('cmt_1', 'reviewer'),
        `${JSON.stringify({
          type: 'status',
          comment_id: 'cmt_1',
          ts: '2026-07-12T01:00:00.000Z',
          author: 'reviewer',
          status: 'resolved',
        })}\n`,
        comment('cmt_2', 'agent'),
      ].join('')
    );
    expect(await attemptFloorOnlyComplete()).toBe(0);
  });

  it('refuses a COMPLETE while a captured uncertainty is undispositioned', async () => {
    await writeFloor();
    await removeStory();
    // The agent wrote down a doubt at capture time. It is a floor citation, so no
    // Story is involved in either raising it or clearing it.
    const floorFile = path.join(reviewDir('demo'), 'floor.json');
    const floor = JSON.parse(await readFile(floorFile, 'utf8')) as {
      citations: { id: string; kind: string; artifact: string; cp: number; text: string }[];
    };
    floor.citations.push({
      id: 'cite:artifact-fixture:cp1:uncertainty:0',
      kind: 'CHECKPOINT_UNCERTAINTY',
      artifact: 'artifact-fixture',
      cp: 1,
      text: 'Unsure the TTL strategy survives multi-region.',
    });
    await writeFile(floorFile, JSON.stringify(floor));
    await coverEveryRow();

    expect(await attemptFloorOnlyComplete()).toBe(1);
    expect(err.join('')).toContain('not dispositioned');

    // Dispose of it and the same COMPLETE lands. The gate names an obligation
    // the reviewer can actually discharge, not an unexplained refusal.
    expect(
      await runJournal(
        args(
          'demo',
          JSON.stringify({
            type: 'uncertainty',
            ts: '2026-07-12T01:00:00.000Z',
            citationId: 'cite:artifact-fixture:cp1:uncertainty:0',
            action: 'ACKNOWLEDGE',
          })
        ),
        root
      )
    ).toBe(0);
    expect(await attemptFloorOnlyComplete()).toBe(0);
  });

  it('refuses a COMPLETE when the obligations cannot be derived at all', async () => {
    // No diff.patch ⇒ the target build fails ⇒ every other input is a LIE: no gap
    // rows derived reads exactly like no gap rows outstanding, and null manifests
    // read exactly like nothing left to cover. Fail closed, and say so.
    await writeFloor();
    await removeStory();
    await coverEveryRow();
    await rm(path.join(reviewDir('demo'), 'diff.patch'), { force: true });

    expect(await attemptFloorOnlyComplete()).toBe(1);
    expect(err.join('')).toContain('could not be derived');
  });

  it('enforces the same gate on the STORY basis — a Story excuses nothing', async () => {
    // The obligations are facts about the branch. Composing a Story around an
    // uncovered row does not review it.
    const generation = await writeFloor();
    expect(await runJournal(args('demo'), root)).toBe(0);

    err = [];
    expect(
      await runJournal(
        args(
          'demo',
          JSON.stringify(storyLifecycleEvent('COMPLETE', generation, lastLedgerGeneration()))
        ),
        root
      )
    ).toBe(1);
    expect(err.join('')).toContain('row(s) not covered');
  });

  it('rejects required Story items by exact id until both are dispositioned', async () => {
    const generation = await writeFloor();
    await coverEveryRow();
    const storyGeneration = await installStory({
      floorInputHash: generation.floorInputHash,
      runId: '22222222-2222-4222-8222-222222222222',
      finalizedAt: '2026-07-23T11:00:00.000Z',
      requiredStoryItems: true,
    });
    const current = { floorInputHash: generation.floorInputHash, storyGeneration };

    out = [];
    expect(await runJournal(args('demo'), root)).toBe(0);
    expect(
      await runJournal(
        args(
          'demo',
          JSON.stringify(storyLifecycleEvent('COMPLETE', current, lastLedgerGeneration()))
        ),
        root
      )
    ).toBe(1);
    expect(err.join('')).toContain('2 required Story item(s)');

    expect(
      await runJournal(
        args(
          'demo',
          JSON.stringify({
            type: 'finding',
            ts: '2026-07-23T11:01:00.000Z',
            findingKey: 'finding:required-story',
            action: 'RESOLVE',
          })
        ),
        root
      )
    ).toBe(0);
    expect(
      await runJournal(
        args(
          'demo',
          JSON.stringify({
            type: 'prompt',
            ts: '2026-07-23T11:02:00.000Z',
            promptKey: 'question:required-story',
            action: 'ACKNOWLEDGE',
          })
        ),
        root
      )
    ).toBe(0);
    expect(
      await runJournal(
        args(
          'demo',
          JSON.stringify(storyLifecycleEvent('COMPLETE', current, lastLedgerGeneration()))
        ),
        root
      )
    ).toBe(0);
  });

  it('lets PARTIAL and REOPEN through — the gate is about calling it DONE', async () => {
    // A reviewer with work outstanding must still be able to record that they
    // stopped, and why. Gating PARTIAL on completeness would be incoherent.
    const { floorInputHash } = await writeFloor();
    await removeStory();
    expect(await runJournal(args('demo'), root)).toBe(0);

    expect(
      await runJournal(
        args(
          'demo',
          JSON.stringify(
            floorOnlyLifecycleEvent(
              'PARTIAL',
              floorInputHash,
              lastLedgerGeneration(),
              'checkpoints 3 onward still unread'
            )
          )
        ),
        root
      )
    ).toBe(0);
    expect(lastLedger().lifecycle).toMatchObject({
      state: 'PARTIAL',
      current: { reviewBasis: 'FLOOR_ONLY', remainingWork: 'checkpoints 3 onward still unread' },
    });

    expect(
      await runJournal(
        args(
          'demo',
          JSON.stringify(floorOnlyLifecycleEvent('REOPEN', floorInputHash, lastLedgerGeneration()))
        ),
        root
      )
    ).toBe(0);
    expect(lastLedger().lifecycle.state).toBe('OPEN');
  });
});

describe('review journal — stdin transport (--input -)', () => {
  it('round-trips a multi-MB coverage event: append via stdin → disk → replay', async () => {
    const { floorInputHash } = await writeFloor();
    expect(await runJournal(args('demo'), root)).toBe(0);
    const { event, rows, digest } = await bigCoverageEvent(
      40_000,
      floorInputHash,
      lastLedgerGeneration()
    );
    const json = JSON.stringify(event);
    // The payload class this transport exists for: bigger than a typical argv
    // limit AND the old 4MB execFile stdout cap.
    expect(json.length).toBeGreaterThan(5 * 1024 * 1024);

    expect(await runJournal(stdinArgs('demo'), root, process.env, Readable.from([json]))).toBe(0);

    // On disk: exactly one ndjson line carrying the full manifest.
    const onDisk = await readFile(journalFile('demo'), 'utf8');
    const lines = onDisk.trim().split('\n');
    expect(lines).toHaveLength(1);
    const persisted = JSON.parse(lines[0]!) as {
      threads: Array<{ coveredRows: ReviewedRow[]; coveredRowsDigest: string }>;
    };
    expect(persisted.threads[0]?.coveredRows).toHaveLength(rows.length);
    expect(persisted.threads[0]?.coveredRowsDigest).toBe(digest);

    // Replayed ledger: current coverage carries the full manifest, untruncated.
    const entry = lastLedger().coverage[0]!;
    expect(entry.coveredRows).toHaveLength(rows.length);
    expect(entry.coveredRows[0]).toEqual(rows[0]);
    expect(entry.coveredRows[rows.length - 1]).toEqual(rows[rows.length - 1]);
    expect(entry.coveredRowsDigest).toBe(digest);
  });

  it('rejects an over-cap stdin payload loudly and appends nothing', async () => {
    // Stream past the cap in 8MB chunks — the reader must reject on total
    // size, never truncate into a half-parsed event.
    const chunk = Buffer.alloc(8 * 1024 * 1024, 0x78);
    const chunks = Array.from({ length: 9 }, () => chunk); // 72MB > 64MB cap
    expect(await runJournal(stdinArgs('demo'), root, process.env, Readable.from(chunks))).toBe(1);
    expect(err.join('')).toContain('64MB cap');
    expect(err.join('')).toContain(String(JOURNAL_STDIN_CAP_BYTES));
    expect(err.join('')).toContain('nothing appended');
    await expect(readFile(journalFile('demo'), 'utf8')).rejects.toThrow();
  });

  it('keeps batch all-or-nothing semantics identical over stdin', async () => {
    const ts = '2026-07-09T00:00:00.000Z';
    const batch = JSON.stringify([
      { type: 'uncertainty', ts, citationId: 'cite:art1:cp1:uncertainty:0', action: 'ACKNOWLEDGE' },
      { type: 'finding', ts, findingKey: 'F1', action: 'DISMISS' }, // reason-gated
    ]);
    expect(await runJournal(stdinArgs('demo'), root, process.env, Readable.from([batch]))).toBe(1);
    expect(err.join('')).toContain('invalid event at index 1');
    expect(err.join('')).toContain('nothing appended');
    await expect(readFile(journalFile('demo'), 'utf8')).rejects.toThrow();
  });

  it("rejects --input values other than '-'", async () => {
    const bad: ReviewArgs = {
      cmd: 'review',
      sub: 'journal',
      branch: 'demo',
      json: true,
      input: 'x',
    };
    expect(await runJournal(bad, root, process.env, Readable.from(['']))).toBe(1);
    expect(err.join('')).toContain("only '-'");
    await expect(readFile(journalFile('demo'), 'utf8')).rejects.toThrow();
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
    expect(await runJournal(both, root, process.env, Readable.from(['{}']))).toBe(1);
    expect(err.join('')).toContain('not both');
    await expect(readFile(journalFile('demo'), 'utf8')).rejects.toThrow();
  });
});

describe('review journal — archive mirroring', () => {
  let repo: TempRepo;
  let dataRoot: string;
  let archiveEnv: NodeJS.ProcessEnv;
  const PROJECT_ID = '019f38b7-3333-7000-8000-000000000001';

  const visit = JSON.stringify({
    type: 'section',
    ts: '2026-07-09T00:00:00.000Z',
    threadKey: 'S1',
    action: 'VISIT',
  });

  const hotJournal = (r: string, slug: string) =>
    path.join(r, '.orcaops', 'reviews', slug, 'journal.ndjson');
  const archiveJournal = (slug: string) =>
    archiveReviewPaths(archiveProjectDir(dataRoot, PROJECT_ID), REVIEW_STATE_VERSION, slug)
      .journalNdjson;

  async function enableArchive(): Promise<void> {
    execFileSync('git', ['-C', repo.path, 'config', '--local', 'orcaops.projectid', PROJECT_ID]);
    await mkdir(path.join(repo.path, '.orcaops'), { recursive: true });
    await writeFile(
      path.join(repo.path, '.orcaops', 'config.json'),
      JSON.stringify({ schema_version: 5, archive: { enabled: true } }),
      'utf8'
    );
  }

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-journal-archive-'));
    archiveEnv = {
      ...process.env,
      ORCAOPS_DATA_DIR: dataRoot,
      XDG_CACHE_HOME: path.join(dataRoot, 'xdg-cache'),
    };
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('mirrors an appended line to the archive byte-identically when enabled', async () => {
    await enableArchive();
    expect(await runJournal(args('demo', visit), repo.path, archiveEnv)).toBe(0);
    expect(await readFile(archiveJournal('demo'), 'utf8')).toBe(
      await readFile(hotJournal(repo.path, 'demo'), 'utf8')
    );
  });

  it('is idempotent by identity: replaying the identical event mirrors one archived line', async () => {
    await enableArchive();
    expect(await runJournal(args('demo', visit), repo.path, archiveEnv)).toBe(0);
    // Replay the byte-identical event. The hot log (no dedup) gains a second
    // line; the archive dedups by content hash and stays at one.
    expect(await runJournal(args('demo', visit), repo.path, archiveEnv)).toBe(0);
    const archiveLines = (await readFile(archiveJournal('demo'), 'utf8')).trim().split('\n');
    expect(archiveLines).toHaveLength(1);
    const hotLines = (await readFile(hotJournal(repo.path, 'demo'), 'utf8')).trim().split('\n');
    expect(hotLines).toHaveLength(2);
  });

  it('mirrors a multi-MB stdin-appended event byte-identically to the archive', async () => {
    await enableArchive();
    const event = {
      type: 'section',
      ts: '2026-07-09T00:00:00.000Z',
      threadKey: 'sec_large',
      action: 'PARTIAL',
      reason: 'x'.repeat(6 * 1024 * 1024),
    };
    const json = JSON.stringify(event);
    expect(json.length).toBeGreaterThan(5 * 1024 * 1024);
    expect(await runJournal(stdinArgs('demo'), repo.path, archiveEnv, Readable.from([json]))).toBe(
      0
    );
    // The archive received the IDENTICAL line the hot log holds — the whole
    // event, not a truncation.
    const hot = await readFile(hotJournal(repo.path, 'demo'), 'utf8');
    expect(await readFile(archiveJournal('demo'), 'utf8')).toBe(hot);
    expect(hot.trim().split('\n')).toHaveLength(1);
  });

  it('writes only the hot log when the archive is disabled (byte-unchanged)', async () => {
    // No enableArchive(): archive.enabled defaults false.
    expect(await runJournal(args('demo', visit), repo.path, archiveEnv)).toBe(0);
    const hot = await readFile(hotJournal(repo.path, 'demo'), 'utf8');
    expect(hot.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(hot.trim())).toEqual(JSON.parse(visit));
    // No archive tree is created at all.
    await expect(access(archiveProjectDir(dataRoot, PROJECT_ID))).rejects.toThrow();
  });

  it('keeps setup warnings inside the successful JSON response', async () => {
    await enableArchive();
    execFileSync('git', ['-C', repo.path, 'config', '--local', 'orcaops.projectid', 'not-a-uuid']);

    expect(await runJournal(args('demo', visit), repo.path, archiveEnv)).toBe(0);

    expect(err.join('')).toBe('');
    expect(JSON.parse(out.at(-1)!)).toMatchObject({
      warnings: [
        {
          code: REVIEW_ARCHIVE_WARNING_CODE.SETUP_FAILED,
          message: expect.stringContaining('not a canonical UUIDv7 project id'),
        },
      ],
    });
    expect((await readFile(hotJournal(repo.path, 'demo'), 'utf8')).trim()).toBe(visit);
  });

  it('keeps mirror-write warnings inside the successful JSON response', async () => {
    await enableArchive();
    await writeFile(path.join(dataRoot, 'projects'), 'blocks the archive project directory');

    expect(await runJournal(args('demo', visit), repo.path, archiveEnv)).toBe(0);

    expect(err.join('')).toBe('');
    expect(JSON.parse(out.at(-1)!)).toMatchObject({
      warnings: [
        {
          code: REVIEW_ARCHIVE_WARNING_CODE.WRITE_FAILED,
          message: expect.any(String),
        },
      ],
    });
    expect((await readFile(hotJournal(repo.path, 'demo'), 'utf8')).trim()).toBe(visit);
  });

  it('retains the typed append rejection when archive setup also warns', async () => {
    await enableArchive();
    expect(await runJournal(args('demo'), repo.path, archiveEnv)).toBe(0);
    await writeFile(hotJournal(repo.path, 'demo'), '{broken journal\n');
    execFileSync('git', ['-C', repo.path, 'config', '--local', 'orcaops.projectid', 'not-a-uuid']);
    out = [];
    err = [];

    expect(await runJournal(args('demo', visit), repo.path, archiveEnv)).toBe(1);

    expect(out).toEqual([]);
    expect(JSON.parse(err.join(''))).toMatchObject({
      ok: false,
      code: 'DURABLE_STATE_UNHEALTHY',
      warnings: [{ code: REVIEW_ARCHIVE_WARNING_CODE.SETUP_FAILED }],
    });
  });

  it('does not replace a stale-generation rejection with archive trouble', async () => {
    root = repo.path;
    const generation = await writeFloor();
    await coverEveryRow();
    await enableArchive();
    execFileSync('git', ['-C', repo.path, 'config', '--local', 'orcaops.projectid', 'not-a-uuid']);
    out = [];
    err = [];
    const stale = storyLifecycleEvent(
      'PARTIAL',
      generation,
      'older-ledger',
      'Finish the remaining evidence.'
    );

    expect(await runJournal(args('demo', JSON.stringify(stale)), repo.path, archiveEnv)).toBe(1);

    expect(out).toEqual([]);
    expect(JSON.parse(err.join(''))).toMatchObject({
      ok: false,
      code: 'STALE_LEDGER',
      warnings: [{ code: REVIEW_ARCHIVE_WARNING_CODE.SETUP_FAILED }],
    });
  });
});
