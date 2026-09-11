import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { inputFile } from '@orcaops/test-harness';

import { fixture, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';
import { plantAcknowledge, plantBlockViolation } from '../support/test-helpers.js';

interface ErrEnvelope {
  ok: false;
  error: { code: string; message: string };
}

describe('blocked summary refusal', { timeout: 60_000 }, () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    f = await fixture();
    agent = makeAgent({
      cwd: f.main,
      env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
    });
  });

  async function capturePlan(): Promise<{
    artifact_id: string;
    plan_steps: Array<{ step_id: string }>;
  }> {
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    expect(planRes.exitCode, planRes.stdout + planRes.stderr).toBe(0);
    return JSON.parse(planRes.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
  }

  it('captureSummary rejects with BLOCKED when an unresolved block-severity violation exists', async () => {
    const plan = await capturePlan();
    await plantBlockViolation({
      fixture: f,
      artifactId: plan.artifact_id,
      evaluatorRef: 'test-pack/api-stub',
    });

    const before = await inventory(f.temporary);
    const sumRes = await agent.runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(JSON.stringify({ artifact_id: plan.artifact_id, outcome: 'shipped' })),
    ]);
    expect(sumRes.exitCode).toBe(1);
    expect(await inventory(f.temporary)).toEqual(before);
    const env = JSON.parse(sumRes.stdout) as ErrEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('BLOCKED');
    expect(env.error.message).toContain('test-pack/api-stub');
    expect(env.error.message).toMatch(/orcaops block (acknowledge|dismiss)/);
  });

  it('captureSummary succeeds again after the block is cleared (acknowledge re-runs the gate)', async () => {
    const plan = await capturePlan();
    const runId = await plantBlockViolation({
      fixture: f,
      artifactId: plan.artifact_id,
      evaluatorRef: 'test-pack/api-stub',
    });
    const blocked = await agent.runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(JSON.stringify({ artifact_id: plan.artifact_id, outcome: 'shipped' })),
    ]);
    expect(blocked.exitCode).toBe(1);
    await plantAcknowledge({
      fixture: f,
      runId,
      artifactId: plan.artifact_id,
      evaluatorRef: 'test-pack/api-stub',
    });
    const ok = await agent.runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(JSON.stringify({ artifact_id: plan.artifact_id, outcome: 'shipped' })),
    ]);
    expect(ok.exitCode).toBe(0);
    const env = JSON.parse(ok.stdout) as { ok: boolean; artifact_id: string };
    expect(env.ok).toBe(true);
    expect(env.artifact_id).toBe(plan.artifact_id);
  });

  it('checkpoint capture is allowed during blocked (remediation work)', async () => {
    const plan = await capturePlan();
    await plantBlockViolation({
      fixture: f,
      artifactId: plan.artifact_id,
      evaluatorRef: 'test-pack/api-stub',
    });
    await writeFile(path.join(f.main, 'fix.ts'), 'fix\n', 'utf8');
    const { gitClient } = await import('@orcaops/test-harness');
    const git = gitClient(f.main);
    await git.add('fix.ts');
    await git.commit('remediation');
    const headSha = (await git.revparse(['HEAD'])).trim();

    const cpOpenRes = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: plan.artifact_id,
          declared_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);
    expect(cpOpenRes.exitCode).toBe(0);
    const cpRes = await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: plan.artifact_id,
          n: 1,
          summary: 'remediation work',
          files_changed: ['fix.ts'],
          head_sha: headSha,
        })
      ),
    ]);
    expect(cpRes.exitCode).toBe(0);
    const env = JSON.parse(cpRes.stdout) as { ok: boolean };
    expect(env.ok).toBe(true);
  });
});
