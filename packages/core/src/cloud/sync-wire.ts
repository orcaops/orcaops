import {
  OssCheckpointOpenedPayload,
  OssCheckpointPayload,
  OssCodingSessionsUsagePayload,
  type OssCodingSessionUsageEntry,
  type OssCodingUsageModelBreakdown,
  type OssCodingUsageSnapshot,
  type OssEvaluatorDispositionRow,
  type OssEvaluatorRun,
  OssEvaluatorsPayload,
  type OssLlmTokenUsage,
  OssPlanPayload,
  type OssSourcePlanUsageLink,
  type OssSummaryPayload,
  type OssCheckpointPayload as WireCheckpoint,
  type OssCheckpointOpenedPayload as WireCheckpointOpened,
} from '@orcaops/sdk';
import { UsageModelBreakdownEntrySchema } from '@orcaops/storage';
import type {
  Checkpoint,
  CodingSessionRow,
  DiffFingerprintManifest,
  EvaluatorLog,
  MaterializedEvaluatorDisposition,
  MaterializedEvaluatorRun,
  Plan,
  SourcePlanLinkRow,
  Summary,
  UsageSnapshotRow,
} from '@orcaops/storage';

import { DoneCriterionTextUnresolvableError } from './errors.js';
import type { ArtifactUsageData } from './hash.js';

/**
 * Translate an OSS open checkpoint into the cloud's `checkpoint_opened`
 * wire shape. The open payload carries declared scope, plan-revision id,
 * head_sha (set at open time), and opened-at — no summary / files /
 * decisions yet.
 *
 * `policy_exceptions` is joined into display-only strings to match the
 * close payload's wire format; cloud stores them as `String[]` and never
 * reparses, so the format is keyed to `${evaluator}: ${reason}` on both
 * sides of the OPEN→CLOSED lifecycle.
 */
export function toWireCheckpointOpened(cp: Checkpoint & { status: 'open' }): WireCheckpointOpened {
  // .parse (not a bare object literal) so the cloud's strict v2 schema +
  // boundary superRefine fail fast LOCALLY with a clear error instead of an
  // opaque cloud 400. Matches the toWireEvaluators precedent below.
  return OssCheckpointOpenedPayload.parse({
    schema_version: 2,
    artifact_id: cp.artifact_id,
    n: cp.n,
    declared_step_ids: cp.declared_step_ids,
    // The server-derived event id of the plan revision this cp opened against
    // (authoritative; the cloud resolves it against Plan.sourceEventId).
    plan_revision_id: cp.open_plan_revision_event_id,
    agent_session_id: cp.agent_session_id ?? null,
    policy_exceptions: cp.policy_exceptions.map((p) => `${p.evaluator}: ${p.reason}`),
    head_sha: cp.head_sha,
    opened_at: cp.opened_at,
    open_snapshot: cp.open_snapshot,
    ...(cp.source_event_id ? { source_event_id: cp.source_event_id } : {}),
  });
}

/**
 * Translate one OSS checkpoint into the cloud's v4 wire shape, or return
 * null if the cloud can't model it. Local checkpoints are a discriminated
 * union (open / closed / abandoned) — only `closed` carries the close-
 * time payload (summary, files_changed, decisions) the cloud expects.
 * Open cps go through `toWireCheckpointOpened`; abandoned cps are skipped
 * (the v1 wire has no abandoned payload).
 *
 * `manifest` is the materialized full diff-fingerprint manifest from
 * `readSnapshot`'s `fingerprintByN` (null for skipped cps, whose
 * `manifest_hash` is null). It is sent iff non-null; the cloud's payload
 * superRefine enforces "manifest_hash non-null ⇔ diff_fingerprint present".
 *
 * .parse (not a bare literal) so the cloud's strict v4 schema + summary /
 * manifest / boundary superRefines fail fast LOCALLY instead of as an
 * opaque cloud 400. The cloud STILL re-validates + recomputes manifest_hash
 * + cross-checks tree SHAs server-side; this is a fast local mirror of the
 * self-contained shape checks only, not a replacement for ingest.
 */
