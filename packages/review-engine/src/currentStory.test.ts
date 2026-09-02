import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { slugifyBranch } from '@orcaops/review-core';
import { ArtifactLock } from '@orcaops/storage';

import {
  CURRENT_STORY_POINTER_FILE,
  CurrentStoryInstallError,
  publishCurrentStoryForRun,
  resolveCurrentStory,
} from './currentStory.js';
import { reviewStateLockKey } from './reviewState.js';
import {
  serializeStoryReviewModel,
  STORY_REVIEW_MODEL_FILE,
  STORY_REVIEW_MODEL_SCHEMA_VERSION,
  type StoryReviewModel,
} from './storyReviewModel.js';
import { terminalRunFileSeed } from '../tests/support/twolaneRunFile.js';

const branch = 'feature/current-story';
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
let root: string;
let reviewDir: string;
let locksDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'current-story-'));
  reviewDir = path.join(root, 'review');
  locksDir = path.join(root, 'locks');
  await mkdir(path.join(reviewDir, 'twolane'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const model = (floorInputHash = 'floor-1'): StoryReviewModel => ({
  schema_version: STORY_REVIEW_MODEL_SCHEMA_VERSION,
  branch,
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
});

async function installTerminal(input: {
  runId: string;
  finalizedAt: string;
  story?: StoryReviewModel;
}): Promise<{ runDir: string; modelBytes: string }> {
  const runDir = path.join(reviewDir, 'twolane', input.runId);
  await mkdir(runDir, { recursive: true });
  const modelBytes = serializeStoryReviewModel(input.story ?? model());
  const modelSha = sha256(modelBytes);
  const inputShas = { dossier: 'dossier', projection: 'projection' };
  await Promise.all([
    writeFile(path.join(runDir, STORY_REVIEW_MODEL_FILE), modelBytes),
    writeFile(
      path.join(runDir, 'run-v1.json'),
      `${JSON.stringify(
        terminalRunFileSeed({ runId: input.runId, branch, finalizedAt: input.finalizedAt }),
        null,
        2
      )}\n`
    ),
    writeFile(
      path.join(runDir, 'run-record-v1.json'),
      `${JSON.stringify(
        {
          schema_version: 1,
          run_id: input.runId,
          branch,
          input_shas: inputShas,
          finalized_at: input.finalizedAt,
          outcome: 'FULL',
          outputs: {
            story_review_model: STORY_REVIEW_MODEL_FILE,
            story_review_model_sha256: modelSha,
          },
        },
        null,
        2
      )}\n`
    ),
  ]);
  return { runDir, modelBytes };
}

const publish = (runId: string, writePointer?: (file: string, bytes: string) => Promise<void>) =>
  publishCurrentStoryForRun({
    reviewDir,
    locksDir,
    containmentRoot: root,
    branch,
    runId,
    ...(writePointer !== undefined ? { writePointer } : {}),
  });

describe('authoritative current Story resolver', () => {
  it('validates the terminal run only after acquiring the review-state lock', async () => {
    const runId = '01010101-0101-4101-8101-010101010101';
    const installed = await installTerminal({
      runId,
      finalizedAt: '2026-07-23T10:00:00.000Z',
    });
    const lock = new ArtifactLock({ locksDir, containmentRoot: root });
    let markAcquired!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = lock.withLock(reviewStateLockKey(slugifyBranch(branch)), async () => {
      markAcquired();
      await blocked;
    });
    await acquired;

    const pending = publish(runId);
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      await rm(path.join(installed.runDir, 'run-record-v1.json'));
    } finally {
      release();
      await held;
    }
    await expect(pending).rejects.toThrow(/run-record-v1\.json/);
    await expect(
      readFile(path.join(reviewDir, 'twolane', CURRENT_STORY_POINTER_FILE), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ignores retired model files when no current pointer exists', async () => {
    expect(await resolveCurrentStory({ reviewDir })).toMatchObject({
      status: 'ABSENT',
      runId: null,
    });
    const runId = '11111111-1111-4111-8111-111111111111';
    const runDir = path.join(reviewDir, 'twolane', runId);
    await mkdir(runDir);
    await writeFile(path.join(runDir, 'story-review-model-v3.json'), 'deliberately not json');
    expect(await resolveCurrentStory({ reviewDir })).toMatchObject({
      status: 'ABSENT',
      runId: null,
    });
  });

  it('publishes and resolves a canonical terminal v4 model, with explicit staleness', async () => {
    const runId = '22222222-2222-4222-8222-222222222222';
    await installTerminal({ runId, finalizedAt: '2026-07-23T10:00:00.000Z' });
    const installed = await publish(runId);
    expect(installed.installed).toBe(true);
    const resolved = await resolveCurrentStory({ reviewDir, floorInputHash: 'floor-1' });
    expect(resolved).toMatchObject({ status: 'OK', runId });
    expect(resolved.generation).toEqual(expect.any(String));
    expect(resolved.model?.schema_version).toBe(4);
    const stale = await resolveCurrentStory({ reviewDir, floorInputHash: 'floor-2' });
    expect(stale).toMatchObject({
      status: 'STALE',
      runId,
      generation: resolved.generation,
    });
    // The model passed full validation before the floor comparison; it is
    // RETAINED for best-effort viewing. Authority stays gated on status.
    expect(stale.model?.schema_version).toBe(4);
  });

  it('refuses a symlinked current pointer without changing its target', async () => {
    const runId = '23232323-2323-4232-8232-232323232323';
    await installTerminal({ runId, finalizedAt: '2026-07-23T10:00:00.000Z' });
    await publish(runId);
    const pointerFile = path.join(reviewDir, 'twolane', CURRENT_STORY_POINTER_FILE);
    const external = path.join(root, 'external-pointer.json');
    await rename(pointerFile, external);
    const pointerBytes = await readFile(external, 'utf8');
    await symlink(external, pointerFile);

    await expect(publish(runId)).rejects.toThrow(/symbolic link/u);
    await expect(readFile(external, 'utf8')).resolves.toBe(pointerBytes);
  });

  it('never falls back from an invalid current pointer to an older readable run', async () => {
    const runId = '33333333-3333-4333-8333-333333333333';
    await installTerminal({ runId, finalizedAt: '2026-07-23T10:00:00.000Z' });
    await publish(runId);
    await writeFile(path.join(reviewDir, 'twolane', CURRENT_STORY_POINTER_FILE), 'not json {');
    expect(await resolveCurrentStory({ reviewDir })).toMatchObject({
      status: 'INVALID',
      model: null,
    });
  });

  it('chooses the greatest terminal tuple and makes equal/older retries no-ops', async () => {
    const older = '44444444-4444-4444-8444-444444444444';
    const newer = '55555555-5555-4555-8555-555555555555';
    const olderInstall = await installTerminal({
      runId: older,
      finalizedAt: '2026-07-23T10:00:00.000Z',
    });
    await installTerminal({ runId: newer, finalizedAt: '2026-07-23T11:00:00.000Z' });
    await publish(newer);
    const touchedAt = new Date('2030-01-01T00:00:00.000Z');
    await utimes(path.join(olderInstall.runDir, STORY_REVIEW_MODEL_FILE), touchedAt, touchedAt);
    const noWrite = vi.fn(async () => {
      throw new Error('equal/older candidate must not write');
    });
    expect((await publish(newer, noWrite)).installed).toBe(false);
    expect((await publish(older, noWrite)).installed).toBe(false);
    expect(noWrite).not.toHaveBeenCalled();
    expect(await resolveCurrentStory({ reviewDir })).toMatchObject({
      status: 'OK',
      runId: newer,
    });
  });

  it('reports an injected post-terminal write failure and a retry repairs it', async () => {
    const runId = '66666666-6666-4666-8666-666666666666';
    await installTerminal({ runId, finalizedAt: '2026-07-23T10:00:00.000Z' });
    await expect(
      publish(runId, async () => {
        throw new Error('disk full');
      })
    ).rejects.toBeInstanceOf(CurrentStoryInstallError);
    expect(await resolveCurrentStory({ reviewDir })).toMatchObject({ status: 'ABSENT' });
    expect((await publish(runId)).installed).toBe(true);
    expect(await resolveCurrentStory({ reviewDir })).toMatchObject({ status: 'OK', runId });
  });

  it('invalidates a pointed run when model bytes or terminal lineage drift', async () => {
    const runId = '77777777-7777-4777-8777-777777777777';
    const installed = await installTerminal({
      runId,
      finalizedAt: '2026-07-23T10:00:00.000Z',
    });
    await publish(runId);
    await writeFile(
      path.join(installed.runDir, STORY_REVIEW_MODEL_FILE),
      `${installed.modelBytes} `
    );
    expect(await resolveCurrentStory({ reviewDir })).toMatchObject({ status: 'INVALID', runId });

    await writeFile(path.join(installed.runDir, STORY_REVIEW_MODEL_FILE), installed.modelBytes);
    const recordFile = path.join(installed.runDir, 'run-record-v1.json');
    const record = JSON.parse(await readFile(recordFile, 'utf8')) as {
      input_shas: Record<string, string>;
    };
    record.input_shas.projection = 'drifted';
    await writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`);
    expect(await resolveCurrentStory({ reviewDir })).toMatchObject({ status: 'INVALID', runId });
  });

  it('rejects a run file missing a required persisted key (strict schema on the pointer path)', async () => {
    const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const installed = await installTerminal({ runId, finalizedAt: '2026-07-23T10:00:00.000Z' });
    await publish(runId);
    const runFilePath = path.join(installed.runDir, 'run-v1.json');
    const seeded = JSON.parse(await readFile(runFilePath, 'utf8')) as Record<string, unknown>;
    delete seeded.runtime_identity;
    await writeFile(runFilePath, `${JSON.stringify(seeded, null, 2)}\n`);
    const resolved = await resolveCurrentStory({ reviewDir });
    expect(resolved).toMatchObject({ status: 'INVALID', runId });
    expect(resolved.issue).toContain('runtime_identity');
  });

  it('refuses a pointer written by a foreign schema version instead of repairing over it', async () => {
    const runId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await installTerminal({ runId, finalizedAt: '2026-07-23T10:00:00.000Z' });
    await writeFile(
      path.join(reviewDir, 'twolane', CURRENT_STORY_POINTER_FILE),
      JSON.stringify({ schema_version: 2, run_id: runId }),
      'utf8'
    );
    await expect(publish(runId)).rejects.toThrow(/pointer schema 2 is unsupported/);
  });

  it('refuses to unseat a newer pointer whose run file fails its contract (no rollback)', async () => {
    const older = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const newer = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await installTerminal({ runId: older, finalizedAt: '2026-07-23T10:00:00.000Z' });
    await publish(older);
    const installed = await installTerminal({
      runId: newer,
      finalizedAt: '2026-07-23T11:00:00.000Z',
    });
    await publish(newer);

    // Damage the NEWER pointed run's contract, then re-publish the older
    // run: the monotonicity guard must hold — refusing loudly beats a
    // silent rollback of the branch's current Story.
    const runFilePath = path.join(installed.runDir, 'run-v1.json');
    const seeded = JSON.parse(await readFile(runFilePath, 'utf8')) as Record<string, unknown>;
    delete seeded.runtime_identity;
    await writeFile(runFilePath, `${JSON.stringify(seeded, null, 2)}\n`);

    await expect(publish(older)).rejects.toThrow(/refusing to unseat/);

    // A MISSING run file (not just field damage) must refuse the same
    // way — ENOENT from the pointed run is indistinguishable from
    // partial deletion, and repairing over it would roll the branch back.
    const { rm } = await import('node:fs/promises');
    await rm(path.join(installed.runDir, 'run-record-v1.json'));
    await expect(publish(older)).rejects.toThrow(/refusing to unseat/);

    // The inverse direction is a REPAIR, not a rollback: a valid run
    // even newer than the damaged pointed one must install.
    const newest = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await installTerminal({ runId: newest, finalizedAt: '2026-07-23T12:00:00.000Z' });
    const result = await publish(newest);
    expect(result.installed).toBe(true);
    expect(result.pointer.run_id).toBe(newest);
  });

  it('shares lifecycle generation across identical models in distinct runs', async () => {
    const first = '88888888-8888-4888-8888-888888888888';
    const second = '99999999-9999-4999-8999-999999999999';
    await installTerminal({ runId: first, finalizedAt: '2026-07-23T10:00:00.000Z' });
    await publish(first);
    const firstResolution = await resolveCurrentStory({ reviewDir });
    await installTerminal({ runId: second, finalizedAt: '2026-07-23T11:00:00.000Z' });
    await publish(second);
    const secondResolution = await resolveCurrentStory({ reviewDir });
    expect(secondResolution.runId).not.toBe(firstResolution.runId);
    expect(secondResolution.generation).toBe(firstResolution.generation);
    expect(secondResolution.pointerSha256).not.toBe(firstResolution.pointerSha256);
  });
});
