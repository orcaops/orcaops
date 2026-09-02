import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '@orcaops/core';
import { ArtifactStore } from '@orcaops/storage';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { runGit } from '../../src/git.js';
import { runReview } from '../../src/run.js';
import type { ReviewRuntimeDescriptor } from '../../src/runtimeIdentity.js';
import { parseStoryReviewModel, STORY_REVIEW_MODEL_FILE } from '../../src/storyReviewModel.js';

const BRANCH = 'routine-e2e';
const ARTIFACT = '11111111-1111-4111-8111-111111111111';
const STEP = 'routine-e2e-step';

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await runGit(root, args);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.toString('utf8').trim();
}

async function createCapturedRepo(): Promise<{
  repo: TempRepo;
  runtime: ReviewRuntimeDescriptor;
}> {
  const repo = await createTempRepo({ initialBranch: 'main' });
  const root = repo.path;
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), '.orcaops/\n');
  await writeFile(path.join(root, 'src', 'app.ts'), 'export const baseline = true;\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'base']);
  const baseSha = await git(root, ['rev-parse', 'HEAD']);
  await git(root, ['checkout', '-b', BRANCH]);

  const config = await loadConfig(root);
  const store = new ArtifactStore({ repoRoot: root, config });
  try {
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: ARTIFACT,
        branch: BRANCH,
        base_sha: baseSha,
        agent: 'codex',
        agent_session_id: null,
        task: 'add a captured routine feature',
        label: 'captured routine feature',
        plan_steps: [
          {
            step_id: STEP,
            text: 'add the routine feature',
            label: 'routine feature',
            acceptance_criteria: [],
          },
        ],
        touched_scope: ['src/feature.ts'],
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
      { idempotencyKey: 'routine-plan' }
    );
    await store.writeCheckpointOpened(
      { artifact_id: ARTIFACT, declared_step_ids: [STEP] },
      { idempotencyKey: 'routine-open', headSha: baseSha }
    );
    await writeFile(
      path.join(root, 'src', 'feature.ts'),
      'export const routineFeature = "captured";\n'
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: ARTIFACT,
        n: 1,
        summary: 'added the captured routine feature',
        files_changed: ['src/feature.ts'],
        decisions: [
          {
            decision: 'keep the fixture feature self-contained',
            reason: 'one changed file keeps the lifecycle assertion focused',
          },
        ],
        uncertainty: [],
        done_criteria: [],
        verification: [{ command: 'fixture verification', exit_code: 0 }],
        completed_step_ids: [STEP],
        head_sha: baseSha,
      },
      { idempotencyKey: 'routine-close' }
    );
  } finally {
    store.close();
  }

  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'add routine feature']);

  const runtimeRoot = path.join(root, '.orcaops', 'runtime');
  const entrypointPath = path.join(runtimeRoot, 'dist', 'sidecar.js');
  await mkdir(path.dirname(entrypointPath), { recursive: true });
  await writeFile(
    path.join(runtimeRoot, 'package.json'),
    JSON.stringify({ name: '@orcaops/review-engine', version: '0.0.0' })
  );
  await writeFile(entrypointPath, 'export {};\n');
  return { repo, runtime: { packageRoot: runtimeRoot, entrypointPath } };
}

function authoredAccount(checkpointAlias: string, citationAlias: string) {
  return {
    schema_version: 1,
    overview: {
      text: 'The captured checkpoint adds one bounded feature.',
      citations: [citationAlias],
    },
    acts: [
      {
        title: 'Add the bounded feature',
        interpretation: 'The checkpoint carries the feature from intent to implementation.',
        parts: [
          {
            title: 'Captured feature',
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

describe('two-lane routine lifecycle', () => {
  let repo: TempRepo | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    await repo?.cleanup();
    repo = null;
  });

  it('enforces forensic-first ordering and installs the accepted Story', async () => {
    const fixture = await createCapturedRepo();
    repo = fixture.repo;

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
        ['review', ...args, '--branch', BRANCH, '--root', fixture.repo.path, '--json'],
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
    const started = lastJson();
    expect(started.lane).toBe('forensic');
    const runId = started.run_id as string;

    const premature = await writePayload('premature-account.json', {});
    expect(await submit(runId, 'account', premature)).toBe(0);
    expect(lastJson()).toMatchObject({
      accepted: false,
      diagnostics: [{ code: 'TWOLANE_ROUTINE_ORDER' }],
    });

    const forensic = await writePayload('forensic.json', {
      findings: [
        {
          claim: 'The new exported value has no behavioral guard.',
          file: 'src/feature.ts',
          related_files: [],
          severity: 'CAUTION',
          confidence: 'HIGH',
        },
      ],
      questions: [],
    });
    expect(await submit(runId, 'forensic', forensic)).toBe(0);
    const forensicEnvelope = lastJson();
    expect(forensicEnvelope, JSON.stringify(forensicEnvelope, null, 2)).toMatchObject({
      accepted: true,
    });
    const accountEnvelope = forensicEnvelope.account as Record<string, unknown>;
    const accountPrompt = await readFile(
      path.join(fixture.repo.path, accountEnvelope.payload_path as string),
      'utf8'
    );
    const checkpointAlias = accountPrompt.match(/^#### (k\d+) ·/m)?.[1];
    const citationAlias = accountPrompt.match(/\[(c\d+)\]/)?.[1];
    expect(checkpointAlias).toBeDefined();
    expect(citationAlias).toBeDefined();

    const account = await writePayload(
      'account.json',
      authoredAccount(checkpointAlias!, citationAlias!)
    );
    expect(await submit(runId, 'account', account)).toBe(0);
    const finalized = lastJson();
    expect(finalized, JSON.stringify(finalized, null, 2)).toMatchObject({
      accepted: true,
      outcome: 'FULL',
    });
    expect(finalized.files).toEqual(
      expect.arrayContaining([
        'review.md',
        'brief.json',
        'composed-story-v2.json',
        STORY_REVIEW_MODEL_FILE,
        'run-record-v1.json',
      ])
    );

    const runDir = path.join(fixture.repo.path, finalized.run_dir as string);
    const record = JSON.parse(await readFile(path.join(runDir, 'run-record-v1.json'), 'utf8')) as {
      outcome: string;
    };
    expect(record.outcome).toBe('FULL');
    const composed = JSON.parse(
      await readFile(path.join(runDir, 'composed-story-v2.json'), 'utf8')
    ) as { story: { parts: { title: string }[] } };
    expect(composed.story.parts).toEqual([expect.objectContaining({ title: 'Captured feature' })]);
    const installed = parseStoryReviewModel(
      JSON.parse(await readFile(path.join(runDir, STORY_REVIEW_MODEL_FILE), 'utf8'))
    );
    expect(installed.parts).toEqual([expect.objectContaining({ title: 'Captured feature' })]);
  });
});
