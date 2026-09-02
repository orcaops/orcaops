import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildReviewFloorFixture } from '@orcaops/review-core';
import { ArtifactLock } from '@orcaops/storage';

import { CURRENT_STORY_POINTER_FILE } from './currentStory.js';
import { inspectDurableReviewState, runDurableState } from './durableState.js';
import { FLOOR_PRODUCER_VERSION } from './floor.js';
import { ensureReviewStateVersion, REVIEW_STATE_VERSION } from './reviewState.js';
import type { ReviewArgs } from './run.js';
import {
  serializeStoryReviewModel,
  STORY_REVIEW_MODEL_FILE,
  STORY_REVIEW_MODEL_SCHEMA_VERSION,
  type StoryReviewModel,
} from './storyReviewModel.js';
import { terminalRunFileSeed } from '../tests/support/twolaneRunFile.js';

let root: string;
let dir: string;
let out: string[];
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const FINALIZED_AT = '2026-07-23T10:00:00.000Z';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function storyModel(floorInputHash: string): StoryReviewModel {
  return {
    schema_version: STORY_REVIEW_MODEL_SCHEMA_VERSION,
    branch: 'demo',
    floor_input_hash: floorInputHash,
    label: 'CODE_ONLY',
    banner: 'Code-only Story',
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
    findings: [],
    questions: [],
    citations: {},
    artifactAliases: {},
  };
}

// A committed bundle, as review data installs one: all three members plus the
// producer marker written last.
async function writeFloor(inputHash: string): Promise<void> {
  const floor = structuredClone(buildReviewFloorFixture('clean').floor);
  floor.input_hash = inputHash;
  await writeFile(path.join(dir, 'floor.json'), JSON.stringify(floor));
  await writeFile(path.join(dir, 'diff.patch'), 'retained diff\n');
  await writeFile(
    path.join(dir, 'floor-cache.json'),
    JSON.stringify({ producerVersion: FLOOR_PRODUCER_VERSION, floorFingerprint: `fp-${inputHash}` })
  );
}

async function installCurrentStory(floorInputHash: string): Promise<string> {
  const modelBytes = serializeStoryReviewModel(storyModel(floorInputHash));
  const modelSha = sha256(modelBytes);
  const twolaneDir = path.join(dir, 'twolane');
  const runDir = path.join(twolaneDir, RUN_ID);
  const inputShas = { dossier: 'dossier', projection: 'projection' };
  await mkdir(runDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(runDir, STORY_REVIEW_MODEL_FILE), modelBytes),
    writeFile(
      path.join(runDir, 'run-v1.json'),
      `${JSON.stringify(
        terminalRunFileSeed({ runId: RUN_ID, branch: 'demo', finalizedAt: FINALIZED_AT, inputShas })
      )}\n`
    ),
    writeFile(
      path.join(runDir, 'run-record-v1.json'),
      `${JSON.stringify({
        schema_version: 1,
        run_id: RUN_ID,
        branch: 'demo',
        input_shas: inputShas,
        finalized_at: FINALIZED_AT,
        outcome: 'FULL',
        outputs: {
          story_review_model: STORY_REVIEW_MODEL_FILE,
          story_review_model_sha256: modelSha,
        },
      })}\n`
    ),
  ]);
  const pointer = `${JSON.stringify({
    schema_version: 1,
    run_id: RUN_ID,
    finalized_at: FINALIZED_AT,
    floor_input_hash: floorInputHash,
    model_file: STORY_REVIEW_MODEL_FILE,
    model_sha256: modelSha,
  })}\n`;
  await writeFile(path.join(twolaneDir, CURRENT_STORY_POINTER_FILE), pointer);
  return pointer;
}

