import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { inputFile } from '@orcaops/test-harness';

import { fixture } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

interface FinishResult {
  finalization_status?: string;
  digest?: { status?: string; markdown?: string };
}

function agent(f: Fixture) {
  return makeAgent({
    cwd: f.main,
    timeoutMs: 120_000,
    env: { ORCAOPS_ROOT: f.main, ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
}

async function run(
  f: Fixture,
  verb: string[],
  body: Record<string, unknown>,
  flags = ['--no-llm']
) {
  const raw = await agent(f).runRaw([
    'capture',
    ...verb,
    ...flags,
    '--input',
    inputFile(JSON.stringify(body)),
  ]);
  return { raw, result: JSON.parse(raw.stdout) as Record<string, unknown> };
}

async function finish(f: Fixture, artifactId: string, outcome: string) {
  const raw = await agent(f).runRaw([
    'finish',
    '--no-llm',
    '--input',
    inputFile(
      JSON.stringify({
        idempotency_key: `summary-${randomUUID()}`,
        artifact_id: artifactId,
        outcome,
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
      })
    ),
  ]);
  return { raw, result: JSON.parse(raw.stdout) as FinishResult };
}

describe('acceptance-criteria workflow', { timeout: 240_000 }, () => {
  it('refuses a pinned multi-step plan whose steps declare no criteria', async () => {
    const f = await fixture();
    const sourcePath = path.join(f.temporary, 'slice-plan.md');
    await writeFile(sourcePath, '# Slice\n\nThe reader must reject an expired pin.\n');

    const raw = await agent(f).runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      sourcePath,
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'ship the reader',
          label: 'Ship the reader',
          plan_steps: [
            { text: 'Build the reader', label: 'Reader' },
            { text: 'Wire the cache', label: 'Cache' },
          ],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);
    expect(raw.exitCode).toBe(1);
    const err = JSON.parse(raw.stdout) as {
      ok: boolean;
      error: { code: string; path?: string; message: string };
    };
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe('PLAN_ACCEPTANCE_CRITERIA_REQUIRED');
    expect(err.error.path).toBe('plan_steps');
    expect(err.error.message).toContain('#1 "Reader"');
    expect(err.error.message).toContain('#2 "Cache"');
    expect(err.error.message).toContain('acceptance_criteria:');
    expect(err.error.message).toContain('orcaops update');
    // Pinning a source plan does not excuse the rubric.
    expect(err.error.message).not.toMatch(/source[- ]plan/i);
  });

  it('keeps the rubric through revision, resume, close evidence, and finish', async () => {
    const f = await fixture();
    const captured = await run(f, ['plan'], {
      idempotency_key: `plan-${randomUUID()}`,
      task: 'deliver the slice',
      label: 'Deliver the slice',
      plan_steps: [
        {
          text: 'Build the reader',
          label: 'Reader',
          acceptance_criteria: [{ text: 'the reader rejects an expired pin' }],
        },
      ],
      touched_scope: [],
      non_goals: [],
    });
    expect(captured.raw.exitCode, captured.raw.stdout + captured.raw.stderr).toBe(0);
    const artifactId = captured.result.artifact_id as string;
    const steps = captured.result.plan_steps as Array<{
      step_id: string;
      acceptance_criteria: Array<{ criterion_id: string }>;
    }>;
    const stepId = steps[0]!.step_id;
    const criterionId = steps[0]!.acceptance_criteria[0]!.criterion_id;

    const stripped = await run(f, ['plan', 'revise'], {
      idempotency_key: `revise-${randomUUID()}`,
      artifact_id: artifactId,
      label: 'Strip the rubric',
      rationale: 'attempt to drop the only criterion',
      prior_plan_event_id: null,
      plan_steps: [{ step_id: stepId, text: 'Build the reader', label: 'Reader' }],
      touched_scope: [],
      non_goals: [],
    });
    expect(stripped.raw.exitCode).toBe(1);
    expect(stripped.result).toMatchObject({
      ok: false,
      error: { code: 'PLAN_ACCEPTANCE_CRITERIA_REQUIRED' },
    });

    const revised = await run(f, ['plan', 'revise'], {
      idempotency_key: `revise-${randomUUID()}`,
      artifact_id: artifactId,
      label: 'Retain the rubric',
      rationale: 'carry the acceptance obligation through the revision',
      prior_plan_event_id: captured.result.plan_event_id,
      plan_steps: [
        {
          step_id: stepId,
          text: 'Build the reader',
          label: 'Reader',
          acceptance_criteria: [
            { criterion_id: criterionId, text: 'the reader rejects an expired pin' },
          ],
        },
      ],
      touched_scope: [],
      non_goals: [],
    });
    expect(revised.raw.exitCode, revised.raw.stdout + revised.raw.stderr).toBe(0);
    expect(revised.result.acceptance_criteria_coverage).toMatchObject({
      revision_n: 1,
      total: 1,
      covered: 1,
      missing: 0,
    });

    const resumedRaw = await agent(f).runRaw(['resume', '--artifact', artifactId, '--json']);
    expect(resumedRaw.exitCode, resumedRaw.stdout + resumedRaw.stderr).toBe(0);
    const resumed = JSON.parse(resumedRaw.stdout) as {
      artifact: {
        acceptance_criteria_coverage: Record<string, unknown>;
        acceptance_criteria_status: string;
        agent_prompt: string;
      };
    };
    expect(resumed.artifact.acceptance_criteria_coverage).toMatchObject({
      revision_n: 1,
      total: 1,
      covered: 1,
      missing: 0,
    });
    expect(resumed.artifact.acceptance_criteria_status).toBe(
      'Recorded acceptance criteria: 1 of 1 steps (revision 1).'
    );
    expect(resumed.artifact.agent_prompt).toContain('Continue work on: deliver the slice');

    const opened = await run(f, ['checkpoint', 'open'], {
      idempotency_key: `open-${randomUUID()}`,
      artifact_id: artifactId,
      declared_step_ids: [stepId],
      plan_revision_id: revised.result.plan_event_id,
    });
    expect(opened.raw.exitCode, opened.raw.stdout + opened.raw.stderr).toBe(0);

    const bare = await run(f, ['checkpoint', 'close'], {
      idempotency_key: `close-${randomUUID()}`,
      artifact_id: artifactId,
      n: opened.result.n,
      summary: 'claim without evidence',
      files_changed: [],
      decisions: [],
      uncertainty: [],
      done_criteria: [],
      verification: [{ command: 'test fixture', exit_code: 0 }],
      completed_step_ids: [stepId],
    });
    expect(bare.raw.exitCode).toBe(1);
    expect(bare.result).toMatchObject({ ok: false, error: { path: 'done_criteria' } });

    const closed = await run(f, ['checkpoint', 'close'], {
      idempotency_key: `close-${randomUUID()}`,
      artifact_id: artifactId,
      n: opened.result.n,
      summary: 'claim with evidence',
      files_changed: [],
      decisions: [],
      uncertainty: [],
      done_criteria: [{ criterion_id: criterionId, evidence: 'expired-pin test added' }],
      verification: [{ command: 'test fixture', exit_code: 0 }],
      completed_step_ids: [stepId],
    });
    expect(closed.raw.exitCode, closed.raw.stdout + closed.raw.stderr).toBe(0);
    expect(closed.result.acceptance_criteria_coverage).toMatchObject({
      total: 1,
      covered: 1,
      missing: 0,
    });

    const finished = await finish(f, artifactId, 'reader delivered');
    expect(finished.raw.exitCode, finished.raw.stdout + finished.raw.stderr).toBe(0);
    expect(finished.result).toMatchObject({
      finalization_status: 'finalized',
      digest: { status: 'current' },
    });
    expect(finished.result.digest?.markdown).toContain(
      'Recorded acceptance criteria: 1 of 1 steps (revision 1).'
    );
    expect(finished.result.digest?.markdown).not.toContain(
      'criterion-level completion is unverified'
    );
  });

  it('finalizes a retained rubric-free artifact with its missing criteria stated', async () => {
    const f = await fixture();
    // Seeded through the history path, as a pre-contract artifact would be.
    const bareStepId = uuidv7();
    const artifactId = await f.capture(undefined, {
      steps: [
        {
          step_id: bareStepId,
          text: 'Retain rubric-free history',
          label: 'Rubric-free history',
          acceptance_criteria: [],
        },
      ],
    });

    const finished = await finish(f, artifactId, 'historical work finalized');
    expect(finished.raw.exitCode, finished.raw.stdout + finished.raw.stderr).toBe(0);
    const markdown = finished.result.digest?.markdown ?? finished.raw.stdout;
    expect(markdown).toContain('acceptance criteria');
    expect(markdown).toContain('0 of 1 steps');
    expect(markdown).toContain('criterion-level completion is unverified');
    expect(markdown).not.toContain('delivery coverage UNVERIFIED');
    expect(markdown).not.toMatch(/exempt|approved exemption/i);
  });
});
