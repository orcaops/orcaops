import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { EvaluatorRunPayload } from '@orcaops/evaluator-protocol';
import { uuidv7 } from '@orcaops/storage';
import {
  readProjectArtifact,
  readProjectArtifactAttempts,
  readProjectExecution,
  readProjectLifecycleCompletions,
} from '@orcaops/storage/history/database';
import { readProjectExecutionFocus } from '@orcaops/storage/history/database/execution-checkout';
import { inputFile } from '@orcaops/test-harness';

import { fixture, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const SESSION = 'existing-session';
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
async function run(
  f: Fixture,
  verb: string[],
  body: Record<string, unknown>,
  session = SESSION,
  flags: string[] = []
) {
  const raw = await agent(f, session).runRaw([
    'capture',
    ...verb,
    ...flags,
    '--input',
    inputFile(JSON.stringify(body)),
  ]);
  return { raw, result: JSON.parse(raw.stdout) };
}
// `capture summary` runs no evaluators, so it registers no --no-llm flag.
const revise = (f: Fixture, body: Record<string, unknown>) =>
  run(f, ['plan', 'revise'], body, SESSION, ['--no-llm']);
const summary = (f: Fixture, body: Record<string, unknown>, session?: string) =>
  run(f, ['summary'], body, session);
function focusScope(f: Fixture, session = SESSION) {
  return {
    rootKey: f.authority.rootKey,
    projectId: f.authority.projectId,
    storeInstanceId: f.authority.storeInstanceId,
    repositoryInstanceId: f.authority.repositoryInstanceId,
    worktreeId: f.context.worktreeId!,
    shellKey: { kind: 'codex_session' as const, value: session },
  };
}
async function plantBlock(f: Fixture, artifactId: string) {
  const run: EvaluatorRunPayload = {
    schema: 'orcaops.evaluator_run/v1',
    run_id: uuidv7(),
    artifact_id: artifactId,
    evaluator_ref: 'test-pack/api-stub',
    package_id: 'test-pack',
    evaluator_id: 'api-stub',
    phase: 'pre-pr',
    severity: 'block',
    run_status: 'completed',
    verdict: 'violation',
    body: 'VIOLATION\n\nseeded for test',
    ts: '2026-09-05T00:00:01.000Z',
  };
  await f.mutate(artifactId, { run }, (semantics) =>
    semantics.writeEvaluatorRunPayload(artifactId, run, { idempotencyKey: uuidv7() })
  );
  return run.run_id;
}

describe('registered database plan revise', { timeout: 60_000 }, () => {
  it('appends a revision with carried step ids, completes its evaluators, and replays or conflicts by key', async () => {
    const f = await fixture();
    const id = await f.capture();
    const before = readProjectArtifact(f.writer, id)!;
    const plan = before.thread.plan!;
    const body = {
      idempotency_key: `revise-${randomUUID()}`,
      artifact_id: id,
      label: 'Retained evidence with tests',
      rationale: 'Discovered a verification step',
      prior_plan_event_id: plan.source_event_id,
      plan_steps: [
        {
          step_id: plan.plan_steps[0].step_id,
          text: 'Read retained evidence',
          label: 'Retained evidence',
        },
        {
          text: 'Verify the port',
          label: 'Verify',
          acceptance_criteria: [{ text: 'the step is delivered' }],
        },
      ],
      touched_scope: [],
      non_goals: [],
    };
    const created = await revise(f, body);
    expect(created.raw.exitCode, created.raw.stdout + created.raw.stderr).toBe(0);
    expect(created.result).toMatchObject({
      ok: true,
      artifact_id: id,
      revision_n: 1,
      idempotency_status: 'created',
      capture_status: 'committed',
      lifecycle: { status: 'complete' },
      step_lineage: { unchanged: [plan.plan_steps[0].step_id] },
      cloud_sync: { status: 'skipped', reason: 'drain_disabled' },
    });
    expect(created.result.plan_steps).toHaveLength(2);
    expect(created.result.plan_steps[0].step_id).toBe(plan.plan_steps[0].step_id);
    expect(created.result.plan_event_id).not.toBe(plan.source_event_id);
    const after = readProjectArtifact(f.writer, id)!;
    expect(after.thread.plan).toMatchObject({
      revision_n: 1,
      source_event_id: created.result.plan_event_id,
      revised_by_agent: 'codex',
    });
    expect(after.revision.generation).toBe(before.revision.generation + 1);
    expect(
      readProjectLifecycleCompletions(f.writer, id).records.map((entry) => entry.record)
    ).toEqual([expect.objectContaining({ fires_at: 'post-plan-revision', cp_n: 1 })]);
    const replay = await revise(f, body);
    expect(replay.result).toMatchObject({
      idempotency_status: 'replay',
      revision_n: 1,
      plan_event_id: created.result.plan_event_id,
      lifecycle: { status: 'replayed' },
    });
    expect(readProjectArtifact(f.writer, id)!.revision).toEqual(after.revision);
    const conflict = await revise(f, { ...body, rationale: 'A different rationale' });
    expect(conflict.raw.exitCode).toBe(1);
    expect(conflict.result.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(readProjectArtifact(f.writer, id)!.revision).toEqual(after.revision);
    const stale = await revise(f, {
      ...body,
      idempotency_key: `revise-${randomUUID()}`,
      prior_plan_event_id: plan.source_event_id,
    });
    expect(stale.result.error.code).toBe('STALE_PLAN_REVISION');
    expect(readProjectArtifact(f.writer, id)!.revision).toEqual(after.revision);
    const unknown = await revise(f, { ...body, artifact_id: uuidv7() });
    expect(unknown.result.error.code).toBe('UNKNOWN_ARTIFACT');
  });

  it('refuses to drop a step an open checkpoint declares and retains the rejected attempt', async () => {
    const f = await fixture();
    const id = await f.capture();
    const plan = readProjectArtifact(f.writer, id)!.thread.plan!;
    await f.mutate(id, { open: true }, (semantics) =>
      semantics.writeCheckpointOpened(
        { artifact_id: id, declared_step_ids: [plan.plan_steps[0].step_id] },
        { idempotencyKey: uuidv7(), headSha: f.context.headOid! }
      )
    );
    const before = readProjectArtifact(f.writer, id)!;
    const files = await inventory(f.main);
    const key = `revise-${randomUUID()}`;
    const dropped = await revise(f, {
      idempotency_key: key,
      artifact_id: id,
      label: 'Replace everything',
      rationale: 'Try to drop the declared step',
      prior_plan_event_id: null,
      plan_steps: [
        {
          text: 'Something else',
          label: 'Else',
          acceptance_criteria: [{ text: 'the step is delivered' }],
        },
      ],
      touched_scope: [],
      non_goals: [],
    });
    expect(dropped.raw.exitCode).toBe(1);
    expect(dropped.result.error.code).toBe('PLAN_REVISION_OPEN_CP_CONFLICT');
    // The refusal appends no artifact history and touches no file, but it does retain
    // the rejected-attempt receipt a same-key retry is adjudicated against.
    expect(readProjectArtifact(f.writer, id)!.revision).toEqual(before.revision);
    expect(await inventory(f.main)).toEqual(files);
    expect(
      readProjectArtifactAttempts(f.writer, id).records.map((entry) => [
        entry.eventType,
        entry.idempotencyKey,
        entry.record?.outcome,
      ])
    ).toEqual([['plan_revised', key, 'hard_rejected']]);
  });
});

describe('registered database capture summary', { timeout: 60_000 }, () => {
  it('refuses BLOCKED and open checkpoints, then completes execution and clears only the matching focus', async () => {
    const f = await fixture();
    const id = await f.capture();
    const other = await f.capture();
    await plantBlock(f, id);
    const blocked = await summary(f, { artifact_id: id, outcome: 'shipped' });
    expect(blocked.raw.exitCode).toBe(1);
    expect(blocked.result.error.code).toBe('BLOCKED');
    expect(blocked.result.error.message).toContain('test-pack/api-stub');
    const checkout = await agent(f).runRaw(['checkout', other, '--json']);
    expect(checkout.exitCode, checkout.stdout + checkout.stderr).toBe(0);
    const plan = readProjectArtifact(f.writer, other)!.thread.plan!;
    await f.mutate(other, { open: true }, (semantics) =>
      semantics.writeCheckpointOpened(
        { artifact_id: other, declared_step_ids: [plan.plan_steps[0].step_id] },
        { idempotencyKey: uuidv7(), headSha: f.context.headOid! }
      )
    );
    const pending = await summary(f, { artifact_id: other, outcome: 'shipped' });
    expect(pending.raw.exitCode).toBe(1);
    expect(pending.result.error.code).toBe('INVALID_INPUT');
    expect(pending.result.error.message).toMatch(/open checkpoint/i);
    await f.mutate(other, { abandon: true }, (semantics) =>
      semantics.writeCheckpointAbandoned(
        { artifact_id: other, n: 1, reason: 'released for the summary test' },
        { idempotencyKey: uuidv7() }
      )
    );
    expect(readProjectExecutionFocus(f.writer, focusScope(f))).toMatchObject({
      status: 'present',
      pin: { artifact_id: other },
    });
    const body = { idempotency_key: `sum-${randomUUID()}`, artifact_id: other, outcome: 'shipped' };
    const first = await summary(f, body);
    expect(first.raw.exitCode, first.raw.stdout + first.raw.stderr).toBe(0);
    expect(first.result).toMatchObject({
      ok: true,
      artifact_id: other,
      idempotency_status: 'created',
      focus: { state: 'cleared' },
      finalization_status: 'finalized',
      digest: { status: 'current', artifact_id: other },
      cloud_sync: { status: 'skipped', reason: 'drain_disabled' },
    });
    expect(first.result.summary_event_id).toMatch(/^[0-9a-f-]{36}$/);
    // The digest is rendered through the real database path, not reported unavailable.
    expect(first.result.digest.markdown).toContain(`# digest — \`main\` / \`${other}\``);
    expect(first.result.digest.markdown).toContain('shipped');
    expect(readProjectExecution(f.writer, other)!.state.lifecycle).toBe('completed');
    expect(readProjectExecutionFocus(f.writer, focusScope(f)).status).toBe('cleared');
    const replay = await summary(f, body);
    expect(replay.result).toMatchObject({
      idempotency_status: 'replay',
      completed_at: first.result.completed_at,
      // A replay writes nothing — no focus row, no usage row...
      focus: { state: 'skipped', reason: 'replay' },
      usage: { state: 'skipped', reason: 'replay' },
      cloud_sync: { status: 'skipped', reason: 'replay' },
      // ...but the digest render caches nothing, so a replay renders it like a fresh run.
      finalization_status: 'finalized',
      digest: { status: 'current', artifact_id: other },
    });
    expect(replay.result.digest.markdown).toContain(`# digest — \`main\` / \`${other}\``);
    const bare = await summary(f, {
      idempotency_key: `sum-${randomUUID()}`,
      artifact_id: other,
      outcome: 'again',
    });
    expect(bare.result.error.code).toBe('SUMMARY_ALREADY_CAPTURED');
    expect(bare.result.error.message).toContain(first.result.summary_event_id);
    const conflict = await summary(f, { ...body, outcome: 'a structurally different outcome' });
    expect(conflict.raw.exitCode).toBe(1);
    expect(conflict.result.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(readProjectArtifact(f.writer, other)!.thread.summary?.outcome).toBe('shipped');
    const stale = await summary(f, {
      idempotency_key: `sum-${randomUUID()}`,
      artifact_id: other,
      outcome: 'again',
      prior_summary_event_id: 'not-the-latest',
    });
    expect(stale.result.error.code).toBe('STALE_SUMMARY');
    const amended = await summary(f, {
      idempotency_key: `sum-${randomUUID()}`,
      artifact_id: other,
      outcome: 'amended wording',
      prior_summary_event_id: first.result.summary_event_id,
    });
    expect(amended.raw.exitCode, amended.raw.stdout + amended.raw.stderr).toBe(0);
    expect(amended.result.summary_event_id).not.toBe(first.result.summary_event_id);
    expect(readProjectArtifact(f.writer, other)!.thread.summary?.outcome).toBe('amended wording');
    expect(readProjectExecution(f.writer, other)!.state.lifecycle).toBe('completed');
  });

  it('leaves another session focus alone and autodetects the single active artifact', async () => {
    const f = await fixture();
    const id = await f.capture();
    const pinned = await agent(f, 'other-session').runRaw(['checkout', id, '--json']);
    expect(pinned.exitCode, pinned.stdout + pinned.stderr).toBe(0);
    const done = await summary(f, { outcome: 'shipped' });
    expect(done.raw.exitCode, done.raw.stdout + done.raw.stderr).toBe(0);
    expect(done.result).toMatchObject({ artifact_id: id, focus: { state: 'not_requested' } });
    expect(readProjectExecutionFocus(f.writer, focusScope(f, 'other-session'))).toMatchObject({
      status: 'present',
      pin: { artifact_id: id },
    });
    const none = await summary(f, { outcome: 'shipped' });
    expect(none.result.error.code).toBe('INVALID_INPUT');
  });
});
