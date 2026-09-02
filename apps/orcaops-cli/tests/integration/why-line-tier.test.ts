import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepoTemplate, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * `why` line-hash tier.
 *
 * The line-tier fixture keeps the work UNCOMMITTED: git blame answers
 * null (ancestry alone would say `weak`), so an `exact` verdict can ONLY
 * come from manifest line-membership — the promotion is what's proven.
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DISTINCTIVE = 'export const distinctiveProvenanceMarker = 0xdecafbad;';

describe('orcaops why — line-hash tier', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  // `init` is identical for every test here and costs ~450ms; run it once
  // and give each test a ~20ms copy of the result.
  const repoTemplate = createRepoTemplate(
    async (repoPath) => {
      await makeAgent({ cwd: repoPath, env: { ORCAOPS_DISABLE_DRAIN: '1' } }).runRaw([
        'init',
        '--json',
        '--no-llm',
      ]);
    },
    { initialBranch: 'main' }
  );

  beforeEach(async () => {
    repo = await repoTemplate.checkout();
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
  });

  afterAll(async () => {
    await repoTemplate.destroy();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  /** Plan + one closed cp adding UNCOMMITTED files (blame stays null). */
  async function capturedUncommitted(): Promise<string> {
    const pr = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'line-tier fixture',
          label: `s6-why-${randomUUID().slice(0, 8)}`,
          plan_steps: [{ text: 'step a', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    const plan = JSON.parse(pr.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
    await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `open-${randomUUID()}`,
          artifact_id: plan.artifact_id,
          declared_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);
    await writeFile(path.join(repo.path, 'mystery.ts'), `${DISTINCTIVE}\n`, 'utf8');
    await writeFile(path.join(repo.path, 'closer.ts'), '}\n', 'utf8');
    const close = await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `close-${randomUUID()}`,
          artifact_id: plan.artifact_id,
          n: 1,
          summary: 'cp1',
          files_changed: ['mystery.ts', 'closer.ts'],
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);
    expect(close.exitCode).toBe(0);
    return plan.artifact_id;
  }

  it('promotes an uncommitted line to exact via manifest line-membership', async () => {
    const artifactId = await capturedUncommitted();
    const r: CliResult = await agent.runRaw(['why', 'mystery.ts:1', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as {
      blame_sha: string | null;
      best: { artifact_id: string; confidence: string; reason: string } | null;
    };
    // Uncommitted → blame null; ancestry alone would cap at 'weak'.
    expect(out.blame_sha).toBeNull();
    expect(out.best?.artifact_id).toBe(artifactId);
    expect(out.best?.confidence).toBe('exact');
    expect(out.best?.reason).toContain('line content hash matches');
  });

  it('leaves trivial lines on ancestry confidence (the guard, not a match)', async () => {
    await capturedUncommitted();
    const r: CliResult = await agent.runRaw(['why', 'closer.ts:1', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as {
      best: { confidence: string; reason: string } | null;
    };
    // `}` is guarded as trivial — membership never fires; blame is null
    // so the file-overlap 'weak' verdict stands.
    expect(out.best?.confidence).toBe('weak');
    expect(out.best?.reason).not.toContain('line content hash');
  });
});
