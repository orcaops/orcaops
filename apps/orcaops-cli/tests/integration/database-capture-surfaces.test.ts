import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { readProjectArtifact, readProjectUsage } from '@orcaops/storage/history/database';
import { readProjectExecutionFocus } from '@orcaops/storage/history/database/execution-checkout';
import { inputFile } from '@orcaops/test-harness';

import { fixture } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';
import { doneCriteriaFor } from '../support/test-helpers.js';

/**
 * Ported by meaning from the surface half of tests/integration/checkpoint-lifecycle.test.ts,
 * the lineage and session half of tests/integration/plan-revision.test.ts, and the
 * headless and blocked cases of tests/integration/pin-lifecycle.test.ts. Those proved that
 * closed checkpoints alone drive the thread count, that an omitted idempotency key is
 * auto-minted, that more than one active artifact is an AMBIGUOUS_ARTIFACT refusal with
 * candidates, that a subagent id survives to the read surfaces, that a revision carries
 * step identity through reorders and rewrites and refuses an unacknowledged completion
 * drop, and that a session with no shell key or a refused summary leaves focus alone.
 */
type Fixture = Awaited<ReturnType<typeof fixture>>;
const SESSION = 'surface-session';
function agent(f: Fixture, session: string | null = SESSION) {
  return makeAgent({
    cwd: f.main,
    timeoutMs: 90_000,
    env: {
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: session ?? '',
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      TMUX_PANE: '',
      STY: '',
      WINDOW: '',
      TTY: '',
      XDG_STATE_HOME: `${f.temporary}/state-${session ?? 'headless'}`,
    },
  });
}
async function run(
  f: Fixture,
  verb: string[],
  body: Record<string, unknown>,
  session: string | null = SESSION,
  flags: string[] = ['--no-llm']
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
async function plan(f: Fixture, labels: string[], session: string | null = SESSION) {
  const { raw, result } = await run(
    f,
    ['plan'],
    {
      idempotency_key: `plan-${randomUUID()}`,
      task: 'Exercise the capture read surfaces',
      label: `Surfaces ${randomUUID().slice(0, 8)}`,
      plan_steps: labels.map((label) => ({
        text: label,
        label,
        acceptance_criteria: [{ text: 'the step is delivered' }],
      })),
      touched_scope: [],
      non_goals: [],
    },
    session
  );
  expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
  const planSteps = result.plan_steps as Array<{
    step_id: string;
    acceptance_criteria: Array<{ criterion_id: string }>;
  }>;
  return {
    artifactId: result.artifact_id as string,
    steps: planSteps.map((step) => step.step_id),
    planSteps,
  };
}
async function status(f: Fixture) {
  const raw = await agent(f).runRaw(['status', '--json']);
  expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
  return JSON.parse(raw.stdout) as {
    artifacts: Array<{
      id: string;
      thread: Record<string, { status: string; count?: number }>;
    }>;
  };
}

describe('registered database capture surfaces', { timeout: 180_000 }, () => {
  it('counts only closed checkpoints, auto-mints a key and keeps the subagent id', async () => {
    const f = await fixture();
    const { artifactId, steps } = await plan(f, ['a', 'b']);
    // No idempotency_key: the runtime mints one rather than refusing.
    const opened = await run(f, ['checkpoint', 'open'], {
      artifact_id: artifactId,
      declared_step_ids: [steps[0]],
      agent_session_id: 'subagent-a',
    });
    expect(opened.raw.exitCode, opened.raw.stdout + opened.raw.stderr).toBe(0);
    expect(opened.result).toMatchObject({ n: 1, agent_session_id: 'subagent-a' });
    const openOnly = await status(f);
    const openThread = openOnly.artifacts.find((entry) => entry.id === artifactId)!.thread;
    expect(openThread.checkpoint.status).toBe('ready');
    expect(openThread.checkpoint.count).toBeUndefined();

    const closed = await run(f, ['checkpoint', 'close'], {
      artifact_id: artifactId,
      n: 1,
      summary: 'Closed the first checkpoint',
      files_changed: [],
      completed_step_ids: [],
      decisions: [],
      uncertainty: [],
      done_criteria: [],
    });
    expect(closed.raw.exitCode, closed.raw.stdout + closed.raw.stderr).toBe(0);
    const secondOpen = await run(f, ['checkpoint', 'open'], {
      artifact_id: artifactId,
      declared_step_ids: [steps[1]],
    });
    expect(secondOpen.result.n).toBe(2);
    const abandoned = await run(
      f,
      ['checkpoint', 'abandon'],
      { artifact_id: artifactId, n: 2, reason: 'released' },
      SESSION,
      []
    );
    expect(abandoned.raw.exitCode, abandoned.raw.stdout + abandoned.raw.stderr).toBe(0);
    const counted = await status(f);
    const thread = counted.artifacts.find((entry) => entry.id === artifactId)!.thread;
    expect(thread.checkpoint.count).toBe(1);
    const retained = readProjectArtifact(f.writer, artifactId)!.thread.checkpoints;
    expect(retained.map((checkpoint) => checkpoint.status)).toEqual(['closed', 'abandoned']);
    expect(retained[0].agent_session_id).toBe('subagent-a');
  });

  it('refuses an ambiguous artifact with candidates instead of guessing', async () => {
    const f = await fixture();
    const first = await plan(f, ['a']);
    const second = await plan(f, ['b']);
    const ambiguous = await run(f, ['checkpoint', 'open'], {
      idempotency_key: `open-${randomUUID()}`,
      declared_step_ids: [first.steps[0]],
    });
    expect(ambiguous.raw.exitCode).toBe(1);
    expect(ambiguous.result.error.code).toBe('AMBIGUOUS_ARTIFACT');
    expect(
      (ambiguous.result.error.candidates as { id: string }[]).map((entry) => entry.id).sort()
    ).toEqual([first.artifactId, second.artifactId].sort());
  });

  it('carries step identity through a reorder and a rewrite and refuses an unacknowledged drop', async () => {
    const f = await fixture();
    const { artifactId, steps, planSteps } = await plan(f, ['a', 'b', 'c']);
    const revise = (body: Record<string, unknown>) =>
      run(f, ['plan', 'revise'], {
        idempotency_key: `revise-${randomUUID()}`,
        artifact_id: artifactId,
        rationale: 'Exercise lineage',
        prior_plan_event_id: null,
        touched_scope: [],
        non_goals: [],
        ...body,
      });
    const reordered = await revise({
      label: 'Reordered',
      plan_steps: [
        {
          step_id: steps[2],
          text: 'c',
          label: 'c',
          acceptance_criteria: [{ text: 'the step is delivered' }],
        },
        {
          step_id: steps[0],
          text: 'a',
          label: 'a',
          acceptance_criteria: [{ text: 'the step is delivered' }],
        },
        {
          step_id: steps[1],
          text: 'b',
          label: 'b',
          acceptance_criteria: [{ text: 'the step is delivered' }],
        },
      ],
    });
    expect(reordered.raw.exitCode, reordered.raw.stdout + reordered.raw.stderr).toBe(0);
    expect(reordered.result.step_lineage.unchanged.slice().sort()).toEqual(steps.slice().sort());
    expect(reordered.result.step_lineage).toMatchObject({ added: [], dropped: [], rewritten: [] });
    expect(reordered.result.plan_steps.map((step: { step_id: string }) => step.step_id)).toEqual([
      steps[2],
      steps[0],
      steps[1],
    ]);

    const rewritten = await revise({
      label: 'Rewritten',
      plan_steps: [
        {
          step_id: steps[2],
          text: 'c',
          label: 'c',
          acceptance_criteria: [{ text: 'the step is delivered' }],
        },
        {
          step_id: steps[0],
          text: 'a, rewritten',
          label: 'a',
          acceptance_criteria: [{ text: 'the step is delivered' }],
        },
        {
          step_id: steps[1],
          text: 'b',
          label: 'b',
          acceptance_criteria: [{ text: 'the step is delivered' }],
        },
      ],
    });
    expect(rewritten.raw.exitCode, rewritten.raw.stdout + rewritten.raw.stderr).toBe(0);
    expect(rewritten.result.step_lineage.rewritten).toHaveLength(1);
    expect(rewritten.result.step_lineage.rewritten[0]).toMatchObject({ step_id: steps[0] });
    expect(rewritten.result.step_lineage.rewritten[0].prior_text_hash).toMatch(/^[0-9a-f]{64}$/);

    // Claim a step, then try to drop it: the completion record must be acknowledged.
    const opened = await run(f, ['checkpoint', 'open'], {
      artifact_id: artifactId,
      declared_step_ids: [steps[0]],
    });
    expect(opened.raw.exitCode, opened.raw.stdout + opened.raw.stderr).toBe(0);
    const closed = await run(f, ['checkpoint', 'close'], {
      artifact_id: artifactId,
      n: opened.result.n,
      summary: 'Claim the step so the drop needs acknowledging',
      files_changed: [],
      completed_step_ids: [steps[0]],
      decisions: [],
      uncertainty: [],
      done_criteria: doneCriteriaFor(planSteps, [steps[0]]),
      verification: [{ command: 'pnpm exec vitest run', exit_code: 0 }],
    });
    expect(closed.raw.exitCode, closed.raw.stdout + closed.raw.stderr).toBe(0);
    const dropped = await revise({
      label: 'Dropping a claimed step',
      plan_steps: [
        {
          step_id: steps[2],
          text: 'c',
          label: 'c',
          acceptance_criteria: [{ text: 'the step is delivered' }],
        },
        {
          step_id: steps[1],
          text: 'b',
          label: 'b',
          acceptance_criteria: [{ text: 'the step is delivered' }],
        },
      ],
    });
    expect(dropped.result.error.code).toBe('PLAN_REVISION_UNACKNOWLEDGED_DROPS');
    const acknowledged = await revise({
      label: 'Dropping a claimed step with acknowledgement',
      plan_steps: [
        {
          step_id: steps[2],
          text: 'c',
          label: 'c',
          acceptance_criteria: [{ text: 'the step is delivered' }],
        },
        {
          step_id: steps[1],
          text: 'b',
          label: 'b',
          acceptance_criteria: [{ text: 'the step is delivered' }],
        },
      ],
      acknowledge_drops_completed_steps: [steps[0]],
    });
    expect(acknowledged.raw.exitCode, acknowledged.raw.stdout + acknowledged.raw.stderr).toBe(0);
    expect(acknowledged.result.step_lineage.dropped).toEqual([steps[0]]);
  });

  it('hands the plan event id to checkpoint open and refuses a stale one', async () => {
    const f = await fixture();
    const captured = await run(f, ['plan'], {
      idempotency_key: `plan-${randomUUID()}`,
      task: 'Hand the plan event id to the checkpoint',
      label: 'Plan revision token',
      plan_steps: [
        { text: 'a', label: 'a', acceptance_criteria: [{ text: 'the step is delivered' }] },
      ],
      touched_scope: [],
      non_goals: [],
    });
    expect(captured.raw.exitCode, captured.raw.stdout + captured.raw.stderr).toBe(0);
    const artifactId = captured.result.artifact_id as string;
    const stepId = captured.result.plan_steps[0].step_id as string;
    const captureEventId = captured.result.plan_event_id as string;
    expect(captureEventId).toMatch(/^[0-9a-f-]{36}$/);
    const accepted = await run(f, ['checkpoint', 'open'], {
      artifact_id: artifactId,
      declared_step_ids: [stepId],
      plan_revision_id: captureEventId,
    });
    expect(accepted.raw.exitCode, accepted.raw.stdout + accepted.raw.stderr).toBe(0);
    expect(accepted.result.n).toBe(1);
    const abandoned = await run(
      f,
      ['checkpoint', 'abandon'],
      { artifact_id: artifactId, n: 1, reason: 'release for the stale-token case' },
      SESSION,
      []
    );
    expect(abandoned.raw.exitCode, abandoned.raw.stdout + abandoned.raw.stderr).toBe(0);
    const revised = await run(f, ['plan', 'revise'], {
      idempotency_key: `revise-${randomUUID()}`,
      artifact_id: artifactId,
      label: 'Moves the plan event id on',
      rationale: 'Make the captured token stale',
      prior_plan_event_id: captureEventId,
      plan_steps: [
        {
          step_id: stepId,
          text: 'a',
          label: 'a',
          acceptance_criteria: [{ text: 'the step is delivered' }],
        },
      ],
      touched_scope: [],
      non_goals: [],
    });
    expect(revised.raw.exitCode, revised.raw.stdout + revised.raw.stderr).toBe(0);
    // The token the capture handed out now names an older plan event.
    const stale = await run(f, ['checkpoint', 'open'], {
      artifact_id: artifactId,
      declared_step_ids: [stepId],
      plan_revision_id: captureEventId,
    });
    expect(stale.raw.exitCode).toBe(1);
    expect(stale.result.error.code).toBe('STALE_PLAN_REVISION');
    const fresh = await run(f, ['checkpoint', 'open'], {
      artifact_id: artifactId,
      declared_step_ids: [stepId],
      plan_revision_id: revised.result.plan_event_id,
    });
    expect(fresh.raw.exitCode, fresh.raw.stdout + fresh.raw.stderr).toBe(0);
    expect(fresh.result.n).toBe(2);
  });

  it('inherits an agent session across revisions and clears it with an explicit null', async () => {
    const f = await fixture();
    const { artifactId, steps } = await plan(f, ['a']);
    const revise = (body: Record<string, unknown>, key = `revise-${randomUUID()}`) =>
      run(f, ['plan', 'revise'], {
        idempotency_key: key,
        artifact_id: artifactId,
        rationale: 'Exercise session inheritance',
        prior_plan_event_id: null,
        plan_steps: [
          {
            step_id: steps[0],
            text: 'a',
            label: 'a',
            acceptance_criteria: [{ text: 'the step is delivered' }],
          },
        ],
        touched_scope: [],
        non_goals: [],
        ...body,
      });
    const set = await revise({ label: 'Session set', agent_session_id: 'session-one' });
    expect(set.raw.exitCode, set.raw.stdout + set.raw.stderr).toBe(0);
    expect(readProjectArtifact(f.writer, artifactId)!.thread.plan!.agent_session_id).toBe(
      'session-one'
    );
    // Omitting the field inherits the retained session rather than clearing it, and the
    // inherited value is not part of the replay identity.
    const inheritKey = `revise-${randomUUID()}`;
    const inherited = await revise({ label: 'Session inherited' }, inheritKey);
    expect(inherited.raw.exitCode, inherited.raw.stdout + inherited.raw.stderr).toBe(0);
    expect(readProjectArtifact(f.writer, artifactId)!.thread.plan!.agent_session_id).toBe(
      'session-one'
    );
    const replayed = await revise({ label: 'Session inherited' }, inheritKey);
    expect(replayed.result).toMatchObject({
      idempotency_status: 'replay',
      revision_n: inherited.result.revision_n,
    });
    const cleared = await revise({ label: 'Session cleared', agent_session_id: null });
    expect(cleared.raw.exitCode, cleared.raw.stdout + cleared.raw.stderr).toBe(0);
    expect(readProjectArtifact(f.writer, artifactId)!.thread.plan!.agent_session_id).toBeNull();
  });

  it('skips focus without a shell key and leaves it alone when the summary refuses', async () => {
    const f = await fixture();
    const headless = await plan(f, ['a'], null);
    // No shell key: auto-focus is not requested, and the capture still commits.
    const focusScope = {
      rootKey: f.authority.rootKey,
      projectId: f.authority.projectId,
      storeInstanceId: f.authority.storeInstanceId,
      repositoryInstanceId: f.authority.repositoryInstanceId,
      worktreeId: f.context.worktreeId!,
      shellKey: { kind: 'codex_session' as const, value: SESSION },
    };
    expect(readProjectExecutionFocus(f.writer, focusScope).status).toBe('absent');
    expect(readProjectArtifact(f.writer, headless.artifactId)).not.toBeNull();

    const pinned = await plan(f, ['b']);
    expect(readProjectExecutionFocus(f.writer, focusScope)).toMatchObject({
      status: 'present',
      pin: { artifact_id: pinned.artifactId },
    });
    await f.mutate(pinned.artifactId, { open: true }, (semantics) =>
      semantics.writeCheckpointOpened(
        { artifact_id: pinned.artifactId, declared_step_ids: [pinned.steps[0]] },
        { idempotencyKey: uuidv7(), headSha: f.context.headOid! }
      )
    );
    const refused = await run(
      f,
      ['summary'],
      {
        idempotency_key: `sum-${randomUUID()}`,
        artifact_id: pinned.artifactId,
        outcome: 'shipped',
      },
      SESSION,
      []
    );
    expect(refused.raw.exitCode).toBe(1);
    // A refused summary never clears the pin it would have cleared on success.
    expect(readProjectExecutionFocus(f.writer, focusScope)).toMatchObject({
      status: 'present',
      pin: { artifact_id: pinned.artifactId },
    });
  });

  it('reports an undiscoverable coding session honestly instead of failing the capture', async () => {
    const f = await fixture();
    const { result } = await run(f, ['plan'], {
      idempotency_key: `plan-${randomUUID()}`,
      task: 'Capture with no readable agent transcript',
      label: 'Usage discovery honesty',
      plan_steps: [
        { text: 'a', label: 'a', acceptance_criteria: [{ text: 'the step is delivered' }] },
      ],
      touched_scope: [],
      non_goals: [],
    });
    // The fixture session has no transcript, so the stamp says so rather than inventing one.
    expect(result.usage).toMatchObject({ state: 'unavailable', usage_source: 'unavailable' });
    expect(readProjectUsage(f.writer)).toBeNull();
    expect(readProjectArtifact(f.writer, result.artifact_id)).not.toBeNull();
  });
});
