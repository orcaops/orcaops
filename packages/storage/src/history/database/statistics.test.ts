import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type ArtifactDraftSemantics,
  prepareArtifactDraft,
} from '../../artifacts/draft-preparation.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import type { PlanInput } from '../../schema/plan.js';
import type { AgentUsageSnapshotPayload } from '../../schema/usage-ledger.js';
import { deriveUsageLedgerRecord } from '../../usage/record.js';
import { normalizeHistoryRoot } from '../paths.js';
import { appendProjectArtifactEvents, readProjectArtifact } from './artifacts.js';
import { publishProjectLifecycleCompletion } from './capture-lifecycles.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import { readProjectStepMembership } from './plan-step-membership.js';
import { rebuildProjectQueryMetadata } from './query-metadata-rebuild.js';
import { prepareArtifactStatistics } from './query-statistics.js';
import { readProjectStatistics } from './statistics.js';
import { appendProjectUsageEvents, readProjectUsage } from './usage.js';

const ts = '2026-06-01T00:00:00.000Z';
const head = 'a'.repeat(40);
const legacyStep = 'original non-UUID step';
const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type CloseOutcome = {
  kind: 'close';
  completed?: string[];
  uncertainty?: string[];
  decisions?: { decision: string; reason: string }[];
  files?: string[];
  closedAt?: string;
};
type CheckpointOutcome = { kind: 'open' } | { kind: 'abandon' } | CloseOutcome;