function args(action: 'health' | 'repair'): ReviewArgs {
  return { cmd: 'review', sub: 'state', action, branch: 'demo', json: true };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'orcaops-durable-state-'));
  dir = path.join(root, '.orcaops', 'reviews', 'demo');
  out = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('durable review-state health and explicit reset', () => {
  it('reports an uninitialized directory as blocked rather than healthy absence', async () => {
    expect(await inspectDurableReviewState(root, 'demo')).toMatchObject({
      status: 'BLOCKED',
      states: expect.arrayContaining([
        expect.objectContaining({ kind: 'REVIEW_STATE', status: 'ABSENT' }),
      ]),
    });
    expect(await runDurableState(args('health'), root)).toBe(1);
  });

  it('treats genuinely absent optional artifacts as healthy current state', async () => {
    await ensureReviewStateVersion(dir, root);

    const result = await inspectDurableReviewState(root, 'demo');

    expect(result.status).toBe('HEALTHY');
    expect(result.schema_version).toBe(2);
    expect(result.states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'REVIEW_STATE', status: 'HEALTHY' }),
        expect.objectContaining({ kind: 'FLOOR', status: 'ABSENT' }),
        expect.objectContaining({ kind: 'STORY', status: 'ABSENT' }),
        expect.objectContaining({ kind: 'COMMENTS', status: 'ABSENT' }),
        expect.objectContaining({ kind: 'JOURNAL', status: 'ABSENT' }),
      ])
    );
    expect(await runDurableState(args('health'), root)).toBe(0);
  });

  it('blocks when an installed Story has no readable floor to compare against', async () => {
    await ensureReviewStateVersion(dir, root);
    const pointer = await installCurrentStory('floor-1');

    const observed = await inspectDurableReviewState(root, 'demo');
    expect(observed).toMatchObject({
      status: 'BLOCKED',
      states: expect.arrayContaining([
        expect.objectContaining({ kind: 'FLOOR', status: 'ABSENT' }),
        expect.objectContaining({
          kind: 'STORY',
          status: 'HEALTHY',
          reason: expect.stringContaining('staleness unassessed'),
        }),
      ]),
      repair: {
        command: 'review data --branch "demo"',
        behavior: expect.stringContaining('remain unchanged'),
      },
    });
    expect(await runDurableState(args('health'), root)).toBe(1);

    out = [];
    expect(await runDurableState(args('repair'), root)).toBe(1);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({
      ok: false,
      code: 'FLOOR_REGENERATION_REQUIRED',
    });
    expect(await readFile(path.join(dir, 'twolane', CURRENT_STORY_POINTER_FILE), 'utf8')).toBe(
      pointer
    );
  });

  it('rejects every partial bundle the floor loader would refuse', async () => {
    await ensureReviewStateVersion(dir, root);
    await writeFloor('floor-1');
    await installCurrentStory('floor-1');

    await rm(path.join(dir, 'floor-cache.json'));
    const markerless = await inspectDurableReviewState(root, 'demo');
    expect(markerless).toMatchObject({
      status: 'BLOCKED',
      states: expect.arrayContaining([
        expect.objectContaining({
          kind: 'FLOOR',
          status: 'CORRUPT',
          reason: expect.stringContaining('floor-cache.json'),
        }),
        expect.objectContaining({
          kind: 'STORY',
          status: 'HEALTHY',
          reason: expect.stringContaining('staleness unassessed'),
        }),
      ]),
      repair: { command: 'review data --branch "demo"' },
    });
    expect(await runDurableState(args('health'), root)).toBe(1);

    await writeFile(
      path.join(dir, 'floor-cache.json'),
      JSON.stringify({ producerVersion: 'stale-producer', floorFingerprint: 'fp' })
    );
    const incompatible = await inspectDurableReviewState(root, 'demo');
    expect(incompatible).toMatchObject({
      status: 'BLOCKED',
      states: expect.arrayContaining([
        expect.objectContaining({
          kind: 'FLOOR',
          status: 'CORRUPT',
          reason: expect.stringContaining('producer marker'),
        }),
      ]),
    });

    await writeFloor('floor-1');
    await rm(path.join(dir, 'diff.patch'));
    const missingDiff = await inspectDurableReviewState(root, 'demo');
    expect(missingDiff).toMatchObject({
      status: 'BLOCKED',
      states: expect.arrayContaining([
        expect.objectContaining({
          kind: 'FLOOR',
          status: 'CORRUPT',
          reason: expect.stringContaining('diff.patch'),
        }),
      ]),
    });

    await writeFloor('floor-1');
    expect((await inspectDurableReviewState(root, 'demo')).status).toBe('HEALTHY');
  });

  it('reports an unparseable floor as corrupt without relabeling the Story', async () => {
    await ensureReviewStateVersion(dir, root);
    await writeFloor('floor-1');
    await installCurrentStory('floor-1');
    await writeFile(path.join(dir, 'floor.json'), 'not json {');

    const malformed = await inspectDurableReviewState(root, 'demo');
    expect(malformed).toMatchObject({
      status: 'BLOCKED',
      states: expect.arrayContaining([
        expect.objectContaining({
          kind: 'FLOOR',
          status: 'CORRUPT',
          reason: expect.stringContaining('not valid JSON'),
        }),
        expect.objectContaining({ kind: 'STORY', status: 'HEALTHY' }),
      ]),
      repair: { command: 'review data --branch "demo"' },
    });
    expect(await runDurableState(args('health'), root)).toBe(1);

    await writeFile(path.join(dir, 'floor.json'), '{"schema_version":999}');
    const invalid = await inspectDurableReviewState(root, 'demo');
    expect(invalid).toMatchObject({
      status: 'BLOCKED',
      states: expect.arrayContaining([
        expect.objectContaining({
          kind: 'FLOOR',
          status: 'CORRUPT',
          reason: expect.stringContaining('violates the current schema'),
        }),
        expect.objectContaining({ kind: 'STORY', status: 'HEALTHY' }),
      ]),
    });

    out = [];
    expect(await runDurableState(args('repair'), root)).toBe(1);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({
      ok: false,
      code: 'FLOOR_REGENERATION_REQUIRED',
    });
    expect(await readFile(path.join(dir, 'floor.json'), 'utf8')).toBe('{"schema_version":999}');
  });

  it('reports healthy, stale, and invalid Current Story through the authoritative reader', async () => {
    await ensureReviewStateVersion(dir, root);
    await writeFloor('floor-1');
    const pointer = await installCurrentStory('floor-1');
    const comments = `${JSON.stringify({
      type: 'add',
      comment_id: 'comment-1',
      ts: '2026-07-23T10:01:00.000Z',
      author: 'reviewer',
      body: 'keep this comment',
      anchor: {
        kind: 'DIFF_LINE',
        file: 'src/a.ts',
        side: 'add',
        line: 1,
        lineHash: 'line-hash',
      },
    })}\n`;
    const journal = `${JSON.stringify({
      type: 'section',
      ts: '2026-07-23T10:02:00.000Z',
      threadKey: 'sec_1',
      action: 'VISIT',
    })}\n`;
    await writeFile(path.join(dir, 'comments.ndjson'), comments);
    await writeFile(path.join(dir, 'journal.ndjson'), journal);

    expect(await inspectDurableReviewState(root, 'demo')).toMatchObject({
      status: 'HEALTHY',
      states: expect.arrayContaining([
        expect.objectContaining({ kind: 'STORY', status: 'HEALTHY', schemaVersion: 1 }),
      ]),
    });

    await writeFloor('floor-2');
    const stale = await inspectDurableReviewState(root, 'demo');
    expect(stale).toMatchObject({
      status: 'BLOCKED',
      states: expect.arrayContaining([
        expect.objectContaining({ kind: 'STORY', status: 'STALE' }),
        expect.objectContaining({ kind: 'COMMENTS', status: 'HEALTHY' }),
        expect.objectContaining({ kind: 'JOURNAL', status: 'HEALTHY' }),
      ]),
      repair: {
        command: 'review routine-start --branch "demo"',
        behavior: expect.stringContaining('remain unchanged'),
      },
    });
    expect(await runDurableState(args('repair'), root)).toBe(1);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({
      ok: false,
      code: 'STORY_REGENERATION_REQUIRED',
    });
    expect(await readFile(path.join(dir, 'twolane', CURRENT_STORY_POINTER_FILE), 'utf8')).toBe(
      pointer
    );
    expect(await readFile(path.join(dir, 'comments.ndjson'), 'utf8')).toBe(comments);
    expect(await readFile(path.join(dir, 'journal.ndjson'), 'utf8')).toBe(journal);

    await writeFile(path.join(dir, 'twolane', CURRENT_STORY_POINTER_FILE), 'not json {');
    const invalid = await inspectDurableReviewState(root, 'demo');
    expect(invalid).toMatchObject({
      status: 'BLOCKED',
      states: expect.arrayContaining([
        expect.objectContaining({ kind: 'STORY', status: 'CORRUPT' }),
        expect.objectContaining({ kind: 'COMMENTS', status: 'HEALTHY' }),
        expect.objectContaining({ kind: 'JOURNAL', status: 'HEALTHY' }),
      ]),
      repair: {
        command: 'review routine-start --branch "demo"',
        behavior: expect.stringContaining('remain unchanged'),
      },
    });
    out = [];
    expect(await runDurableState(args('repair'), root)).toBe(1);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({
      ok: false,
      code: 'STORY_REGENERATION_REQUIRED',
    });
    expect(await readFile(path.join(dir, 'twolane', CURRENT_STORY_POINTER_FILE), 'utf8')).toBe(
      'not json {'
    );
    expect(await readFile(path.join(dir, 'comments.ndjson'), 'utf8')).toBe(comments);
    expect(await readFile(path.join(dir, 'journal.ndjson'), 'utf8')).toBe(journal);
    expect(await readdir(path.dirname(dir))).toEqual(['demo']);
  });

  it('fails closed across all durable files and deletes them during explicit repair', async () => {
    await ensureReviewStateVersion(dir, root);
    const originals: Record<string, string> = {
      'comments.ndjson': '{broken comment\n',
      'journal.ndjson': '{broken journal\n',
    };
    for (const [name, content] of Object.entries(originals)) {
      await writeFile(path.join(dir, name), content);
    }

    expect(await runDurableState(args('health'), root)).toBe(1);
    const unhealthy = JSON.parse(out.at(-1)!) as Awaited<
      ReturnType<typeof inspectDurableReviewState>
    >;
    expect(unhealthy.status).toBe('BLOCKED');
    expect(unhealthy.states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'COMMENTS', status: 'CORRUPT' }),
        expect.objectContaining({ kind: 'JOURNAL', status: 'CORRUPT' }),
      ])
    );

    expect(await runDurableState(args('repair'), root)).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ reset: true });
    expect(await readdir(dir)).toEqual(['review-state.json']);
    expect(await readdir(path.dirname(dir))).toEqual(['demo']);
    expect(JSON.parse(await readFile(path.join(dir, 'review-state.json'), 'utf8'))).toEqual({
      review_state_version: REVIEW_STATE_VERSION,
    });
    expect((await inspectDurableReviewState(root, 'demo')).status).toBe('HEALTHY');
  });

  it('waits for the branch journal lock before destructive repair', async () => {
    await ensureReviewStateVersion(dir, root);
    const comments = '{broken comment\n';
    await writeFile(path.join(dir, 'comments.ndjson'), comments);
    const locksDir = path.join(root, '.orcaops', 'tmp', 'locks');
    const lock = new ArtifactLock({ locksDir, containmentRoot: root });
    let release!: () => void;
    const held = lock.withLock('demo', async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    while (release === undefined) await new Promise((resolve) => setTimeout(resolve, 1));

    const repair = runDurableState(args('repair'), root);
    const stateWhileLocked = await Promise.race([
      repair.then(() => 'completed' as const),
      new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 25)),
    ]);
    expect(stateWhileLocked).toBe('waiting');
    expect(await readFile(path.join(dir, 'comments.ndjson'), 'utf8')).toBe(comments);

    release();
    await held;
    expect(await repair).toBe(0);
    expect(await readdir(dir)).toEqual(['review-state.json']);
  });

  it('classifies an old directory schema as unsupported rather than corrupt', async () => {
    await ensureReviewStateVersion(dir, root);
    await writeFile(
      path.join(dir, 'review-state.json'),
      `${JSON.stringify({ review_state_version: REVIEW_STATE_VERSION - 1 })}\n`
    );
    expect(await inspectDurableReviewState(root, 'demo')).toMatchObject({
      status: 'BLOCKED',
      states: [expect.objectContaining({ kind: 'REVIEW_STATE', status: 'UNSUPPORTED_SCHEMA' })],
    });
  });
});
