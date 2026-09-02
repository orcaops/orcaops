import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { commitFile } from '../support/test-helpers.js';

describe('orcaops lineage', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('reports zero updated/skipped on a fresh repo with no artifacts', async () => {
    await agent.init({ noLlm: true });
    const res = await agent.runRaw(['lineage', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as { ok: boolean; updated: unknown[]; skipped: unknown[] };
    expect(r.ok).toBe(true);
    expect(r.updated).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it('skips an artifact whose latest_lineage_sha is already the branch HEAD', async () => {
    await agent.init({ noLlm: true });
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({ task: 'add rate limiting', plan_steps: [{ text: 's1', label: 's1' }] })
      ),
    ]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };

    const res = await agent.runRaw(['lineage', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as {
      updated: unknown[];
      skipped: Array<{ artifact_id: string; reason: string }>;
    };
    expect(r.updated).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).toMatchObject({
      artifact_id: plan.artifact_id,
      reason: 'already-current',
    });
  });

  it('appends a rebased lineage entry after the branch HEAD moves (simulated rebase)', async () => {
    await agent.init({ noLlm: true });
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 'extend api', plan_steps: [{ text: 's1', label: 's1' }] })),
    ]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };

    // Simulate a rebase by adding a new commit on the same branch.
    await commitFile(repo.path, 'extra.ts', 'export const x = 1;\n', 'extra commit');

    const res = await agent.runRaw(['lineage', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as {
      head_sha: string;
      updated: Array<{ artifact_id: string; prior_sha: string; new_sha: string }>;
      skipped: unknown[];
    };
    expect(r.updated).toHaveLength(1);
    expect(r.updated[0].artifact_id).toBe(plan.artifact_id);
    expect(r.updated[0].new_sha).toBe(r.head_sha);
    expect(r.updated[0].prior_sha).not.toBe(r.head_sha);
  });

  it('is idempotent: running sync twice on the same HEAD does nothing the second time', async () => {
    await agent.init({ noLlm: true });
    await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    await commitFile(repo.path, 'x.ts', 'x\n', 'extra');

    const first = JSON.parse((await agent.runRaw(['lineage', '--json'])).stdout) as {
      updated: unknown[];
      skipped: unknown[];
    };
    expect(first.updated).toHaveLength(1);

    const second = JSON.parse((await agent.runRaw(['lineage', '--json'])).stdout) as {
      updated: unknown[];
      skipped: unknown[];
    };
    expect(second.updated).toEqual([]);
    expect(second.skipped).toHaveLength(1);
  });

  it('only touches artifacts on the current branch (--branch override participates)', async () => {
    await agent.init({ noLlm: true });
    await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 'main work', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);

    const res = await agent.runRaw(['lineage', '--branch', 'never-existed', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as { updated: unknown[]; skipped: unknown[] };
    expect(r.updated).toEqual([]);
    expect(r.skipped).toEqual([]);
  });
});
