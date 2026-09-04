import { readdir, readFile } from 'node:fs/promises';

import { rebuildLineageIndex } from './rebuild-lineage-index.js';
import {
  rebuildPlanIdempotency,
  type RebuildPlanIdempotencyResult,
} from './rebuild-plan-idempotency.js';
import { buildPlanSearchContent } from './search-content.js';
import { type CheckpointRow, Store } from './sqlite.js';
import { artifactPathsFor, artifactsRoot, locksDir } from '../artifacts/paths.js';
import { ArtifactStore, withReconciledArtifactDeletionStaging } from '../artifacts/store.js';
import { type EventType, readEventLog } from '../events/event-log.js';
import {
  type EventWithPayload,
  latestPlanRevisionEventId,
  loadEventsWithPayloads,
  rebuildPlanFromEvents,
} from '../events/rebuilders.js';
import { lossyCorruptEvents, recoverProjection } from '../events/recovery.js';
import { ArtifactLock } from '../locks.js';
import { assertSafePathSegment } from '../paths/containment.js';
import { CheckpointSchema } from '../schema/checkpoint.js';
import type { Config } from '../schema/config.js';
import type { EvaluatorLog } from '../schema/evaluator-run.js';
import { type Plan, PlanSchema } from '../schema/plan.js';
import type { Summary } from '../schema/summary.js';
import { rebuildUsageLedger } from '../usage/ledger.js';

export interface RebuildResult {
  /** Artifacts whose plan projection was malformed and skipped (surfaced, never silent). */
  skipped_artifacts: number;
  artifacts: number;
  checkpoints: number;
  summaries: number;
  evaluator_runs: number;
  digests: number;
  block_resolutions: number;
  pin_displaced: number;
  usage_snapshots: number;
  source_plan_links: number;
}

export interface RebuildOptions {
  repoRoot: string;
  config: Config;
  store: Store;
  /**
   * Called before destructive reset and before marker clear; a throw leaves
   * either the old cache or a marked partial projection for the next rebuild.
   * `rebuildCache` composes the lock lease's own assert in front of any
   * caller-supplied hook (the hook is the test seam for the abort path).
   */
  assertLease?: () => Promise<void>;
  /**
   * Receives the reservation rebuilder's duplicate-key conflicts (a
   * filesystem-corruption signal). Deliberately a callback, never a
   * RebuildResult field: the CLI spreads the result verbatim into the
   * frozen `rebuild --json` envelope, so any field would leak into it.
   */
  onPlanIdempotencyConflicts?: (conflicts: RebuildPlanIdempotencyResult['conflicts']) => void;
  /**
   * Progress hook fired at named phases. A test seam for the two-handle
   * serialization barriers (like assertLease for the abort path); awaited,
   * so a paused hook holds the rebuild at that phase under its lock.
   */
  onPhase?: (phase: 'reset-start' | 'replay-start') => Promise<void>;
}

export async function rebuildCache(opts: RebuildOptions): Promise<RebuildResult> {
  // Concurrent rebuilds must not interleave reset, replay, and finalization.
  // repo-scoped lock serializes them; the key is fixed because the cache
  // is one file.
  const lock = new ArtifactLock({
    locksDir: locksDir(opts.repoRoot),
    containmentRoot: opts.repoRoot,
    // A full replay can outlive the 120s stale threshold, and a reaped
    // lock would let a second rebuild race this one. The heartbeat keeps a
    // LIVE holder's lease fresh; a genuinely lost lease (holder suspended
    // past the threshold) still fails loudly via ArtifactLockLeaseLostError.
    heartbeatIntervalMs: 30_000,
  });
  const { result } = await withReconciledArtifactDeletionStaging(
    { repoRoot: opts.repoRoot, config: opts.config, store: opts.store },
    (assertDeletionLease) =>
      lock.withLock('cache-rebuild', (lease) =>
        rebuildCacheLocked({
          ...opts,
          assertLease: async () => {
            await assertDeletionLease();
            await lease.assert();
            await opts.assertLease?.();
          },
        })
      )
  );
  return result;
}

