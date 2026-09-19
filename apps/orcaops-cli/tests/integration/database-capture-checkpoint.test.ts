import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  readProjectArtifact,
  readProjectArtifactAttempts,
  readProjectGitRetention,
} from '@orcaops/storage/history/database';
import { initializeUnboundExecution } from '@orcaops/storage/history/execution';
import { inputFile } from '@orcaops/test-harness';

import {
  prepareExecutionRecords,
  settleExecutionRecords,
} from '../../../../packages/storage/dist/history/database/execution-records.js';
import { runProjectOperation } from '../../../../packages/storage/dist/history/database/transactions.js';
import {
  adjudicateThreadOverlap,
  readDatabaseOverlapSupport,
} from '../../src/lib/database-manifest-sources.js';
import { fixture, git, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
function agent(f: Fixture) {
  return makeAgent({
    cwd: f.main,
    env: {
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: 'checkpoint-session',
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
  flags: string[] = ['--no-llm']
) {
  const raw = await agent(f).runRaw([
    'capture',
    'checkpoint',
    ...verb,
    ...flags,
    '--input',
    inputFile(JSON.stringify(body)),
  ]);
  return { raw, result: JSON.parse(raw.stdout) };
}
const open = (f: Fixture, body: Record<string, unknown>) => run(f, ['open'], body);
const close = (f: Fixture, body: Record<string, unknown>) => run(f, ['close'], body);
// Abandon fires no evaluators, so it registers no --no-llm flag.
const abandon = (f: Fixture, body: Record<string, unknown>) => run(f, ['abandon'], body, []);

/** Adds a second plan step so two checkpoints can declare disjoint scope. */
async function twoStepPlan(f: Fixture, id: string) {
  const plan = readProjectArtifact(f.writer, id)!.thread.plan!;
  const raw = await agent(f).runRaw([
    'capture',
    'plan',
    'revise',
    '--no-llm',
    '--input',
    inputFile(
      JSON.stringify({
        idempotency_key: `revise-${randomUUID()}`,
        artifact_id: id,
        label: 'Two steps to declare',
        rationale: 'Give the second checkpoint its own step',
        prior_plan_event_id: null,
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
      })
    ),
  ]);
  expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
  return (JSON.parse(raw.stdout).plan_steps as { step_id: string }[]).map((step) => step.step_id);
}

async function retainOpenCheckpoint(f: Fixture, artifactId: string) {
  const plan = readProjectArtifact(f.writer, artifactId)!.thread.plan!;
  return f.mutate(artifactId, { artifactId }, (semantics) =>
    semantics.writeCheckpointOpened(
      { artifact_id: artifactId, declared_step_ids: [plan.plan_steps[0].step_id] },
      { idempotencyKey: uuidv7(), headSha: f.context.headOid! }
    )
  );
}

async function retainUnknownExecution(f: Fixture, artifactId: string) {
  const operationId = uuidv7();
  const retained = readProjectArtifact(f.writer, artifactId)!;
  const state = initializeUnboundExecution({
    artifactId,
    operationId,
    reason: 'legacy_unknown',
    ts: retained.thread.plan!.started_at,
  });
  const prepared = prepareExecutionRecords({
    state,
    previous: null,
    operationId,
    artifactRevision: retained.revision,
    secretAllow: [],
  });
  await runProjectOperation(
    f.writer,
    {
      operationId,
      kind: 'execution.import',
      target: { artifactId },
      payload: { state },
      expectedState: null,
      intentChange: false,
    },
    (transaction) => settleExecutionRecords(transaction, prepared)
  );
}

describe('registered database checkpoint lifecycle', { timeout: 120_000 }, () => {
  it('retains and adjudicates overlapping checkpoints across captured artifacts', async () => {
    const f = await fixture();
    const firstId = await f.capture();
    const secondId = await f.capture();
    const firstStep = readProjectArtifact(f.writer, firstId)!.thread.plan!.plan_steps[0].step_id;
    const secondStep = readProjectArtifact(f.writer, secondId)!.thread.plan!.plan_steps[0].step_id;
    await open(f, {
      idempotency_key: `open-${randomUUID()}`,
      artifact_id: firstId,
      declared_step_ids: [firstStep],
    });
    await open(f, {
      idempotency_key: `open-${randomUUID()}`,
      artifact_id: secondId,
      declared_step_ids: [secondStep],
    });
    const firstClose = {
      idempotency_key: `close-${randomUUID()}`,
      artifact_id: firstId,
      n: 1,
      summary: 'Closed the first concurrent artifact',
      files_changed: [],
      completed_step_ids: [],
      decisions: [],
      uncertainty: [],
      done_criteria: [],
    };
    const closedFirst = await close(f, firstClose);
    expect(closedFirst.raw.exitCode, closedFirst.raw.stdout + closedFirst.raw.stderr).toBe(0);
    const closedSecond = await close(f, {
      idempotency_key: `close-${randomUUID()}`,
      artifact_id: secondId,
      n: 1,
      summary: 'Closed the second concurrent artifact',
      files_changed: [],
      completed_step_ids: [],
      decisions: [],
      uncertainty: [],
      done_criteria: [],
    });
    expect(closedSecond.raw.exitCode, closedSecond.raw.stdout + closedSecond.raw.stderr).toBe(0);

    const first = readProjectArtifact(f.writer, firstId)!.thread;
    const second = readProjectArtifact(f.writer, secondId)!.thread;
    const firstCheckpoint = first.checkpoints[0];
    const secondCheckpoint = second.checkpoints[0];
    if (firstCheckpoint.status !== 'closed' || secondCheckpoint.status !== 'closed')
      throw new Error('Concurrent checkpoint fixture did not close');
    expect(firstCheckpoint.window_overlap).toMatchObject({
      pending: true,
      cross_artifact_siblings: [{ artifact_id: secondId, n: 1 }],
    });
    expect(secondCheckpoint.window_overlap).toMatchObject({
      pending: true,
      cross_artifact_siblings: [{ artifact_id: firstId, n: 1 }],
    });

    const beforeRead = await inventory(f.temporary);
    const support = readDatabaseOverlapSupport(f.writer, [first, second]);
    expect(adjudicateThreadOverlap(first, support).get(1)).toMatchObject({ finalized: true });
    expect(adjudicateThreadOverlap(second, support).get(1)).toMatchObject({ finalized: true });
    expect(await inventory(f.temporary)).toEqual(beforeRead);

    const replay = await close(f, firstClose);
    expect(replay.result).toMatchObject({ idempotency_status: 'replay' });
    expect(await inventory(f.temporary)).toEqual(beforeRead);
  });

  it('excludes imported and differently attributed worktree checkpoints', async () => {
    const f = await fixture();
    const owner = await f.capture();
    const imported = await f.capture(uuidv7(), { reason: 'imported' });
    const linked = await f.capture(uuidv7(), { cwd: f.linked });
    await retainOpenCheckpoint(f, imported);
    await retainOpenCheckpoint(f, linked);
    const step = readProjectArtifact(f.writer, owner)!.thread.plan!.plan_steps[0].step_id;
    await open(f, {
      idempotency_key: `open-${randomUUID()}`,
      artifact_id: owner,
      declared_step_ids: [step],
    });
    const closed = await close(f, {
      idempotency_key: `close-${randomUUID()}`,
      artifact_id: owner,
      n: 1,
      summary: 'Closed without unrelated overlap',
      files_changed: [],
      completed_step_ids: [],
      decisions: [],
      uncertainty: [],
      done_criteria: [],
    });
    expect(closed.raw.exitCode, closed.raw.stdout + closed.raw.stderr).toBe(0);
    const checkpoint = readProjectArtifact(f.writer, owner)!.thread.checkpoints[0];
    if (checkpoint.status !== 'closed') throw new Error('Owner checkpoint did not close');
    expect(checkpoint.window_overlap).toBeUndefined();
  });

  it('does not invent worktree overlap for converted checkpoints with unknown attribution', async () => {
    const f = await fixture();
    const owner = await f.capture();
    const step = readProjectArtifact(f.writer, owner)!.thread.plan!.plan_steps[0].step_id;
    const opened = await open(f, {
      idempotency_key: `open-${randomUUID()}`,
      artifact_id: owner,
      declared_step_ids: [step],
    });
    expect(opened.raw.exitCode, opened.raw.stdout + opened.raw.stderr).toBe(0);
    const unattributed = await f.capture(uuidv7(), { reason: 'legacy_unknown' });
    await retainUnknownExecution(f, unattributed);
    await retainOpenCheckpoint(f, unattributed);
    const closed = await close(f, {
      idempotency_key: `close-${randomUUID()}`,
      artifact_id: owner,
      n: 1,
      summary: 'Close beside retained unknown attribution',
      files_changed: [],
      completed_step_ids: [],
      decisions: [],
      uncertainty: [],
      done_criteria: [],
    });
    expect(closed.raw.exitCode, closed.raw.stdout + closed.raw.stderr).toBe(0);
    const checkpoint = readProjectArtifact(f.writer, owner)!.thread.checkpoints[0];
    if (checkpoint.status !== 'closed') throw new Error('Owner checkpoint did not close');
    expect(checkpoint.window_overlap).toBeUndefined();
  });

  it('publishes each boundary as a retained suffixed ref and replays open by key', async () => {
    const f = await fixture();
    const id = await f.capture();
    const [first, second] = await twoStepPlan(f, id);
    const openBody = {
      idempotency_key: `open-${randomUUID()}`,
      artifact_id: id,
      declared_step_ids: [first],
      agent_session_id: 'checkpoint-worker',
    };
    const opened = await open(f, openBody);
    expect(opened.raw.exitCode, opened.raw.stdout + opened.raw.stderr).toBe(0);
    expect(opened.result).toMatchObject({
      ok: true,
      artifact_id: id,
      n: 1,
      status: 'open',
      idempotency_status: 'created',
      declared_step_ids: [first],
      agent_session_id: 'checkpoint-worker',
      cloud_sync: { status: 'skipped', reason: 'drain_disabled' },
    });
    const openRef: string = opened.result.snapshot_ref;
    expect(openRef).toMatch(new RegExp(`^refs/orcaops/snap/${id}/1/open-[0-9a-f]{8}-[0-9a-f-]+$`));
    const retained = readProjectArtifact(f.writer, id)!;
    const checkpoint = retained.thread.checkpoints.find((entry) => entry.n === 1)!;
    expect(checkpoint.open_snapshot).toMatchObject({
      snapshot_ref: openRef,
      snapshot_error_reason: null,
    });
    const retention = readProjectGitRetention(f.writer, opened.result.operation_id).value!;
    expect(retention.input.publications).toEqual([
      expect.objectContaining({
        role: 'checkpoint',
        checkpointNumber: 1,
        checkpointPhase: 'open',
        fullRef: openRef,
        treeOid: checkpoint.open_snapshot.tree_sha,
        objectOid: checkpoint.open_snapshot.snapshot_commit_sha,
      }),
    ]);
    const resolved = await git(f.main, ['rev-parse', openRef]);
    expect(resolved.stdout.trim()).toBe(checkpoint.open_snapshot.snapshot_commit_sha);

    const replay = await open(f, openBody);
    expect(replay.result).toMatchObject({ idempotency_status: 'replay', n: 1, status: 'open' });
    expect(readProjectArtifact(f.writer, id)!.revision).toEqual(retained.revision);

    const closed = await close(f, {
      idempotency_key: `close-${randomUUID()}`,
      artifact_id: id,
      summary: 'Recorded the retained boundary',
      files_changed: [],
      completed_step_ids: [],
      decisions: [],
      uncertainty: [],
      done_criteria: [],
    });
    expect(closed.raw.exitCode, closed.raw.stdout + closed.raw.stderr).toBe(0);
    expect(closed.result).toMatchObject({ n: 1, status: 'closed', idempotency_status: 'created' });
    expect(closed.result.snapshot_ref).toMatch(
      new RegExp(`^refs/orcaops/snap/${id}/1/close-[0-9a-f]{8}-[0-9a-f-]+$`)
    );
    expect(
      (await git(f.main, ['rev-parse', closed.result.snapshot_ref])).stdout.trim()
    ).toBeTruthy();

    const secondOpen = await open(f, {
      idempotency_key: `open-${randomUUID()}`,
      artifact_id: id,
      declared_step_ids: [second],
    });
    expect(secondOpen.result.n).toBe(2);
    const abandoned = await abandon(f, {
      idempotency_key: `abandon-${randomUUID()}`,
      artifact_id: id,
      n: 2,
      reason: 'Released the declared step',
    });
    expect(abandoned.raw.exitCode, abandoned.raw.stdout + abandoned.raw.stderr).toBe(0);
    expect(abandoned.result).toMatchObject({
      n: 2,
      status: 'abandoned',
      reason: 'Released the declared step',
    });
    expect(abandoned.result.snapshot_ref).toMatch(
      new RegExp(`^refs/orcaops/snap/${id}/2/abandon-[0-9a-f]{8}-[0-9a-f-]+$`)
    );
    const finalThread = readProjectArtifact(f.writer, id)!.thread;
    expect(finalThread.checkpoints.map((entry) => [entry.n, entry.status])).toEqual([
      [1, 'closed'],
      [2, 'abandoned'],
    ]);
  });

  it('refuses overlapping and unknown scope, unverified claims and an ambiguous close', async () => {
    const f = await fixture();
    const id = await f.capture();
    const [first, second] = await twoStepPlan(f, id);
    await open(f, {
      idempotency_key: `open-${randomUUID()}`,
      artifact_id: id,
      declared_step_ids: [first],
    });
    const overlap = await open(f, {
      idempotency_key: `open-${randomUUID()}`,
      artifact_id: id,
      declared_step_ids: [first],
    });
    expect(overlap.raw.exitCode).toBe(1);
    expect(overlap.result.error.code).toBe('OPEN_CP_OVERLAP');
    const unknownKey = `open-${randomUUID()}`;
    const unknown = await open(f, {
      idempotency_key: unknownKey,
      artifact_id: id,
      declared_step_ids: [uuidv7()],
    });
    expect(unknown.result.error.code).toBe('INVALID_INPUT');
    expect(unknown.result.error.path).toBe('declared_step_ids');
    // The refusals append no artifact history, but each hard rejection keeps the
    // receipt a same-key retry is adjudicated against.
    expect(
      readProjectArtifactAttempts(f.writer, id).records.map((entry) => [
        entry.eventType,
        entry.idempotencyKey,
        entry.record?.outcome,
      ])
    ).toContainEqual(['checkpoint_opened', unknownKey, 'hard_rejected']);
    const unverified = await close(f, {
      idempotency_key: `close-${randomUUID()}`,
      artifact_id: id,
      n: 1,
      summary: 'Claiming a step with no verification',
      files_changed: [],
      completed_step_ids: [first],
      decisions: [],
      uncertainty: [],
      done_criteria: [],
    });
    expect(unverified.result.error.code).toBe('INVALID_INPUT');
    expect(unverified.result.error.path).toBe('verification');
    await open(f, {
      idempotency_key: `open-${randomUUID()}`,
      artifact_id: id,
      declared_step_ids: [second],
    });
    const revision = readProjectArtifact(f.writer, id)!.revision;
    const files = await inventory(f.main);
    const ambiguous = await close(f, {
      idempotency_key: `close-${randomUUID()}`,
      artifact_id: id,
      summary: 'Which checkpoint?',
      files_changed: [],
      completed_step_ids: [],
      decisions: [],
      uncertainty: [],
      done_criteria: [],
    });
    expect(ambiguous.result.error.code).toBe('AMBIGUOUS_CHECKPOINT');
    expect(ambiguous.result.error.open_checkpoints.map((c: { n: number }) => c.n)).toEqual([1, 2]);
    expect(readProjectArtifact(f.writer, id)!.revision).toEqual(revision);
    expect(await inventory(f.main)).toEqual(files);
  });
});
