import Database from 'better-sqlite3';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { projectDatabasePath } from '@orcaops/storage/history/database';
import { digest } from '@orcaops/storage/history/primitives';
import { createTempRepo } from '@orcaops/test-harness';

import {
  loadDatabaseSeedStateForWrite,
  publishDatabaseSeedState,
} from '../../src/lib/database-seed-state.js';
import { closeFingerprintedCheckpoint, commitFile } from '../helpers/database-fingerprint.js';
import { fixture, git, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

function agentFor(f: Fixture) {
  return makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
}

async function why(f: Fixture, target: string, flags: string[] = []) {
  const raw = await agentFor(f).runRaw(['why', target, ...flags, '--json']);
  return { raw, body: JSON.parse(raw.stdout) as Record<string, unknown> };
}

async function whyOk(f: Fixture, target: string, flags: string[] = []) {
  const { raw, body } = await why(f, target, flags);
  expect(raw.exitCode, raw.stderr || raw.stdout).toBe(0);
  return body;
}

describe('registered database why', { timeout: 90_000 }, () => {
  it('attributes an exact line with the original open-plan revision and source plan', async () => {
    const f = await fixture();
    const openRef = f.context.headOid!;
    const sourcePlan = {
      source_ref: { kind: 'local' as const, locator: '/removed/approved-plan.md' },
      content: 'Use the approved implementation boundary.',
      hash: digest('Use the approved implementation boundary.'),
      baseline: null,
    };
    const artifactId = await f.capture(undefined, {
      cwd: f.linked,
      sourcePlan,
      decisions: [{ decision: 'Use the original design', reason: 'It is approved', revision_n: 0 }],
    });
    const closeRef = await commitFile(
      f,
      'src/retained.ts',
      'export const retainedImplementation = true;\n'
    );
    await closeFingerprintedCheckpoint(f, artifactId, {
      files: ['src/retained.ts'],
      openRef,
      closeRef,
      summary: 'Implemented the approved design',
    });
    await f.mutate(artifactId, { rationale: 'Later context' }, async (semantics) => {
      const plan = await semantics.readPlan(artifactId);
      await semantics.revisePlan(
        {
          idempotency_key: uuidv7(),
          artifact_id: artifactId,
          label: 'Later design label',
          plan_steps: plan!.plan_steps,
          touched_scope: plan!.touched_scope,
          non_goals: plan!.non_goals,
          decisions: [{ decision: 'Use later context', reason: 'New information' }],
          rationale: 'Recorded after the checkpoint',
          prior_plan_event_id: null,
          acknowledge_drops_completed_steps: [],
          acknowledge_criteria_changes: [],
        },
        { idempotencyKey: uuidv7() }
      );
    });
    await git(f.main, ['worktree', 'remove', '--force', f.linked]);
    const before = await inventory(f.temporary);
    const result = await whyOk(f, 'src/retained.ts:1', ['--details', '--audit']);
    expect(result).toMatchObject({
      schema_version: 8,
      representation: 'details',
      code_revision: closeRef,
      target: { file: 'src/retained.ts', line: 1, blame: { sha: closeRef } },
      best: expect.stringContaining(`${artifactId}:`),
      diagnostics: { integrity: { selection: 'metadata', candidates: 'verified' } },
    });
    const audit = result.audit as { candidates: Array<Record<string, unknown>> };
    expect(audit.candidates[0]).toMatchObject({
      artifact_id: artifactId,
      source_plan: sourcePlan,
      confidence: 'exact',
      plan_support: {
        plan: {
          revision_n: 0,
          decisions: [
            { decision: 'Use the original design', reason: 'It is approved', revision_n: 0 },
          ],
        },
      },
    });
    expect(JSON.stringify(audit.candidates[0])).not.toContain('Use later context');
    const compact = await whyOk(f, 'src/retained.ts:1');
    const rich = audit.candidates[0]!;
    expect((compact.results as unknown[])[0]).toMatchObject({
      artifact_id: artifactId,
      label: `History ${artifactId}`,
      confidence: 'exact',
      evidence: { plan: 'available' },
    });
    expect((compact.results as unknown[])[0]).not.toHaveProperty('plan_support');
    expect(result.best).toBe(`${artifactId}:${rich.source_event_id}`);
    const human = await agentFor(f).runRaw(['why', 'src/retained.ts:1']);
    expect(human.exitCode, human.stderr).toBe(0);
    expect(human.stdout).toContain('Use the original design');
    expect(human.stdout).toContain('Reason: It is approved');
    expect(human.stdout).toContain('--details --candidate');
    const humanDetails = await agentFor(f).runRaw([
      'why',
      'src/retained.ts:1',
      '--details',
      '--audit',
    ]);
    expect(humanDetails.exitCode).toBe(0);
    expect(humanDetails.stdout).toContain('Use the original design');
    expect(humanDetails.stdout).toContain('Reason: It is approved');
    expect(human.stdout).not.toContain('orcaops show <artifact_id>');
    expect(humanDetails.stdout).toContain('Only if anchored audit evidence lacks');
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('preserves attribution across output modes and identifies an off-page best', async () => {
    const f = await fixture();
    const openRef = f.context.headOid!;
    const artifactId = await f.capture();
    const closeRef = await commitFile(
      f,
      'src/page.ts',
      'export const paginationEvidence = true;\n'
    );
    await closeFingerprintedCheckpoint(f, artifactId, {
      files: ['src/page.ts'],
      openRef,
      closeRef,
    });
    const identity = (result: Record<string, unknown>) =>
      (result.results as Array<Record<string, unknown>>).map((row) =>
        Object.fromEntries(
          [
            'artifact_id',
            'source_event_id',
            'confidence',
            'reasons',
            'reachability',
            'relationship',
            'evidence',
          ].map((key) => [key, row[key]])
        )
      );
    const compact = await whyOk(f, 'src/page.ts:1');
    for (const flags of [['--details', '--audit'], ['--all'], ['--all', '--details', '--audit']]) {
      const expanded = await whyOk(f, 'src/page.ts:1', flags);
      expect(identity(expanded)).toEqual(identity(compact));
      expect(expanded.conclusion).toBe('supported');
      expect(expanded.best).toEqual((expanded.results as Array<{ id: string }>)[0]!.id);
      expect(expanded).not.toHaveProperty('best_result_offset');
      expect(expanded).not.toHaveProperty('best_follow_up');
    }
    const page = await whyOk(f, 'src/page.ts:1', ['--offset', '1', '--limit', '1']);
    expect(page.best).toEqual(compact.best);
    expect(page).toMatchObject({
      pagination: {
        offset: 1,
        returned: 1,
        total: 2,
        next_offset: null,
        total_basis: 'evaluated_matches',
      },
    });
    const detailed = await whyOk(f, 'src/page.ts:1', ['--details', '--audit']);
    const pageDetails = await whyOk(f, 'src/page.ts:1', [
      '--details',
      '--audit',
      '--offset',
      '1',
      '--limit',
      '1',
    ]);
    expect(pageDetails.best).toEqual((detailed.results as Array<{ id: string }>)[0]!.id);
    expect(pageDetails.best_candidate).toMatchObject({ confidence: 'exact', checkpoint: 1 });
    expect(pageDetails.results).toEqual((detailed.results as unknown[]).slice(1));
    expect((pageDetails.audit as { source_versions: unknown }).source_versions).toEqual(
      (detailed.audit as { source_versions: unknown }).source_versions
    );
    for (const flags of [[], ['--details', '--audit']]) {
      const empty = await whyOk(f, 'src/page.ts:1', ['--offset', '99', ...flags]);
      expect(empty).toMatchObject({
        results: [],
        pagination: { returned: 0, next_offset: null },
        best_candidate: { confidence: 'exact' },
      });
      expect(empty.best).toEqual(flags.includes('--details') ? detailed.best : compact.best);
    }
  });

  it('displays the next results page when following human pagination guidance', async () => {
    const f = await fixture();
    const openRef = f.context.headOid!;
    const artifactId = await f.capture();
    const closeRef = await commitFile(
      f,
      'src/page.ts',
      'export const paginationEvidence = true;\n'
    );
    await closeFingerprintedCheckpoint(f, artifactId, {
      files: ['src/page.ts'],
      openRef,
      closeRef,
    });
    const agent = agentFor(f);
    const first = await agent.runRaw(['why', 'src/page.ts:1', '--limit', '1']);
    expect(first.exitCode, first.stderr || first.stdout).toBe(0);
    expect(first.stdout).toContain(`${artifactId} checkpoint 1:`);
    const hint = first.stdout.match(/More evaluated results: repeat with (.+)/);
    expect(hint).not.toBeNull();
    const flags = hint![1]!.trim().split(/\s+/);
    const next = await agent.runRaw(['why', 'src/page.ts:1', ...flags]);
    expect(next.exitCode, next.stderr || next.stdout).toBe(0);
    expect(next.stdout).toContain(`${artifactId} plan:`);
    expect(next.stdout).not.toContain(`${artifactId} checkpoint 1:`);
    expect(next.stdout).toContain(
      `Best match outside this page: ${artifactId}; checkpoint 1; exact`
    );
    expect(next.stdout).not.toContain('More evaluated results:');
    expect(await whyOk(f, 'src/page.ts:1', flags)).toMatchObject({
      pagination: { offset: 1, limit: 1, returned: 1, next_offset: null },
    });
  });

  it('resolves an exact historical target without mixing the current checkout', async () => {
    const f = await fixture();
    const openRef = f.context.headOid!;
    const artifactId = await f.capture();
    const retained = await commitFile(f, 'src/history.ts', 'export const state = "retained";\n');
    await closeFingerprintedCheckpoint(f, artifactId, {
      files: ['src/history.ts'],
      openRef,
      closeRef: retained,
    });
    const current = await commitFile(f, 'src/history.ts', 'export const state = "current";\n');
    await writeFile(path.join(f.main, 'src/history.ts'), 'export const state = "local";\n');
    const before = await inventory(f.temporary);
    const result = await whyOk(f, 'src/history.ts:1', ['--at', retained]);
    expect(result).toMatchObject({
      code_revision: retained,
      target: { selection: 'revision', dirty: false, blame: { sha: retained } },
      results: expect.arrayContaining([
        expect.objectContaining({
          artifact_id: artifactId,
          confidence: 'exact',
          reachability: 'reachable',
        }),
      ]),
    });
    expect(result.code_revision).not.toBe(current);
    expect(await whyOk(f, 'src/history.ts:1')).toMatchObject({
      target: { selection: 'current', dirty: true, blame: { status: 'uncommitted' } },
    });
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('pages whole-file history using the same compact schema with and without all', async () => {
    const f = await fixture();
    await commitFile(f, 'src/history.ts', 'export const historyEvidence = true;\n');
    for (let i = 0; i < 30; i++)
      await f.capture(undefined, { task: `Recorded intent ${i} ` + 'context '.repeat(2048) });
    const normal = await whyOk(f, 'src/history.ts');
    const oversized = await why(f, 'src/history.ts', ['--all']);
    expect(oversized.raw.exitCode).not.toBe(0);
    expect(oversized.raw.stdout).toContain('Reduce --limit');
    expect(Buffer.byteLength(oversized.raw.stdout)).toBeLessThanOrEqual(16_384);
    const all = await whyOk(f, 'src/history.ts', ['--all', '--limit', '5']);
    const detailed = await whyOk(f, 'src/history.ts', ['--all', '--details', '--audit']);
    expect(normal).toMatchObject({
      schema_version: 8,
      representation: 'compact',
      conclusion: 'ambiguous',
      best: null,
      pagination: { limit: 5, total: 30 },
    });
    expect(all).toMatchObject({
      representation: 'compact',
      pagination: { limit: 5, total: 30 },
      diagnostics: { candidate_selection: { omitted: 0, complete: true } },
    });
    expect(normal.results).toEqual(all.results);
    const firstRows = normal.results as unknown[];
    expect(firstRows.length).toBeGreaterThan(0);
    expect(firstRows.length).toBe(5);
    expect(normal.pagination).toMatchObject({
      returned: firstRows.length,
      next_offset: firstRows.length,
    });
    expect(Buffer.byteLength(JSON.stringify({ ok: true, ...all })) + 1).toBeLessThanOrEqual(16_384);
    expect(normal).not.toHaveProperty('source_versions');
    expect((detailed.audit as { source_versions: unknown[] }).source_versions).toHaveLength(30);
    const next = await whyOk(f, 'src/history.ts', ['--offset', String(firstRows.length)]);
    expect(next.pagination).toMatchObject({ offset: firstRows.length });
    expect(
      (next.results as { artifact_id: string }[]).some((row) =>
        (firstRows as { artifact_id: string }[]).some(
          (first) => first.artifact_id === row.artifact_id
        )
      )
    ).toBe(false);
    expect(detailed.conclusion).toBe(all.conclusion);
    expect((detailed.results as unknown[]).length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify({ ok: true, ...detailed })) + 1).toBeLessThanOrEqual(
      65_536
    );
    for (const row of all.results as {
      historical_task: { text: string; truncated: boolean };
      plan_support: object;
    }[]) {
      expect(row.historical_task.text.length).toBeLessThanOrEqual(240);
      expect(row.historical_task.truncated).toBe(true);
      expect(row).not.toHaveProperty('plan_support');
    }
    expect(JSON.stringify(detailed)).toContain('Recorded intent');
  });

  it('keeps ambiguous best null with one detail row after history changes', async () => {
    const f = await fixture();
    const openRef = f.context.headOid!;
    const owner = await f.capture();
    const closeRef = await commitFile(
      f,
      'src/current.ts',
      'export const currentEvidence = true;\n'
    );
    await closeFingerprintedCheckpoint(f, owner, { files: ['src/current.ts'], openRef, closeRef });
    const original = await whyOk(f, 'src/current.ts:1', ['--at', closeRef, '--offset', '1']);
    expect(original).toMatchObject({
      conclusion: 'supported',
      best_candidate: { artifact_id: owner },
    });
    const sibling = await f.capture();
    await closeFingerprintedCheckpoint(f, sibling, {
      files: ['src/current.ts'],
      openRef,
      closeRef,
    });
    const followed = await whyOk(f, 'src/current.ts:1', [
      '--at',
      closeRef,
      '--details',
      '--audit',
      '--offset',
      '0',
      '--limit',
      '1',
    ]);
    expect(followed.code_revision).toBe(original.code_revision);
    expect(followed).toMatchObject({
      conclusion: 'ambiguous',
      best: null,
    });
    expect(followed.results).toHaveLength(1);
    const refreshed = await whyOk(f, 'src/current.ts:1', ['--at', closeRef, '--limit', '1']);
    expect(refreshed.best).toBeNull();
    expect(
      (refreshed.context as { observation_ceiling: number }).observation_ceiling
    ).toBeGreaterThan((original.context as { observation_ceiling: number }).observation_ceiling);
  });

  it('offers seed only from complete project coverage and honors a retained decline', async () => {
    const f = await fixture();
    const head = await commitFile(f, 'src/unexplained.ts', 'export const unexplained = true;\n');
    const incomplete = await whyOk(f, 'src/unexplained.ts:1');
    expect(incomplete).toMatchObject({
      best: null,
      diagnostics: {
        project_coverage: { complete: false },
      },
    });
    expect((incomplete.diagnostics as Record<string, unknown>).seed_guidance).toBeUndefined();
    const state = loadDatabaseSeedStateForWrite(f.writer, new Date('2026-09-09T00:00:00.000Z'));
    state.coverage = {
      schema_version: 1,
      branch_sha: head,
      generated_at: '2026-09-09T00:00:00.000Z',
      complete: true,
      directories: { src: { covered_lines: 0, total_lines: 1, percent: 0 } },
    };
    await publishDatabaseSeedState(f.writer, state);
    const offered = await whyOk(f, 'src/unexplained.ts:1');
    expect(offered).toMatchObject({
      diagnostics: { seed_guidance: { state: 'offer', command: `orcaops seed --commit ${head}` } },
    });
    const narrowed = await whyOk(f, 'src/unexplained.ts:1', ['--branch', 'main']);
    expect(narrowed).toMatchObject({
      diagnostics: {
        project_coverage: { complete: true },
      },
    });
    expect((narrowed.diagnostics as Record<string, unknown>).seed_guidance).toBeUndefined();
    const declined = loadDatabaseSeedStateForWrite(f.writer, new Date('2026-09-09T00:00:01.000Z'));
    declined.precious.discovery_areas.src = { declined_at: null };
    await publishDatabaseSeedState(f.writer, declined);
    expect(await whyOk(f, 'src/unexplained.ts:1')).toMatchObject({
      diagnostics: { seed_guidance: { state: 'declined', command: null } },
    });
  });

  it('refuses missing history without initializing the repository', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const dataRoot = path.join(repo.path, 'data');
      const before = await inventory(repo.path);
      const raw = await makeAgent({
        cwd: repo.path,
        env: { ORCAOPS_DATA_DIR: dataRoot, ORCAOPS_DISABLE_DRAIN: '1' },
      }).runRaw(['why', 'src/missing.ts:1', '--json']);
      expect(raw.exitCode).toBe(1);
      expect(JSON.parse(raw.stdout)).toMatchObject({
        ok: false,
        error: { code: expect.any(String) },
      });
      expect(await inventory(repo.path)).toEqual(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('reports a corrupt retained candidate as incomplete without repairing project history', async () => {
    const f = await fixture();
    const openRef = f.context.headOid!;
    const artifactId = await f.capture();
    const closeRef = await commitFile(f, 'src/corrupt.ts', 'export const corrupt = true;\n');
    await closeFingerprintedCheckpoint(f, artifactId, {
      files: ['src/corrupt.ts'],
      openRef,
      closeRef,
    });
    const raw = new Database(projectDatabasePath(f.authority));
    try {
      const trigger = raw
        .prepare("SELECT sql FROM sqlite_schema WHERE name='artifact_revisions_no_update'")
        .get() as { sql: string };
      raw.exec('DROP TRIGGER artifact_revisions_no_update');
      raw
        .prepare('UPDATE artifact_revisions SET ordered_hash=? WHERE artifact_id=?')
        .run('0'.repeat(64), artifactId);
      raw.exec(trigger.sql);
    } finally {
      raw.close();
    }
    const before = await inventory(f.temporary);
    const { raw: result, body } = await why(f, 'src/corrupt.ts:1', ['--details', '--audit']);
    expect(result.exitCode).toBe(0);
    expect(body).toMatchObject({
      ok: true,
      best: null,
      diagnostics: {
        completeness: {
          complete: false,
          issues: {
            items: expect.arrayContaining([
              expect.objectContaining({
                code: 'HISTORY_INTEGRITY_REQUIRED',
                occurrences: 1,
              }),
            ]),
          },
        },
      },
      audit: {
        diagnostics: {
          completeness: expect.arrayContaining([
            expect.objectContaining({
              artifact_id: artifactId,
              code: 'HISTORY_INTEGRITY_REQUIRED',
            }),
          ]),
        },
      },
    });
    const compact = await whyOk(f, 'src/corrupt.ts:1');
    expect(compact.results).toEqual([]);
    expect(compact).toMatchObject({
      diagnostics: {
        completeness: {
          complete: false,
          issues: {
            omitted: 0,
            items: expect.arrayContaining([
              expect.objectContaining({
                code: 'HISTORY_INTEGRITY_REQUIRED',
                occurrences: (body.diagnostics as { completeness: { issues: { total: number } } })
                  .completeness.issues.total,
              }),
            ]),
          },
        },
      },
    });
    expect(body).toHaveProperty('audit');
    expect(compact).not.toHaveProperty('audit');
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
