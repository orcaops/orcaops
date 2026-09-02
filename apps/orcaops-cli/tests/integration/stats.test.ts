import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepoTemplate, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * Minimal `orcaops stats` surface, plus the sibling sections. The four
 * base keys are asserted shape-UNCHANGED; new data rides only in new
 * sibling keys.
 */

interface StatsOk {
  ok: true;
  artifacts: { total: number; by_status: Record<string, number> };
  checkpoints: { total: number; by_status: Record<string, number> };
  summaries: { total: number };
  coding_sessions: {
    total: number;
    tokens: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
  };
  evaluators: {
    by_evaluator: Array<{
      evaluator_ref: string;
      phase: string;
      total: number;
      pass: number;
      violation: number;
      pass_rate: number | null;
    }>;
  };
  plan_revisions: {
    artifacts_with_plan: number;
    revised_artifacts: number;
    max_revisions: number;
    mean_revisions: number;
    histogram: Record<string, number>;
  };
  checkpoint_durations: {
    closed_total: number;
    min_ms: number | null;
    max_ms: number | null;
    mean_ms: number | null;
    median_ms: number | null;
    p90_ms: number | null;
  };
  hygiene: Record<string, unknown> & {
    diff_attributed_pct: number | null;
    notes: { diff_attributed_pct: string };
  };
}

describe('orcaops stats', () => {
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

  it('reports zeros on a fresh store, counts after a capture', async () => {
    const fresh = JSON.parse((await agent.runRaw(['stats', '--json'])).stdout) as StatsOk;
    expect(fresh.ok).toBe(true);
    expect(fresh.artifacts.total).toBe(0);
    expect(fresh.checkpoints.total).toBe(0);
    expect(fresh.summaries.total).toBe(0);
    expect(fresh.coding_sessions.total).toBe(0);

    // Sibling sections: present and zero-shaped on an empty store; the
    // four base keys above keep their exact shape.
    expect(fresh.evaluators).toEqual({ by_evaluator: [] });
    expect(fresh.plan_revisions).toEqual({
      artifacts_with_plan: 0,
      revised_artifacts: 0,
      max_revisions: 0,
      mean_revisions: 0,
      histogram: {},
    });
    expect(fresh.checkpoint_durations).toEqual({
      closed_total: 0,
      min_ms: null,
      max_ms: null,
      mean_ms: null,
      median_ms: null,
      p90_ms: null,
    });
    // No artifact on the branch yet -> the attribution metric is null.
    expect(fresh.hygiene.diff_attributed_pct).toBeNull();
    expect(fresh.hygiene.notes.diff_attributed_pct).toMatch(/unambiguous hunk-level attribution/);
    expect(fresh.hygiene.open_checkpoints_on_finished_artifacts).toBe(0);

    const planR = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'stats fixture',
          label: 'stats-fixture',
          plan_steps: [{ text: 'step a', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    const plan = JSON.parse(planR.stdout) as {
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

    const after = JSON.parse((await agent.runRaw(['stats', '--json'])).stdout) as StatsOk;
    expect(after.artifacts.total).toBe(1);
    expect(after.artifacts.by_status.active).toBe(1);
    expect(after.checkpoints.total).toBe(1);
    expect(after.checkpoints.by_status.open).toBe(1);
    expect(after.summaries.total).toBe(0);
    expect(after.coding_sessions.tokens.input_tokens).toBeGreaterThanOrEqual(0);

    // The capture recorded one plan at revision 0. (Evaluator pass-rate
    // grouping is store-tested in stats-rollups.test.ts — a bare temp-repo
    // init has no evaluator pack installed, so by_evaluator stays empty.)
    expect(after.plan_revisions.artifacts_with_plan).toBe(1);
    expect(after.plan_revisions.histogram['0']).toBe(1);
    expect(after.evaluators.by_evaluator).toEqual([]);

    // Once a checkpoint with a manifest closes, the
    // attribution metric fills in (a number, not null — the exact value
    // depends on untracked .orcaops noise in the worktree window).
    await writeFile(path.join(repo.path, 'attributed.ts'), 'export const a = 1;\n', 'utf8');
    await agent.runRaw([
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
          files_changed: ['attributed.ts'],
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);
    const filled = JSON.parse((await agent.runRaw(['stats', '--json'])).stdout) as StatsOk;
    expect(typeof filled.hygiene.diff_attributed_pct).toBe('number');

    // A second artifact rots: the attribution pool is skip-reduced while
    // sources remain (the healthy artifact's manifest), so the metric
    // must degrade to null — a percentage computed from a reduced pool
    // would be confidently wrong.
    const planB = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'stats rot fixture',
          label: 'stats-rot-fixture',
          plan_steps: [{ text: 'step b', label: 'sb' }],
          touched_scope: [],
        })
      ),
    ]);
    const b = JSON.parse(planB.stdout) as {
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
          artifact_id: b.artifact_id,
          declared_step_ids: [b.plan_steps[0].step_id],
        })
      ),
    ]);
    await writeFile(path.join(repo.path, 'attributed-b.ts'), 'export const bb = 2;\n', 'utf8');
    await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `close-${randomUUID()}`,
          artifact_id: b.artifact_id,
          n: 1,
          summary: 'cp1',
          files_changed: ['attributed-b.ts'],
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [b.plan_steps[0].step_id],
        })
      ),
    ]);
    const bDir = path.join(repo.path, '.orcaops', 'artifacts', b.artifact_id);
    const bLog = path.join(bDir, 'events.ndjson');
    const lines = (await readFile(bLog, 'utf8')).split('\n');
    const i = lines.findIndex((l) => l.includes('"checkpoint_closed"'));
    lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
    await writeFile(bLog, lines.join('\n'), 'utf8');
    await rm(path.join(bDir, 'checkpoint-1.json'), { force: true });

    const degraded = JSON.parse((await agent.runRaw(['stats', '--json'])).stdout) as StatsOk & {
      degraded_artifacts: string[];
      evaluators: { by_evaluator: unknown };
      plan_revisions: unknown;
      checkpoint_durations: unknown;
    };
    expect(degraded.hygiene.diff_attributed_pct).toBeNull();
    // Aggregates folding log-content claims degrade to null when any
    // artifact is unreadable; the artifacts are disclosed.
    expect(degraded.degraded_artifacts).toContain(b.artifact_id);
    expect(degraded.evaluators.by_evaluator).toBeNull();
    expect(degraded.plan_revisions).toBeNull();
    expect(degraded.checkpoint_durations).toBeNull();
    // Row counts are index facts, not log-content claims: they still
    // include the unreadable member.
    expect(degraded.artifacts.total).toBe(2);
    expect(degraded.checkpoints.total).toBe(2);
  });

  it('human mode renders the counts and exits 0', async () => {
    const r = await agent.runRaw(['stats']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Store stats');
    expect(r.stdout).toContain('artifacts:');
  });
});
