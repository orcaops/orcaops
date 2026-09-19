import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  readProjectArtifact,
  readProjectExecution,
  readProjectLifecycleCompletions,
  readProjectUsage,
} from '@orcaops/storage/history/database';
import { readProjectExecutionFocus } from '@orcaops/storage/history/database/execution-checkout';
import { inputFile } from '@orcaops/test-harness';

import { fixture, git, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const SESSION = 'plan-session';
function agent(f: Fixture, session = SESSION) {
  return makeAgent({
    cwd: f.main,
    env: {
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: session,
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      TMUX_PANE: '',
      STY: '',
      WINDOW: '',
      TTY: '',
      XDG_STATE_HOME: f.temporary + '/unused-state',
    },
  });
}
function payload(extra: Record<string, unknown> = {}) {
  return {
    idempotency_key: `plan-${randomUUID()}`,
    task: 'Port the plan command onto project history',
    label: 'Plan command port',
    plan_steps: [
      {
        text: 'write the adapter',
        label: 'Adapter',
        acceptance_criteria: [{ text: 'the step is delivered' }],
      },
      {
        text: 'prove it with tests',
        label: 'Tests',
        acceptance_criteria: [{ text: 'tests pass' }],
      },
    ],
    touched_scope: ['cli'],
    ...extra,
  };
}
async function capturePlan(f: Fixture, body: Record<string, unknown>, args: string[] = []) {
  const raw = await agent(f).runRaw([
    'capture',
    'plan',
    '--no-llm',
    '--input',
    inputFile(JSON.stringify(body)),
    ...args,
  ]);
  return { raw, result: JSON.parse(raw.stdout) };
}
async function refs(f: Fixture) {
  return (
    await git(f.main, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/orcaops'])
  ).stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort();
}

describe('registered database capture plan', { timeout: 60_000 }, () => {
  it('captures a plan into project history, focuses the session and replays the same key without new writes', async () => {
    const f = await fixture();
    const body = payload();
    const first = await capturePlan(f, body);
    expect(first.raw.exitCode, first.raw.stdout + first.raw.stderr).toBe(0);
    const { result } = first;
    expect(result).toMatchObject({
      ok: true,
      idempotency_status: 'created',
      branch: 'main',
      label: 'Plan command port',
      revision_n: 0,
      capture_status: 'committed',
      historical: false,
      blocking: false,
      lifecycle: { status: 'complete' },
      focus: { state: 'updated', displaced_artifact_id: null },
      cloud_sync: { status: 'skipped', reason: 'drain_disabled' },
    });
    expect(result.plan_steps).toHaveLength(2);
    expect(result.plan_steps[0]).toMatchObject({ idx: 1, label: 'Adapter' });
    expect(result.plan_steps[1].acceptance_criteria[0].criterion_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.operation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.source_plan).toBeNull();
    expect(result.next_actions[0]?.verb).toBe('checkpoint-open');
    const id = result.artifact_id as string;
    const retained = readProjectArtifact(f.writer, id)!;
    expect(retained.thread.plan).toMatchObject({
      task: body.task,
      agent: 'codex',
      branch: 'main',
      base_sha: f.context.headOid,
      source_event_id: result.plan_event_id,
    });
    expect(retained.thread.plan!.plan_steps.map((step) => step.step_id)).toEqual(
      result.plan_steps.map((step: { step_id: string }) => step.step_id)
    );
    expect(readProjectExecution(f.writer, id)!.state.current_binding?.worktree_id).toBe(
      f.context.worktreeId
    );
    expect(
      readProjectLifecycleCompletions(f.writer, id).records.map((entry) => entry.record.fires_at)
    ).toEqual(['post-plan']);
    expect(
      readProjectExecutionFocus(f.writer, {
        rootKey: f.authority.rootKey,
        projectId: f.authority.projectId,
        storeInstanceId: f.authority.storeInstanceId,
        repositoryInstanceId: f.authority.repositoryInstanceId,
        worktreeId: f.context.worktreeId!,
        shellKey: { kind: 'codex_session', value: SESSION },
      })
    ).toMatchObject({ status: 'present', pin: { artifact_id: id } });
    const baselineRefs = await refs(f);
    expect(baselineRefs.some((ref) => ref.startsWith(`refs/orcaops/baseline/${id}-`))).toBe(true);
    const planEvent = retained.thread.events.find(
      (event) => event.record.event_id === result.plan_event_id
    );
    expect(
      (planEvent?.payload as { baseline_seed_tree_sha?: string }).baseline_seed_tree_sha
    ).toMatch(/^[0-9a-f]{40}$/);
    const usageBefore = readProjectUsage(f.writer)?.revision ?? null;
    const replay = await capturePlan(f, body);
    expect(replay.raw.exitCode, replay.raw.stdout + replay.raw.stderr).toBe(0);
    expect(replay.result).toMatchObject({
      artifact_id: id,
      plan_event_id: result.plan_event_id,
      idempotency_status: 'replay',
      code: 'IDEMPOTENT_REPLAY',
      lifecycle: { status: 'replayed' },
      usage: { state: 'skipped', reason: 'replay' },
    });
    expect(readProjectArtifact(f.writer, id)!.revision).toEqual(retained.revision);
    expect(readProjectUsage(f.writer)?.revision ?? null).toEqual(usageBefore);
    expect(await refs(f)).toEqual(baselineRefs);
    const status = await agent(f).runRaw(['status', '--json']);
    const artifacts = JSON.parse(status.stdout).artifacts as Array<{
      id: string;
      thread: Record<string, { status: string }>;
    }>;
    expect(artifacts.map((artifact) => artifact.id)).toEqual([id]);
    expect(artifacts[0].thread.plan.status).toBe('done');
    expect(artifacts[0].thread['eval-plan'].status).toBe('done');
  });

  it('refuses a secret in the plan before any history is written', async () => {
    const f = await fixture();
    const secret = 'ghp_' + 'b'.repeat(36);
    const before = await inventory(f.temporary);
    const refused = await capturePlan(f, payload({ task: `deploy with ${secret}` }));
    expect(refused.raw.exitCode).toBe(1);
    expect(refused.result).toMatchObject({ ok: false, error: { code: 'SECRET_IN_PAYLOAD' } });
    expect(refused.raw.stdout).not.toContain(secret);
    expect(await inventory(f.temporary)).toEqual(before);
    const cleanPin = await capturePlan(f, payload(), ['--source-plan', 'missing-plan.md']);
    expect(cleanPin.result).toMatchObject({ ok: false, error: { code: 'NO_INPUT' } });
    expect(await inventory(f.temporary)).toEqual(before);
    const cloudPin = await capturePlan(f, payload(), ['--source-plan', 'cloud:abc@1']);
    expect(cloudPin.result).toMatchObject({ ok: false, error: { code: 'NO_INPUT' } });
    expect(cloudPin.result.error.message).toContain('plan pull');
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('pins a local source plan with its baseline, links it and echoes the content-free pin', async () => {
    const f = await fixture();
    await writeFile(path.join(f.main, 'plan.md'), '# Source plan\n\nDo the port.\n', 'utf8');
    const captured = await capturePlan(f, payload(), ['--source-plan', 'plan.md']);
    expect(captured.raw.exitCode, captured.raw.stdout + captured.raw.stderr).toBe(0);
    expect(captured.result.source_plan).toMatchObject({
      pinned: true,
      source_ref: { kind: 'local', locator: 'plan.md' },
    });
    expect(captured.result.source_plan).not.toHaveProperty('content');
    const id = captured.result.artifact_id as string;
    const retained = readProjectArtifact(f.writer, id)!;
    expect(retained.thread.artifactJson?.source_plan).toMatchObject({
      hash: captured.result.source_plan.hash,
      baseline: { branch: 'main' },
    });
    expect(readProjectUsage(f.writer)!.events.map((event) => event.record.type)).toContain(
      'source_plan_linked'
    );
    expect(captured.result.usage).toMatchObject({ state: 'committed' });
  });

  it('reports a history-missing project instead of initializing a replacement', async () => {
    const f = await fixture();
    f.writer.close();
    const { rm } = await import('node:fs/promises');
    const { projectDatabasePath } = await import('@orcaops/storage/history/database');
    await rm(projectDatabasePath(f.authority));
    const before = await inventory(f.temporary);
    const missing = await capturePlan(f, payload());
    expect(missing.raw.exitCode).toBe(1);
    expect(missing.result.error.code).toBe('HISTORY_MISSING');
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
