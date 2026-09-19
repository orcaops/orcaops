import { expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { readProjectArtifact } from '@orcaops/storage/history/database';
import { readProjectExecutionFocus } from '@orcaops/storage/history/database/execution-checkout';
import { inputFile } from '@orcaops/test-harness';

import { fixture, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
function agent(f: Fixture, session = 'focus-session') {
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
      XDG_STATE_HOME: f.temporary + '/state',
    },
  });
}
function focus(f: Fixture) {
  const { counters: _counters, ...selected } = readProjectExecutionFocus(f.writer, {
    rootKey: f.authority.rootKey,
    projectId: f.authority.projectId,
    storeInstanceId: f.authority.storeInstanceId,
    repositoryInstanceId: f.authority.repositoryInstanceId,
    worktreeId: f.context.worktreeId!,
    shellKey: { kind: 'codex_session', value: 'focus-session' },
  });
  return selected;
}
async function plan(f: Fixture, key = uuidv7(), session?: string) {
  const raw = await agent(f, session).runRaw([
    'capture',
    'plan',
    '--no-llm',
    '--input',
    inputFile(
      JSON.stringify({
        idempotency_key: key,
        task: 'Retain a task',
        plan_steps: [
          {
            text: 'Verify the task',
            label: 'Verify',
            acceptance_criteria: [{ text: 'the step is delivered' }],
          },
        ],
      })
    ),
  ]);
  expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
  return JSON.parse(raw.stdout) as {
    artifact_id: string;
    focus: { state: string; reason?: string; displaced_artifact_id?: string | null };
  };
}
async function summarize(f: Fixture, artifactId: string, session?: string) {
  const raw = await agent(f, session).runRaw([
    'capture',
    'summary',
    '--input',
    inputFile(JSON.stringify({ artifact_id: artifactId, outcome: 'Done' })),
  ]);
  return {
    raw,
    result: JSON.parse(raw.stdout) as { focus?: { state: string }; error?: { code: string } },
  };
}

it('moves session focus to a new plan while keeping the previous artifact history intact', async () => {
  const f = await fixture();
  const first = await plan(f);
  const previous = readProjectArtifact(f.writer, first.artifact_id)!.revision;
  const next = await plan(f);
  expect(next.focus).toMatchObject({ state: 'updated', displaced_artifact_id: first.artifact_id });
  expect(focus(f)).toMatchObject({ status: 'present', pin: { artifact_id: next.artifact_id } });
  expect(readProjectArtifact(f.writer, first.artifact_id)!.revision).toEqual(previous);
});

it('replays an older plan without moving a newer focus or changing history', async () => {
  const f = await fixture();
  const key = uuidv7();
  const first = await plan(f, key);
  const next = await plan(f);
  const before = await inventory(f.temporary);
  const replay = await plan(f, key);
  expect(replay.artifact_id).toBe(first.artifact_id);
  expect(replay.focus).toMatchObject({ state: 'skipped', reason: 'replay' });
  expect(focus(f)).toMatchObject({ status: 'present', pin: { artifact_id: next.artifact_id } });
  expect(await inventory(f.temporary)).toEqual(before);
});

it('keeps another focused task when summarizing an explicit artifact', async () => {
  const f = await fixture();
  const first = await plan(f);
  const next = await plan(f);
  const before = focus(f);
  const done = await summarize(f, first.artifact_id);
  expect(done.raw.exitCode, done.raw.stdout + done.raw.stderr).toBe(0);
  expect(done.result.focus).toMatchObject({ state: 'not_requested' });
  expect(focus(f)).toEqual(before);
  expect(focus(f)).toMatchObject({ status: 'present', pin: { artifact_id: next.artifact_id } });
});

it('does not create focus without a shell identity or clear another shell focus', async () => {
  const f = await fixture();
  const headless = await plan(f, uuidv7(), '');
  expect(headless.focus).toMatchObject({ state: 'not_requested' });
  expect(focus(f).status).toBe('absent');
  const focused = await plan(f);
  const before = focus(f);
  const done = await summarize(f, focused.artifact_id, '');
  expect(done.raw.exitCode, done.raw.stdout + done.raw.stderr).toBe(0);
  expect(done.result.focus).toMatchObject({ state: 'not_requested' });
  expect(focus(f)).toEqual(before);
});

it('keeps focus when a summary is blocked by retained evaluator evidence', async () => {
  const f = await fixture();
  const captured = await plan(f);
  const artifactId = captured.artifact_id;
  await f.mutate(artifactId, { blocked: true }, (semantics) =>
    semantics.writeEvaluatorRunPayload(
      artifactId,
      {
        schema: 'orcaops.evaluator_run/v1',
        run_id: uuidv7(),
        artifact_id: artifactId,
        evaluator_ref: 'test-pack/refusal',
        package_id: 'test-pack',
        evaluator_id: 'refusal',
        phase: 'pre-pr',
        severity: 'block',
        run_status: 'completed',
        verdict: 'violation',
        body: 'Retained blocking evidence',
        ts: '2026-09-05T00:00:01.000Z',
      },
      { idempotencyKey: uuidv7() }
    )
  );
  const before = focus(f);
  const result = await summarize(f, artifactId);
  expect(result.raw.exitCode).toBe(1);
  expect(result.result.error?.code).toBe('BLOCKED');
  expect(focus(f)).toEqual(before);
});
