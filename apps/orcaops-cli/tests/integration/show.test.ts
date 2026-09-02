import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sourcePlanCacheDir, writePullCacheRecord } from '@orcaops/storage';
import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { cloudRecord } from '../support/source-plan-test-helpers.js';
import { makeAgent } from '../support/test-agent.js';

// Covers the human (non --json) `orcaops show` render of plan-time decisions.
// The --json path already carries plan.decisions.
describe('orcaops show — plan decisions render', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('renders plan decisions with provenance, reason, and rejected alternatives', async () => {
    await agent.init({ noLlm: true });
    const plan = await agent.capturePlan(
      {
        task: 'add rate limiting',
        plan_steps: [{ text: 's1', label: 's1' }],
        touched_scope: [],
        decisions: [
          {
            decision: 'use a sliding-window limiter',
            reason: 'smooths burst-at-boundary',
            alternatives_considered: [
              { option: 'fixed-window counter', rejected_because: 'allows a boundary burst' },
            ],
          },
        ],
      },
      { noLlm: true }
    );

    const res = await agent.runRaw(['show', plan.artifact_id]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Decisions:');
    // Provenance tag distinguishes plan decisions from checkpoint decisions.
    expect(res.stdout).toContain('use a sliding-window limiter  (plan rev 0)');
    expect(res.stdout).toContain('smooths burst-at-boundary');
    expect(res.stdout).toContain(
      'considered fixed-window counter — rejected because allows a boundary burst'
    );
  });

  it('omits the Decisions block when the plan has no decisions', async () => {
    await agent.init({ noLlm: true });
    const plan = await agent.capturePlan(
      { task: 't', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );

    const res = await agent.runRaw(['show', plan.artifact_id]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain('Decisions:');
  });
});

// Pin observability: `show` must make a pinned source plan legible — both in
// the --json projection and the human render — so verifying a pin attached
// doesn't require reading raw artifact.json.
describe('orcaops show — source plan pin', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  const planJson = JSON.stringify({
    task: 'work under a pinned plan',
    label: 'pinned-show',
    plan_steps: [{ text: 's1', label: 's1' }],
    touched_scope: [],
  });

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function captureCloudPinned(): Promise<string> {
    await writePullCacheRecord(sourcePlanCacheDir(repo.path), cloudRecord());
    const res = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      'cloud:ext-1@3',
      '--input',
      inputFile(planJson),
    ]);
    expect(res.exitCode).toBe(0);
    return (JSON.parse(res.stdout) as { artifact_id: string }).artifact_id;
  }

  it('surfaces the content-free source_plan in show --json', async () => {
    const id = await captureCloudPinned();
    const res = await agent.runRaw(['show', id, '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as {
      artifact: {
        source_plan: {
          pinned: boolean;
          source_ref: { kind: string; locator: string; version: string };
          hash: string;
          content?: unknown;
        };
      };
    };
    expect(out.artifact.source_plan.pinned).toBe(true);
    expect(out.artifact.source_plan.source_ref).toMatchObject({
      kind: 'cloud',
      locator: 'ext-1',
      version: '3',
    });
    expect('content' in out.artifact.source_plan).toBe(false);
  });

  it('reports source_plan: null in show --json for an unpinned artifact', async () => {
    const plan = await agent.capturePlan(
      { task: 't', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const res = await agent.runRaw(['show', plan.artifact_id, '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as { artifact: { source_plan: unknown } };
    expect(out.artifact.source_plan).toBeNull();
  });

  it('renders a Source plan line in the human show render for a pinned artifact', async () => {
    const id = await captureCloudPinned();
    const res = await agent.runRaw(['show', id]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Source plan: cloud:ext-1@3');
  });

  it('omits the Source plan line for an unpinned artifact', async () => {
    const plan = await agent.capturePlan(
      { task: 't', plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const res = await agent.runRaw(['show', plan.artifact_id]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain('Source plan:');
  });
});