export function toWireCheckpoint(
  cp: Checkpoint,
  manifest: DiffFingerprintManifest | null,
  criterionText: Map<string, string>
): WireCheckpoint | null {
  if (cp.status !== 'closed') return null;
  return OssCheckpointPayload.parse({
    schema_version: 4,
    artifact_id: cp.artifact_id,
    n: cp.n,
    declared_step_ids: cp.declared_step_ids,
    completed_step_ids: cp.completed_step_ids,
    // Authoritative open-time plan-revision event id (cloud resolves it against
    // Plan.sourceEventId for open-time step ordinals + the stale-plan badge).
    plan_revision_id: cp.open_plan_revision_event_id,
    agent_session_id: cp.agent_session_id ?? null,
    policy_exceptions: cp.policy_exceptions.map((p) => `${p.evaluator}: ${p.reason}`),
    summary: cp.summary,
    files_changed: cp.files_changed,
    // V4 `OssCheckpointDecision` carries `alternatives_considered`, structurally
    // identical to the stored shape — passes through verbatim.
    decisions: cp.decisions,
    uncertainty: cp.uncertainty,
    // V4 carries structured done_criteria; `text` is the acceptance-criterion
    // text as it read in the plan revision this cp OPENED against, resolved by
    // resolveDoneCriterionText (which guarantees a map hit for every entry).
    done_criteria: cp.done_criteria.map((d) => ({
      criterion_id: d.criterion_id,
      evidence: d.evidence,
      text: criterionText.get(d.criterion_id)!,
    })),
    head_sha: cp.head_sha,
    opened_at: cp.opened_at,
    ts: cp.closed_at,
    open_snapshot: cp.open_snapshot,
    close_snapshot: cp.close_snapshot,
    diff_fingerprint_summary: cp.diff_fingerprint_summary,
    ...(manifest !== null ? { diff_fingerprint: manifest } : {}),
    ...(cp.source_event_id ? { source_event_id: cp.source_event_id } : {}),
  });
}

/**
 * Resolve each done-criterion's open-time `text` for the V4 wire. The cloud
 * snapshots the criterion text as it read in the plan revision the checkpoint
 * OPENED against and does not replay plan history itself, so we resolve it here
 * from `open_plan_revision_event_id` — never the latest revision — and FAIL
 * FAST (DoneCriterionTextUnresolvableError) rather than ship a degraded read.
 * That way a transient cache miss redrives clean instead of durably recording
 * the wrong rubric. Returns an empty map when there is nothing to resolve
 * (non-closed cp). In normal operation this never
 * throws: close-time validation already proved every criterion_id resolves
 * to a completed step in the open revision, on the same strict rule.
 */
export async function resolveDoneCriterionText(
  store: {
    resolveOpenRevisionPlanStrict(
      artifactId: string,
      openPlanRevisionEventId: string
    ): Promise<{ kind: 'resolved'; plan: Plan } | { kind: 'unresolved' }>;
  },
  cp: Checkpoint
): Promise<Map<string, string>> {
  if (cp.status !== 'closed') return new Map();
  // Resolve for EVERY closed cp — an empty rubric must not bypass the
  // strict open-revision rule, or a push would ship an unresolvable
  // revision id that close/why/rebuild all refuse.
  const resolved = await store.resolveOpenRevisionPlanStrict(
    cp.artifact_id,
    cp.open_plan_revision_event_id
  );
  if (resolved.kind === 'unresolved') {
    throw new DoneCriterionTextUnresolvableError(
      cp.artifact_id,
      cp.n,
      null,
      'open-revision-not-in-cache'
    );
  }
  const textByCriterion = new Map<string, string>();
  for (const step of resolved.plan.plan_steps) {
    for (const criterion of step.acceptance_criteria) {
      textByCriterion.set(criterion.criterion_id, criterion.text);
    }
  }
  for (const dc of cp.done_criteria) {
    if (!textByCriterion.has(dc.criterion_id)) {
      throw new DoneCriterionTextUnresolvableError(
        cp.artifact_id,
        cp.n,
        dc.criterion_id,
        'criterion-absent-in-open-revision'
      );
    }
  }
  return textByCriterion;
}

