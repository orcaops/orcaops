import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { CapturePlanReviseInputSchema, CaptureSummaryInputSchema } from '@orcaops/storage';
import { artifactOperationId } from '@orcaops/storage/history/artifact-operation-id';
import {
  queryProjectArtifacts,
  readProjectArtifact,
  readProjectArtifactAttempts,
  readProjectGitRetention,
  readProjectPendingCapture,
} from '@orcaops/storage/history/database';
import { inputFile } from '@orcaops/test-harness';

import { recordDatabaseCaptureRefusal } from '../../src/lib/database-capture-attempts.js';
import { fixture } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

/**
 * Ported by meaning from the capture half of tests/integration/concurrency.test.ts.
 * That file proved parallel captures stayed isolated by giving each agent its own
 * repository, which the single-writer project database makes the weaker claim: here
 * the parallel captures contend for ONE database, so what is proven is that every
 * writer waits its turn and each capture keeps its own identity.
 */
type Fixture = Awaited<ReturnType<typeof fixture>>;
function agent(f: Fixture, session: string) {
  return makeAgent({
    cwd: f.main,
    timeoutMs: 120_000,
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
      XDG_STATE_HOME: `${f.temporary}/state-${session}`,
    },
  });
}

describe('registered database capture concurrency', { timeout: 180_000 }, () => {
  it('serializes parallel plan captures into one project without losing an identity', async () => {
    const f = await fixture();
    const count = 6;
    const results = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        agent(f, `parallel-${index}`).runRaw([
          'capture',
          'plan',
          '--no-llm',
          '--input',
          inputFile(
            JSON.stringify({
              idempotency_key: `plan-${randomUUID()}`,
              task: `Parallel capture ${index}`,
              label: `Parallel ${index}`,
              plan_steps: [
                {
                  text: `step ${index}`,
                  label: `Step ${index}`,
                  acceptance_criteria: [{ text: 'the step is delivered' }],
                },
              ],
              touched_scope: [],
              non_goals: [],
            })
          ),
        ])
      )
    );
    for (const raw of results) expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
    const ids = results.map((raw) => JSON.parse(raw.stdout).artifact_id as string);
    expect(new Set(ids).size).toBe(count);
    for (const id of ids) expect(readProjectArtifact(f.writer, id)).not.toBeNull();
    expect(
      new Set(
        queryProjectArtifacts(f.writer, { profile: 'versions' }).rows.map((row) => row.artifactId)
      )
    ).toEqual(new Set(ids));
  });

  it('retires the losing racing open, replays its refusal by key and admits a fresh key once', async () => {
    const f = await fixture();
    const captured = await agent(f, 'racing').runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'Race two checkpoint opens',
          label: 'Racing opens',
          plan_steps: [
            {
              text: 'first',
              label: 'First',
              acceptance_criteria: [{ text: 'the step is delivered' }],
            },
            {
              text: 'second',
              label: 'Second',
              acceptance_criteria: [{ text: 'the step is delivered' }],
            },
          ],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);
    expect(captured.exitCode, captured.stdout + captured.stderr).toBe(0);
    const plan = JSON.parse(captured.stdout);
    const steps: string[] = plan.plan_steps.map((step: { step_id: string }) => step.step_id);
    const body = (stepId: string, index: number, key: string) =>
      JSON.stringify({
        idempotency_key: key,
        artifact_id: plan.artifact_id,
        declared_step_ids: [stepId],
        agent_session_id: `subagent-${index}`,
      });
    const keys = steps.map(() => `open-${randomUUID()}`);
    const opens = await Promise.all(
      steps.map((stepId, index) =>
        agent(f, `open-${index}`).runRaw([
          'capture',
          'checkpoint',
          'open',
          '--no-llm',
          '--input',
          inputFile(body(stepId, index, keys[index])),
        ])
      )
    );
    const parsed = opens.map((raw) => JSON.parse(raw.stdout));
    const admitted = parsed.filter((entry) => entry.ok === true);
    const refused = parsed.filter((entry) => entry.ok === false);
    // Execution version is the precondition, so a racing open refuses rather than
    // retargeting; the file era serialized on a lock and admitted both.
    expect(admitted).toHaveLength(1);
    expect(refused.map((entry) => entry.error.code)).toEqual(['STALE_CONTEXT']);
    expect(admitted[0].n).toBe(1);
    const loserIndex = parsed.findIndex((entry) => entry.ok === false);
    const loserKey = keys[loserIndex];
    const loserStep = steps[loserIndex];
    expect(refused[0].error.message).toMatch(/FRESH idempotency_key/);
    const afterRace = readProjectArtifact(f.writer, plan.artifact_id)!;
    expect(afterRace.thread.checkpoints.map((checkpoint) => checkpoint.n)).toEqual([1]);
    // The refused admission is retired, not left prepared for a resume that can only fail,
    // and the refusal itself is retained as the receipt the same key replays.
    const loserOperationId = artifactOperationId(plan.artifact_id, loserKey, 'checkpoint_opened');
    expect(readProjectGitRetention(f.writer, loserOperationId).value?.current.kind).toBe('retired');
    expect(
      readProjectPendingCapture(f.writer, loserOperationId).value?.retention.current.kind
    ).toBe('retired');
    const attemptsAfterRace = readProjectArtifactAttempts(f.writer, plan.artifact_id).records;
    expect(
      attemptsAfterRace.map((entry) => [entry.eventType, entry.idempotencyKey])
    ).toContainEqual(['checkpoint_opened', loserKey]);

    // The same key replays the recorded refusal and writes nothing further.
    const sameKey = await agent(f, 'open-retry').runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(body(loserStep, loserIndex, loserKey)),
    ]);
    expect(sameKey.exitCode).toBe(1);
    const replayed = JSON.parse(sameKey.stdout);
    expect(replayed.error.code).toBe('STALE_CONTEXT');
    expect(replayed.error.message).toMatch(/FRESH idempotency_key/);
    expect(readProjectArtifact(f.writer, plan.artifact_id)!.revision).toEqual(afterRace.revision);
    expect(readProjectArtifactAttempts(f.writer, plan.artifact_id).records).toEqual(
      attemptsAfterRace
    );

    // A fresh key is admitted exactly once, and the second step ends up declared.
    const fresh = await agent(f, 'open-fresh').runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(body(loserStep, 9, `open-${randomUUID()}`)),
    ]);
    expect(fresh.exitCode, fresh.stdout + fresh.stderr).toBe(0);
    expect(JSON.parse(fresh.stdout).n).toBe(2);
    const retained = readProjectArtifact(f.writer, plan.artifact_id)!.thread.checkpoints;
    expect(retained.map((checkpoint) => checkpoint.status)).toEqual(['open', 'open']);
    expect(new Set(retained.flatMap((checkpoint) => checkpoint.declared_step_ids))).toEqual(
      new Set(steps)
    );
  });
});

