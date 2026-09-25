import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * CLI contract: `capture plan revise --json` surfaces `criterion_lineage`
 * on the created result, plus a `warnings` array of possible omitted-criterion_id
 * rewords (per-step drop+mint), each carrying the actionable minted
 * {criterion_id, text}. A clean omit-identical carry surfaces the lineage but
 * emits no warning.
 */
describe('capture plan revise: criterion_lineage + reword warnings', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  interface Criterion {
    criterion_id: string;
    text: string;
  }
  interface PlanOut {
    artifact_id: string;
    plan_steps: Array<{ step_id: string; acceptance_criteria: Criterion[] }>;
  }
  interface ReviseOut {
    criterion_lineage?: {
      added: string[];
      carried: string[];
      removed: Array<{ criterion_id: string; prior_step_id: string; text: string }>;
      rewritten: unknown[];
    };
    warnings?: Array<{
      step_id: string;
      label: string;
      removed_texts: string[];
      minted: Criterion[];
    }>;
    criterion_move_warnings?: Array<{
      kind: string;
      source_step_id: string;
      destination_step_id: string;
      text: string;
      minted_criterion_id: string;
      message: string;
    }>;
  }

  async function capturePlan(): Promise<PlanOut> {
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'deliver the slice',
          label: 'initial label',
          plan_steps: [
            {
              text: 'step a',
              label: 'step-a',
              acceptance_criteria: [{ text: 'suite has >= 42 tests' }],
            },
          ],
        })
      ),
    ]);
    expect(res.exitCode).toBe(0);
    return JSON.parse(res.stdout) as PlanOut;
  }

  async function revise(
    stepId: string,
    criterionText: string,
    artifactId: string,
    stepText: string
  ) {
    const res = await agent.runRaw([
      'capture',
      'plan',
      'revise',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: artifactId,
          label: 'revised label',
          rationale: 'rewrite step text, re-state the criterion',
          prior_plan_event_id: null,
          plan_steps: [
            {
              step_id: stepId,
              text: stepText,
              label: 'step-a',
              acceptance_criteria: [{ text: criterionText }],
            },
          ],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);
    expect(res.exitCode).toBe(0);
    return JSON.parse(res.stdout) as ReviseOut;
  }

  it('omit-identical revise surfaces criterion_lineage (carried) and emits NO warning', async () => {
    const plan = await capturePlan();
    const step = plan.plan_steps[0];
    const critId = step.acceptance_criteria[0].criterion_id;

    // Rewrite the step text but re-state the criterion verbatim with its id omitted.
    const out = await revise(
      step.step_id,
      'suite has >= 42 tests',
      plan.artifact_id,
      'step a (rev)'
    );

    expect(out.criterion_lineage).toBeDefined();
    expect(out.criterion_lineage?.carried).toEqual([critId]);
    expect(out.criterion_lineage?.added).toEqual([]);
    expect(out.criterion_lineage?.removed).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  it('omit-reworded revise emits a warnings entry with the actionable minted {criterion_id, text}', async () => {
    const plan = await capturePlan();
    const step = plan.plan_steps[0];

    // Reword the criterion in place with its id omitted → mints + drops the prior.
    const out = await revise(
      step.step_id,
      'suite has a couple smoke tests',
      plan.artifact_id,
      'step a'
    );

    expect(out.criterion_lineage?.removed).toHaveLength(1);
    expect(out.criterion_lineage?.added).toHaveLength(1);
    const mintedId = out.criterion_lineage!.added[0];

    expect(out.warnings).toHaveLength(1);
    expect(out.warnings?.[0]).toEqual({
      step_id: step.step_id,
      label: 'step-a',
      removed_texts: ['suite has >= 42 tests'],
      minted: [{ criterion_id: mintedId, text: 'suite has a couple smoke tests' }],
    });
  });

  it('cross-step identical-text move emits its advisory on the created path', async () => {
    // Two-step plan; the criterion starts on step a.
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'demo',
          label: 'two step move demo',
          touched_scope: [],
          non_goals: [],
          plan_steps: [
            {
              text: 'step a',
              label: 'step-a',
              acceptance_criteria: [
                { text: 'moved criterion text' },
                { text: 'step a keeps this one' },
              ],
            },
            {
              text: 'step b',
              label: 'step-b',
              acceptance_criteria: [{ text: 'the step is delivered' }],
            },
          ],
        })
      ),
    ]);
    expect(res.exitCode).toBe(0);
    const plan = JSON.parse(res.stdout) as PlanOut;
    const [stepA, stepB] = plan.plan_steps;

    const rev = await agent.runRaw([
      'capture',
      'plan',
      'revise',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: plan.artifact_id,
          label: 'moved the criterion',
          rationale: 'moving the rubric item to the step that owns it',
          prior_plan_event_id: null,
          plan_steps: [
            {
              step_id: stepA.step_id,
              text: 'step a',
              label: 'step-a',
              acceptance_criteria: [{ text: 'step a keeps this one' }],
            },
            {
              step_id: stepB.step_id,
              text: 'step b',
              label: 'step-b',
              acceptance_criteria: [{ text: 'moved criterion text' }],
            },
          ],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);
    expect(rev.exitCode).toBe(0);
    const out = JSON.parse(rev.stdout) as ReviseOut;
    expect(out.criterion_move_warnings).toHaveLength(1);
    const w = out.criterion_move_warnings![0];
    expect(w.kind).toBe('cross-step-criterion-move');
    expect(w.source_step_id).toBe(stepA.step_id);
    expect(w.destination_step_id).toBe(stepB.step_id);
    expect(w.text).toBe('moved criterion text');
    expect(w.minted_criterion_id).toBe(out.criterion_lineage!.added[0]);
    expect(w.message).toMatch(/cross-step criterion_id reuse is forbidden/);
  });

  it('explicit-id carry of the same text on another step suppresses the advisory', async () => {
    // Step a and step c both start with the same boilerplate text; the
    // revise moves a's occurrence to b while c RE-SUPPLIES its criterion_id
    // explicitly (which never lands in criterion_lineage.carried). Guard 3
    // must still see c's occurrence and stay quiet.
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'demo',
          label: 'boilerplate move demo',
          touched_scope: [],
          non_goals: [],
          plan_steps: [
            {
              text: 'step a',
              label: 'step-a',
              acceptance_criteria: [
                { text: 'shared boilerplate' },
                { text: 'step a keeps this one' },
              ],
            },
            {
              text: 'step b',
              label: 'step-b',
              acceptance_criteria: [{ text: 'the step is delivered' }],
            },
            {
              text: 'step c',
              label: 'step-c',
              acceptance_criteria: [{ text: 'shared boilerplate' }],
            },
          ],
        })
      ),
    ]);
    expect(res.exitCode).toBe(0);
    const plan = JSON.parse(res.stdout) as PlanOut;
    const [stepA, stepB, stepC] = plan.plan_steps;
    const cCritId = stepC.acceptance_criteria[0].criterion_id;

    const rev = await agent.runRaw([
      'capture',
      'plan',
      'revise',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: plan.artifact_id,
          label: 'moved one boilerplate occurrence',
          rationale: 'move the rubric item while c keeps its own copy explicitly',
          prior_plan_event_id: null,
          plan_steps: [
            {
              step_id: stepA.step_id,
              text: 'step a',
              label: 'step-a',
              acceptance_criteria: [{ text: 'step a keeps this one' }],
            },
            {
              step_id: stepB.step_id,
              text: 'step b',
              label: 'step-b',
              acceptance_criteria: [{ text: 'shared boilerplate' }],
            },
            {
              step_id: stepC.step_id,
              text: 'step c',
              label: 'step-c',
              acceptance_criteria: [{ criterion_id: cCritId, text: 'shared boilerplate' }],
            },
          ],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);
    expect(rev.exitCode).toBe(0);
    const out = JSON.parse(rev.stdout) as ReviseOut;
    expect(out.criterion_move_warnings).toEqual([]);
  });
});