/**
 * Build the evaluator wire payload. The shape mirrors the materialized
 * projection one-for-one (distinct phase / run_status / verdict /
 * disposition fields plus an explicit dispositions array). Validates
 * at the SDK boundary via the protocol's own Zod schema so contract
 * violations — enum drift, missing required fields, broken cross-field
 * invariants — fail loud here instead of on the cloud's ingest.
 */
export function toWireEvaluators(log: EvaluatorLog): OssEvaluatorsPayload {
  return OssEvaluatorsPayload.parse({
    schema_version: 1,
    artifact_id: log.artifact_id,
    runs: log.runs.map(toWireEvaluatorRun),
    dispositions: log.dispositions.map(toWireEvaluatorDisposition),
  });
}

function toWireEvaluatorRun(run: MaterializedEvaluatorRun): OssEvaluatorRun {
  return {
    schema: 'orcaops.evaluator_run/v1',
    run_id: run.run_id,
    evaluator_ref: run.evaluator_ref,
    package_id: run.package_id,
    evaluator_id: run.evaluator_id,
    phase: run.phase,
    severity: run.severity,
    run_status: run.run_status,
    verdict: run.verdict,
    disposition: run.disposition,
    body: run.body,
    ...(run.raw !== undefined ? { raw: run.raw } : {}),
    ...(run.metrics !== undefined ? { metrics: run.metrics } : {}),
    ...(run.model !== undefined ? { model: run.model } : {}),
    ...(run.tokens !== undefined ? { tokens: run.tokens } : {}),
    ...(run.cost_usd !== undefined ? { cost_usd: run.cost_usd } : {}),
    ...(run.duration_ms !== undefined ? { duration_ms: run.duration_ms } : {}),
    ...(run.checkpoint_n !== undefined ? { checkpoint_n: run.checkpoint_n } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    ts: run.ts,
    source_event_index: run.source_event_index,
    local_kind_rank: 0,
    local_index: run.local_index,
  };
}

function toWireEvaluatorDisposition(
  dispo: MaterializedEvaluatorDisposition
): OssEvaluatorDispositionRow {
  return {
    schema: 'orcaops.evaluator_disposition/v1',
    disposition_id: dispo.disposition_id,
    run_id: dispo.run_id,
    evaluator_ref: dispo.evaluator_ref,
    disposition: dispo.disposition,
    reason: dispo.reason,
    agent_session_id: dispo.agent_session_id,
    ts: dispo.ts,
    source_event_index: dispo.source_event_index,
    local_kind_rank: 1,
    local_index: dispo.local_index,
  };
}

/**
 * Build the coding-agent usage wire payload. The native Claude token
 * names are renamed to the wire's in/out/cache_read/cache_write ONLY here, and
 * every per-snapshot `delta_*` is dropped — the payload is cumulative-only, so
 * the cloud recomputes the high-water span from the cumulative rows + the
 * first-class session total and NEVER by summing deltas, structurally.
 * `.parse` validates at the SDK boundary so contract drift fails
 * loud here instead of as an opaque cloud 400 — matching the other producers.
 */
export function toWireUsage(
  usage: ArtifactUsageData,
  artifactId: string
): OssCodingSessionsUsagePayload {
  const breakdownBySession = new Map<string, OssCodingUsageModelBreakdown[]>();
  // The per-session high-water TOTAL dimensions — a sibling of the per-model
  // breakdown, both read from the same high-water SessionModelBreakdownRow.
  const dimensionsBySession = new Map<string, Record<string, number>>();
  for (const mb of usage.modelBreakdowns) {
    const key = usageSessionKey(mb.agent, mb.session_id);
    breakdownBySession.set(key, toWireModelBreakdown(mb.model_breakdown));
    dimensionsBySession.set(key, parseDimensions(mb.dimensions));
  }
  return OssCodingSessionsUsagePayload.parse({
    schema_version: 1,
    artifact_id: artifactId,
    sessions: usage.sessions.map((s) =>
      toWireSessionUsageEntry(s, breakdownBySession, dimensionsBySession)
    ),
    snapshots: usage.snapshots.map(toWireUsageSnapshot),
    source_plan_links: usage.source_plan_links.map(toWireSourcePlanUsageLink),
  });
}

/** (agent, session_id) join key — JSON, never a control-char delimiter. */
function usageSessionKey(agent: string, sessionId: string): string {
  return JSON.stringify([agent, sessionId]);
}

/** Parse a stored `dimensions` JSON column → a numeric map ({} on any failure).
 *  The column is `TEXT NOT NULL DEFAULT '{}'` (migration 020), so this normally
 *  parses an object; the guard keeps a malformed/legacy value from throwing. */
function parseDimensions(json: string): Record<string, number> {
  try {
    const raw = JSON.parse(json) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, number>;
    }
  } catch {
    // fall through to the empty default
  }
  return {};
}