describe('registered database existing-capture refusal contract', { timeout: 180_000 }, () => {
  /**
   * capture plan revise and capture summary settle immediately after reading their
   * expectation — they hold no git work in between, unlike the boundary-publishing
   * checkpoint verbs — so a real precondition race is not reproducible from two CLI calls
   * and a race-based control here would be flaky. What IS deterministic, and what these
   * controls prove, is that both verbs consult the retained refusal receipt BEFORE they
   * prepare anything: a receipt under their key stops the capture dead. The replayed
   * refusal itself is proven end to end on the checkpoint verbs above, through the same
   * shared module all five commands use.
   */
  async function seedRefusal(
    f: Fixture,
    artifactId: string,
    eventType: string,
    key: string,
    replayPayload: unknown
  ) {
    await recordDatabaseCaptureRefusal(f.writer, {
      artifactId,
      artifactRevision: readProjectArtifact(f.writer, artifactId)!.revision,
      eventType,
      idempotencyKey: key,
      replayPayload,
      refusal: { code: 'STALE_CONTEXT', message: 'seeded refusal receipt' },
      command: 'test fixture',
      secretAllow: [],
    });
  }
  /** What prepareDatabaseCapture hands the composer: the parsed payload plus the branch. */
  function preparedInput<T>(schema: { parse: (value: unknown) => T }, body: unknown, f: Fixture) {
    return { ...(schema.parse(body) as object), branch: f.context.branch };
  }
  function operationCount(f: Fixture) {
    return f.writer.read((view) =>
      view.get<{ total: number }>('SELECT count(*) AS total FROM operations')
    ).value!.total;
  }
  function attemptRows(f: Fixture, artifactId: string) {
    return readProjectArtifactAttempts(f.writer, artifactId).records;
  }

  it('replays a refused revision by key without writing, and conflicts on a different payload', async () => {
    const f = await fixture();
    const id = await f.capture();
    const plan = readProjectArtifact(f.writer, id)!.thread.plan!;
    const key = `revise-${randomUUID()}`;
    const body = (label: string) => ({
      idempotency_key: key,
      artifact_id: id,
      label,
      rationale: 'The receipt is consulted before anything is prepared',
      prior_plan_event_id: null,
      plan_steps: [
        {
          step_id: plan.plan_steps[0].step_id,
          text: 'Read retained evidence',
          label: 'Retained evidence',
        },
      ],
      touched_scope: [],
      non_goals: [],
    });
    const replayed = body('Refused by the retained receipt');
    await seedRefusal(
      f,
      id,
      'plan_revised',
      key,
      preparedInput(CapturePlanReviseInputSchema, replayed, f)
    );
    const revise = (payload: Record<string, unknown>) =>
      agent(f, 'revise-receipt').runRaw([
        'capture',
        'plan',
        'revise',
        '--no-llm',
        '--input',
        inputFile(JSON.stringify(payload)),
      ]);
    const before = readProjectArtifact(f.writer, id)!;
    const attemptsBefore = attemptRows(f, id);
    const operationsBefore = operationCount(f);
    for (const attempt of [1, 2]) {
      const refused = await revise(replayed);
      expect(refused.exitCode, `attempt ${attempt}: ${refused.stdout}`).toBe(1);
      expect(JSON.parse(refused.stdout).error.code, `attempt ${attempt}`).toBe('STALE_CONTEXT');
      // The recorded answer is returned, not re-recorded: no new attempt revision, no
      // new operation, no artifact history.
      expect(attemptRows(f, id), `attempt ${attempt}`).toEqual(attemptsBefore);
      expect(operationCount(f), `attempt ${attempt}`).toBe(operationsBefore);
      expect(readProjectArtifact(f.writer, id)!.revision).toEqual(before.revision);
    }
    const conflict = await revise(body('A structurally different label'));
    expect(conflict.exitCode).toBe(1);
    expect(JSON.parse(conflict.stdout).error).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      path: 'idempotency_key',
    });
    expect(readProjectArtifact(f.writer, id)!.revision).toEqual(before.revision);
  });

  it('replays a refused summary by key without writing, and conflicts on a different payload', async () => {
    const f = await fixture();
    const id = await f.capture();
    const key = `sum-${randomUUID()}`;
    const body = (outcome: string) => ({ idempotency_key: key, artifact_id: id, outcome });
    const replayed = body('shipped');
    await seedRefusal(
      f,
      id,
      'summary_captured',
      key,
      preparedInput(CaptureSummaryInputSchema, replayed, f)
    );
    const summary = (payload: Record<string, unknown>) =>
      agent(f, 'summary-receipt').runRaw([
        'capture',
        'summary',
        '--input',
        inputFile(JSON.stringify(payload)),
      ]);
    const before = readProjectArtifact(f.writer, id)!;
    const attemptsBefore = attemptRows(f, id);
    const operationsBefore = operationCount(f);
    for (const attempt of [1, 2]) {
      const refused = await summary(replayed);
      expect(refused.exitCode, `attempt ${attempt}: ${refused.stdout}`).toBe(1);
      expect(JSON.parse(refused.stdout).error.code, `attempt ${attempt}`).toBe('STALE_CONTEXT');
      expect(attemptRows(f, id), `attempt ${attempt}`).toEqual(attemptsBefore);
      expect(operationCount(f), `attempt ${attempt}`).toBe(operationsBefore);
      expect(readProjectArtifact(f.writer, id)!.thread.summary).toBeNull();
    }
    const conflict = await summary(body('a different outcome'));
    expect(conflict.exitCode).toBe(1);
    expect(JSON.parse(conflict.stdout).error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(readProjectArtifact(f.writer, id)!.revision).toEqual(before.revision);
  });
});