describe('capture plan revise: revision-rationale-required block', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true });
    const added = await agent.runRaw([
      'eval',
      'add-pack',
      '@orcaops/evaluator-pack',
      'core',
      '--yes',
      '--json',
    ]);
    expect(added.exitCode).toBe(0);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  interface RationalePlan {
    artifact_id: string;
    plan_steps: Array<{ step_id: string }>;
  }

  async function capturePlan(): Promise<RationalePlan> {
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'deliver the slice with tests',
          label: 'deliver the slice',
          plan_steps: [
            {
              text: 'step a with tests',
              label: 'step-a',
              acceptance_criteria: [{ text: 'the step a tests pass' }],
            },
          ],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);
    expect(res.exitCode).toBe(0);
    return JSON.parse(res.stdout) as RationalePlan;
  }

  async function revisePlan(
    plan: RationalePlan,
    rationale: string
  ): Promise<{ ok: boolean; revision_n: number; blocking: boolean }> {
    const res = await agent.runRaw([
      'capture',
      'plan',
      'revise',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: plan.artifact_id,
          label: 'deliver the slice',
          rationale,
          prior_plan_event_id: null,
          plan_steps: [
            {
              step_id: plan.plan_steps[0]!.step_id,
              text: 'step a with tests',
              label: 'step-a',
              acceptance_criteria: [{ text: 'the step a tests pass' }],
            },
          ],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);
    expect(res.exitCode, res.stdout + res.stderr).toBe(0);
    return JSON.parse(res.stdout) as { ok: boolean; revision_n: number; blocking: boolean };
  }

  it('commits a short-rationale revision and leaves a blocking violation, as the evaluator text says', async () => {
    const planned = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'deliver the slice with tests',
          label: 'deliver the slice',
          plan_steps: [
            {
              text: 'step a with tests',
              label: 'step-a',
              acceptance_criteria: [{ text: 'the step a tests pass' }],
            },
          ],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);
    expect(planned.exitCode).toBe(0);
    const plan = JSON.parse(planned.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };

    const revised = await agent.runRaw([
      'capture',
      'plan',
      'revise',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: plan.artifact_id,
          label: 'deliver the slice',
          rationale: 'x',
          prior_plan_event_id: null,
          plan_steps: [
            {
              step_id: plan.plan_steps[0]!.step_id,
              text: 'step a with tests',
              label: 'step-a',
              acceptance_criteria: [{ text: 'the step a tests pass' }],
            },
          ],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);
    expect(revised.exitCode).toBe(0);
    const out = JSON.parse(revised.stdout) as {
      ok: boolean;
      revision_n: number;
      capture_status: string;
      blocking: boolean;
      evaluator_results: Array<{ evaluator_ref: string; verdict: string | null }>;
    };
    expect(out).toMatchObject({
      ok: true,
      revision_n: 1,
      capture_status: 'committed',
      blocking: true,
    });
    expect(out.evaluator_results).toContainEqual(
      expect.objectContaining({
        evaluator_ref: 'core/revision-rationale-required',
        verdict: 'violation',
      })
    );

    const shown = await agent.runRaw([
      'eval',
      'show',
      'core/revision-rationale-required',
      '--json',
    ]);
    expect(shown.exitCode).toBe(0);
    const { evaluator } = JSON.parse(shown.stdout) as {
      evaluator: { description: string; on_block_message: string };
    };
    expect(evaluator.description).not.toContain('fails the revise call');
    expect(evaluator.description).toContain('the revision is still recorded');
    expect(evaluator.on_block_message).toContain('The revision was committed');
    expect(evaluator.on_block_message).toContain('orcaops block dismiss');
    expect(evaluator.on_block_message).not.toContain('block acknowledge');
  });

  it('clears the rationale block when a later revision states a full rationale', async () => {
    const plan = await capturePlan();
    expect((await revisePlan(plan, 'x')).blocking).toBe(true);

    const fuller = await revisePlan(plan, 'narrowed step a to the tested path after review');
    expect(fuller).toMatchObject({ ok: true, revision_n: 2, blocking: false });
  });

  it('resolves the rationale block with block dismiss, as the block message says', async () => {
    const plan = await capturePlan();
    expect((await revisePlan(plan, 'x')).blocking).toBe(true);

    const acknowledged = await agent.runRaw([
      'block',
      'acknowledge',
      '--artifact',
      plan.artifact_id,
      '--evaluator',
      'core/revision-rationale-required',
      '--reason',
      'accepted',
    ]);
    expect(acknowledged.exitCode).toBe(1);
    expect((JSON.parse(acknowledged.stdout) as { error: { code: string } }).error.code).toBe(
      'BLOCK_NOT_ACKNOWLEDGEABLE'
    );

    const dismissed = await agent.runRaw([
      'block',
      'dismiss',
      '--artifact',
      plan.artifact_id,
      '--evaluator',
      'core/revision-rationale-required',
      '--reason',
      'rationale recorded elsewhere',
    ]);
    expect(dismissed.exitCode, dismissed.stdout + dismissed.stderr).toBe(0);
    expect(JSON.parse(dismissed.stdout)).toMatchObject({ ok: true, action: 'dismissed' });
  });
});