/** Native Claude token names → wire names. The ONLY place this rename happens.
 *  `dimensions` (the open numeric counters) rides inside every OssLlmTokenUsage —
 *  emitted only when non-empty so a default session stays byte-identical on the wire. */
function toWireUsageTokens(
  t: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  },
  dimensions?: Record<string, number>
): OssLlmTokenUsage {
  return {
    in: t.input_tokens,
    out: t.output_tokens,
    cache_read: t.cache_read_input_tokens,
    cache_write: t.cache_creation_input_tokens,
    ...(dimensions && Object.keys(dimensions).length > 0 ? { dimensions } : {}),
  };
}

/** Parse a stored `model_breakdown` JSON and map to the wire shape (drops delta).
 *  Carries the price-determining rate classes + per-model dimensions; each is
 *  omitted when default/empty (the parser already canonicalizes), matching the
 *  wire's optional-omit convention. */
function toWireModelBreakdown(json: string): OssCodingUsageModelBreakdown[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const parsed = UsageModelBreakdownEntrySchema.array().safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.map((e) => ({
    model: e.model,
    ...(e.speed ? { speed: e.speed } : {}),
    ...(e.service_tier ? { service_tier: e.service_tier } : {}),
    ...(e.inference_geo ? { inference_geo: e.inference_geo } : {}),
    cumulative: toWireUsageTokens(e.cumulative, e.cumulative.dimensions),
  }));
}

function toWireSessionUsageEntry(
  s: CodingSessionRow,
  breakdownBySession: Map<string, OssCodingUsageModelBreakdown[]>,
  dimensionsBySession: Map<string, Record<string, number>>
): OssCodingSessionUsageEntry {
  const key = usageSessionKey(s.agent, s.session_id);
  return {
    agent: s.agent,
    session_id: s.session_id,
    // The session total's high-water dimensions ride inside `total` — sourced
    // from the per-session breakdown row, since CodingSessionRow has no JSON column.
    total: toWireUsageTokens(
      {
        input_tokens: s.cumulative_input_tokens,
        output_tokens: s.cumulative_output_tokens,
        cache_creation_input_tokens: s.cumulative_cache_creation_input_tokens,
        cache_read_input_tokens: s.cumulative_cache_read_input_tokens,
      },
      dimensionsBySession.get(key)
    ),
    model_breakdown: breakdownBySession.get(key) ?? [],
    as_of: s.as_of,
    record_count: s.record_count,
  };
}

