import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { commitFile } from '../support/test-helpers.js';

/**
 * `orcaops step brief` end to end: claim states + criterion-keyed
 * evidence + the dropped-step historical resolution. Pure assembly is
 * unit-tested in `commands/step.test.ts`.
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface BriefOk {
  ok: true;
  artifact_id: string;
  step: {
    step_id: string;
    label: string;
    acceptance_criteria: Array<{ criterion_id: string; text: string }>;
    dropped_in_latest_revision: boolean;
    last_present_revision_n: number;
  };
  claim_state: { state: string; checkpoint_n?: number };
  related_closed_checkpoints: Array<{
    n: number;
    done_criteria: Array<{ criterion_id: string; evidence: string }>;
  }>;
  guardrails: { non_goals: unknown[]; touched_scope: string[] };
  siblings: Array<{ step_id: string; claim_state: { state: string } }>;
  note?: string;
}

function parseOk(r: CliResult): BriefOk {
  expect(r.exitCode).toBe(0);
  const parsed = JSON.parse(r.stdout) as BriefOk;
  expect(parsed.ok).toBe(true);
  return parsed;
}

describe('orcaops step brief', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let artifactId: string;
  let stepIds: string[];
  let criterionId: string;
  let planEventId: string | null;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.runRaw(['init', '--json', '--no-llm']);

    const planR = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'step brief fixture',
          label: 'step-brief-fixture',
          plan_steps: [
            {
              text: 'implement middleware',
              label: 'Implement middleware',
              acceptance_criteria: [{ text: 'limit-exceeded path tested' }],
            },
            { text: 'write docs', label: 'Write docs' },
          ],
          touched_scope: ['payments'],
          non_goals: [{ text: 'no auth changes', rationale: 'separate slice' }],
        })
      ),
    ]);
    const plan = JSON.parse(planR.stdout) as {
      artifact_id: string;
      plan_event_id?: string;
      plan_steps: Array<{
        step_id: string;
        acceptance_criteria: Array<{ criterion_id: string }>;
      }>;
    };
    artifactId = plan.artifact_id;
    stepIds = plan.plan_steps.map((s) => s.step_id);
    criterionId = plan.plan_steps[0].acceptance_criteria[0].criterion_id;
    planEventId = plan.plan_event_id ?? null;

    await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `open-${randomUUID()}`,
          artifact_id: artifactId,
          declared_step_ids: [stepIds[0]],
        })
      ),
    ]);
    await commitFile(repo.path, 'src/mw.ts', 'export const mw = 1;\n', 'mw');
    await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `close-${randomUUID()}`,
          artifact_id: artifactId,
          n: 1,
          summary: 'middleware wired',
          files_changed: ['src/mw.ts'],
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [stepIds[0]],
          done_criteria: [{ criterion_id: criterionId, evidence: 'limit test green' }],
        })
      ),
    ]);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  function brief(stepId: string, ...flags: string[]): Promise<CliResult> {
    return agent.runRaw(['step', 'brief', stepId, '--json', ...flags]);
  }

  it('claimed step: claim state, criterion-keyed evidence, guardrails, sibling states', async () => {
    const out = parseOk(await brief(stepIds[0]));

    expect(out.artifact_id).toBe(artifactId);
    expect(out.step.label).toBe('Implement middleware');
    expect(out.step.dropped_in_latest_revision).toBe(false);
    expect(out.claim_state).toEqual({ state: 'claimed', checkpoint_n: 1 });
    expect(out.related_closed_checkpoints).toHaveLength(1);
    expect(out.related_closed_checkpoints[0].done_criteria).toEqual([
      { criterion_id: criterionId, evidence: 'limit test green' },
    ]);
    expect(out.guardrails.touched_scope).toEqual(['payments']);
    expect(out.guardrails.non_goals).toHaveLength(1);
    expect(out.siblings).toHaveLength(1);
    expect(out.siblings[0].claim_state.state).toBe('unclaimed');
    expect(out.note).toBeUndefined();
  });

  it('a step dropped by a revision renders from its last-present revision, non-dispatchable', async () => {
    const r = await agent.runRaw([
      'capture',
      'plan',
      'revise',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `revise-${randomUUID()}`,
          artifact_id: artifactId,
          label: 'step-brief-fixture (docs cut)',
          rationale: 'docs moved to a separate artifact',
          prior_plan_event_id: planEventId,
          plan_steps: [
            {
              step_id: stepIds[0],
              text: 'implement middleware',
              label: 'Implement middleware',
              acceptance_criteria: [
                { criterion_id: criterionId, text: 'limit-exceeded path tested' },
              ],
            },
          ],
          touched_scope: ['payments'],
          non_goals: [{ text: 'no auth changes', rationale: 'separate slice' }],
        })
      ),
    ]);
    expect(r.exitCode).toBe(0);

    const out = parseOk(await brief(stepIds[1]));
    expect(out.step.dropped_in_latest_revision).toBe(true);
    expect(out.step.last_present_revision_n).toBe(0);
    expect(out.step.label).toBe('Write docs');
    expect(out.claim_state).toEqual({ state: 'not_claimable_dropped' });
    expect(out.note).toMatch(/informational-only/);
    // Siblings reflect the LATEST revision (only the middleware step).
    expect(out.siblings.map((s) => s.step_id)).toEqual([stepIds[0]]);
  });

  it('unknown step_id → INVALID_INPUT; wrong --artifact → INVALID_INPUT', async () => {
    const unknown = await brief('01890000-0000-7000-8000-000000000000');
    expect(unknown.exitCode).toBe(1);
    expect((JSON.parse(unknown.stdout) as { error: { code: string } }).error.code).toBe(
      'INVALID_INPUT'
    );

    const wrongArtifact = await brief(
      stepIds[0],
      '--artifact',
      '01890000-0000-7000-8000-000000000000'
    );
    expect(wrongArtifact.exitCode).toBe(1);
    expect((JSON.parse(wrongArtifact.stdout) as { error: { code: string } }).error.code).toBe(
      'INVALID_INPUT'
    );
  });
});
