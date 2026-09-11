import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDefaultSkippedFingerprintSummary, uuidv7 } from '@orcaops/storage';
import { projectDatabasePath } from '@orcaops/storage/history/database';

import { appendProjectUsageEvents } from '../../../../packages/storage/dist/history/database/usage.js';
import { deriveUsageLedgerRecord } from '../../../../packages/storage/dist/usage/record.js';
import { fixture, git, inventory } from '../helpers/database-history.js';
import { cloudRecord } from '../support/source-plan-test-helpers.js';
import { makeAgent } from '../support/test-agent.js';

describe('registered database show', { timeout: 30_000 }, () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let agent: ReturnType<typeof makeAgent>;
  beforeEach(async () => {
    f = await fixture();
    agent = makeAgent({
      cwd: f.main,
      env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
    });
  });
  async function show(id: string, flags: string[] = []) {
    const result = await agent.runRaw(['show', id, ...flags]);
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    return result;
  }
  async function capturePinned() {
    const record = cloudRecord();
    return f.capture(undefined, {
      task: 'work under a pinned plan',
      sourcePlan: {
        source_ref: {
          kind: 'cloud',
          locator: record.external_id,
          version: String(record.version_number),
          base_url: record.base_url,
          org_id: record.org_id,
        },
        content: record.body,
        hash: record.content_hash,
        baseline: null,
      },
    });
  }
  it('renders plan decisions with provenance, reason, and rejected alternatives', async () => {
    const id = await f.capture(undefined, {
      task: 'add rate limiting',
      decisions: [
        {
          decision: 'use a sliding-window limiter',
          revision_n: 0,
          reason: 'smooths burst-at-boundary',
          alternatives_considered: [
            { option: 'fixed-window counter', rejected_because: 'allows a boundary burst' },
          ],
        },
      ],
    });
    const res = await show(id);
    expect(res.stdout).toContain('Decisions:');
    expect(res.stdout).toContain('use a sliding-window limiter  (plan rev 0)');
    expect(res.stdout).toContain('smooths burst-at-boundary');
    expect(res.stdout).toContain(
      'considered fixed-window counter — rejected because allows a boundary burst'
    );
  });
  it('renders command reports separately from the later checkpoint snapshot', async () => {
    const id = await f.capture(undefined, { task: 'Label reported evidence' });
    const head = f.context.headOid!;
    const tree = (await git(f.main, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
    const snapshotRef = `refs/orcaops/snap/${id}/1/close`;
    await git(f.main, ['update-ref', snapshotRef, head]);
    await f.mutate(id, 'A defect exists', async (draft) => {
      const plan = await draft.readPlan(id);
      const opened = await draft.writeCheckpointOpened(
        { artifact_id: id, declared_step_ids: [plan!.plan_steps[0].step_id] },
        { idempotencyKey: uuidv7(), headSha: head }
      );
      if (!('checkpoint' in opened)) throw new Error('Expected open checkpoint');
      await draft.writeCheckpointClosed(
        {
          artifact_id: id,
          n: opened.checkpoint.n,
          head_sha: head,
          summary: 'A defect exists',
          files_changed: [],
          completed_step_ids: [],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
          verification: [{ command: 'irrelevant successful command', exit_code: 0 }],
        },
        {
          idempotencyKey: uuidv7(),
          snapshotCallbacks: {
            captureCloseFingerprint: async () => ({
              boundary: {
                snapshot_ref: snapshotRef,
                tree_sha: tree,
                snapshot_commit_sha: head,
                snapshot_error_reason: null,
              },
              summary: buildDefaultSkippedFingerprintSummary(),
              manifest: null,
            }),
          },
        }
      );
    });
    const res = await show(id);
    expect(res.stdout).toContain('Agent-reported: A defect exists');
    expect(res.stdout).toContain(
      'irrelevant successful command — Agent reports command exited 0. Checkpoint subsequently closed at snapshot'
    );
    expect(res.stdout).not.toContain('ran against snapshot');
  });
  it('omits the Decisions block when the plan has no decisions', async () => {
    expect((await show(await f.capture())).stdout).not.toContain('Decisions:');
  });
  it('surfaces the content-free source_plan in show JSON', async () => {
    const out = JSON.parse((await show(await capturePinned(), ['--json'])).stdout);
    expect(out.artifact.source_plan.pinned).toBe(true);
    expect(out.artifact.source_plan.source_ref).toMatchObject({
      kind: 'cloud',
      locator: 'ext-1',
      version: '3',
    });
    expect('content' in out.artifact.source_plan).toBe(false);
  });
  it('reports a null source_plan for an unpinned artifact', async () => {
    expect(
      JSON.parse((await show(await f.capture(), ['--json'])).stdout).artifact.source_plan
    ).toBeNull();
  });
  it('renders a Source plan line for a pinned artifact', async () => {
    expect((await show(await capturePinned())).stdout).toContain('Source plan: cloud:ext-1@3');
  });
  it('omits the Source plan line for an unpinned artifact', async () => {
    expect((await show(await f.capture())).stdout).not.toContain('Source plan:');
  });
  it('reads a unique prefix across branches and retains one source sequence without application writes', async () => {
    const id = await f.capture();
    await git(f.main, ['checkout', '-qb', 'other']);
    const idempotencyKey = uuidv7();
    const ts = '2026-06-01T00:04:00.000Z';
    const totals = {
      input_tokens: 17,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const record = deriveUsageLedgerRecord({
      type: 'agent_usage_snapshot_recorded',
      ts,
      idempotency_key: idempotencyKey,
      payload: {
        snapshot_id: uuidv7(),
        idempotency_key: idempotencyKey,
        agent: 'codex',
        session_id: 'retained-session',
        artifact_id: id,
        source_plan_ref_id: null,
        lifecycle_event: 'checkpoint_close',
        checkpoint_n: 1,
        cumulative_usage: totals,
        delta_usage: null,
        baseline_kind: 'first_observation',
        model_breakdown: [{ model: 'retained-model', cumulative: totals, delta: null }],
        record_count: 1,
        as_of: ts,
      },
    }).record;
    await appendProjectUsageEvents(f.writer, {
      operationId: uuidv7(),
      expectedRevision: null,
      eventBytes: Buffer.from(JSON.stringify(record) + '\n'),
      sidecarPayloads: [],
      secretAllow: [],
    });
    const before = await inventory(f.temporary);
    const counters = f.writer.read(() => null).counters;
    const out = JSON.parse(
      (await show(id.slice(0, -1), ['--project', f.authority.projectId, '--json'])).stdout
    );
    expect(out).toMatchObject({
      schema_version: 3,
      artifact: {
        id,
        project_id: f.authority.projectId,
        branch: 'main',
        state: 'planned',
        usage: { accounting: { status: 'exact', totals }, sources: [{ counters }] },
      },
      sources: [{ counters }],
    });
    expect(out.artifact.git_context.state).toBe('available');
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('returns qualified ambiguity candidates and never decodes unrelated artifact bodies', async () => {
    const id = await f.capture();
    const other = await f.capture();
    const raw = new Database(projectDatabasePath(f.authority));
    try {
      const trigger = raw
        .prepare("SELECT sql FROM sqlite_schema WHERE name='artifact_events_no_update'")
        .get() as { sql: string };
      raw.exec('DROP TRIGGER artifact_events_no_update');
      raw
        .prepare('UPDATE artifact_events SET record_bytes=? WHERE artifact_id=?')
        .run(Buffer.from('malformed'), other);
      raw.exec(trigger.sql);
    } finally {
      raw.close();
    }
    expect(JSON.parse((await show(id, ['--json'])).stdout).artifact.id).toBe(id);
    const ambiguous = await agent.runRaw([
      'show',
      id.slice(0, 1),
      '--project',
      f.authority.projectId,
      '--json',
    ]);
    expect(ambiguous.exitCode).toBe(1);
    const out = JSON.parse(ambiguous.stdout);
    expect(out.error.code).toBe('AMBIGUOUS_ARTIFACT');
    expect(out.error.history_candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id,
          project_id: f.authority.projectId,
          command: `orcaops show ${id} --project ${f.authority.projectId}`,
        }),
        expect.objectContaining({ id: other }),
      ])
    );
  });
  it('keeps the exact artifact available outside Git and reports deleted registered history without replacing it', async () => {
    const id = await f.capture();
    const outside = path.join(f.temporary, 'outside');
    await mkdir(outside);
    const external = makeAgent({
      cwd: outside,
      env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
    });
    const result = await external.runRaw([
      'show',
      id,
      '--project',
      f.authority.projectId,
      '--json',
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).artifact).toMatchObject({
      id,
      git_context: { state: 'unavailable', reason: 'GIT_CONTEXT_UNAVAILABLE' },
      repo_state: null,
    });
    f.writer.close();
    await rm(projectDatabasePath(f.authority));
    const before = await inventory(f.temporary);
    const missing = await agent.runRaw(['show', id, '--json']);
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stdout).error.code).toBe('HISTORY_MISSING');
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('selects later related evidence from metadata without reading sibling threads', async () => {
    const id = await f.capture(undefined, { ts: '2026-06-01T00:00:00.000Z' });
    await f.recordFiles(id, ['src/shared.ts']);
    await f.mutate(id, 'Remaining work', async (draft) =>
      draft.writeSummary(
        {
          artifact_id: id,
          schema_version: 1,
          head_sha: f.context.headOid!,
          outcome: 'First work',
          tests_written: [],
          tests_run: [],
          open_items: ['Remaining work'],
          deferred_decisions: [],
          ts: '2026-06-02T00:00:00.000Z',
        },
        { idempotencyKey: uuidv7() }
      )
    );
    const later = await f.capture(undefined, { ts: '2026-06-03T00:00:00.000Z' });
    await f.recordFiles(later, ['src/shared.ts', 'src/other.ts']);
    const out = JSON.parse((await show(id, ['--json'])).stdout);
    expect(out.artifact.related_evidence).toMatchObject({
      state: 'available',
      laterArtifact: { artifact_id: later, files: ['src/shared.ts'] },
    });
    expect(out.artifact.repo_state.open_items_addressed_since).toContainEqual({
      item: 'Remaining work',
      evidence: { kind: 'later_artifact', artifact_id: later, files: ['src/shared.ts'] },
    });
    expect(out.artifact.related_evidence.laterArtifact.revision.generation).toBeGreaterThan(0);
  });
});
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('rejects unsupported exact selectors before initializing history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'show-refusal-'));
  roots.push(root);
  const agent = makeAgent({
    cwd: root,
    env: { ORCAOPS_DATA_DIR: path.join(root, 'history'), ORCAOPS_DISABLE_DRAIN: '1' },
  });
  const before = await inventory(root);
  for (const flags of [
    ['--scope', 'all-projects'],
    ['--branch', 'main'],
    ['--origin', 'all'],
    ['--project', 'invalid'],
  ])
    expect((await agent.runRaw(['show', uuidv7(), '--json', ...flags])).exitCode).not.toBe(0);
  expect(await inventory(root)).toEqual(before);
});