function toWireUsageSnapshot(row: UsageSnapshotRow): OssCodingUsageSnapshot {
  return {
    snapshot_id: row.snapshot_id,
    idempotency_key: row.idempotency_key,
    session_id: row.session_id,
    agent: row.agent,
    artifact_id: row.artifact_id,
    source_plan_ref_id: row.source_plan_ref_id,
    lifecycle_event: row.lifecycle_event,
    // checkpoint_n is wire-optional + must be positive; plan / plan_review rows
    // carry null. Omit when null (never emit 0).
    ...(row.checkpoint_n !== null ? { checkpoint_n: row.checkpoint_n } : {}),
    baseline_kind: row.baseline_kind as OssCodingUsageSnapshot['baseline_kind'],
    // The snapshot total's dimensions ride inside `cumulative` (the per-model
    // dimensions ride inside `model_breakdown` via toWireModelBreakdown).
    cumulative: toWireUsageTokens(
      {
        input_tokens: row.cumulative_input_tokens,
        output_tokens: row.cumulative_output_tokens,
        cache_creation_input_tokens: row.cumulative_cache_creation_input_tokens,
        cache_read_input_tokens: row.cumulative_cache_read_input_tokens,
      },
      parseDimensions(row.dimensions)
    ),
    model_breakdown: toWireModelBreakdown(row.model_breakdown),
    as_of: row.as_of,
    ts: row.ts,
  };
}

function toWireSourcePlanUsageLink(row: SourcePlanLinkRow): OssSourcePlanUsageLink {
  return {
    source_plan_ref_id: row.source_plan_ref_id,
    linked_at: row.linked_at,
    ...(row.pinned_version !== null ? { pinned_version: row.pinned_version } : {}),
  };
}

export function toWirePlan(plan: Plan): OssPlanPayload {
  // .parse (not a bare literal) so the V4 schema's step-label / criterion_id
  // uniqueness superRefines fail fast LOCALLY instead of as an opaque cloud
  // 400 — matching the checkpoint producers. Storage already enforces the same
  // uniqueness, so a valid stored plan always parses.
  return OssPlanPayload.parse({
    schema_version: 4,
    artifact_id: plan.artifact_id,
    branch: plan.branch,
    base_sha: plan.base_sha,
    agent: plan.agent,
    agent_session_id: plan.agent_session_id,
    task: plan.task,
    label: plan.label,
    // V4 carries per-step acceptance_criteria ({criterion_id, text}),
    // structurally identical to storage — pass through.
    plan_steps: plan.plan_steps.map((s) => ({
      step_id: s.step_id,
      label: s.label,
      text: s.text,
      acceptance_criteria: s.acceptance_criteria,
    })),
    // V4 non_goals are structured {text, rationale, source_refs} — pass the
    // stored shape straight through (was flattened to text-only on the v3 wire).
    non_goals: plan.non_goals,
    touched_scope: plan.touched_scope,
    started_at: plan.started_at,
    revision_n: plan.revision_n,
    revised_at: plan.revised_at,
    rationale: plan.rationale,
    step_lineage: plan.step_lineage,
    // V4 carries the criterion-level diff against the prior revision; cloud
    // renders removed/rewritten (added is ignored cloud-side).
    criterion_lineage: plan.criterion_lineage,
    // V4 OssPlanDecision is structurally identical to the stored PlanDecision
    // (decision, reason, alternatives_considered?, revision_n) — pass the
    // cumulative set straight through, mirroring toWireCheckpoint. The store
    // cumulates plan decisions at write and we sync only the latest revision,
    // so this array is the full append-only history (each entry keeps its
    // made-at revision_n); both attachPlan (rev 0) and attachPlanRevision
    // (rev >= 1) carry the complete set, which is what the cloud relies on.
    decisions: plan.decisions,
    prior_plan_event_id: plan.prior_plan_event_id,
    ...(plan.source_event_id ? { source_event_id: plan.source_event_id } : {}),
  });
}

export function toWireSummary(summary: Summary): OssSummaryPayload {
  return {
    schema_version: summary.schema_version,
    artifact_id: summary.artifact_id,
    outcome: summary.outcome,
    tests_written: summary.tests_written,
    tests_run: summary.tests_run,
    open_items: summary.open_items,
    deferred_decisions: summary.deferred_decisions,
    head_sha: summary.head_sha,
    ts: summary.ts,
    ...(summary.source_event_id ? { source_event_id: summary.source_event_id } : {}),
  };
}
