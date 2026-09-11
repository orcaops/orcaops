import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { readProjectArtifact } from '@orcaops/storage/history/database';
import { inputFile } from '@orcaops/test-harness';

import { fixture, grantEvaluatorPack } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

/**
 * Ported by meaning from the evaluator-gated half of
 * tests/integration/checkpoint-lifecycle.test.ts and the prior-plan case of
 * tests/integration/plan-revise-criterion.test.ts. Those proved the pre-append
 * checkpoint-open gate: a blocking evaluator refuses the open without writing, the same
 * key replays the cached envelope, a policy exception clears it, a bad exception is a
 * typed refusal, a changed evaluator set invalidates the cached block, a hard rejection
 * clears once its cause is gone, and a revision is compared against its prior revision.
 */
const TEST_PACK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/test-pack'
);
const CORE_PACK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/evaluator-pack/dist/packs/core'
);
type Fixture = Awaited<ReturnType<typeof fixture>>;
function agent(f: Fixture) {
  return makeAgent({
    cwd: f.main,
    timeoutMs: 120_000,
    env: {
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: 'gate-session',
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
async function capture(f: Fixture, verb: string[], body: Record<string, unknown>) {
  const raw = await agent(f).runRaw([
    'capture',
    ...verb,
    '--no-llm',
    '--input',
    inputFile(JSON.stringify(body)),
  ]);
  return { raw, result: JSON.parse(raw.stdout) };
}
const open = (f: Fixture, body: Record<string, unknown>) =>
  capture(f, ['checkpoint', 'open'], body);
async function planWithSteps(f: Fixture, count: number) {
  const { raw, result } = await capture(f, ['plan'], {
    idempotency_key: `plan-${randomUUID()}`,
    task: 'Exercise the checkpoint-open gate',
    label: 'Gate subject',
    plan_steps: Array.from({ length: count }, (_, index) => ({
      text: `step ${index}`,
      label: `Step ${index}`,
    })),
    touched_scope: [],
    non_goals: [],
  });
  expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
  return {
    artifactId: result.artifact_id as string,
    steps: (result.plan_steps as { step_id: string }[]).map((step) => step.step_id),
  };
}

describe('registered database checkpoint-open gate', { timeout: 180_000 }, () => {
  it('blocks, replays the block by key, and admits the open under a policy exception', async () => {
    const f = await fixture();
    await grantEvaluatorPack(f, {
      packageId: 'test-pack',
      packRoot: TEST_PACK,
      enable: { 'test-pack/scope-density-stub': true },
    });
    const { artifactId, steps } = await planWithSteps(f, 2);
    const key = `open-${randomUUID()}`;
    const body = {
      idempotency_key: key,
      artifact_id: artifactId,
      declared_step_ids: [steps[0]],
    };
    const blocked = await open(f, body);
    expect(blocked.result).toMatchObject({
      ok: false,
      status: 'blocked',
      blocking: true,
      blocked_evaluator_refs: ['test-pack/scope-density-stub'],
    });
    const before = readProjectArtifact(f.writer, artifactId)!;
    expect(before.thread.checkpoints).toEqual([]);

    // The soft-blocked receipt replays the same envelope for the same key.
    const replay = await open(f, body);
    expect(replay.result).toMatchObject({ status: 'blocked', blocking: true });
    expect(replay.result.blocked_evaluator_refs).toEqual(['test-pack/scope-density-stub']);
    expect(readProjectArtifact(f.writer, artifactId)!.revision).toEqual(before.revision);

    const excepted = await open(f, {
      idempotency_key: `open-${randomUUID()}`,
      artifact_id: artifactId,
      declared_step_ids: [steps[0]],
      policy_exceptions: [
        {
          evaluator: 'test-pack/scope-density-stub',
          reason: 'the fixture stub always violates; the scope is deliberate',
        },
      ],
    });
    expect(excepted.raw.exitCode, excepted.raw.stdout + excepted.raw.stderr).toBe(0);
    expect(excepted.result).toMatchObject({ n: 1, status: 'open' });
    expect(excepted.result.policy_exceptions).toHaveLength(1);

    const unknown = await open(f, {
      idempotency_key: `open-${randomUUID()}`,
      artifact_id: artifactId,
      declared_step_ids: [steps[1]],
      policy_exceptions: [{ evaluator: 'test-pack/nonexistent', reason: 'no such evaluator' }],
    });
    expect(unknown.result.error).toMatchObject({
      code: 'INVALID_INPUT',
      path: 'policy_exceptions',
    });
  });

  it('re-evaluates a cached block when the enabled evaluator set changes', async () => {
    const f = await fixture();
    await grantEvaluatorPack(f, {
      packageId: 'test-pack',
      packRoot: TEST_PACK,
      enable: { 'test-pack/scope-density-stub': true },
    });
    const { artifactId, steps } = await planWithSteps(f, 1);
    const body = {
      idempotency_key: `open-${randomUUID()}`,
      artifact_id: artifactId,
      declared_step_ids: [steps[0]],
    };
    expect((await open(f, body)).result.status).toBe('blocked');
    // Disabling the gate changes the checkpoint-open fingerprint, which invalidates the
    // cached block instead of replaying an answer the current evaluator set never gave.
    await grantEvaluatorPack(f, {
      packageId: 'test-pack',
      packRoot: TEST_PACK,
      enable: { 'test-pack/scope-density-stub': false },
    });
    const admitted = await open(f, body);
    expect(admitted.raw.exitCode, admitted.raw.stdout + admitted.raw.stderr).toBe(0);
    expect(admitted.result).toMatchObject({ n: 1, status: 'open' });
  });

  it('clears a hard-rejected overlap once the conflicting checkpoint is abandoned', async () => {
    const f = await fixture();
    const { artifactId, steps } = await planWithSteps(f, 1);
    const first = await open(f, {
      idempotency_key: `open-${randomUUID()}`,
      artifact_id: artifactId,
      declared_step_ids: [steps[0]],
    });
    expect(first.raw.exitCode, first.raw.stdout + first.raw.stderr).toBe(0);
    const key = `open-${randomUUID()}`;
    const body = {
      idempotency_key: key,
      artifact_id: artifactId,
      declared_step_ids: [steps[0]],
    };
    const overlapped = await open(f, body);
    expect(overlapped.result.error.code).toBe('OPEN_CP_OVERLAP');
    const abandoned = await agent(f).runRaw([
      'capture',
      'checkpoint',
      'abandon',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `abandon-${randomUUID()}`,
          artifact_id: artifactId,
          n: 1,
          reason: 'release the declared step',
        })
      ),
    ]);
    expect(abandoned.exitCode, abandoned.stdout + abandoned.stderr).toBe(0);
    // A hard rejection is allowed to clear: the same key retries against the new state.
    const retried = await open(f, body);
    expect(retried.raw.exitCode, retried.raw.stdout + retried.raw.stderr).toBe(0);
    expect(retried.result).toMatchObject({ n: 2, status: 'open' });
  });

  it('compares a revision against its immediately prior revision', async () => {
    const f = await fixture();
    await grantEvaluatorPack(f, {
      packageId: 'core',
      packRoot: CORE_PACK,
      enable: { 'core/revision-non-goals-stable': true },
    });
    const { artifactId, steps } = await planWithSteps(f, 1);
    const step = { step_id: steps[0], text: 'step 0', label: 'Step 0' };
    const bounded = await capture(f, ['plan', 'revise'], {
      idempotency_key: `revise-${randomUUID()}`,
      artifact_id: artifactId,
      label: 'Bounded by an explicit non-goal',
      rationale: 'Record the boundary the port must not cross',
      prior_plan_event_id: null,
      plan_steps: [step],
      touched_scope: [],
      non_goals: [{ text: 'No converter work', rationale: 'Owned by another unit' }],
    });
    expect(bounded.raw.exitCode, bounded.raw.stdout + bounded.raw.stderr).toBe(0);
    const relaxed = await capture(f, ['plan', 'revise'], {
      idempotency_key: `revise-${randomUUID()}`,
      artifact_id: artifactId,
      label: 'Boundary relaxed',
      rationale: 'Drop the boundary to prove the prior revision is read',
      prior_plan_event_id: null,
      plan_steps: [step],
      touched_scope: [],
      non_goals: [],
    });
    expect(relaxed.raw.exitCode, relaxed.raw.stdout + relaxed.raw.stderr).toBe(0);
    const nonGoals = relaxed.result.evaluator_results.find(
      (entry: { evaluator_ref: string }) => entry.evaluator_ref === 'core/revision-non-goals-stable'
    );
    expect(nonGoals).toMatchObject({ phase: 'post-plan-revision', verdict: 'violation' });
    expect(nonGoals.body).toContain('No converter work');
  });
});