async function rebuildCacheLocked(opts: RebuildOptions): Promise<RebuildResult> {
  const { repoRoot, config, store } = opts;
  if (opts.onPhase) await opts.onPhase('reset-start');
  // Reset and pending health land in one transaction so a kill leaves either
  // the prior cache or a baseline projection that the next open must replay.
  // FK toggling is a no-op inside a transaction, and reset()'s drop order
  // needs FKs off — so the toggle brackets the transaction.
  store.db.exec('PRAGMA foreign_keys = OFF');
  try {
    store.db.transaction(() => {
      store.reset();
      store.setProjectionHealth('rebuild_pending');
    })();
  } finally {
    store.db.exec('PRAGMA foreign_keys = ON');
  }
  if (opts.onPhase) await opts.onPhase('replay-start');

  const result: RebuildResult = {
    skipped_artifacts: 0,
    artifacts: 0,
    checkpoints: 0,
    summaries: 0,
    evaluator_runs: 0,
    digests: 0,
    block_resolutions: 0,
    pin_displaced: 0,
    usage_snapshots: 0,
    source_plan_links: 0,
  };

  // Replay the repo-level usage ledger FIRST — before any artifact handling.
  // Usage lives in `.orcaops/usage/` (not under artifacts) and can predate any
  // capture, so it must survive a rebuild even when `.orcaops/artifacts/` does
  // not exist yet. It must stay above the readdir() ENOENT early-return below;
  // otherwise pre-artifact usage is wiped. Embedded deltas are projected as-is
  // — never recomputed from transcripts.
  {
    const { snapshots, links } = await rebuildUsageLedger(store, repoRoot);
    result.usage_snapshots = snapshots;
    result.source_plan_links = links;
  }

  const root = artifactsRoot(repoRoot, config);

  let artifactIds: string[];
  try {
    artifactIds = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // No artifacts dir = an empty repo, not a failure — fall through so the
    // finalization tail (health transition) still runs; an early return here
    // would leave the durable pending state set forever.
    artifactIds = [];
  }

  // Artifacts with ANY unreadable projection source (plan, checkpoint,
  // summary, evaluator log, or event log) — surfaced via
  // `skipped_artifacts` so a partial rebuild is never certified as
  // complete.
  const skippedArtifactIds = new Set<string>();
  const recoveryStore = new ArtifactStore({ repoRoot, config, store });

  for (const artifactId of artifactIds) {
    try {
      assertSafePathSegment(artifactId, 'artifact id');
    } catch {
      continue;
    }
    const paths = artifactPathsFor(repoRoot, config, artifactId);
    const dir = paths.dir;
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') continue;
      throw err;
    }

    let loadedEvents: EventWithPayload[] | null | undefined;
    const eventsForRecovery = async (): Promise<EventWithPayload[] | null> => {
      if (loadedEvents !== undefined) return loadedEvents;
      try {
        const read = await readEventLog({
          eventLogPath: paths.eventsNdjson,
          sidecarsDir: paths.sidecarsDir,
          containmentRoot: repoRoot,
        });
        if (lossyCorruptEvents(read.corrupt).length > 0) {
          loadedEvents = null;
          return null;
        }
        loadedEvents = await loadEventsWithPayloads(read.events, {
          sidecarsDir: paths.sidecarsDir,
          containmentRoot: repoRoot,
        });
        return loadedEvents;
      } catch {
        loadedEvents = null;
        return null;
      }
    };

    let plan: Plan | null = null;
    let planSourceEventId: string | null = null;
    let planRevisionSourceEventId: string | null = null;
    let eventHistoryUnreadable = false;
    if (files.includes('events.ndjson')) {
      try {
        const events = await eventsForRecovery();
        eventHistoryUnreadable = events === null;
        if (events !== null) {
          let projection: { value: Plan; source_event_id: string } | { unreadable: true } | null =
            null;
          if (files.includes('plan.json')) {
            try {
              const value = PlanSchema.parse(JSON.parse(await readFile(paths.planJson, 'utf8')));
              projection = { value, source_event_id: value.source_event_id };
            } catch {
              projection = { unreadable: true };
            }
          }
          const recovery = recoverProjection<Plan>({
            projection,
            events: events.map((event) => event.record),
            lossyCorrupt: [],
            lineByEventId: new Map(
              events.map((event, index) => [event.record.event_id, index + 1] as const)
            ),
            relevantTypes: new Set<EventType>([
              'plan_captured',
              'plan_revised',
              'git_import_enriched',
            ]),
            rebuild: () => {
              const rebuilt = rebuildPlanFromEvents(events);
              if (!rebuilt) throw new Error(`artifact ${artifactId} has no plan event`);
              return rebuilt.plan;
            },
          });
          if (recovery.status === 'current' || recovery.status === 'rebuilt') {
            plan = recovery.projection;
            planSourceEventId = recovery.sourceEventId;
            planRevisionSourceEventId = latestPlanRevisionEventId(events);
          }
        }
      } catch {
        eventHistoryUnreadable = true;
        plan = null;
      }
    }
    if (eventHistoryUnreadable) skippedArtifactIds.add(artifactId);
    if (plan === null || planSourceEventId === null || planRevisionSourceEventId === null) {
      skippedArtifactIds.add(artifactId);
      continue;
    }
    try {
      if ((await recoveryStore.readArtifact(artifactId)) === null) {
        skippedArtifactIds.add(artifactId);
        continue;
      }
    } catch {
      // Artifact-level metadata (including a pinned source plan) must
      // validate before any part of the thread becomes queryable.
      skippedArtifactIds.add(artifactId);
      continue;
    }

    try {
      store.upsertArtifact({
        id: plan.artifact_id,
        branch: plan.branch,
        task: plan.task,
        label: plan.label,
        agent: plan.agent,
        base_sha: plan.base_sha,
        started_at: plan.started_at,
        completed_at: null,
        status: 'active',
        non_goals: JSON.stringify(plan.non_goals),
        origin_kind: plan.origin?.kind ?? null,
      });
      // Project the latest validated plan into SQLite. When the event log is
      // intact it wins over a missing, malformed, or stale plan.json.
      store.upsertPlanRevision({
        plan: {
          artifact_id: plan.artifact_id,
          revision_n: plan.revision_n,
          captured_at: plan.revised_at ?? plan.started_at,
          label: plan.label,
          rationale: plan.rationale,
          touched_scope: JSON.stringify(plan.touched_scope),
          non_goals: JSON.stringify(plan.non_goals),
          decisions: JSON.stringify(plan.decisions),
          step_lineage: JSON.stringify(plan.step_lineage),
          criterion_lineage: JSON.stringify(plan.criterion_lineage),
          prior_event_id: plan.prior_plan_event_id,
          source_event_id: planRevisionSourceEventId,
        },
        steps: plan.plan_steps.map((s, idx) => ({
          step_id: s.step_id,
          idx,
          label: s.label,
          text: s.text,
          acceptance_criteria: JSON.stringify(s.acceptance_criteria),
        })),
      });
      const planSearchContent = buildPlanSearchContent(plan);
      store.replaceSearchEntry({
        artifact_id: plan.artifact_id,
        source: `plan:${plan.revision_n}`,
        branch: plan.branch,
        ts: plan.revised_at ?? plan.started_at,
        content: planSearchContent,
      });
      result.artifacts++;
    } catch {
      skippedArtifactIds.add(artifactId);
      continue;
    }

    const planMetaRaw = plan;
    const branch = plan.branch;

    try {
      for (const cp of await recoveryStore.readCheckpointsRecovered(artifactId)) {
        const row = checkpointToRowForRebuild(cp);
        store.upsertCheckpoint(row);
        if (cp.status === 'closed') {
          store.replaceSearchEntry({
            artifact_id: cp.artifact_id,
            source: `checkpoint:${cp.n}`,
            branch,
            ts: cp.closed_at,
            content: `${cp.summary} · ${cp.uncertainty.join(' · ')}`,
          });
        }
        result.checkpoints++;
      }
    } catch {
      skippedArtifactIds.add(artifactId);
    }

    let evaluatorLog: EvaluatorLog | null = null;
    try {
      evaluatorLog = await recoveryStore.readEvaluatorLog(artifactId);
    } catch {
      skippedArtifactIds.add(artifactId);
    }
    if (evaluatorLog !== null) {
      try {
        const log = evaluatorLog;
        // The materialized log carries every SQL column (order keys and
        // dispositions included), so the run/disposition TABLES rebuild
        // alongside the search rows — block-state derivation reads them.
        for (const run of log.runs) {
          store.insertEvaluatorRun({
            run_id: run.run_id,
            artifact_id: run.artifact_id,
            evaluator_ref: run.evaluator_ref,
            package_id: run.package_id,
            evaluator_id: run.evaluator_id,
            phase: run.phase,
            severity: run.severity,
            run_status: run.run_status,
            verdict: run.verdict,
            body: run.body,
            raw: run.raw !== undefined ? JSON.stringify(run.raw) : null,
            metrics: run.metrics !== undefined ? JSON.stringify(run.metrics) : null,
            provider: run.provider ?? null,
            model: run.model ?? null,
            tokens_in: run.tokens?.in ?? null,
            tokens_out: run.tokens?.out ?? null,
            tokens_cache_read: run.tokens?.cache_read ?? null,
            tokens_cache_write: run.tokens?.cache_write ?? null,
            cost_usd: run.cost_usd ?? null,
            duration_ms: run.duration_ms ?? null,
            checkpoint_n: run.checkpoint_n ?? null,
            error_code: run.error?.code ?? null,
            error_message: run.error?.message ?? null,
            ts: run.ts,
            disposition: run.disposition,
            source_event_index: run.source_event_index,
            local_kind_rank: 0,
            local_index: run.local_index,
          });
          const verdictTag = run.verdict !== null ? `/${run.verdict}` : '';
          store.replaceSearchEntry({
            artifact_id: log.artifact_id,
            source: `evaluator:${run.evaluator_ref}:${run.ts}`,
            branch,
            ts: run.ts,
            content: `${run.evaluator_ref} · ${run.severity}/${run.run_status}${verdictTag} · ${run.body}`,
          });
          result.evaluator_runs++;
        }
        for (const dispo of log.dispositions) {
          store.insertEvaluatorDisposition({
            disposition_id: dispo.disposition_id,
            artifact_id: dispo.artifact_id,
            run_id: dispo.run_id,
            evaluator_ref: dispo.evaluator_ref,
            disposition: dispo.disposition,
            reason: dispo.reason,
            agent_session_id: dispo.agent_session_id ?? null,
            ts: dispo.ts,
            source_event_index: dispo.source_event_index,
            local_kind_rank: 1,
            local_index: dispo.local_index,
          });
          store.replaceSearchEntry({
            artifact_id: log.artifact_id,
            source: `block-resolution:${dispo.evaluator_ref}:${dispo.ts}`,
            branch,
            ts: dispo.ts,
            content: `${dispo.evaluator_ref} · ${dispo.disposition} · ${dispo.reason}`,
          });
          result.block_resolutions++;
        }
      } catch {
        skippedArtifactIds.add(artifactId);
      }
    }

    if (files.includes('events.ndjson')) {
      try {
        const eventsResult = await readEventLog({
          eventLogPath: paths.eventsNdjson,
          sidecarsDir: paths.sidecarsDir,
          containmentRoot: repoRoot,
        });
        // Prior plan revisions exist only in the event log (plan.json holds
        // the latest, inserted above). Rebuild each earlier revision from
        // the event prefix that ends at its plan event.
        try {
          const withPayloads = await loadEventsWithPayloads(eventsResult.events, {
            sidecarsDir: paths.sidecarsDir,
            containmentRoot: repoRoot,
          });
          const planEventIdx = withPayloads
            .map((e, i) => ({ type: e.record.type, i }))
            .filter((e) => e.type === 'plan_captured' || e.type === 'plan_revised')
            .map((e) => e.i);
          // Every plan event except the last (the plan.json insert above).
          for (const idx of planEventIdx.slice(0, -1)) {
            const rebuilt = rebuildPlanFromEvents(withPayloads.slice(0, idx + 1));
            if (!rebuilt) continue;
            const p = rebuilt.plan;
            store.upsertPlanRevision({
              plan: {
                artifact_id: p.artifact_id,
                revision_n: p.revision_n,
                captured_at: p.revised_at ?? p.started_at,
                label: p.label,
                rationale: p.rationale,
                touched_scope: JSON.stringify(p.touched_scope),
                non_goals: JSON.stringify(p.non_goals),
                decisions: JSON.stringify(p.decisions),
                step_lineage: JSON.stringify(p.step_lineage),
                criterion_lineage: JSON.stringify(p.criterion_lineage),
                prior_event_id: p.prior_plan_event_id,
                source_event_id: p.source_event_id,
              },
              steps: p.plan_steps.map((st, stIdx) => ({
                step_id: st.step_id,
                idx: stIdx,
                label: st.label,
                text: st.text,
                acceptance_criteria: JSON.stringify(st.acceptance_criteria),
              })),
            });
            // The live path indexes each revision; text that only exists in
            // a superseded revision must stay searchable after a rebuild.
            store.replaceSearchEntry({
              artifact_id: p.artifact_id,
              source: `plan:${p.revision_n}`,
              branch,
              ts: p.revised_at ?? p.started_at,
              content: buildPlanSearchContent(p),
            });
          }
          // Checkpoint-open evaluator work is pre-append and embedded in
          // the opened event's gate audit. The event therefore proves
          // completion; plan/revision/close firing events do not.
          for (const event of withPayloads) {
            if (event.record.type !== 'checkpoint_opened') continue;
            const n = (event.payload as { n?: unknown }).n;
            if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) continue;
            store.recordLifecycle({
              artifact_id: artifactId,
              fires_at: 'checkpoint-open',
              cp_n: n,
              triggered_at: event.record.ts,
            });
          }
        } catch {
          // Sidecar/payload gaps degrade prior-revision coverage; doctor
          // surfaces corrupted logs.
          skippedArtifactIds.add(artifactId);
        }
        if (eventsResult.corrupt.length > 0) {
          skippedArtifactIds.add(artifactId);
        }
        // A passing pre-pr marker is appended only after evaluator work
        // completes, so it is a completion witness even when the cache DB
        // itself was lost. Keep only the latest successful pass.
        const latestPrePr = eventsResult.events
          .filter((event) => event.type === 'pre_pr_checked')
          .sort((a, b) => a.ts.localeCompare(b.ts))
          .at(-1);
        if (latestPrePr !== undefined) {
          store.recordLifecycle({
            artifact_id: artifactId,
            fires_at: 'pre-pr',
            triggered_at: latestPrePr.ts,
          });
        }
        for (const ev of eventsResult.events) {
          if (ev.type !== 'pin_displaced') continue;
          if (!('payload' in ev)) continue;
          const p = ev.payload as {
            displaced_by_artifact_id?: string;
            shell_key?: { kind?: string };
            reason?: string;
          };
          const shellKeyKind = p.shell_key?.kind ?? 'unknown';
          store.replaceSearchEntry({
            artifact_id: artifactId,
            source: `pin-displaced:${ev.event_id}`,
            branch,
            ts: ev.ts,
            content:
              `pin-displaced · displaced_by=${p.displaced_by_artifact_id ?? '?'} ` +
              `shell_key=${shellKeyKind} reason=${p.reason ?? 'unknown'}`,
          });
          result.pin_displaced++;
        }
      } catch {
        // Skip — corrupted event logs are surfaced by doctor.
        skippedArtifactIds.add(artifactId);
      }
    }

    let summary: Summary | null = null;
    try {
      summary = await recoveryStore.readSummary(artifactId);
    } catch {
      skippedArtifactIds.add(artifactId);
    }
    if (summary !== null) {
      try {
        store.upsertSummary({
          artifact_id: summary.artifact_id,
          outcome: summary.outcome,
          tests_written: summary.tests_written,
          tests_run: summary.tests_run,
          open_items: summary.open_items,
          ts: summary.ts,
        });
        const artifact = store.getArtifact(summary.artifact_id);
        if (artifact) {
          store.upsertArtifact({ ...artifact, completed_at: summary.ts, status: 'complete' });
        }
        store.replaceSearchEntry({
          artifact_id: summary.artifact_id,
          source: 'summary',
          branch,
          ts: summary.ts,
          content: `${summary.outcome} · ${summary.open_items.join(' · ')}`,
        });
        result.summaries++;
      } catch {
        skippedArtifactIds.add(artifactId);
      }
    }

    // After the summary block, so completed_at is populated: the live
    // digest writer stamps completed_at ?? started_at, and a rebuild must not
    // shift search timestamps. With no readable plan metadata there is
    // nothing truthful to stamp — skip and surface, never fabricate.
    if (files.includes('digest.md')) {
      const md = await readFile(paths.digestMd, 'utf8');
      const id = planMetaRaw?.artifact_id ?? artifactId;
      const ts = store.getArtifact(id)?.completed_at ?? planMetaRaw?.started_at;
      if (ts === undefined || ts === null) {
        skippedArtifactIds.add(artifactId);
      } else {
        store.replaceSearchEntry({
          artifact_id: id,
          source: 'digest',
          branch,
          ts,
          content: md,
        });
        result.digests++;
      }
    }
  }
  // Seed branch membership from the strict artifact projection so a lossy
  // event history still reaches degraded-row disclosure. Clean event-derived
  // lineage below overwrites it; refusal leaves the artifact marked skipped.
  await rebuildLineageIndex({ repoRoot, config, store });
  for (const id of artifactIds) {
    try {
      const json = await recoveryStore.readArtifact(id);
      const tail = json?.branch_lineage.at(-1);
      if (!json || !tail) {
        skippedArtifactIds.add(id);
        continue;
      }
      store.upsertLineageByLatestSha({
        artifact_id: json.id,
        latest_lineage_sha: tail.head_sha,
        branch_name: tail.branch,
      });
      for (const entry of json.branch_lineage) {
        store.upsertLineageBranch({ artifact_id: json.id, branch_name: entry.branch });
      }
    } catch {
      skippedArtifactIds.add(id);
    }
  }
  result.skipped_artifacts = skippedArtifactIds.size;

  // Plan idempotency keys replay from plan_captured events via their
  // dedicated rebuilder. Cache-only reservations are intentionally gone.
  const planIdem = await rebuildPlanIdempotency({ repoRoot, config, store });
  if (planIdem.conflicts.length > 0) {
    opts.onPlanIdempotencyConflicts?.(planIdem.conflicts);
  }

  // The heartbeat only DETECTS a lost lease — it cannot interrupt this
  // function. Re-verify ownership before certifying the rebuilt projection:
  // if the lock was reaped, a concurrent rebuild may be mid-flight. Leaving
  // the pending state intact makes the interleave recoverable.
  if (opts.assertLease) await opts.assertLease();
  store.setProjectionHealth(result.skipped_artifacts > 0 ? 'degraded' : 'healthy', {
    skippedArtifacts: result.skipped_artifacts,
  });

  return result;
}

