import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { inputFile } from '@orcaops/test-harness';

import { fixture } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

/**
 * Ported by meaning from tests/integration/plan-revise-criterion.test.ts, which
 * proved the criterion lineage contract of `capture plan revise` against file
 * authority: an omitted criterion whose text is unchanged auto-carries its id and
 * warns about nothing, a reworded one drops and mints with an actionable warning,
 * and an identical text that appears on a different step raises the cross-step
 * move advisory because criterion ids may never be reused across steps.
 */
type Fixture = Awaited<ReturnType<typeof fixture>>;
function agent(f: Fixture) {
  return makeAgent({
    cwd: f.main,
    env: {
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: 'criteria-session',
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
  expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
  return JSON.parse(raw.stdout);
}
const CRITERION = 'suite has at least 42 tests';
function plan(f: Fixture, steps: Record<string, unknown>[]) {
  return capture(f, ['plan'], {
    idempotency_key: `plan-${randomUUID()}`,
    task: 'Deliver the slice',
    label: 'Criterion lineage subject',
    plan_steps: steps,
    touched_scope: [],
    non_goals: [],
  });
}
function revise(f: Fixture, artifactId: string, steps: Record<string, unknown>[]) {
  return capture(f, ['plan', 'revise'], {
    idempotency_key: `revise-${randomUUID()}`,
    artifact_id: artifactId,
    label: 'Revised criteria',
    rationale: 'Restate the rubric under the switched command',
    prior_plan_event_id: null,
    plan_steps: steps,
    touched_scope: [],
    non_goals: [],
  });
}

describe('registered database plan revise criteria', { timeout: 120_000 }, () => {
  it('auto-carries an unchanged criterion and warns only when its text was reworded', async () => {
    const f = await fixture();
    const captured = await plan(f, [
      { text: 'step a', label: 'step-a', acceptance_criteria: [{ text: CRITERION }] },
    ]);
    const step = captured.plan_steps[0];
    const criterionId = step.acceptance_criteria[0].criterion_id;
    const carried = await revise(f, captured.artifact_id, [
      {
        step_id: step.step_id,
        text: 'step a (rewritten)',
        label: 'step-a',
        acceptance_criteria: [{ text: CRITERION }],
      },
    ]);
    expect(carried.criterion_lineage).toMatchObject({
      carried: [criterionId],
      added: [],
      removed: [],
    });
    expect(carried.warnings).toEqual([]);

    const reworded = await revise(f, captured.artifact_id, [
      {
        step_id: step.step_id,
        text: 'step a (rewritten)',
        label: 'step-a',
        acceptance_criteria: [{ text: 'suite has a couple of smoke tests' }],
      },
    ]);
    expect(reworded.criterion_lineage.removed).toHaveLength(1);
    expect(reworded.criterion_lineage.added).toHaveLength(1);
    expect(reworded.warnings).toEqual([
      {
        step_id: step.step_id,
        label: 'step-a',
        removed_texts: [CRITERION],
        minted: [
          {
            criterion_id: reworded.criterion_lineage.added[0],
            text: 'suite has a couple of smoke tests',
          },
        ],
      },
    ]);
  });

  it('raises the cross-step move advisory when the same text reappears on another step', async () => {
    const f = await fixture();
    const captured = await plan(f, [
      { text: 'step a', label: 'step-a', acceptance_criteria: [{ text: 'moved criterion text' }] },
      { text: 'step b', label: 'step-b' },
    ]);
    const [stepA, stepB] = captured.plan_steps;
    const moved = await revise(f, captured.artifact_id, [
      { step_id: stepA.step_id, text: 'step a', label: 'step-a' },
      {
        step_id: stepB.step_id,
        text: 'step b',
        label: 'step-b',
        acceptance_criteria: [{ text: 'moved criterion text' }],
      },
    ]);
    expect(moved.criterion_move_warnings).toHaveLength(1);
    expect(moved.criterion_move_warnings[0]).toMatchObject({
      kind: 'cross-step-criterion-move',
      source_step_id: stepA.step_id,
      destination_step_id: stepB.step_id,
      text: 'moved criterion text',
      minted_criterion_id: moved.criterion_lineage.added[0],
    });
    expect(moved.criterion_move_warnings[0].message).toMatch(
      /cross-step criterion_id reuse is forbidden/
    );
  });
});
