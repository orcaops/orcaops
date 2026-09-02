import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * An artifact captured by the current writer — plan, revision, checkpoint,
 * summary — survives a strict rebuild with zero skipped artifacts and an
 * identical reviewer-facing view.
 */
describe('current writer through a strict rebuild', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.init({ noLlm: true });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('a full capture lifecycle rebuilds with zero skips and identical output', async () => {
    const plan = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'survive a strict rebuild end to end',
          label: 'strict rebuild survival fixture',
          plan_steps: [{ text: 'do the work', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    expect(plan.exitCode).toBe(0);
    const artifactId = (JSON.parse(plan.stdout) as { artifact_id: string }).artifact_id;
    const shown = JSON.parse((await agent.runRaw(['show', artifactId, '--json'])).stdout) as {
      artifact: { plan: { plan_steps: Array<{ step_id: string }> } };
    };
    const stepId = shown.artifact.plan.plan_steps[0].step_id;
    const revise = await agent.runRaw([
      'capture',
      'plan',
      'revise',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: artifactId,
          label: 'strict rebuild survival fixture (revised)',
          rationale: 'prove revisions survive the strict rebuild',
          prior_plan_event_id: null,
          plan_steps: [
            { step_id: stepId, text: 'do the work', label: 's1' },
            { text: 'verify the work', label: 's2' },
          ],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);
    expect(revise.exitCode).toBe(0);
    const open = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ artifact_id: artifactId, declared_step_ids: [stepId] })),
    ]);
    expect(open.exitCode).toBe(0);
    const close = await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: artifactId,
          n: 1,
          summary: 'did the work',
          files_changed: [],
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [stepId],
        })
      ),
    ]);
    expect(close.exitCode).toBe(0);
    const summary = await agent.runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: artifactId,
          outcome: 'work done and verified',
        })
      ),
    ]);
    expect(summary.exitCode).toBe(0);
    const digestBefore = await agent.runRaw(['digest', '--artifact', artifactId]);
    expect(digestBefore.exitCode).toBe(0);

    const listBefore = (await agent.runRaw(['list', '--json'])).stdout;
    const showBefore = (await agent.runRaw(['show', artifactId, '--json'])).stdout;

    const rebuild = await agent.runRaw(['rebuild', '--json']);
    expect(rebuild.exitCode).toBe(0);
    const env = JSON.parse(rebuild.stdout) as { skipped_artifacts: number };
    expect(env.skipped_artifacts).toBe(0);

    expect((await agent.runRaw(['list', '--json'])).stdout).toBe(listBefore);
    expect((await agent.runRaw(['show', artifactId, '--json'])).stdout).toBe(showBefore);
    const digestAfter = await agent.runRaw(['digest', '--artifact', artifactId]);
    expect(digestAfter.exitCode).toBe(0);
    expect(digestAfter.stdout).toBe(digestBefore.stdout);
  });
});
