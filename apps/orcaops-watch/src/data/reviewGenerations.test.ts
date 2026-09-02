import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildReviewFloorFixture } from '@orcaops/review-core';
import {
  CURRENT_STORY_POINTER_FILE,
  SEMANTIC_ANCHOR_CURRENT_FILE,
  SEMANTIC_ANCHOR_MANIFEST_FILE,
  SEMANTIC_ANCHOR_MODEL_FILE,
  serializeStoryReviewModel,
  STORY_REVIEW_MODEL_FILE,
  STORY_REVIEW_MODEL_SCHEMA_VERSION,
  type StoryReviewModel,
} from '@orcaops/review-engine';

import { loadInstalledReview, readReviewGenerations, type ReviewGenerations } from './reviewSource';
import { terminalRunFileSeed } from '../../tests/support/twolaneRunFile.js';

const roots: string[] = [];
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const diff = [
  'diff --git a/src/fixture.ts b/src/fixture.ts',
  '--- a/src/fixture.ts',
  '+++ b/src/fixture.ts',
  '@@ -1,0 +1 @@',
  '+stable fixture row',
  '',
].join('\n');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function changedKeys(before: ReviewGenerations, after: ReviewGenerations): string[] {
  return (Object.keys(before) as Array<keyof ReviewGenerations>).filter(
    (key) => before[key] !== after[key]
  );
}

function storyModel(floorHash: string, banner = 'code only'): StoryReviewModel {
  return {
    schema_version: STORY_REVIEW_MODEL_SCHEMA_VERSION,
    branch: 'probe',
    floor_input_hash: floorHash,
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
    findings: [],
    questions: [],
    citations: {},
    artifactAliases: {},
  };
}

