import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { projectDatabasePath, readProjectArtifact } from '@orcaops/storage/history/database';

import { publishProjectLifecycleCompletion } from '../../../../packages/storage/dist/history/database/capture-lifecycles.js';
import type { readDatabaseStats } from '../../src/lib/database-stats.js';
import { fixture, git, inventory } from '../helpers/database-history.js';
import { closeWithFindings, insightFixture, summarize } from '../helpers/database-insights.js';
import { tokens, usageObservation } from '../helpers/database-usage.js';
import { makeAgent } from '../support/test-agent.js';

type Stats = ReturnType<typeof readDatabaseStats>;
function agentFor(f: { main: string; root: string }, cwd = f.main) {
  return makeAgent({ cwd, env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' } });
}
async function stats(f: { main: string; root: string }, flags: string[] = [], cwd = f.main) {
  const raw = await agentFor(f, cwd).runRaw(['stats', '--json', ...flags]);
  expect(raw.exitCode, raw.stderr || raw.stdout).toBe(0);
  const parsed = JSON.parse(raw.stdout) as Stats & { ok: boolean };
  expect(parsed.ok).toBe(true);
  return parsed;
}
async function prePrCompletion(f: Awaited<ReturnType<typeof fixture>>, artifactId: string) {
  const bytes = Buffer.from(' {"fires_at":"pre-pr","cp_n":0,"triggered_at":"original time"}\n');
  await publishProjectLifecycleCompletion(
    f.writer,
    {
      artifactId,
      operationId: uuidv7(),
      revisionId: uuidv7(),
      artifactRevision: readProjectArtifact(f.writer, artifactId)!.revision,
      expectedSelection: null,
      source: {
        identity: 'Original lifecycle',
        locator: 'sqlite:evaluator_lifecycles#0',
        revisionId: null,
        eventId: null,
        operationId: null,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      bytes,
    },
    { secretAllow: [] }
  );
}

describe('orcaops stats', { timeout: 30_000 }, () => {
  it('reports complete zeros on an empty project and counts after captures', async () => {
    const f = await fixture();
    const before = await inventory(f.temporary);
    const fresh = await stats(f);
    expect(fresh).toMatchObject({
      schema_version: 3,
      scope: { kind: 'project', branch: { source: 'all', value: null } },
      artifacts: { total: 0, by_status: {}, by_state: {} },
      checkpoints: { total: 0, by_status: {} },
      summaries: { total: 0 },
      coding_sessions: { total: 0, tokens: null },
      imported_artifacts: 0,
      evaluators: { by_evaluator: [] },
      plan_revisions: {
        artifacts_with_plan: 0,
        revised_artifacts: 0,
        max_revisions: 0,
        mean_revisions: 0,
        histogram: {},
      },
      checkpoint_durations: {
        closed_total: 0,
        min_ms: null,
        max_ms: null,
        mean_ms: null,
        median_ms: null,
        p90_ms: null,
      },
      hygiene: {
        open_checkpoints_on_finished_artifacts: 0,
        summaries_without_pre_pr_run: 0,
        closed_cp_without_completed_steps: 0,
        closed_cp_without_uncertainty: 0,
        closed_cp_without_decisions: 0,
        closed_cp_without_files_changed: 0,
        diff_attributed_pct: null,
        // Nothing is captured yet, so there is no artifact base to measure from.
        diff_attribution: { state: 'unavailable', reason: 'ARTIFACT_BASE_UNAVAILABLE' },
      },
      completeness: { complete: true, issues: [] },
      coverage: { counted_projects: [f.authority.projectId], unknown_projects: [] },
    });
    expect(fresh.hygiene.notes.diff_attributed_pct).toMatch(/unambiguous hunk-level attribution/);
    expect(fresh.usage.accounting.status).toBe('unavailable');
    expect(await inventory(f.temporary)).toEqual(before);

    const id = await f.capture();
    await f.recordFiles(id, ['src/retained.ts']);
    const after = await stats(f);
    expect(after.artifacts).toEqual({
      total: 1,
      by_status: { active: 1 },
      by_state: { active: 1 },
    });
    expect(after.checkpoints).toEqual({ total: 1, by_status: { closed: 1 } });
    expect(after.summaries.total).toBe(0);
    expect(after.plan_revisions).toMatchObject({ artifacts_with_plan: 1, histogram: { '0': 1 } });
    expect(after.checkpoint_durations.closed_total).toBe(1);
    expect(after.hygiene).toMatchObject({
      closed_cp_without_completed_steps: 1,
      closed_cp_without_uncertainty: 1,
      closed_cp_without_decisions: 1,
      closed_cp_without_files_changed: 0,
    });
    expect(after.sources).toEqual([
      expect.objectContaining({
        project_id: f.authority.projectId,
        counters: { writeSequence: expect.any(Number), intentChangeCounter: expect.any(Number) },
      }),
    ]);
  });

  it('counts imported history in base sections while excluding it from churn, durations and hygiene', async () => {
    const f = await insightFixture();
    await closeWithFindings(f);
    await summarize(f);
    const imported = await f.capture(undefined, { reason: 'imported' });
    await f.recordFiles(imported, ['src/imported.ts']);
    await f.mutate(imported, { outcome: 'Imported outcome' }, (semantics) =>
      semantics.writeSummary({
        schema_version: 1,
        artifact_id: imported,
        outcome: 'Imported outcome',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: f.registeredContext.binding.git_context.head_sha!,
        ts: '2026-09-02T00:00:00.000Z',
      })
    );
    const before = await inventory(f.temporary);
    const result = await stats(f);
    expect(result.artifacts).toEqual({
      total: 2,
      by_status: { complete: 2 },
      by_state: { summarized: 2 },
    });
    expect(result.checkpoints).toEqual({ total: 2, by_status: { closed: 2 } });
    expect(result.summaries.total).toBe(2);
    expect(result.imported_artifacts).toBe(1);
    expect(result.plan_revisions.artifacts_with_plan).toBe(1);
    expect(result.checkpoint_durations.closed_total).toBe(1);
    expect(result.hygiene).toMatchObject({
      summaries_without_pre_pr_run: 1,
      closed_cp_without_completed_steps: 1,
      closed_cp_without_uncertainty: 0,
      closed_cp_without_decisions: 0,
      closed_cp_without_files_changed: 0,
    });
    expect((await stats(f, ['--origin', 'imported'])).artifacts.total).toBe(1);
    expect((await stats(f, ['--state', 'summarized'])).summaries.total).toBe(2);
    const human = await f.agent.runRaw(['stats']);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('Store stats');
    expect(human.stdout).toContain('artifacts:   2 (complete=2)');
    expect(human.stdout).toContain('imported:    1 (excluded from duration aggregates)');
    expect(human.stdout).toContain('closed_cp_without_completed_steps: 1');
    expect(human.stdout).toContain('diff attribution: unavailable (NO_MANIFEST_SOURCES)');
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('treats a zero-run pre-PR completion as completion and rates retained evaluator runs', async () => {
    const f = await insightFixture();
    await closeWithFindings(f, f.id, true);
    await summarize(f, f.id, true);
    for (const verdict of ['pass', 'violation'] as const)
      await f.mutate(f.id, `Retained ${verdict}`, (draft) =>
        draft.writeEvaluatorRunPayload(f.id, {
          schema: 'orcaops.evaluator_run/v1',
          run_id: uuidv7(),
          artifact_id: f.id,
          evaluator_ref: 'test/retained',
          package_id: 'test',
          evaluator_id: 'retained',
          phase: 'checkpoint-close',
          severity: 'warn',
          run_status: 'completed',
          verdict,
          body: `${verdict.toUpperCase()}\n\nRetained evidence`,
          ts: '2026-09-01T00:00:00.000Z',
        })
      );
    expect((await stats(f)).hygiene.summaries_without_pre_pr_run).toBe(1);
    await prePrCompletion(f, f.id);
    const before = await inventory(f.temporary);
    const result = await stats(f);
    expect(result.hygiene).toMatchObject({
      summaries_without_pre_pr_run: 0,
      closed_cp_without_completed_steps: 0,
      closed_cp_without_uncertainty: 1,
    });
    expect(result.evaluators.by_evaluator).toEqual([
      {
        evaluator_ref: 'test/retained',
        phase: 'checkpoint-close',
        total: 2,
        completed: 2,
        pass: 1,
        violation: 1,
        info: 0,
        error: 0,
        skipped: 0,
        pass_rate: 0.5,
      },
    ]);
    const human = await f.agent.runRaw(['stats']);
    expect(human.stdout).toContain('test/retained [checkpoint-close]: 50% (1/2 graded, 2 runs)');
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('applies literal branch, worktree and touching selectors before aggregating and follows selected usage', async () => {
    const f = await fixture();
    const main = await f.capture();
    await f.recordFiles(main, ['src/main.ts']);
    await git(f.main, ['checkout', '-qb', 'feature']);
    const feature = await f.capture();
    const linked = await f.capture(undefined, { cwd: f.linked });
    await usageObservation(f.writer, main, 10);
    await usageObservation(f.writer, feature, 20, { session_id: 'feature-session' });
    await usageObservation(f.writer, null, 40, { session_id: 'unassociated' });
    const before = await inventory(f.temporary);
    const all = await stats(f);
    expect(all.artifacts.total).toBe(3);
    expect(all.coding_sessions).toEqual({ total: 3, tokens: tokens(70) });
    const branch = await stats(f, ['--branch', 'main']);
    expect(branch.artifacts.total).toBe(1);
    expect(branch.coding_sessions).toEqual({ total: 1, tokens: tokens(10) });
    expect((await stats(f, ['--branch', 'ma*'])).artifacts.total).toBe(0);
    const touching = await stats(f, ['--touching', 'src/**']);
    expect(touching.artifacts.total).toBe(1);
    expect(touching.checkpoints.total).toBe(1);
    const worktree = await stats(f, ['--scope', 'worktree'], f.linked);
    expect(worktree.scope.kind).toBe('worktree');
    expect(worktree.artifacts.total).toBe(1);
    expect(worktree.coding_sessions).toEqual({ total: 0, tokens: null });
    expect(linked).not.toBe(feature);
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('reports missing registered history as unknown contributions, never a fresh zero', async () => {
    const f = await fixture();
    await f.capture();
    f.writer.close();
    await rm(projectDatabasePath(f.authority));
    const before = await inventory(f.temporary);
    const result = await stats(f);
    expect(result.completeness).toMatchObject({
      complete: false,
      issues: [expect.objectContaining({ code: 'HISTORY_MISSING' })],
    });
    expect(result.coverage).toEqual({
      counted_projects: [],
      unknown_projects: [f.authority.projectId],
    });
    expect(result.artifacts.total).toBe(0);
    expect(result.coding_sessions.tokens).toBeNull();
    expect(result.projects[0].state).toBe('unknown');
    const human = await agentFor(f).runRaw(['stats']);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('Unknown contributions: 1 project(s) unavailable');
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('discloses damaged derived metadata and unreadable lifecycle rows without repairing them', async () => {
    const f = await insightFixture();
    await summarize(f);
    const raw = new Database(projectDatabasePath(f.authority));
    raw.pragma('foreign_keys = OFF');
    const triggers = raw
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name IN ('artifact_lifecycle_current','artifact_lifecycle_revisions')"
      )
      .all() as { name: string; sql: string }[];
    for (const trigger of triggers)
      raw.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
    raw.exec(
      "INSERT INTO artifact_lifecycle_current VALUES (?, 'pre-pr', 0, 'missing', 1)".replace(
        '?',
        `'${f.id}'`
      )
    );
    for (const trigger of triggers) raw.exec(trigger.sql);
    raw.close();
    const before = await inventory(f.temporary);
    const lifecycle = await stats(f);
    expect(lifecycle.artifacts.total).toBe(1);
    expect(lifecycle.hygiene.summaries_without_pre_pr_run).toBeNull();
    expect(lifecycle.completeness).toMatchObject({
      complete: false,
      issues: [
        expect.objectContaining({
          code: 'HISTORY_INTEGRITY_REQUIRED',
          resource: 'lifecycle',
          artifact_id: f.id,
        }),
      ],
    });
    expect(await inventory(f.temporary)).toEqual(before);
    const damaged = new Database(projectDatabasePath(f.authority));
    damaged.exec('DELETE FROM artifact_query_metadata');
    damaged.close();
    const missing = await inventory(f.temporary);
    const metadata = await stats(f);
    expect(metadata.completeness).toMatchObject({
      complete: false,
      issues: [expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })],
    });
    expect(metadata.coverage.unknown_projects).toEqual([f.authority.projectId]);
    expect(metadata.artifacts.total).toBe(0);
    expect(await inventory(f.temporary)).toEqual(missing);
  });

  it('rolls up every registered project under all-projects scope, including outside a repository', async () => {
    const a = await fixture();
    const b = await fixture(a.root);
    await a.capture();
    await a.capture(undefined, { cwd: a.linked });
    await b.capture();
    const before = [await inventory(a.temporary), await inventory(b.temporary)];
    const inside = await stats(a, ['--scope', 'all-projects']);
    expect(inside.projects).toHaveLength(2);
    expect(inside.artifacts.total).toBe(3);
    expect(
      inside.projects.find((project) => project.project_id === a.authority.projectId)!.artifacts
        .total
    ).toBe(2);
    const outside = await stats({ main: a.temporary, root: a.root }, ['--scope', 'all-projects']);
    expect(outside.artifacts.total).toBe(inside.artifacts.total);
    expect(outside.scope.worktree_id).toBeNull();
    expect((await stats(a, ['--project', b.authority.projectId])).artifacts.total).toBe(1);
    const retired = await agentFor(a).runRaw(['stats', '--all-projects', '--json']);
    expect(retired.exitCode).toBe(1);
    const bare = await agentFor(a, a.temporary).runRaw(['stats', '--json']);
    expect(bare.exitCode).toBe(1);
    expect(JSON.parse(bare.stdout).error.code).toBe('PROJECT_REQUIRED');
    expect([await inventory(a.temporary), await inventory(b.temporary)]).toEqual(before);
  });
});
