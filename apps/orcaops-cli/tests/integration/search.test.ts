import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '@orcaops/core';
import { ArtifactStore } from '@orcaops/storage';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { installTestPack, plantBlockViolation } from '../support/test-helpers.js';

describe('orcaops search — flag matrix + error envelopes', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  /** Capture a thread on `branch` with given task + summary. */
  async function seedOn(branchName: string, task: string, summaryOutcome: string): Promise<string> {
    const { gitClient } = await import('@orcaops/test-harness');
    const git = gitClient(repo.path);
    const current = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    if (current !== branchName) {
      try {
        await git.checkout(branchName);
      } catch {
        await git.checkoutBranch(branchName, current);
      }
    }
    const plan = await agent.capturePlan(
      { task, plan_steps: [{ text: 's1', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    await agent.captureCheckpoint(
      {
        artifact_id: plan.artifact_id,
        n: 1,
        summary: 'wired the redis middleware',
        files_changed: ['src/x.ts'],
      },
      { noLlm: true }
    );
    await agent.captureSummary({ artifact_id: plan.artifact_id, outcome: summaryOutcome });
    return plan.artifact_id;
  }

  // ── Validation errors ─────────────────────────────────────────────────

  it('rejects empty <query> with INVALID_INPUT (path: "query")', async () => {
    await agent.init({ noLlm: true });
    const err = await agent.expectError(['search', '', '--json']);
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.path).toBe('query');
  });

  it('rejects whitespace-only <query> with INVALID_INPUT', async () => {
    await agent.init({ noLlm: true });
    const err = await agent.expectError(['search', '   ', '--json']);
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.path).toBe('query');
  });

  it('rejects an invalid --type with INVALID_INPUT (path: "type")', async () => {
    await agent.init({ noLlm: true });
    const err = await agent.expectError(['search', 'redis', '--json', '--type', 'nope']);
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.path).toBe('type');
    expect(err.error.message).toMatch(/plan, checkpoint, summary, evaluator/);
    expect(err.error.message).toMatch(/digest/);
    expect(err.error.message).toMatch(/block-resolution/);
    expect(err.error.message).toMatch(/pin-displaced/);
  });

  // ── Filters ───────────────────────────────────────────────────────────

  it('--type summary narrows to summary rows only', async () => {
    await agent.init({ noLlm: true });
    await seedOn('main', 'add rate limiting', 'redis middleware shipped to production');

    const onlySummary = await agent.search('redis', { type: 'summary' });
    expect(onlySummary.results.every((r) => r.source === 'summary')).toBe(true);
    expect(onlySummary.count).toBeGreaterThanOrEqual(1);
  });

  it('--type plan narrows to plan rows only', async () => {
    await agent.init({ noLlm: true });
    await seedOn('main', 'add rate limiting redis middleware', 'shipped');
    const onlyPlan = await agent.search('redis', { type: 'plan' });
    expect(onlyPlan.results.every((r) => r.source.startsWith('plan'))).toBe(true);
    expect(onlyPlan.count).toBeGreaterThanOrEqual(1);
  });

  it('--branch narrows to one branch across multi-branch fixture', async () => {
    await agent.init({ noLlm: true });
    await seedOn('main', 'main has redis logic', 'shipped redis on main');
    await seedOn('feat/other', 'feat has redis too', 'shipped redis on feat');

    const all = await agent.search('redis');
    const branches = new Set(all.results.map((r) => r.branch));
    expect(branches.has('main')).toBe(true);
    expect(branches.has('feat/other')).toBe(true);

    const onlyMain = await agent.search('redis', { branch: 'main' });
    expect(onlyMain.results.every((r) => r.branch === 'main')).toBe(true);
    expect(onlyMain.count).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('marks hits from an unreadable artifact and discloses it, instead of serving them as fact', async () => {
    await agent.init({ noLlm: true });
    const id = await seedOn('main', 'rot search fixture', 'done fine');
    const dir = path.join(repo.path, '.orcaops', 'artifacts', id);
    const log = path.join(dir, 'events.ndjson');
    const lines = (await readFile(log, 'utf8')).split('\n');
    const i = lines.findIndex((l) => l.includes('"checkpoint_closed"'));
    lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
    await writeFile(log, lines.join('\n'), 'utf8');

    const res = await agent.runRaw(['search', 'redis', '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as {
      degraded_artifacts: string[];
      results: Array<{ artifact_id: string; unreadable?: boolean }>;
    };
    expect(out.degraded_artifacts).toContain(id);
    for (const r of out.results.filter((x) => x.artifact_id === id)) {
      expect(r.unreadable).toBe(true);
    }
  });

  it('--limit caps the result count', async () => {
    await agent.init({ noLlm: true });
    await seedOn('main', 'redis redis redis', 'redis');
    const all = await agent.search('redis');
    expect(all.results.length).toBeGreaterThanOrEqual(3);

    const capped = await agent.search('redis', { limit: 2 });
    expect(capped.results.length).toBeLessThanOrEqual(2);
  });

  // ── Sanitizer integration: hyphens / colons in user input ─────────────

  it('hyphenated query like "rate-limit" works without an FTS syntax error', async () => {
    await agent.init({ noLlm: true });
    await seedOn('main', 'add rate-limit middleware', 'shipped rate-limit');
    const r = await agent.search('rate-limit');
    expect(r.count).toBeGreaterThanOrEqual(1);
  });

  it('UNINITIALIZED before init', async () => {
    const err = await agent.expectError(['search', 'redis', '--json']);
    expect(err.error.code).toBe('UNINITIALIZED');
  });

  // ── Evaluator-run indexing ────────────────────────────────────────────

  it('--type evaluator finds an indexed evaluator run by body content', async () => {
    await agent.init({ noLlm: true });
    // Install bundled `core` so post-plan evaluators (plan-mentions-tests
    // and plan-label-quality) actually fire
    // and write rows the search indexer picks up. Without `core`
    // installed, capture plan completes with zero evaluator rows.
    const addPack = await agent.runRaw([
      'eval',
      'add-pack',
      '@orcaops/evaluator-pack',
      'core',
      '--yes',
      '--json',
    ]);
    expect(addPack.exitCode).toBe(0);
    await agent.capturePlan(
      {
        task: 'add rate limiting',
        plan_steps: [{ text: 'middleware', label: 's1' }],
        touched_scope: [],
      },
      { noLlm: true }
    );
    // plan-mentions-tests fires post-plan; with no test intent in the
    // plan, the violation diagnostic is indexed as evaluator content.
    const r = await agent.search('intent', { type: 'evaluator' });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.every((row) => row.source.startsWith('evaluator:'))).toBe(true);
  });

  it('evaluator-source rows distinguish per (evaluator, ts) pair', async () => {
    await agent.init({ noLlm: true });
    const addPack = await agent.runRaw([
      'eval',
      'add-pack',
      '@orcaops/evaluator-pack',
      'core',
      '--yes',
      '--json',
    ]);
    expect(addPack.exitCode).toBe(0);
    await agent.capturePlan(
      { task: 'first', plan_steps: [{ text: 's', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    await agent.capturePlan(
      { task: 'second', plan_steps: [{ text: 's', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const r = await agent.search('tests', { type: 'evaluator' });
    const sources = new Set(r.results.map((row) => row.source));
    expect(sources.size).toBeGreaterThanOrEqual(2);
  });

  // ── Block-resolution indexing ─────────────────────────────────────────

  it('--type block-resolution finds the dismiss reason text', async () => {
    await agent.init({ noLlm: true });
    // Install the workspace test-pack so the discovery-routed `block
    // dismiss` can resolve `test-pack/api-stub`. plantBlockViolation
    // seeds storage directly with that ref; without the pack install,
    // the dismiss command returns EVALUATOR_NOT_FOUND.
    await installTestPack(agent);
    const plan = await agent.capturePlan(
      { task: 't', plan_steps: [{ text: 's', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    await plantBlockViolation({
      cwd: repo.path,
      artifactId: plan.artifact_id,
      evaluatorRef: 'test-pack/api-stub',
    });
    const dismiss = await agent.blockDismiss({
      artifact: plan.artifact_id,
      evaluator: 'test-pack/api-stub',
      reason: 'banzai-rationale-marker',
    });
    expect(dismiss.action).toBe('dismissed');

    const r = await agent.search('banzai-rationale-marker', { type: 'block-resolution' });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.every((row) => row.source.startsWith('block-resolution:'))).toBe(true);
  });

  it('block-resolution rows live alongside the original evaluator row (distinct sources)', async () => {
    await agent.init({ noLlm: true });
    await installTestPack(agent);
    const plan = await agent.capturePlan(
      { task: 't', plan_steps: [{ text: 's', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    await plantBlockViolation({
      cwd: repo.path,
      artifactId: plan.artifact_id,
      evaluatorRef: 'test-pack/api-stub',
    });
    await agent.blockDismiss({
      artifact: plan.artifact_id,
      evaluator: 'test-pack/api-stub',
      reason: 'kappa-marker-text',
    });
    // Search by the evaluator_ref string (`test-pack/api-stub`) which
    // appears in both the seeded evaluator row and the block-resolution
    // row the dismiss synthesized. Each row reports a distinct source.
    const evalSearch = await agent.search('test-pack/api-stub', { type: 'evaluator' });
    const brSearch = await agent.search('test-pack/api-stub', { type: 'block-resolution' });
    expect(evalSearch.results.length).toBeGreaterThan(0);
    expect(brSearch.results.length).toBeGreaterThan(0);
  });

  // ── Pin-displaced indexing ────────────────────────────────────────────

  it('--type pin-displaced finds pin lifecycle events', async () => {
    await agent.init({ noLlm: true });
    const a = await agent.capturePlan(
      { task: 'first', plan_steps: [{ text: 's', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    await agent.captureCheckpoint(
      { artifact_id: a.artifact_id, n: 1, summary: 'cp1', files_changed: ['x.ts'] },
      { noLlm: true }
    );
    const b = await agent.capturePlan(
      { task: 'second', plan_steps: [{ text: 's', label: 's1' }], touched_scope: [] },
      { noLlm: true }
    );
    const config = await loadConfig(repo.path);
    const store = new ArtifactStore({ repoRoot: repo.path, config });
    try {
      await store.writePinDisplaced(a.artifact_id, {
        displaced_by_artifact_id: b.artifact_id,
        shell_key: { kind: 'claude_session', value: 'sess_x' },
        reason: 'explicit-checkout',
      });
    } finally {
      store.close();
    }
    const r = await agent.search('explicit-checkout', { type: 'pin-displaced' });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.every((row) => row.source.startsWith('pin-displaced:'))).toBe(true);
  });

  // ── Digest indexing ───────────────────────────────────────────────────

  it('--type digest finds digest content after `orcaops digest` runs', async () => {
    await agent.init({ noLlm: true });
    const plan = await agent.capturePlan(
      {
        task: 'add zerolimit middleware',
        plan_steps: [{ text: 'wire zerolimit', label: 's1' }],
        touched_scope: [],
      },
      { noLlm: true }
    );
    await agent.captureCheckpoint(
      {
        artifact_id: plan.artifact_id,
        n: 1,
        summary: 'wired zerolimit',
        files_changed: ['src/zl.ts'],
      },
      { noLlm: true }
    );
    await agent.captureSummary({ artifact_id: plan.artifact_id, outcome: 'shipped zerolimit' });
    await agent.digest({ artifact: plan.artifact_id });

    const r = await agent.search('zerolimit', { type: 'digest' });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.every((row) => row.source === 'digest')).toBe(true);
  });
});
