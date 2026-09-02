import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepoTemplate, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { commitFile } from '../support/test-helpers.js';

/**
 * `orcaops snapshots diff`.
 *
 * Covers: single-cp window with manifest-tree authority (`tree_source`),
 * cross-cp and baseline.. ranges, per-status default phases (abandoned →
 * abandon; open cp → typed error), phase-vs-status errors, byte-cap
 * truncation, and secret redaction of the diff text.
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Fake secret matching the redaction patterns (GitHub classic PAT shape).
const FAKE_GH_TOKEN = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';

describe('orcaops snapshots diff', () => {
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

  async function capturePlan(): Promise<{ artifact_id: string; step_ids: string[] }> {
    const pr = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'diff fixture',
          label: `s2-diff-${randomUUID().slice(0, 8)}`,
          plan_steps: [
            { text: 'step a', label: 's1' },
            { text: 'step b', label: 's2' },
          ],
          touched_scope: [],
        })
      ),
    ]);
    const plan = JSON.parse(pr.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
    return { artifact_id: plan.artifact_id, step_ids: plan.plan_steps.map((s) => s.step_id) };
  }

  async function openCp(artifactId: string, stepId: string): Promise<void> {
    const r = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `open-${randomUUID()}`,
          artifact_id: artifactId,
          declared_step_ids: [stepId],
        })
      ),
    ]);
    expect(r.exitCode).toBe(0);
  }

  async function closeCp(artifactId: string, n: number, stepId: string): Promise<void> {
    const r = await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `close-${randomUUID()}`,
          artifact_id: artifactId,
          n,
          summary: `cp${n}`,
          files_changed: [],
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [stepId],
        })
      ),
    ]);
    expect(r.exitCode).toBe(0);
  }

  function diff(args: string[]): Promise<CliResult> {
    return agent.runRaw(['snapshots', 'diff', ...args]);
  }

  it('diffs a closed cp window with manifest-tree authority and shows the work', async () => {
    const { artifact_id, step_ids } = await capturePlan();
    await openCp(artifact_id, step_ids[0]);
    await commitFile(repo.path, 'one.ts', 'export const one = 1;\n', 'cp1 work');
    await closeCp(artifact_id, 1, step_ids[0]);

    const r = await diff(['1', '--artifact', artifact_id, '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as {
      tree_source: string;
      truncated: boolean;
      diff: string;
      from: { phase: string };
      to: { phase: string };
    };
    expect(out.from.phase).toBe('open');
    expect(out.to.phase).toBe('close');
    expect(out.tree_source).toBe('stored_manifest_trees');
    expect(out.truncated).toBe(false);
    expect(out.diff).toContain('+export const one = 1;');
  });

  it('diffs across checkpoints (close..close default) showing only the later work', async () => {
    const { artifact_id, step_ids } = await capturePlan();
    await openCp(artifact_id, step_ids[0]);
    await commitFile(repo.path, 'one.ts', 'export const one = 1;\n', 'cp1 work');
    await closeCp(artifact_id, 1, step_ids[0]);
    await openCp(artifact_id, step_ids[1]);
    await commitFile(repo.path, 'two.ts', 'export const two = 2;\n', 'cp2 work');
    await closeCp(artifact_id, 2, step_ids[1]);

    const r = await diff(['1..2', '--artifact', artifact_id, '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { diff: string; tree_source: string };
    expect(out.tree_source).toBe('snapshot_boundaries');
    expect(out.diff).toContain('+export const two = 2;');
    expect(out.diff).not.toContain('one = 1');
  });

  it('diffs baseline..1 from the plan-time seed', async () => {
    const { artifact_id, step_ids } = await capturePlan();
    await openCp(artifact_id, step_ids[0]);
    await commitFile(repo.path, 'one.ts', 'export const one = 1;\n', 'cp1 work');
    await closeCp(artifact_id, 1, step_ids[0]);

    const r = await diff(['baseline..1', '--artifact', artifact_id, '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { diff: string; from: { kind: string } };
    expect(out.from.kind).toBe('baseline');
    expect(out.diff).toContain('+export const one = 1;');
  });

  it('defaults an abandoned cp window to open..abandon; still-open cp is SNAPSHOT_UNAVAILABLE', async () => {
    const { artifact_id, step_ids } = await capturePlan();
    await openCp(artifact_id, step_ids[0]);
    await commitFile(repo.path, 'doomed.ts', 'export const doomed = 1;\n', 'doomed');

    // Still open → typed error.
    const openErr = await diff(['1', '--artifact', artifact_id, '--json']);
    expect(openErr.exitCode).toBe(1);
    expect((JSON.parse(openErr.stdout) as { error: { code: string } }).error.code).toBe(
      'SNAPSHOT_UNAVAILABLE'
    );

    const ab = await agent.runRaw([
      'capture',
      'checkpoint',
      'abandon',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `abandon-${randomUUID()}`,
          artifact_id,
          n: 1,
          reason: 'fixture abandon',
        })
      ),
    ]);
    expect(ab.exitCode).toBe(0);

    const r = await diff(['1', '--artifact', artifact_id, '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { diff: string; to: { phase: string } };
    expect(out.to.phase).toBe('abandon');
    expect(out.diff).toContain('+export const doomed = 1;');

    // Phase that doesn't exist for the status → typed error.
    const bad = await diff(['1', '--artifact', artifact_id, '--to-phase', 'close', '--json']);
    expect(bad.exitCode).toBe(1);
    expect((JSON.parse(bad.stdout) as { error: { code: string } }).error.code).toBe(
      'SNAPSHOT_UNAVAILABLE'
    );
  });

  it('truncates at diff_fingerprint.max_diff_bytes with truncated: true', async () => {
    const configPath = path.join(repo.path, '.orcaops', 'config.json');
    const existing = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      configPath,
      JSON.stringify({ ...existing, diff_fingerprint: { enabled: true, max_diff_bytes: 200 } }),
      'utf8'
    );

    const { artifact_id, step_ids } = await capturePlan();
    await openCp(artifact_id, step_ids[0]);
    await commitFile(repo.path, 'big.ts', `export const big = '${'x'.repeat(2000)}';\n`, 'big');
    await closeCp(artifact_id, 1, step_ids[0]);

    const r = await diff(['1', '--artifact', artifact_id, '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { truncated: boolean; byte_count: number; diff: string };
    expect(out.truncated).toBe(true);
    expect(out.byte_count).toBeLessThanOrEqual(200);
  });

  it('redacts secrets in the diff text (digest.redact_secrets default)', async () => {
    const { artifact_id, step_ids } = await capturePlan();
    await openCp(artifact_id, step_ids[0]);
    await writeFile(path.join(repo.path, 'leaky.env'), `TOKEN=${FAKE_GH_TOKEN}\n`, 'utf8');
    await closeCp(artifact_id, 1, step_ids[0]);

    const r = await diff(['1', '--artifact', artifact_id, '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { diff: string };
    expect(out.diff).toContain('leaky.env');
    expect(out.diff).not.toContain(FAKE_GH_TOKEN);
  });

  it('human mode writes the raw diff to stdout only (metadata on stderr)', async () => {
    const { artifact_id, step_ids } = await capturePlan();
    await openCp(artifact_id, step_ids[0]);
    await commitFile(repo.path, 'one.ts', 'export const one = 1;\n', 'cp1 work');
    await closeCp(artifact_id, 1, step_ids[0]);

    const r = await diff(['1', '--artifact', artifact_id]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('+export const one = 1;');
    expect(r.stdout).not.toContain('tree_source');
  });
});
