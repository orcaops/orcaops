import { type ArchivedArtifactThread } from './read.js';
import { latestPlanRevisionEventId } from '../events/rebuilders.js';
import { checkpointToRowForRebuild } from '../store/rebuild.js';
import { buildPlanSearchContent } from '../store/search-content.js';
import type { Store } from '../store/sqlite.js';

/**
 * Archive events → per-project index Store. Clones the shape of
 * `rebuildCache` but sourced from REBUILT projections (the archive has no
 * projection JSONs by design), so an index row is identical whether it
 * came from the hot cache rebuild or from here. Write-side FTS redaction
 * is preserved for free: `Store.replaceSearchEntry` redacts at insert.
 */

export interface IngestArtifactResult {
  /** True when the artifact contributed a plan row (i.e., is queryable). */
  indexed: boolean;
}

/**
 * PRECONDITION: callers must pre-assert the thread was loaded losslessly
 * (`lossyLines === 0`) — this function indexes whatever it is given and
 * cannot detect a lossy source, so an unguarded call serves
 * silently-incomplete state. Live guards: `assertIndexableThread` on the
 * global-index ingest paths; `loadStrictArchiveThread`'s corrupt-line
 * refusal on the restore paths.
 */
export function ingestArtifactThread(
  store: Store,
  thread: ArchivedArtifactThread
): IngestArtifactResult {
  const { plan, checkpoints, summary, evaluatorLog } = thread;
  if (!plan) return { indexed: false };
  if (!plan.source_event_id) {
    throw new Error(
      `Cannot index archive artifact "${plan.artifact_id}": rebuilt plan has no source event id.`
    );
  }
  const planRevisionSourceEventId =
    latestPlanRevisionEventId(thread.events) ?? plan.source_event_id;

  store.upsertArtifact({
    id: plan.artifact_id,
    branch: plan.branch,
    task: plan.task,
    label: plan.label,
    agent: plan.agent,
    base_sha: plan.base_sha,
    started_at: plan.started_at,
    completed_at: summary ? summary.ts : null,
    status: summary ? 'complete' : 'active',
    non_goals: JSON.stringify(plan.non_goals),
    origin_kind: plan.origin?.kind ?? null,
  });
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
  store.replaceSearchEntry({
    artifact_id: plan.artifact_id,
    source: `plan:${plan.revision_n}`,
    branch: plan.branch,
    ts: plan.revised_at ?? plan.started_at,
    content: buildPlanSearchContent(plan),
  });

  for (const cp of checkpoints) {
    store.upsertCheckpoint(checkpointToRowForRebuild(cp));
    if (cp.status === 'closed') {
      store.replaceSearchEntry({
        artifact_id: cp.artifact_id,
        source: `checkpoint:${cp.n}`,
        branch: plan.branch,
        ts: cp.closed_at,
        content: `${cp.summary} · ${cp.uncertainty.join(' · ')}`,
      });
    }
  }

  if (evaluatorLog) {
    for (const run of evaluatorLog.runs) {
      const verdictTag = run.verdict !== null ? `/${run.verdict}` : '';
      store.replaceSearchEntry({
        artifact_id: evaluatorLog.artifact_id,
        source: `evaluator:${run.evaluator_ref}:${run.ts}`,
        branch: plan.branch,
        ts: run.ts,
        content: `${run.evaluator_ref} · ${run.severity}/${run.run_status}${verdictTag} · ${run.body}`,
      });
    }
    for (const dispo of evaluatorLog.dispositions) {
      store.replaceSearchEntry({
        artifact_id: evaluatorLog.artifact_id,
        source: `block-resolution:${dispo.evaluator_ref}:${dispo.ts}`,
        branch: plan.branch,
        ts: dispo.ts,
        content: `${dispo.evaluator_ref} · ${dispo.disposition} · ${dispo.reason}`,
      });
    }
  }

  for (const ev of thread.events) {
    if (ev.record.type !== 'pin_displaced') continue;
    const p = ev.payload as {
      displaced_by_artifact_id?: string;
      shell_key?: { kind?: string };
      reason?: string;
    };
    store.replaceSearchEntry({
      artifact_id: plan.artifact_id,
      source: `pin-displaced:${ev.record.event_id}`,
      branch: plan.branch,
      ts: ev.record.ts,
      content:
        `pin-displaced · displaced_by=${p.displaced_by_artifact_id ?? '?'} ` +
        `shell_key=${p.shell_key?.kind ?? 'unknown'} reason=${p.reason ?? 'unknown'}`,
    });
  }

  if (summary) {
    store.upsertSummary({
      artifact_id: summary.artifact_id,
      outcome: summary.outcome,
      tests_written: summary.tests_written,
      tests_run: summary.tests_run,
      open_items: summary.open_items,
      ts: summary.ts,
    });
    store.replaceSearchEntry({
      artifact_id: summary.artifact_id,
      source: 'summary',
      branch: plan.branch,
      ts: summary.ts,
      content: `${summary.outcome} · ${summary.open_items.join(' · ')}`,
    });
  }

  return { indexed: true };
}