async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'statistics-read-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
  const writer = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: ts,
    authorize() {},
  });
  handles.push(writer);
  async function mutate<T>(
    artifactId: string,
    payload: unknown,
    callback: (semantics: ArtifactDraftSemantics) => Promise<T>
  ): Promise<T> {
    const retained = readProjectArtifact(writer, artifactId);
    const draft = await prepareArtifactDraft(
      {
        artifactId,
        priorEvents: retained?.thread.events ?? [],
        authoredPayload: payload,
        secretAllow: [],
        idempotencyBlocks: [],
      },
      callback
    );
    if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
    if (draft.idempotencyChanges.length) throw new Error('Fixture mutation was refused');
    if (draft.events.length)
      await appendProjectArtifactEvents(writer, {
        artifactId,
        operationId: uuidv7(),
        expectedRevision: retained?.revision ?? null,
        eventBytes: Buffer.concat(draft.events.map((event) => event.eventBytes)),
        sidecarPayloads: draft.events.flatMap((event) =>
          event.sidecar ? [{ eventId: event.record.event_id, bytes: event.sidecar.bytes }] : []
        ),
        secretAllow: [],
      });
    return draft.evaluation.value;
  }
  async function capture(steps: string[], options: { imported?: boolean; branch?: string } = {}) {
    const artifactId = uuidv7();
    const plan: PlanInput = {
      schema_version: 4,
      artifact_id: artifactId,
      branch: options.branch ?? 'main',
      base_sha: head,
      agent: 'codex',
      agent_session_id: null,
      task: 'Retain statistics inputs',
      label: `Statistics ${artifactId.slice(0, 8)}`,
      plan_steps: steps.map((step_id, index) => ({
        step_id,
        text: `Retain step ${index + 1}`,
        label: `Retain step ${index + 1}`,
        acceptance_criteria: [],
      })),
      touched_scope: [],
      non_goals: [],
      decisions: [],
      started_at: ts,
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
      prior_plan_event_id: null,
      ...(options.imported
        ? {
            origin: {
              kind: 'git-import' as const,
              imported_at: ts,
              tool_version: 'test',
              source_range: 'HEAD',
              authors: ['Test'],
              enriched_at: null,
            },
          }
        : {}),
    };
    await mutate(artifactId, plan, (semantics) =>
      semantics.writePlan(plan, { idempotencyKey: uuidv7() })
    );
    return artifactId;
  }
  function checkpoint(artifactId: string, declared: string[], outcome: CheckpointOutcome) {
    return mutate(artifactId, { declared }, async (semantics) => {
      const opened = await semantics.writeCheckpointOpened(
        { artifact_id: artifactId, declared_step_ids: declared },
        { idempotencyKey: uuidv7(), headSha: head, openedAt: ts }
      );
      if (opened.outcome !== 'created') throw new Error('Fixture checkpoint did not open');
      const n = opened.checkpoint.n;
      if (outcome.kind === 'abandon')
        return semantics.writeCheckpointAbandoned(
          { artifact_id: artifactId, n, reason: 'Fixture abandonment' },
          { idempotencyKey: uuidv7() }
        );
      if (outcome.kind === 'close')
        return semantics.writeCheckpointClosed(
          {
            artifact_id: artifactId,
            n,
            head_sha: head,
            summary: 'Fixture close',
            files_changed: outcome.files ?? [],
            decisions: outcome.decisions ?? [],
            uncertainty: outcome.uncertainty ?? [],
            done_criteria: [],
            completed_step_ids: outcome.completed ?? [],
            verification: outcome.completed?.length ? [{ command: 'fixture', exit_code: 0 }] : [],
          },
          { idempotencyKey: uuidv7(), closedAt: outcome.closedAt }
        );
      return opened;
    });
  }
  function summarize(artifactId: string) {
    const summary = {
      schema_version: 1 as const,
      artifact_id: artifactId,
      outcome: 'Fixture outcome',
      tests_written: [],
      tests_run: [],
      open_items: [],
      deferred_decisions: [],
      head_sha: head,
      ts: '2026-06-01T01:00:00.000Z',
    };
    return mutate(artifactId, summary, (semantics) =>
      semantics.writeSummary(summary, { idempotencyKey: uuidv7() })
    );
  }
  function evaluatorRun(
    artifactId: string,
    run: {
      phase: 'checkpoint-close' | 'pre-pr';
      status: 'completed' | 'skipped';
      verdict: 'pass' | 'violation' | null;
    }
  ) {
    return mutate(artifactId, { run }, (semantics) =>
      semantics.writeEvaluatorRunPayload(artifactId, {
        schema: 'orcaops.evaluator_run/v1',
        run_id: uuidv7(),
        artifact_id: artifactId,
        evaluator_ref: 'test/retained',
        package_id: 'test',
        evaluator_id: 'retained',
        phase: run.phase,
        severity: 'warn',
        run_status: run.status,
        verdict: run.verdict,
        body: run.verdict === 'violation' ? 'VIOLATION\n\nRetained' : 'PASS\n\nRetained',
        ts: '2026-06-01T00:05:00.000Z',
      })
    );
  }
  async function prePrCompletion(artifactId: string) {
    const bytes = Buffer.from(' {"fires_at":"pre-pr","cp_n":0,"triggered_at":"original time"}\n');
    await publishProjectLifecycleCompletion(
      writer,
      {
        artifactId,
        operationId: uuidv7(),
        revisionId: uuidv7(),
        artifactRevision: readProjectArtifact(writer, artifactId)!.revision,
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
  async function usage(artifactId: string | null, sessionId: string, tokens: number) {
    const scalars = {
      input_tokens: tokens,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const payload: AgentUsageSnapshotPayload = {
      snapshot_id: uuidv7(),
      idempotency_key: uuidv7(),
      agent: 'codex',
      session_id: sessionId,
      artifact_id: artifactId,
      source_plan_ref_id: null,
      lifecycle_event: 'plan',
      checkpoint_n: null,
      cumulative_usage: scalars,
      delta_usage: null,
      baseline_kind: 'first_observation',
      model_breakdown: [{ model: 'model', cumulative: scalars, delta: null }],
      record_count: 1,
      as_of: ts,
    };
    const record = deriveUsageLedgerRecord({
      type: 'agent_usage_snapshot_recorded',
      ts,
      idempotency_key: payload.idempotency_key,
      payload,
    }).record;
    await appendProjectUsageEvents(writer, {
      operationId: uuidv7(),
      expectedRevision: readProjectUsage(writer)?.revision ?? null,
      eventBytes: Buffer.from(JSON.stringify(record) + '\n'),
      sidecarPayloads: [],
      secretAllow: [],
    });
  }
  return {
    authority,
    writer,
    mutate,
    capture,
    checkpoint,
    summarize,
    evaluatorRun,
    prePrCompletion,
    usage,
  };
}

/**
 * Two captured artifacts and one imported artifact: every checkpoint status,
 * both hygiene extremes, a revised plan that drops a legacy identifier that
 * the imported artifact also carries, one zero-run pre-PR completion and
 * associated plus unassociated usage sessions.
 */
async function populated() {
  const f = await fixture();
  const steps = { a: [uuidv7(), uuidv7(), uuidv7()], b: [legacyStep, uuidv7()] };
  const a = await f.capture(steps.a);
  await f.checkpoint(a, [steps.a[0]], {
    kind: 'close',
    completed: [steps.a[0]],
    uncertainty: ['Retained uncertainty'],
    decisions: [{ decision: 'Retained decision', reason: 'Retained reason' }],
    files: ['retained.ts'],
    closedAt: '2026-06-01T00:10:00.000Z',
  });
  await f.checkpoint(a, [steps.a[1]], { kind: 'close', closedAt: '2026-06-01T00:30:00.000Z' });
  await f.checkpoint(a, [steps.a[2]], { kind: 'abandon' });
  await f.evaluatorRun(a, { phase: 'checkpoint-close', status: 'completed', verdict: 'pass' });
  await f.evaluatorRun(a, { phase: 'checkpoint-close', status: 'completed', verdict: 'violation' });
  await f.evaluatorRun(a, { phase: 'pre-pr', status: 'skipped', verdict: null });
  await f.summarize(a);
  await f.checkpoint(a, [steps.a[2]], { kind: 'open' });
  await f.prePrCompletion(a);

  const b = await f.capture(steps.b);
  await f.checkpoint(b, [steps.b[1]], { kind: 'close', closedAt: '2026-06-01T00:20:00.000Z' });
  const revision = {
    idempotency_key: uuidv7(),
    artifact_id: b,
    label: 'Revised retained plan',
    plan_steps: [
      {
        step_id: steps.b[1],
        text: 'Retain step 2',
        label: 'Retain step 2',
        acceptance_criteria: [],
      },
      {
        text: 'Added step',
        label: 'Added step',
        acceptance_criteria: [{ text: 'the added step is observable' }],
      },
    ],
    touched_scope: [],
    non_goals: [],
    decisions: [],
    rationale: 'The legacy step was dropped',
    prior_plan_event_id: null,
    acknowledge_drops_completed_steps: [],
    acknowledge_criteria_changes: [],
  };
  await f.mutate(b, revision, (semantics) =>
    semantics.revisePlan(revision, { idempotencyKey: revision.idempotency_key })
  );
  const added = readProjectArtifact(f.writer, b)!.thread.plan!.plan_steps.find(
    (step) => step.label === 'Added step'
  )!.step_id;
  await f.summarize(b);
  await f.checkpoint(b, [added], { kind: 'open' });

  const c = await f.capture([legacyStep, uuidv7()], { imported: true });
  await f.checkpoint(c, [legacyStep], { kind: 'close', closedAt: '2026-06-01T00:40:00.000Z' });
  await f.summarize(c);

  await f.usage(a, 'session-a', 10);
  await f.usage(c, 'session-c', 20);
  await f.usage(null, 'session-unassociated', 40);
  return { ...f, a, b, c, steps: { ...steps, added } };
}

function tables(handle: ProjectDatabase) {
  const db = new Database(handle.databasePath, { readonly: true });
  try {
    return (
      db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map(({ name }) => [
      name,
      (db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() as object[]).map((row) =>
        JSON.stringify(row, (_key, value: unknown) =>
          Buffer.isBuffer(value) ? value.toString('hex') : value
        )
      ),
    ]);
  } finally {
    db.close();
  }
}
function statementsDuring<T>(read: () => T): { value: T; sql: string[] } {
  const sql: string[] = [];
  const prepare = Database.prototype.prepare;
  const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    source: string
  ) {
    sql.push(source);
    return prepare.call(this, source);
  });
  try {
    return { value: read(), sql };
  } finally {
    spy.mockRestore();
  }
}
/** Corpus hydration reads original artifact event bytes; metadata, lifecycle and usage rows are not corpus. */
function hydratesArtifactEvents(source: string): boolean {
  return source.includes('artifact_events') && /record_bytes|sidecar_payload_bytes/u.test(source);
}
function dropTriggers(file: string, tables: string[], apply: (db: Database.Database) => void) {
  const db = new Database(file);
  try {
    const triggers = db
      .prepare(
        `SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name IN (${tables.map(() => '?').join(',')})`
      )
      .all(...tables) as { name: string; sql: string }[];
    for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
    apply(db);
    for (const trigger of triggers) db.exec(trigger.sql);
  } finally {
    db.close();
  }
}

describe('scoped project statistics', () => {
  it('reads every retained statistic, lifecycle completion and session in one passive snapshot', async () => {
    const f = await populated();
    const before = tables(f.writer);
    const counters = f.writer.read(() => null).counters;
    const exec = vi.spyOn(Database.prototype, 'exec');
    const { value: result, sql } = statementsDuring(() => readProjectStatistics(f.writer));
    expect(exec.mock.calls.filter(([source]) => /^BEGIN/iu.test(source))).toHaveLength(1);
    expect(result.counters).toEqual(counters);
    expect(sql.some(hydratesArtifactEvents)).toBe(false);
    expect(sql.some((source) => source.includes('artifact_lifecycle_revisions'))).toBe(true);
    expect(result.artifacts.map(({ row }) => row.artifactId)).toEqual([f.a, f.b, f.c].sort());
    expect(result.counts).toEqual({ captured: 2, imported: 1 });
    expect(result.filtered).toBe(false);
    expect(result.issues).toEqual([]);
    const byId = new Map(result.artifacts.map((artifact) => [artifact.row.artifactId, artifact]));
    const a = byId.get(f.a)!;
    expect(a.details.statistics).toEqual({
      maximumPlanRevision: 0,
      checkpointCounts: { open: 1, closed: 2, abandoned: 1 },
      closedIntervals: [
        { n: 1, openedAt: ts, closedAt: '2026-06-01T00:10:00.000Z' },
        { n: 2, openedAt: ts, closedAt: '2026-06-01T00:30:00.000Z' },
      ],
      closedWithoutCompletedSteps: 1,
      closedWithoutUncertainty: 1,
      closedWithoutDecisions: 1,
      closedWithoutFiles: 1,
    });
    expect(a.details.evaluatorRuns.map((run) => [run.phase, run.run_status, run.verdict])).toEqual([
      ['checkpoint-close', 'completed', 'pass'],
      ['checkpoint-close', 'completed', 'violation'],
      ['pre-pr', 'skipped', null],
    ]);
    expect(a.lifecycles!.map((record) => record.record)).toEqual([
      { fires_at: 'pre-pr', cp_n: 0, triggered_at: 'original time' },
    ]);
    expect(a.row.state).toBe('summarized');
    const b = byId.get(f.b)!;
    expect(b.details.statistics).toMatchObject({
      maximumPlanRevision: 1,
      checkpointCounts: { open: 1, closed: 1, abandoned: 0 },
      closedWithoutCompletedSteps: 1,
    });
    expect(b.details.historicalStepCount).toBe(3);
    expect(b.lifecycles).toEqual([]);
    expect(byId.get(f.c)!.row.origin).toBe('git-import');
    expect(byId.get(f.c)!.details.origin?.kind).toBe('git-import');
    for (const artifact of result.artifacts)
      expect(artifact.details.statistics).toEqual(
        prepareArtifactStatistics(readProjectArtifact(f.writer, artifact.row.artifactId)!.thread)
          .statistics
      );
    expect(result.usage).toMatchObject({ projectId: f.authority.projectId });
    expect(result.usage!.artifactIds).toBeUndefined();
    expect(result.sessions.map((session) => session.sessionId).sort()).toEqual([
      'session-a',
      'session-c',
      'session-unassociated',
    ]);
    expect(tables(f.writer)).toEqual(before);
  });

  it('supplies the six hygiene inputs over captured artifacts with the zero-run pre-PR completion', async () => {
    const f = await populated();
    const result = readProjectStatistics(f.writer);
    const captured = result.artifacts.filter((artifact) => artifact.row.origin === 'captured');
    const finished = captured.filter((artifact) => artifact.row.completedAt !== null);
    const hygiene = {
      open_checkpoints_on_finished_artifacts: finished.reduce(
        (sum, artifact) => sum + artifact.details.statistics.checkpointCounts.open,
        0
      ),
      summaries_without_pre_pr_run: finished.filter(
        (artifact) => !artifact.lifecycles!.some((record) => record.record.fires_at === 'pre-pr')
      ).length,
      closed_cp_without_completed_steps: captured.reduce(
        (sum, artifact) => sum + artifact.details.statistics.closedWithoutCompletedSteps,
        0
      ),
      closed_cp_without_uncertainty: captured.reduce(
        (sum, artifact) => sum + artifact.details.statistics.closedWithoutUncertainty,
        0
      ),
      closed_cp_without_decisions: captured.reduce(
        (sum, artifact) => sum + artifact.details.statistics.closedWithoutDecisions,
        0
      ),
      closed_cp_without_files_changed: captured.reduce(
        (sum, artifact) => sum + artifact.details.statistics.closedWithoutFiles,
        0
      ),
    };
    expect(hygiene).toEqual({
      open_checkpoints_on_finished_artifacts: 2,
      summaries_without_pre_pr_run: 1,
      closed_cp_without_completed_steps: 2,
      closed_cp_without_uncertainty: 2,
      closed_cp_without_decisions: 2,
      closed_cp_without_files_changed: 2,
    });
  });

  it('follows selected artifacts for usage only when a selector narrows the collection', async () => {
    const f = await populated();
    const captured = readProjectStatistics(f.writer, { origin: 'captured' });
    expect(captured.filtered).toBe(true);
    expect(captured.artifacts.map(({ row }) => row.artifactId)).toEqual([f.a, f.b].sort());
    expect(captured.usage!.artifactIds).toEqual([f.a, f.b].sort());
    expect(captured.sessions.map((session) => session.sessionId)).toEqual(['session-a']);
    const branch = readProjectStatistics(f.writer, { branch: 'unrecorded' });
    expect(branch.artifacts).toEqual([]);
    expect(branch.usage!.artifactIds).toEqual([]);
    expect(branch.sessions).toEqual([]);
    const reader = await openProjectDatabase({ authority: f.authority, mode: 'reader' });
    handles.push(reader);
    expect(readProjectStatistics(reader, { state: 'summarized' }).artifacts).toHaveLength(3);
  });

  it('refuses invalid selectors before touching the database', async () => {
    const f = await populated();
    const exec = vi.spyOn(Database.prototype, 'exec');
    for (const input of [null, [], { limit: 1 }, { origin: 'archive' }, { touching: '../x' }])
      expect(() => readProjectStatistics(f.writer, input as never)).toThrow(
        expect.objectContaining({ code: 'INVALID_INPUT' })
      );
    expect(exec).not.toHaveBeenCalled();
  });

  it('reports unreadable lifecycle or usage rows as issues without repairing or hiding counts', async () => {
    const f = await populated();
    dropTriggers(
      f.writer.databasePath,
      ['artifact_lifecycle_current', 'artifact_lifecycle_revisions'],
      (db) =>
        db.exec('DELETE FROM artifact_lifecycle_current; DELETE FROM artifact_lifecycle_revisions')
    );
    const raw = new Database(f.writer.databasePath);
    raw.prepare("UPDATE usage_snapshots SET cumulative_json='{}'").run();
    raw.close();
    const before = tables(f.writer);
    const result = readProjectStatistics(f.writer);
    expect(result.artifacts).toHaveLength(3);
    expect(result.artifacts.find(({ row }) => row.artifactId === f.a)!.lifecycles).toBeNull();
    expect(result.usage).toBeNull();
    expect(result.issues).toEqual([
      expect.objectContaining({
        resource: 'lifecycle',
        artifactId: f.a,
        code: 'HISTORY_INTEGRITY_REQUIRED',
      }),
      expect.objectContaining({ resource: 'usage', code: 'HISTORY_INTEGRITY_REQUIRED' }),
    ]);
    expect(tables(f.writer)).toEqual(before);
  });
});

describe('historical plan step membership', () => {
  it('finds dropped, carried and legacy identifiers across artifacts without decoding any thread', async () => {
    const f = await populated();
    const counters = f.writer.read(() => null).counters;
    const { value: legacy, sql } = statementsDuring(() =>
      readProjectStepMembership(f.writer, legacyStep)
    );
    expect(sql.some(hydratesArtifactEvents)).toBe(false);
    expect(sql.some((source) => source.includes('artifact_plan_step_history'))).toBe(true);
    expect(legacy.artifacts.map((row) => row.artifactId)).toEqual([f.b, f.c].sort());
    expect(legacy.artifacts[0]).toMatchObject({ label: null, task: null, detailsJson: null });
    expect(legacy.counters).toEqual(counters);
    expect(
      readProjectStepMembership(f.writer, f.steps.b[1]).artifacts.map((row) => row.artifactId)
    ).toEqual([f.b]);
    expect(
      readProjectStepMembership(f.writer, f.steps.added).artifacts.map((row) => row.artifactId)
    ).toEqual([f.b]);
    expect(
      readProjectStepMembership(f.writer, f.steps.a[0]).artifacts.map((row) => row.artifactId)
    ).toEqual([f.a]);
    expect(readProjectStepMembership(f.writer, uuidv7()).artifacts).toEqual([]);
    for (const artifactId of [f.a, f.b, f.c])
      expect(
        f.writer.read(
          (view) =>
            view.get<{ n: number }>(
              'SELECT count(*) AS n FROM artifact_plan_step_history WHERE artifact_id=?',
              artifactId
            )!.n
        ).value
      ).toBe(
        readProjectStatistics(f.writer).artifacts.find(({ row }) => row.artifactId === artifactId)!
          .details.historicalStepCount
      );
    for (const stepId of ['', '   ', 'a\0b', 7])
      expect(() => readProjectStepMembership(f.writer, stepId as never)).toThrow(
        expect.objectContaining({ code: 'INVALID_INPUT' })
      );
  });

  it('refuses missing derived membership without rebuilding until an explicit rebuild restores it', async () => {
    const f = await populated();
    const raw = new Database(f.writer.databasePath);
    raw.prepare('DELETE FROM artifact_plan_step_history WHERE artifact_id=?').run(f.b);
    raw.close();
    const before = tables(f.writer);
    for (const read of [
      () => readProjectStepMembership(f.writer, legacyStep),
      () => readProjectStepMembership(f.writer, f.steps.a[0]),
      () => readProjectStatistics(f.writer),
    ])
      expect(read).toThrow(expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' }));
    expect(tables(f.writer)).toEqual(before);
    f.writer.close();
    handles.splice(handles.indexOf(f.writer), 1);
    await rebuildProjectQueryMetadata({ authority: f.authority, authorize() {} });
    const reader = await openProjectDatabase({ authority: f.authority, mode: 'reader' });
    handles.push(reader);
    expect(
      readProjectStepMembership(reader, legacyStep).artifacts.map((row) => row.artifactId)
    ).toEqual([f.b, f.c].sort());
    expect(readProjectStatistics(reader).artifacts).toHaveLength(3);
  });
});
