import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { installTestPack } from '../support/test-helpers.js';

describe('finish pause', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.init({ noLlm: true });
    await installTestPack(agent);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('does not finalize or render a digest when a warning needs attention', async () => {
    expect(
      (await agent.runRaw(['eval', 'disable', 'test-pack/strict-stub', '--json'])).exitCode
    ).toBe(0);
    expect(
      (await agent.runRaw(['eval', 'enable', 'test-pack/pre-pr-warn-stub', '--json'])).exitCode
    ).toBe(0);
    const plan = await agent.capturePlan(
      {
        task: 'pausemarker finish regression',
        plan_steps: [{ text: 'exercise warning pause', label: 'warning-pause' }],
        touched_scope: [],
      },
      { noLlm: true }
    );
    const result = await agent.runRaw([
      'finish',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: plan.artifact_id,
          outcome: 'this summary must not be saved',
        })
      ),
    ]);

    expect(result.exitCode, result.stdout).toBe(0);
    const response = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(response).toMatchObject({
      ok: true,
      status: 'needs_attention',
      acceptance_allowed: true,
    });
    expect(response).not.toHaveProperty('summary_event_id');
    expect(response).not.toHaveProperty('finalization_status');
    expect(response).not.toHaveProperty('digest');
    expect(response).not.toHaveProperty('renderFinalDigest');

    const artifactDir = path.join(repo.path, '.orcaops', 'artifacts', plan.artifact_id);
    expect(existsSync(path.join(artifactDir, 'summary.json'))).toBe(false);
    expect(existsSync(path.join(artifactDir, 'digest.md'))).toBe(false);
    expect(existsSync(path.join(artifactDir, 'digest.meta.json'))).toBe(false);
    expect((await agent.search('pausemarker', { type: 'digest' })).results).toEqual([]);
  });

  it('does not finalize or render a digest when a pre-PR check blocks', async () => {
    const plan = await agent.capturePlan(
      {
        task: 'blockpausemarker finish regression',
        plan_steps: [{ text: 'exercise blocked finish', label: 'blocked-finish' }],
        touched_scope: [],
      },
      { noLlm: true }
    );
    const result = await agent.runRaw([
      'finish',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: plan.artifact_id,
          outcome: 'this blocked summary must not be saved',
        })
      ),
    ]);

    expect(result.exitCode, result.stdout).toBe(0);
    const response = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(response).toMatchObject({ ok: true, status: 'blocked', blocking: true });
    expect(response).not.toHaveProperty('summary_event_id');
    expect(response).not.toHaveProperty('finalization_status');
    expect(response).not.toHaveProperty('digest');
    expect(response).not.toHaveProperty('renderFinalDigest');

    const artifactDir = path.join(repo.path, '.orcaops', 'artifacts', plan.artifact_id);
    expect(existsSync(path.join(artifactDir, 'summary.json'))).toBe(false);
    expect(existsSync(path.join(artifactDir, 'digest.md'))).toBe(false);
    expect(existsSync(path.join(artifactDir, 'digest.meta.json'))).toBe(false);
    expect((await agent.search('blockpausemarker', { type: 'digest' })).results).toEqual([]);
  });
});