/**
 * Checkpoint projection → SQLite row. Exported for the archive global
 * index, whose events-sourced ingest must produce byte-equal
 * rows to this projection-sourced rebuild.
 */
export function checkpointToRowForRebuild(
  cp: ReturnType<typeof CheckpointSchema.parse>
): CheckpointRow {
  if (cp.status === 'open') {
    return {
      status: 'open',
      artifact_id: cp.artifact_id,
      n: cp.n,
      declared_step_ids: [...cp.declared_step_ids],
      agent_session_id: cp.agent_session_id ?? null,
      policy_exceptions: cp.policy_exceptions,
      plan_revision_id: cp.plan_revision_id,
      opened_at: cp.opened_at,
      head_sha: cp.head_sha,
      open_plan_revision_event_id: cp.open_plan_revision_event_id,
    };
  }
  if (cp.status === 'closed') {
    return {
      status: 'closed',
      artifact_id: cp.artifact_id,
      n: cp.n,
      declared_step_ids: [...cp.declared_step_ids],
      agent_session_id: cp.agent_session_id ?? null,
      policy_exceptions: cp.policy_exceptions,
      plan_revision_id: cp.plan_revision_id,
      opened_at: cp.opened_at,
      closed_at: cp.closed_at,
      summary: cp.summary,
      files_changed: [...cp.files_changed],
      decisions: [...cp.decisions],
      uncertainty: [...cp.uncertainty],
      done_criteria: [...cp.done_criteria],
      completed_step_ids: [...cp.completed_step_ids],
      head_sha: cp.head_sha,
      open_plan_revision_event_id: cp.open_plan_revision_event_id,
    };
  }
  return {
    status: 'abandoned',
    artifact_id: cp.artifact_id,
    n: cp.n,
    declared_step_ids: [...cp.declared_step_ids],
    agent_session_id: cp.agent_session_id ?? null,
    policy_exceptions: cp.policy_exceptions,
    plan_revision_id: cp.plan_revision_id,
    opened_at: cp.opened_at,
    abandoned_at: cp.abandoned_at,
    reason: cp.reason,
    head_sha: cp.head_sha,
    open_plan_revision_event_id: cp.open_plan_revision_event_id,
  };
}
