import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '@orcaops/core';
import type { Floor } from '@orcaops/review-core';
import {
  CURRENT_STORY_POINTER_FILE,
  type ReviewRuntimeDescriptor,
  runReview,
  serializeStoryReviewModel,
  STORY_REVIEW_MODEL_FILE,
  STORY_REVIEW_MODEL_SCHEMA_VERSION,
  type StoryReviewModel,
} from '@orcaops/review-engine';
import { ArtifactStore } from '@orcaops/storage';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { loadRoutineStoryOverlay } from './reviewSource';
import { terminalRunFileSeed } from '../../tests/support/twolaneRunFile.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'routine-overlay-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const floorWith = (hash: string): Floor => ({ input_hash: hash }) as unknown as Floor;
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const execFileAsync = promisify(execFile);

const model = (floorHash: string, branch = 'b'): StoryReviewModel => ({
  schema_version: STORY_REVIEW_MODEL_SCHEMA_VERSION,
  branch,
  floor_input_hash: floorHash,
  label: 'CODE_ONLY',
  banner: 'code only',
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

async function installRun(input: {
  runId: string;
  model: StoryReviewModel;
  finalizedAt: string;
  point?: boolean;
}): Promise<void> {
  const twolaneDir = path.join(dir, 'twolane');
  const runDir = path.join(twolaneDir, input.runId);
  await mkdir(runDir, { recursive: true });
  const modelBytes = serializeStoryReviewModel(input.model);
  const modelSha = sha256(modelBytes);
  const inputShas = { dossier: 'dossier-sha', projection: 'projection-sha' };
  await Promise.all([
    writeFile(path.join(runDir, STORY_REVIEW_MODEL_FILE), modelBytes),
    writeFile(
      path.join(runDir, 'run-v1.json'),
      `${JSON.stringify(
        terminalRunFileSeed({
          runId: input.runId,
          branch: input.model.branch,
          finalizedAt: input.finalizedAt,
          inputShas,
        }),
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
          branch: input.model.branch,
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
  if (input.point !== false)
    await writeFile(
      path.join(twolaneDir, CURRENT_STORY_POINTER_FILE),
      `${JSON.stringify(
        {
          schema_version: 1,
          run_id: input.runId,
          finalized_at: input.finalizedAt,
          floor_input_hash: input.model.floor_input_hash,
          model_file: STORY_REVIEW_MODEL_FILE,
          model_sha256: modelSha,
        },
        null,
        2
      )}\n`
    );
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...args], { cwd: root });
  return result.stdout.trim();
}

async function createCapturedLifecycleRepo(): Promise<{
  repo: TempRepo;
  runtime: ReviewRuntimeDescriptor;
  branch: string;
}> {
  const branch = 'watch-routine-e2e';
  const artifact = '22222222-2222-4222-8222-222222222222';
  const step = 'watch-routine-e2e-step';
  const repo = await createTempRepo({ initialBranch: 'main' });
  const root = repo.path;
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), '.orcaops/\n');
  await writeFile(path.join(root, 'src', 'app.ts'), 'export const baseline = true;\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'base']);
  const baseSha = await git(root, ['rev-parse', 'HEAD']);
  await git(root, ['checkout', '-b', branch]);

  const config = await loadConfig(root);
  const store = new ArtifactStore({ repoRoot: root, config });
  try {
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: artifact,
        branch,
        base_sha: baseSha,
        agent: 'codex',
        agent_session_id: null,
        task: 'add a Watch-visible routine feature',
        label: 'Watch-visible routine feature',
        plan_steps: [
          {
            step_id: step,
            text: 'add the Watch-visible routine feature',
            label: 'Watch-visible feature',
            acceptance_criteria: [],
          },
        ],
        touched_scope: ['src/watch-feature.ts'],
        non_goals: [],
        decisions: [],
        started_at: '2026-07-31T00:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: 'watch-routine-plan' }
    );
    await store.writeCheckpointOpened(
      { artifact_id: artifact, declared_step_ids: [step] },
      { idempotencyKey: 'watch-routine-open', headSha: baseSha }
    );
    await writeFile(
      path.join(root, 'src', 'watch-feature.ts'),
      'export const watchFeature = "captured";\n'
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: artifact,
        n: 1,
        summary: 'added the Watch-visible routine feature',
        files_changed: ['src/watch-feature.ts'],
        decisions: [
          {
            decision: 'keep the Watch lifecycle fixture bounded',
            reason: 'one changed file makes the installed Part unambiguous',
          },
        ],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'watch routine fixture setup', exit_code: 0 }],
        completed_step_ids: [step],
        head_sha: baseSha,
      },
      { idempotencyKey: 'watch-routine-close' }
    );
  } finally {
    store.close();
  }

  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'add Watch routine feature']);

  const runtimeRoot = path.join(root, '.orcaops', 'runtime');
  const entrypointPath = path.join(runtimeRoot, 'dist', 'sidecar.js');
  await mkdir(path.dirname(entrypointPath), { recursive: true });
  await writeFile(
    path.join(runtimeRoot, 'package.json'),
    JSON.stringify({ name: '@orcaops/review-engine', version: '0.0.0' })
  );
  await writeFile(entrypointPath, 'export {};\n');
  return { repo, runtime: { packageRoot: runtimeRoot, entrypointPath }, branch };
}

function authoredAccount(checkpointAlias: string, citationAlias: string) {
  return {
    schema_version: 1,
    overview: {
      text: 'The captured checkpoint adds one Watch-visible feature.',
      citations: [citationAlias],
    },
    acts: [
      {
        title: 'Add the Watch-visible feature',
        interpretation: 'The checkpoint carries the feature into the installed Story.',
        parts: [
          {
            title: 'Watch-visible feature',
            checkpoints: [checkpointAlias],
            interpretation: 'The changed file implements the captured checkpoint.',
            citations: [citationAlias],
          },
        ],
      },
    ],
    questions: [],
  };
}

describe('loadRoutineStoryOverlay — authoritative current Story', () => {
  it('is absent when no current pointer or retired model exists', async () => {
    expect(await loadRoutineStoryOverlay({ dir, floor: floorWith('h1') })).toEqual({
      model: null,
      status: 'absent',
      issue: null,
      runId: null,
      generation: null,
      installationToken: null,
      anchors: { model: null, status: 'absent', issue: null, generation: null },
    });
  });

  it('loads the terminal run selected by the current pointer', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    await installRun({
      runId,
      model: model('h1', 'my-branch'),
      finalizedAt: '2026-07-23T10:00:00.000Z',
    });
    const overlay = await loadRoutineStoryOverlay({ dir, floor: floorWith('h1') });
    expect(overlay.status).toBe('ok');
    expect(overlay.model?.branch).toBe('my-branch');
    expect(overlay.runId).toBe(runId);
    expect(overlay.generation).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(overlay.installationToken).not.toBeNull();
    expect(overlay.anchors).toEqual({
      model: null,
      status: 'absent',
      issue: null,
      generation: null,
    });
  });

  it('loads every Part installed by the real two-lane routine lifecycle', async () => {
    const fixture = await createCapturedLifecycleRepo();
    try {
      const stdout: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdout.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const lastJson = (): Record<string, unknown> => {
        for (let index = stdout.length - 1; index >= 0; index -= 1) {
          const line = stdout[index]!;
          if (line.trimStart().startsWith('{')) {
            return JSON.parse(line) as Record<string, unknown>;
          }
        }
        throw new Error('routine command emitted no JSON');
      };
      const run = (args: string[]) =>
        runReview(
          ['review', ...args, '--branch', fixture.branch, '--root', fixture.repo.path, '--json'],
          process.env,
          undefined,
          fixture.runtime
        );
      const writePayload = async (name: string, value: unknown): Promise<string> => {
        const file = path.join(fixture.repo.path, name);
        await writeFile(file, JSON.stringify(value));
        return file;
      };
      const submit = (runId: string, lane: string, input: string) =>
        run([
          'routine-submit',
          '--run',
          runId,
          '--lane',
          lane,
          '--isolation',
          'sequential',
          '--input',
          input,
        ]);

      expect(await run(['routine-start'])).toBe(0);
      const runId = lastJson().run_id as string;
      expect(
        await submit(
          runId,
          'forensic',
          await writePayload('watch-forensic.json', {
            findings: [
              {
                claim: 'The exported value has no behavioral guard.',
                file: 'src/watch-feature.ts',
                related_files: [],
                severity: 'CAUTION',
                confidence: 'HIGH',
              },
            ],
            questions: [],
          })
        )
      ).toBe(0);
      const accountEnvelope = lastJson().account as Record<string, unknown>;
      const accountPrompt = await readFile(
        path.join(fixture.repo.path, accountEnvelope.payload_path as string),
        'utf8'
      );
      const checkpointAlias = accountPrompt.match(/^#### (k\d+) ·/m)?.[1];
      const citationAlias = accountPrompt.match(/\[(c\d+)\]/)?.[1];
      expect(checkpointAlias).toBeDefined();
      expect(citationAlias).toBeDefined();

      expect(
        await submit(
          runId,
          'account',
          await writePayload(
            'watch-account.json',
            authoredAccount(checkpointAlias!, citationAlias!)
          )
        )
      ).toBe(0);
      expect(lastJson()).toMatchObject({ accepted: true, outcome: 'FULL' });

      const reviewDir = path.join(fixture.repo.path, '.orcaops', 'reviews', fixture.branch);
      const floor = JSON.parse(await readFile(path.join(reviewDir, 'floor.json'), 'utf8')) as Floor;
      const overlay = await loadRoutineStoryOverlay({ dir: reviewDir, floor });
      expect(overlay).toMatchObject({
        status: 'ok',
        runId,
        model: {
          parts: [expect.objectContaining({ title: 'Watch-visible feature' })],
        },
      });
    } finally {
      await fixture.repo.cleanup();
    }
  });

  it('keeps Story readable while ignoring a retired anchor pointer', async () => {
    const runId = '66666666-6666-4666-8666-666666666666';
    await installRun({
      runId,
      model: model('h1', 'my-branch'),
      finalizedAt: '2026-07-23T10:00:00.000Z',
    });
    const anchorsDir = path.join(dir, 'twolane', runId, 'anchors');
    await mkdir(anchorsDir, { recursive: true });
    await writeFile(path.join(anchorsDir, 'current-v2.json'), '{"schema_version":2}\n');

    const overlay = await loadRoutineStoryOverlay({ dir, floor: floorWith('h1') });
    expect(overlay).toMatchObject({
      status: 'ok',
      model: { branch: 'my-branch' },
      anchors: {
        model: null,
        status: 'absent',
        generation: null,
      },
    });
    expect(overlay.anchors.issue).toBeNull();
  });

  it('ignores a retired Story model when no current pointer exists', async () => {
    const runId = '22222222-2222-4222-8222-222222222222';
    const runDir = path.join(dir, 'twolane', runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, 'story-review-model-v3.json'), '{}\n');
    const overlay = await loadRoutineStoryOverlay({ dir, floor: floorWith('h1') });
    expect(overlay).toMatchObject({ status: 'absent', model: null, runId: null, issue: null });
  });

  it('reports stale when the pointed model belongs to a different floor', async () => {
    await installRun({
      runId: '33333333-3333-4333-8333-333333333333',
      model: model('OLD'),
      finalizedAt: '2026-07-23T10:00:00.000Z',
    });
    const overlay = await loadRoutineStoryOverlay({ dir, floor: floorWith('NEW') });
    expect(overlay.status).toBe('stale');
    // The validated model is RETAINED for best-effort read-only viewing; every
    // authority decision keys off `status`, never off model presence.
    expect(overlay.model?.floor_input_hash).toBe('OLD');
    expect(overlay.generation).not.toBeNull();
  });

  it('does not select by model mtime or search backward from the pointer', async () => {
    const pointed = '44444444-4444-4444-8444-444444444444';
    await installRun({
      runId: '55555555-5555-4555-8555-555555555555',
      model: model('h1', 'newer-unpointed'),
      finalizedAt: '2026-07-23T11:00:00.000Z',
      point: false,
    });
    await installRun({
      runId: pointed,
      model: model('h1', 'pointed'),
      finalizedAt: '2026-07-23T10:00:00.000Z',
    });
    const overlay = await loadRoutineStoryOverlay({ dir, floor: floorWith('h1') });
    expect(overlay).toMatchObject({ status: 'ok', runId: pointed });
    expect(overlay.model?.branch).toBe('pointed');

    await writeFile(path.join(dir, 'twolane', CURRENT_STORY_POINTER_FILE), 'not json {');
    const broken = await loadRoutineStoryOverlay({ dir, floor: floorWith('h1') });
    expect(broken.status).toBe('invalid');
    expect(broken.model).toBeNull();
  });
});