async function installStory(
  reviewDir: string,
  runId: string,
  model: StoryReviewModel,
  finalizedAt: string
): Promise<void> {
  const twolaneDir = path.join(reviewDir, 'twolane');
  const runDir = path.join(twolaneDir, runId);
  await mkdir(runDir, { recursive: true });
  const modelBytes = serializeStoryReviewModel(model);
  const modelSha = sha256(modelBytes);
  const inputShas = { dossier: 'dossier', projection: 'projection' };
  await Promise.all([
    writeFile(path.join(runDir, STORY_REVIEW_MODEL_FILE), modelBytes),
    writeFile(
      path.join(runDir, 'run-v1.json'),
      `${JSON.stringify(
        terminalRunFileSeed({ runId, branch: model.branch, finalizedAt, inputShas })
      )}\n`
    ),
    writeFile(
      path.join(runDir, 'run-record-v1.json'),
      `${JSON.stringify({
        schema_version: 1,
        run_id: runId,
        branch: model.branch,
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
  await writeFile(
    path.join(twolaneDir, CURRENT_STORY_POINTER_FILE),
    `${JSON.stringify({
      schema_version: 1,
      run_id: runId,
      finalized_at: finalizedAt,
      floor_input_hash: model.floor_input_hash,
      model_file: STORY_REVIEW_MODEL_FILE,
      model_sha256: modelSha,
    })}\n`
  );
}

async function installedFixture(): Promise<{
  root: string;
  dir: string;
  floorHash: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'orcaops-review-installed-'));
  roots.push(root);
  const fixture = buildReviewFloorFixture('clean');
  fixture.floor.scope.branch = 'probe';
  fixture.floor.scope.branch_slug = 'probe';
  const dir = path.join(root, '.orcaops', 'reviews', 'probe');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'floor.json'), `${JSON.stringify(fixture.floor)}\n`);
  await writeFile(path.join(dir, 'diff.patch'), diff);
  return { root, dir, floorHash: fixture.floor.input_hash };
}

describe('review file generations', () => {
  it('ignores publication narrative files and changes only live Watch layers', async () => {
    const { root, dir } = await installedFixture();
    await writeFile(path.join(dir, 'floor-cache.json'), '{}\n');

    const initial = await readReviewGenerations({ root, branch: 'probe' });
    await writeFile(path.join(dir, 'comments.ndjson'), '{"type":"comment"}\n');
    const comments = await readReviewGenerations({ root, branch: 'probe' });
    expect(changedKeys(initial, comments)).toEqual(['comments']);

    await writeFile(path.join(dir, 'narrative.json'), '{broken publication bytes');
    await mkdir(path.join(dir, 'validation-receipts'), { recursive: true });
    await writeFile(path.join(dir, 'validation-receipts', 'receipt.json'), '{}\n');
    const publication = await readReviewGenerations({ root, branch: 'probe' });
    expect(changedKeys(comments, publication)).toEqual([]);
  });

  it('reads an installed bundle without executing a producer or reading corrupt narrative', async () => {
    const { root, dir, floorHash } = await installedFixture();
    const floorFile = path.join(dir, 'floor.json');
    const before = await readFile(floorFile, 'utf8');
    await writeFile(path.join(dir, 'narrative.json'), '{not json');

    const loaded = await loadInstalledReview({
      root,
      branch: 'probe',
      sidecarPath: path.join(root, 'must-not-execute.mjs'),
    });

    expect(loaded.floor.input_hash).toBe(floorHash);
    expect(loaded.routineStory.status).toBe('absent');
    expect(await readFile(floorFile, 'utf8')).toBe(before);
  });

  it('fails closed when an installed floor has no diff.patch', async () => {
    const { root, dir } = await installedFixture();
    await rm(path.join(dir, 'diff.patch'));

    const loaded = await loadInstalledReview({ root, branch: 'probe' });

    expect(loaded.reviewDiff).toBe('');
    expect(loaded.targetsStatus).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no retained parent hunk in diff.patch'),
    });
    expect(loaded.eligibleTargets).toEqual([]);
    expect(loaded.currentThreads.every((thread) => thread.rows === null)).toBe(true);
  });

  it('separates Story content generation from run installation identity', async () => {
    const { root, dir, floorHash } = await installedFixture();
    const before = await readReviewGenerations({ root, branch: 'probe' });

    const firstModel = storyModel(floorHash);
    await installStory(
      dir,
      '11111111-1111-4111-8111-111111111111',
      firstModel,
      '2026-07-23T10:00:00.000Z'
    );
    const first = await readReviewGenerations({ root, branch: 'probe' });
    expect(first.story).not.toBeNull();
    expect(first.storyInstallation).not.toBeNull();
    expect(changedKeys(before, first)).toEqual(['story', 'storyInstallation']);

    await installStory(
      dir,
      '22222222-2222-4222-8222-222222222222',
      firstModel,
      '2026-07-23T11:00:00.000Z'
    );
    const sameContent = await readReviewGenerations({ root, branch: 'probe' });
    expect(sameContent.story).toBe(first.story);
    expect(sameContent.storyInstallation).not.toBe(first.storyInstallation);

    await installStory(
      dir,
      '33333333-3333-4333-8333-333333333333',
      storyModel(floorHash, 'new Story contract'),
      '2026-07-23T12:00:00.000Z'
    );
    const differentContent = await readReviewGenerations({ root, branch: 'probe' });
    expect(differentContent.story).not.toBe(sameContent.story);
    expect(differentContent.storyInstallation).not.toBe(sameContent.storyInstallation);
  });

  it('ignores retired historical runs during pointerless probe and load', async () => {
    const { root, dir } = await installedFixture();
    const retired = path.join(dir, 'twolane', '44444444-4444-4444-8444-444444444444');
    await mkdir(retired, { recursive: true });
    await writeFile(path.join(retired, 'story-review-model-v3.json'), '{}\n');

    const generations = await readReviewGenerations({ root, branch: 'probe' });
    expect(generations.story).toBeNull();
    expect(generations.storyInstallation).toBeNull();
    const loaded = await loadInstalledReview({ root, branch: 'probe' });
    expect(loaded.routineStory.status).toBe('absent');
  });

  it('tracks anchors only inside the selected Story run, including UUIDv7 generations', async () => {
    const { root, dir, floorHash } = await installedFixture();
    const runId = '77777777-7777-7777-8777-777777777777';
    const generationId = '88888888-8888-7888-8888-888888888888';
    await installStory(dir, runId, storyModel(floorHash), '2026-07-23T13:00:00.000Z');
    const before = await readReviewGenerations({ root, branch: 'probe' });
    expect(before.storyAnchors).toBeNull();

    const generationDir = path.join(dir, 'twolane', runId, 'anchors', 'generations', generationId);
    await mkdir(generationDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(generationDir, SEMANTIC_ANCHOR_MANIFEST_FILE), '{"manifest":1}\n'),
      writeFile(path.join(generationDir, SEMANTIC_ANCHOR_MODEL_FILE), '{"model":1}\n'),
      writeFile(
        path.join(dir, 'twolane', runId, 'anchors', SEMANTIC_ANCHOR_CURRENT_FILE),
        `${JSON.stringify({ schema_version: 3, generation_id: generationId })}\n`
      ),
    ]);
    const installed = await readReviewGenerations({ root, branch: 'probe' });
    expect(changedKeys(before, installed)).toEqual(['storyAnchors']);
    expect(installed.storyAnchors).not.toBeNull();

    await writeFile(path.join(generationDir, SEMANTIC_ANCHOR_MODEL_FILE), '{"model":200}\n');
    const replacedModel = await readReviewGenerations({ root, branch: 'probe' });
    expect(changedKeys(installed, replacedModel)).toEqual(['storyAnchors']);

    const historical = path.join(dir, 'twolane', '99999999-9999-4999-8999-999999999999', 'anchors');
    await mkdir(historical, { recursive: true });
    await writeFile(path.join(historical, SEMANTIC_ANCHOR_CURRENT_FILE), '{}\n');
    const afterHistoricalWrite = await readReviewGenerations({ root, branch: 'probe' });
    expect(changedKeys(replacedModel, afterHistoricalWrite)).toEqual([]);
  });
});
