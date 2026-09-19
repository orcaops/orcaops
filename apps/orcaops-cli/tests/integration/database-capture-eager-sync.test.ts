import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readProjectArtifact } from '@orcaops/storage/history/database';
import { inputFile } from '@orcaops/test-harness';

import { databaseCloudClient } from '../helpers/database-cloud-client.js';
import { fixture, git, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

const injected = vi.hoisted(() => ({
  cloud: null as ReturnType<typeof databaseCloudClient> | null,
}));
vi.mock('@orcaops/core', async (original) => ({
  ...(await original<typeof import('@orcaops/core')>()),
  resolveCredentialStore: () => {
    if (!injected.cloud) throw new Error('Test cloud was not installed');
    return injected.cloud.credentialStore;
  },
}));
vi.mock('../../src/lib/database-cloud-session.js', async (original) => {
  const actual = await original<typeof import('../../src/lib/database-cloud-session.js')>();
  return {
    ...actual,
    connectDatabaseCloudSession: (
      input: Parameters<typeof actual.connectDatabaseCloudSession>[0]
    ) => {
      if (!injected.cloud) throw new Error('Test cloud was not installed');
      return actual.connectDatabaseCloudSession(input, injected.cloud.dependencies);
    },
  };
});
beforeEach(() => {
  injected.cloud = databaseCloudClient();
});

describe('capture command eager sync', { timeout: 120_000 }, () => {
  it('sends fresh plans, revisions, checkpoints and evaluator passes, but never resends a replay', async () => {
    const f = await fixture();
    await git(f.main, ['remote', 'add', 'origin', 'git@github.com:team/repo.git']);
    const agent = makeAgent({
      cwd: f.main,
      cloudBaseUrl: 'https://cloud.example',
      env: {
        ORCAOPS_ROOT: f.main,
        ORCAOPS_DATA_DIR: f.root,
        ORCAOPS_DISABLE_DRAIN: '0',
        CODEX_SESSION_ID: '',
        CLAUDE_SESSION_ID: '',
        CLAUDE_CODE_SESSION_ID: '',
        XDG_STATE_HOME: f.temporary + '/unused-state',
      },
    });
    const run = async (verb: string[], body: Record<string, unknown>, flags = ['--no-llm']) => {
      const result = await agent.runRaw([
        'capture',
        ...verb,
        ...flags,
        '--input',
        inputFile(JSON.stringify(body)),
      ]);
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    const planBody = {
      idempotency_key: randomUUID(),
      task: 'Capture a task',
      label: 'Task',
      plan_steps: [
        {
          text: 'Implement the task',
          label: 'Implement',
          acceptance_criteria: [{ text: 'the step is delivered' }],
        },
      ],
      touched_scope: [],
    };
    const plan = await run(['plan'], planBody);
    expect(plan.cloud_sync).toMatchObject({ status: 'ok' });
    const id = plan.artifact_id as string;
    const before = await inventory(f.root);
    const count = injected.cloud!.calls.length;
    expect((await run(['plan'], planBody)).cloud_sync).toEqual({
      status: 'skipped',
      reason: 'replay',
    });
    expect(injected.cloud!.calls).toHaveLength(count);
    expect(await inventory(f.root)).toEqual(before);
    const revision = await run(['plan', 'revise'], {
      idempotency_key: randomUUID(),
      artifact_id: id,
      label: 'Updated task',
      rationale: 'Clarify the task',
      prior_plan_event_id: null,
      plan_steps: readProjectArtifact(f.writer, id)!.thread.plan!.plan_steps,
      touched_scope: [],
      non_goals: [],
    });
    expect(revision.cloud_sync).toMatchObject({ status: 'ok' });
    const opened = await run(['checkpoint', 'open'], {
      idempotency_key: randomUUID(),
      artifact_id: id,
      declared_step_ids: [plan.plan_steps[0].step_id],
    });
    expect(opened.cloud_sync).toMatchObject({ status: 'ok' });
    const closeBody = {
      idempotency_key: randomUUID(),
      artifact_id: id,
      n: opened.n,
      summary: 'Implemented the task',
      completed_step_ids: [],
      files_changed: [],
      verification: [],
    };
    expect((await run(['checkpoint', 'close'], closeBody)).cloud_sync).toMatchObject({
      status: 'ok',
    });
    const afterClose = injected.cloud!.calls.length;
    expect((await run(['checkpoint', 'close'], closeBody)).cloud_sync).toEqual({
      status: 'skipped',
      reason: 'replay',
    });
    expect(injected.cloud!.calls).toHaveLength(afterClose);
    const next = await run(['checkpoint', 'open'], {
      idempotency_key: randomUUID(),
      artifact_id: id,
      declared_step_ids: [plan.plan_steps[0].step_id],
    });
    expect(
      (
        await run(
          ['checkpoint', 'abandon'],
          {
            idempotency_key: randomUUID(),
            artifact_id: id,
            n: next.n,
            reason: 'No further change required',
          },
          []
        )
      ).cloud_sync
    ).toMatchObject({ status: 'ok' });
    expect(
      (await run(['run-evaluators'], { artifact_id: id, fires_at: 'post-plan' })).cloud_sync.status
    ).toMatch(/^(ok|skipped)$/);
    expect((await run(['pre-pr-check'], { artifact_id: id })).cloud_sync.status).toMatch(
      /^(ok|skipped)$/
    );
    expect(injected.cloud!.calls.map((call) => call.method)).toEqual(
      expect.arrayContaining([
        'captureThread.attachPlan',
        'captureThread.attachPlanRevision',
        'captureThread.attachCheckpointOpened',
        'captureThread.attachCheckpoint',
      ])
    );
  });
});
