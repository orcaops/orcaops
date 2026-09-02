import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { commitFile } from '../support/test-helpers.js';

/**
 * `orcaops loose-ends` end to end: current-state findings, the
 * ≥1-finding inclusion rule, exact-scope `--artifact`, the
 * `window_semantics` envelope note, and the pinned window×--artifact
 * rejection. Pure assembly is unit-tested in `commands/loose-ends.test.ts`.
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface LooseEndsOk {
  ok: true;
  artifacts: Array<{
    artifact_id: string;
    uncovered_steps: Array<{ step_id: string; label: string }>;
    open_checkpoints: Array<{ n: number; age_seconds: number }>;
    no_summary: boolean;
    finding_count: number;
  }>;
  window_semantics: string;
}

function parseOk(r: CliResult): LooseEndsOk {
  expect(r.exitCode).toBe(0);
  const parsed = JSON.parse(r.stdout) as LooseEndsOk;
  expect(parsed.ok).toBe(true);
  return parsed;
}

describe('orcaops loose-ends', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  /** Artifact with loose ends: 2-step plan, one step's cp left OPEN. */
  let inflightId: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.runRaw(['init', '--json', '--no-llm']);

    const planR = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'loose ends fixture',
          label: 'loose-ends-fixture',
          plan_steps: [
            { text: 'step a', label: 's1' },
            { text: 'step b', label: 's2' },
          ],
          touched_scope: [],
        })
      ),
    ]);
    const plan = JSON.parse(planR.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
    inflightId = plan.artifact_id;
    await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `open-${randomUUID()}`,
          artifact_id: inflightId,
          declared_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('reports current-state findings with the window_semantics note', async () => {
    const out = parseOk(await agent.runRaw(['loose-ends', '--json']));
    expect(out.window_semantics).toBe('selects-artifacts-only');
    expect(out.artifacts).toHaveLength(1);

    const a = out.artifacts[0];
    expect(a.artifact_id).toBe(inflightId);
    // Step 1 is declared by the open cp (covered); step 2 is uncovered.
    expect(a.uncovered_steps.map((s) => s.label)).toEqual(['s2']);
    expect(a.open_checkpoints).toHaveLength(1);
    expect(a.open_checkpoints[0].age_seconds).toBeGreaterThanOrEqual(0);
    expect(a.no_summary).toBe(true);
    expect(a.finding_count).toBe(3);
  });

  it('a fully-delivered summarized artifact is excluded (zero findings)', async () => {
    // Second artifact on the same branch: single step, closed cp claiming
    // it, clean summary — nothing owed.
    const planR = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'clean artifact',
          label: 'clean-artifact',
          plan_steps: [{ text: 'only step', label: 'only' }],
          touched_scope: [],
        })
      ),
    ]);
    const plan = JSON.parse(planR.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
    const cleanId = plan.artifact_id;
    const stepId = plan.plan_steps[0].step_id;
    await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `open-${randomUUID()}`,
          artifact_id: cleanId,
          declared_step_ids: [stepId],
        })
      ),
    ]);
    await commitFile(repo.path, 'src/clean.ts', 'export const c = 1;\n', 'clean work');
    await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `close-${randomUUID()}`,
          artifact_id: cleanId,
          n: 1,
          summary: 'done cleanly',
          files_changed: ['src/clean.ts'],
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [stepId],
        })
      ),
    ]);
    await agent.runRaw([
      'capture',
      'pre-pr-check',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ idempotency_key: `prepr-${randomUUID()}`, artifact_id: cleanId })),
    ]);
    await agent.runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `sum-${randomUUID()}`,
          artifact_id: cleanId,
          outcome: 'done',
        })
      ),
    ]);

    const out = parseOk(await agent.runRaw(['loose-ends', '--json']));
    const ids = out.artifacts.map((a) => a.artifact_id);
    expect(ids).toContain(inflightId);
    expect(ids).not.toContain(cleanId);

    // Rot the clean artifact's summary: an unreadable summary is NOT
    // "no summary" — the recorded open items exist but cannot be
    // served, and the row must say so instead of reporting the
    // artifact as captured-then-forgotten.
    const cleanDir = path.join(repo.path, '.orcaops', 'artifacts', cleanId);
    const log = path.join(cleanDir, 'events.ndjson');
    const lines = (await readFile(log, 'utf8')).split('\n');
    const i = lines.findIndex((l) => l.includes('"summary_captured"'));
    lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
    await writeFile(log, lines.join('\n'), 'utf8');
    await rm(path.join(cleanDir, 'summary.json'), { force: true });

    const degraded = await agent.runRaw(['loose-ends', '--json']);
    expect(degraded.exitCode).toBe(0);
    expect(degraded.stderr).toMatch(/unreadable in loose-ends/);
    const dOut = JSON.parse(degraded.stdout) as {
      artifacts: Array<{
        artifact_id: string;
        label: string;
        task: string;
        branch: string;
        open_items: unknown[];
        deferred_decisions: unknown[];
        uncertainty: unknown[];
        uncovered_steps: unknown[];
        open_checkpoints: unknown[];
        no_summary: boolean;
        summary_unreadable: boolean;
        finding_count: number;
        unreadable?: boolean;
      }>;
    };
    const row = dOut.artifacts.find((a) => a.artifact_id === cleanId);
    expect(row?.summary_unreadable).toBe(true);
    expect(row?.no_summary).toBe(false);
    // Checksum rot refuses every projection read, so the row-level marker
    // rides along; index facts and folds are served verbatim under it, and
    // the summary-derived arrays fold to [] — unknown, not empty.
    expect(row?.unreadable).toBe(true);
    expect(row?.label).toBe('clean-artifact');
    expect(row?.task).toBe('clean artifact');
    expect(row?.branch).toBe('main');
    expect(row?.open_items).toEqual([]);
    expect(row?.deferred_decisions).toEqual([]);
    expect(row?.uncertainty).toEqual([]);
    expect(row?.uncovered_steps).toEqual([]);
    expect(row?.open_checkpoints).toEqual([]);
    expect(row?.finding_count).toBe(2);
  });

  it('a clean suffix truncation on a summary-less artifact marks the row unreadable', async () => {
    // readSummary legitimately returns null here (no summary event), so
    // the summary probe alone cannot witness the truncation —
    // artifact.json's source (always the LAST event) does.
    const dir = path.join(repo.path, '.orcaops', 'artifacts', inflightId);
    const log = path.join(dir, 'events.ndjson');
    const lines = (await readFile(log, 'utf8')).split('\n').filter((l) => l.length > 0);
    await writeFile(log, lines.slice(0, -1).join('\n') + '\n', 'utf8');

    const res = await agent.runRaw(['loose-ends', '--json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as {
      artifacts: Array<{
        artifact_id: string;
        label: string;
        task: string;
        branch: string;
        open_items: unknown[];
        deferred_decisions: unknown[];
        uncertainty: unknown[];
        uncovered_steps: Array<{ label: string }>;
        open_checkpoints: unknown[];
        unreadable?: boolean;
        no_summary: boolean;
        summary_unreadable: boolean;
        finding_count: number;
      }>;
    };
    const row = out.artifacts.find((a) => a.artifact_id === inflightId);
    expect(row?.unreadable).toBe(true);
    // The (intact) log genuinely has no summary event: no_summary stays
    // TRUE and summary_unreadable FALSE — the row-level marker alone
    // carries the truncation uncertainty.
    expect(row?.no_summary).toBe(true);
    expect(row?.summary_unreadable).toBe(false);
    // Index facts and folds served verbatim under the marker.
    expect(row?.label).toBe('loose-ends-fixture');
    expect(row?.task).toBe('loose ends fixture');
    expect(row?.branch).toBe('main');
    expect(row?.open_items).toEqual([]);
    expect(row?.deferred_decisions).toEqual([]);
    expect(row?.uncertainty).toEqual([]);
    expect(row?.uncovered_steps.map((s) => s.label)).toEqual(['s2']);
    expect(row?.open_checkpoints).toHaveLength(1);
    expect(row?.finding_count).toBe(4);
  });

  it('keeps a zero-finding artifact whose row rots while its summary stays readable', async () => {
    // Zero findings: one step, completed, no uncertainty, clean summary.
    const planR = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'quiet artifact',
          label: 'quiet-artifact',
          plan_steps: [{ text: 'only step', label: 'only' }],
          touched_scope: [],
        })
      ),
    ]);
    const plan = JSON.parse(planR.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
    const quietId = plan.artifact_id;
    const stepId = plan.plan_steps[0].step_id;
    await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `open-${randomUUID()}`,
          artifact_id: quietId,
          declared_step_ids: [stepId],
        })
      ),
    ]);
    await commitFile(repo.path, 'src/quiet.ts', 'export const q = 1;\n', 'quiet work');
    await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `close-${randomUUID()}`,
          artifact_id: quietId,
          n: 1,
          summary: 'done quietly',
          files_changed: ['src/quiet.ts'],
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [stepId],
        })
      ),
    ]);
    await agent.runRaw([
      'capture',
      'pre-pr-check',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ idempotency_key: `prepr-${randomUUID()}`, artifact_id: quietId })),
    ]);
    await agent.runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `sum-${randomUUID()}`,
          artifact_id: quietId,
          outcome: 'done',
        })
      ),
    ]);
    const before = parseOk(await agent.runRaw(['loose-ends', '--json']));
    expect(before.artifacts.map((a) => a.artifact_id)).not.toContain(quietId);

    // Append a post-summary event (the lineage entry), then cleanly
    // truncate it: artifact.json now names a source the log no longer
    // holds, so the row probe refuses — while summary.json's own source
    // event survives and the summary stays readable.
    await commitFile(repo.path, 'src/later.ts', 'export const l = 1;\n', 'after summary');
    await agent.runRaw(['lineage', '--json']);
    const log = path.join(repo.path, '.orcaops', 'artifacts', quietId, 'events.ndjson');
    const lines = (await readFile(log, 'utf8')).split('\n').filter((l) => l.length > 0);
    expect(lines[lines.length - 1]).toContain('"branch_lineage_updated"');
    await writeFile(log, lines.slice(0, -1).join('\n') + '\n', 'utf8');

    const res = await agent.runRaw(['loose-ends', '--json']);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toMatch(/unreadable in loose-ends/);
    const out = JSON.parse(res.stdout) as {
      artifacts: Array<{ artifact_id: string; unreadable?: boolean; finding_count: number }>;
    };
    expect(out.artifacts).toContainEqual(
      expect.objectContaining({ artifact_id: quietId, unreadable: true, finding_count: 1 })
    );
    expect('degraded_artifacts' in out).toBe(false);
  });

  it('--artifact exact-scope returns only that artifact and keeps the note', async () => {
    const out = parseOk(await agent.runRaw(['loose-ends', '--artifact', inflightId, '--json']));
    expect(out.artifacts.map((a) => a.artifact_id)).toEqual([inflightId]);
    expect(out.window_semantics).toBe('selects-artifacts-only');
  });

  it('window flags combined with --artifact are rejected (loose ends are current state)', async () => {
    const r = await agent.runRaw([
      'loose-ends',
      '--artifact',
      inflightId,
      '--active-since',
      '2026-01-01',
      '--json',
    ]);
    expect(r.exitCode).toBe(1);
    const err = JSON.parse(r.stdout) as { ok: false; error: { code: string; message: string } };
    expect(err.error.code).toBe('INVALID_INPUT');
    expect(err.error.message).toMatch(/current state/);
  });
});
