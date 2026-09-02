import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sourcePlanCacheDir, writePullCacheRecord } from '@orcaops/storage';
import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { cloudRecord } from '../support/source-plan-test-helpers.js';
import { makeAgent } from '../support/test-agent.js';
import { plantBlockViolation } from '../support/test-helpers.js';

describe('state surfacing in list / status / show', () => {
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

  it('list --json: a freshly-planned artifact reports state=planned', async () => {
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    const listRes = await agent.runRaw(['list', '--json']);
    const r = JSON.parse(listRes.stdout) as {
      artifacts: Array<{ id: string; state: string }>;
    };
    const found = r.artifacts.find((a) => a.id === plan.artifact_id);
    expect(found?.state).toBe('planned');
  });

  it('list --json: state moves to blocked when a block violation lands', async () => {
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    await plantBlockViolation({
      cwd: repo.path,
      artifactId: plan.artifact_id,
      evaluatorRef: 'test-pack/api-stub',
    });
    const listRes = await agent.runRaw(['list', '--json']);
    const r = JSON.parse(listRes.stdout) as {
      artifacts: Array<{ id: string; state: string }>;
    };
    expect(r.artifacts.find((a) => a.id === plan.artifact_id)?.state).toBe('blocked');
  });

  it('status --json: reports state per artifact', async () => {
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    const res = await agent.runRaw(['status', '--json']);
    const r = JSON.parse(res.stdout) as {
      artifacts: Array<{ id: string; state: string }>;
    };
    expect(r.artifacts.find((a) => a.id === plan.artifact_id)?.state).toBe('planned');
  });

  it('show --json: reports the derived state and no coarse status column', async () => {
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    const res = await agent.runRaw(['show', plan.artifact_id, '--json']);
    const r = JSON.parse(res.stdout) as {
      artifact: { id: string; state: string; status?: string };
    };
    expect(r.artifact.state).toBe('planned');
    // One public vocabulary: the coarse status column never leaves show.
    expect(r.artifact.status).toBeUndefined();
  });

  it('show --json: state=summarized after capture summary completes', async () => {
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    await agent.runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(JSON.stringify({ artifact_id: plan.artifact_id, outcome: 'shipped' })),
    ]);
    const res = await agent.runRaw(['show', plan.artifact_id, '--json']);
    const r = JSON.parse(res.stdout) as { artifact: { state: string } };
    expect(r.artifact.state).toBe('summarized');
  });

  it('list human format includes the STATE column', async () => {
    await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    const res = await agent.runRaw(['list']);
    expect(res.stdout).toMatch(/STATE/);
    expect(res.stdout).toMatch(/planned/);
  });

  it('status --json: surfaces a per-artifact source_plan, distinct from top-level current_pin', async () => {
    await writePullCacheRecord(sourcePlanCacheDir(repo.path), cloudRecord());
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      'cloud:ext-1@3',
      '--input',
      inputFile(
        JSON.stringify({
          task: 't',
          label: 'pinned-status',
          plan_steps: [{ text: 's', label: 's1' }],
        })
      ),
    ]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    const res = await agent.runRaw(['status', '--json']);
    const r = JSON.parse(res.stdout) as {
      current_pin: unknown;
      artifacts: Array<{
        id: string;
        source_plan: {
          pinned?: boolean;
          source_ref?: { kind?: string; locator?: string; version?: string };
          content?: unknown;
        } | null;
      }>;
    };
    const found = r.artifacts.find((a) => a.id === plan.artifact_id);
    expect(found?.source_plan?.pinned).toBe(true);
    expect(found?.source_plan?.source_ref).toMatchObject({
      kind: 'cloud',
      locator: 'ext-1',
      version: '3',
    });
    expect('content' in (found!.source_plan as object)).toBe(false);
    // Regression guard for the naming collision: the per-artifact source_plan
    // is orthogonal to the shell's top-level current_pin — both keys coexist.
    expect('current_pin' in r).toBe(true);
  });

  it('status --json: source_plan is null for an unpinned artifact', async () => {
    const planRes = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
    ]);
    const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
    const res = await agent.runRaw(['status', '--json']);
    const r = JSON.parse(res.stdout) as {
      artifacts: Array<{ id: string; source_plan: unknown }>;
    };
    expect(r.artifacts.find((a) => a.id === plan.artifact_id)?.source_plan).toBeNull();
  });
});
