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
    const result = await whyOk(f, 'src/retained.ts:1', ['--details']);
    expect(result).toMatchObject({
      schema_version: 4,
      representation: 'details',
      code_revision: closeRef,
      target: { file: 'src/retained.ts', line: 1, blame: { sha: closeRef } },
      best: { artifact_id: artifactId, confidence: 'exact' },
      integrity: { selection: 'metadata', candidates: 'verified' },
    });
    expect((result.results as unknown[])[0]).toMatchObject({
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
    expect(JSON.stringify((result.results as unknown[])[0])).not.toContain('Use later context');
    const compact = await whyOk(f, 'src/retained.ts:1');
    const rich = (result.results as Array<Record<string, unknown>>)[0];
    const support = rich.plan_support as Record<string, unknown>;
    expect(compact.best).toMatchObject({
      artifact_id: artifactId,
      label: `History ${artifactId}`,
      evidence_counts: { plan_decisions: 1, checkpoint_decisions: 0, checkpoint_uncertainty: 0 },
      plan_support: {
        anchor_event_id: support.anchor_event_id,
        source_event_id: support.source_event_id,
        content_event_id: support.content_event_id,
        base_sha: openRef,
      },
    });
    expect(compact.best).not.toHaveProperty('plan_support.plan');
    expect(result.best).toEqual(rich);
    expect(result.best).toHaveProperty('label', `History ${artifactId}`);
    const human = await agentFor(f).runRaw(['why', 'src/retained.ts:1']);
    expect(human.exitCode, human.stderr).toBe(0);
    expect(human.stdout).toContain('Use the original design: It is approved');
    expect(human.stdout).toContain('--json --details');
    const humanDetails = await agentFor(f).runRaw(['why', 'src/retained.ts:1', '--details']);
    expect(humanDetails.exitCode).toBe(0);
    expect(humanDetails.stdout).toBe(human.stdout);
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
            'project_id',
            'store_instance_id',
            'source_event_id',
            'version_token',
            'confidence',
            'reasons',
            'reachability',
            'relationship',
            'provisional',
          ].map((key) => [key, row[key]])
        )
      );
    const compact = await whyOk(f, 'src/page.ts:1');
    for (const flags of [['--details'], ['--all'], ['--all', '--details']]) {
      const expanded = await whyOk(f, 'src/page.ts:1', flags);
      expect(identity(expanded)).toEqual(identity(compact));
      expect(expanded.conclusion).toBe('supported');
      expect(expanded.best).toEqual((expanded.results as unknown[])[0]);
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
    const detailed = await whyOk(f, 'src/page.ts:1', ['--details']);
    const pageDetails = await whyOk(f, 'src/page.ts:1', [
      '--details',
      '--offset',
      '1',
      '--limit',
      '1',
    ]);
    expect(pageDetails.best).toEqual((detailed.results as unknown[])[0]);
    expect(pageDetails.best).toHaveProperty('checkpoint.summary');
    expect(pageDetails.results).toEqual((detailed.results as unknown[]).slice(1));
    expect(pageDetails.source_versions).toEqual(detailed.source_versions);
    for (const flags of [[], ['--details']]) {
      const empty = await whyOk(f, 'src/page.ts:1', ['--offset', '99', ...flags]);
      expect(empty).toMatchObject({
        results: [],
        pagination: { returned: 0, next_offset: null },
        detail_omissions: { best: !flags.includes('--details') },
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
      best: { artifact_id: artifactId, confidence: 'exact', reachability: 'reachable' },
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
    const all = await whyOk(f, 'src/history.ts', ['--all']);
    const detailed = await whyOk(f, 'src/history.ts', ['--all', '--details']);
    expect(normal).toMatchObject({
      schema_version: 4,
      representation: 'compact',
      conclusion: 'ambiguous',
      best: null,
      pagination: { limit: 25, returned: 25, total: 30, next_offset: 25 },
    });
    expect(all).toMatchObject({
      representation: 'compact',
      pagination: { limit: 1000, returned: 30, total: 30, next_offset: null },
      candidate_selection: { materialized: 30, omitted: 0 },
    });
    expect(normal.results).toEqual((all.results as unknown[]).slice(0, 25));
    expect(normal.source_versions).toEqual(all.source_versions);
    expect(all.source_versions).toMatchObject({
      count: 30,
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    const next = await whyOk(f, 'src/history.ts', ['--offset', '25']);
    expect([...(normal.results as unknown[]), ...(next.results as unknown[])]).toEqual(all.results);
    expect(detailed.conclusion).toBe(all.conclusion);
    expect(detailed.results as unknown[]).toHaveLength(30);
    expect(JSON.stringify(all)).not.toContain('Recorded intent');
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
      best: { artifact_id: owner },
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
    expect(refreshed.source_versions).not.toEqual(original.source_versions);
    expect(refreshed.best).toBeNull();
    expect((followed.project_coverage as Record<string, unknown>).generation_token).not.toBe(
      (original.project_coverage as Record<string, unknown>).generation_token
    );
  });

  it('offers seed only from complete project coverage and honors a retained decline', async () => {
    const f = await fixture();
    const head = await commitFile(f, 'src/unexplained.ts', 'export const unexplained = true;\n');
    const incomplete = await whyOk(f, 'src/unexplained.ts:1');
    expect(incomplete).toMatchObject({
      best: null,
      seed_guidance: {
        state: 'suppressed',
        command: null,
        reasons: expect.arrayContaining(['PROJECT_COVERAGE_INCOMPLETE']),
      },
    });
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
      seed_guidance: { state: 'offer', command: `orcaops seed --commit ${head}` },
    });
    expect(await whyOk(f, 'src/unexplained.ts:1', ['--branch', 'main'])).toMatchObject({
      project_coverage: { complete: true },
      seed_guidance: {
        state: 'suppressed',
        command: null,
        reasons: expect.arrayContaining(['QUERY_NARROWED']),
      },
    });
    const declined = loadDatabaseSeedStateForWrite(f.writer, new Date('2026-09-09T00:00:01.000Z'));
    declined.precious.discovery_areas.src = { declined_at: null };
    await publishDatabaseSeedState(f.writer, declined);
    expect(await whyOk(f, 'src/unexplained.ts:1')).toMatchObject({
      seed_guidance: { state: 'declined', command: null },
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
    const { raw: result, body } = await why(f, 'src/corrupt.ts:1', ['--details']);
    expect(result.exitCode).toBe(0);
    expect(body).toMatchObject({
      ok: true,
      best: null,
      completeness: {
        complete: false,
        issues: expect.arrayContaining([
          expect.objectContaining({
            artifact_id: artifactId,
            code: 'HISTORY_INTEGRITY_REQUIRED',
          }),
        ]),
      },
    });
    const compact = await whyOk(f, 'src/corrupt.ts:1');
    expect(compact.results).toEqual([]);
    expect(compact).toMatchObject({
      completeness: {
        complete: false,
        issues: {
          total: (body.completeness as { issues: unknown[] }).issues.length,
          code_counts: expect.arrayContaining([
            expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' }),
          ]),
        },
      },
      detail_omissions: { shared_diagnostics: true },
    });
    expect(body).toMatchObject({ detail_omissions: { shared_diagnostics: false } });
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
