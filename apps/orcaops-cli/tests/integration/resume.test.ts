import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

describe('checkpoint completion scope validation', () => {
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
      {
        task: 't',
        plan_steps: [
          {
            text: 'only step',
            label: 's1',
            acceptance_criteria: [{ text: 'the step is delivered' }],
          },
        ],
        touched_scope: [],
      },
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
          { text: 's1', label: 's1', acceptance_criteria: [{ text: 'the step is delivered' }] },
          { text: 's2', label: 's2', acceptance_criteria: [{ text: 'the step is delivered' }] },
          { text: 's3', label: 's3', acceptance_criteria: [{ text: 'the step is delivered' }] },
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
      {
        task: 't',
        plan_steps: [
          { text: 's1', label: 's1', acceptance_criteria: [{ text: 'the step is delivered' }] },
        ],
        touched_scope: [],
      },
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
});
