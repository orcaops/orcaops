import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

describe('orcaops resume — flag matrix + error envelopes', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("completed_step_ids referencing a step_id not in the open's declared scope → INVALID_INPUT", async () => {
    await agent.init({ noLlm: true });
    const plan = await agent.capturePlan(
      { task: 't', plan_steps: [{ text: 'only step', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const stepId = plan.plan_steps[0].step_id;
    await agent.captureCheckpointOpen(
      { artifact_id: plan.artifact_id, declared_step_ids: [stepId] },
      { noLlm: true }
    );
    const err = await agent.expectError([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: plan.artifact_id,
          n: 1,
          summary: 'cp',
          files_changed: [],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
          completed_step_ids: ['019dd7df-aaaa-7bbb-cccc-ddddeeeeffff'],
          idempotency_key: 'test-cp1-close-out-of-range',
        })
      ),
    ]);
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.path).toBe('completed_step_ids');
    expect(err.error.message).toMatch(/not declared at open/);
  });

  it('completed_step_ids with duplicates → INVALID_INPUT', async () => {
    await agent.init({ noLlm: true });
    const plan = await agent.capturePlan(
      {
        task: 't',
        plan_steps: [
          { text: 's1', label: 's1' },
          { text: 's2', label: 's2' },
          { text: 's3', label: 's3' },
        ],
        touched_scope: [],
      },
      { noLlm: true }
    );
    const [s1, s2] = plan.plan_steps.map((s) => s.step_id);
    await agent.captureCheckpointOpen(
      { artifact_id: plan.artifact_id, declared_step_ids: [s1, s2] },
      { noLlm: true }
    );
    const err = await agent.expectError([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: plan.artifact_id,
          n: 1,
          summary: 'cp',
          files_changed: [],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
          completed_step_ids: [s1, s2, s1],
          idempotency_key: 'test-cp1-close-duplicates',
        })
      ),
    ]);
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.path).toBe('completed_step_ids');
    expect(err.error.message).toMatch(/duplicate/);
  });

  it('completed_step_ids must be non-empty strings (Zod rejects empty)', async () => {
    await agent.init({ noLlm: true });
    const plan = await agent.capturePlan(
      { task: 't', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const stepId = plan.plan_steps[0].step_id;
    await agent.captureCheckpointOpen(
      { artifact_id: plan.artifact_id, declared_step_ids: [stepId] },
      { noLlm: true }
    );
    const err = await agent.expectError([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: plan.artifact_id,
          n: 1,
          summary: 'cp',
          files_changed: [],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
          completed_step_ids: [''],
          idempotency_key: 'test-cp1-close-empty',
        })
      ),
    ]);
    expect(err.error.code).toBe('INVALID_INPUT');
  });

  it('--artifact <id> selects an explicit artifact (resume-once, no pin write)', async () => {
    await agent.init({ noLlm: true });
    const a1 = await agent.capturePlan(
      { task: 'first', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const a2 = await agent.capturePlan(
      { task: 'second', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    expect(a1.artifact_id).not.toBe(a2.artifact_id);

    const r = await agent.resume({ artifact: a1.artifact_id });
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.resolution_via).toBe('explicit-flag');
    expect(r.artifact?.artifact_id).toBe(a1.artifact_id);
    expect(r.artifact?.task).toBe('first');
  });

  it('--json surfaces decisions[] captured across closed checkpoints', async () => {
    await agent.init({ noLlm: true });
    const plan = await agent.capturePlan(
      {
        task: 't',
        plan_steps: [
          { text: 's1', label: 's1' },
          { text: 's2', label: 's2' },
        ],
        touched_scope: [],
      },
      { noLlm: true }
    );
    const [s1] = plan.plan_steps.map((s) => s.step_id);
    const open = await agent.captureCheckpointOpen(
      { artifact_id: plan.artifact_id, declared_step_ids: [s1] },
      { noLlm: true }
    );
    expect(open.ok).toBe(true);
    if (!open.ok) return;
    await agent.captureCheckpointClose(
      {
        artifact_id: plan.artifact_id,
        n: open.n,
        summary: 'did s1',
        files_changed: [],
        verification: [{ command: 'test fixture', exit_code: 0 }],
        completed_step_ids: [s1],
        decisions: [
          {
            decision: 'token bucket',
            reason: 'avoids boundary burst',
            alternatives_considered: [
              { option: 'fixed window', rejected_because: 'boundary burst' },
            ],
          },
        ],
        uncertainty: [],
        done_criteria: [],
      },
      { noLlm: true }
    );

    const r = await agent.resume({ artifact: plan.artifact_id });
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.artifact?.decisions).toEqual([
      {
        decision: 'token bucket',
        reason: 'avoids boundary burst',
        source: 'checkpoint',
        checkpoint: 1,
        alternatives_considered: [{ option: 'fixed window', rejected_because: 'boundary burst' }],
      },
    ]);
    // The WHY also rides the paste-ready prompt a resuming agent reads.
    expect(r.artifact?.agent_prompt).toContain('Decisions made so far:');
    expect(r.artifact?.agent_prompt).toContain(
      'considered fixed window — rejected because boundary burst'
    );
  });

  it('--branch selects from a different branch (sibling branch falls back via SHA reachability)', async () => {
    await agent.init({ noLlm: true });
    const onMain = await agent.capturePlan(
      { task: 'main work', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );

    const { gitClient } = await import('@orcaops/test-harness');
    const git = gitClient(repo.path);
    await git.checkoutBranch('feat/empty', 'main');

    const fallback = await agent.resume();
    expect(fallback.resolved).toBe(true);
    if (!fallback.resolved) return;
    expect(fallback.artifact?.artifact_id).toBe(onMain.artifact_id);
    expect(fallback.artifact?.lineage_stale).toBe(true);
    expect(fallback.artifact?.lineage_branches).toEqual(['main']);

    const r = await agent.resume({ branch: 'main' });
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.artifact?.artifact_id).toBe(onMain.artifact_id);
    expect(r.artifact?.branch).toBe('main');
    expect(r.artifact?.lineage_stale).toBe(false);
  });

  it('returns UNKNOWN_ARTIFACT for an unknown --artifact id', async () => {
    await agent.init({ noLlm: true });
    const err = await agent.expectError(['resume', '--json', '--artifact', 'doesnotexist']);
    expect(err.error.code).toBe('UNKNOWN_ARTIFACT');
    expect(err.error.message).toContain('doesnotexist');
  });

  it('returns UNINITIALIZED before init', async () => {
    const err = await agent.expectError(['resume', '--json']);
    expect(err.error.code).toBe('UNINITIALIZED');
  });

  it('resolves the latest IN-FLIGHT artifact and excludes summarized ones', async () => {
    await agent.init({ noLlm: true });
    const a1 = await agent.capturePlan(
      { task: 'first', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    await agent.captureSummary({ artifact_id: a1.artifact_id, outcome: 'done' });
    const a2 = await agent.capturePlan(
      { task: 'second', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const r = await agent.resume();
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.resolution_via).toBe('single-active');
    expect(r.artifact?.artifact_id).toBe(a2.artifact_id);
    expect(r.artifact?.is_complete).toBe(false);
  });

  it('completed artifact is still resumable via --artifact <id> (resume-once)', async () => {
    await agent.init({ noLlm: true });
    const plan = await agent.capturePlan(
      { task: 't', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    await agent.captureSummary({ artifact_id: plan.artifact_id, outcome: 'done' });
    const r = await agent.resume({ artifact: plan.artifact_id });
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.artifact?.artifact_id).toBe(plan.artifact_id);
    expect(r.artifact?.is_complete).toBe(true);
  });

  it('plain resume with no in-flight artifacts resolves-empty (no error)', async () => {
    await agent.init({ noLlm: true });
    const plan = await agent.capturePlan(
      { task: 't', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    await agent.captureSummary({ artifact_id: plan.artifact_id, outcome: 'done' });
    const r = await agent.resume();
    expect(r.resolved).toBe(true);
    if (!r.resolved) return;
    expect(r.resolution_via).toBe('no-active-artifacts');
    expect(r.artifact).toBeNull();
    expect(r.next_actions?.[0]?.verb).toBe('capture-plan');
  });
});
