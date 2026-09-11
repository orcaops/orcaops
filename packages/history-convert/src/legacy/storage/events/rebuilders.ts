import { type EventRecord, type EventType } from './event-log.js';
import { blockingEvaluatorFailureKind, GateAuditPayloadSchema } from '../../protocol/index.js';
import { RecoveryRefusedError } from '../artifacts/errors.js';
import {
  type ArtifactJson,
  type ArtifactState,
  type BranchLineageEntry,
  BranchLineageEntrySchema,
} from '../schema/artifact-json.js';
import {
  type AbandonedCheckpoint,
  AbandonedCheckpointSchema,
  type AttributionDegraded,
  type Checkpoint,
  CheckpointSchema,
  type ClosedCheckpoint,
  ClosedCheckpointSchema,
  type DoneCriterion,
  type OpenCheckpoint,
  OpenCheckpointSchema,
  type PolicyException,
  type VerificationEntry,
  type WindowOverlap,
} from '../schema/checkpoint.js';
import type {
  CheckpointSnapshotBoundary,
  DiffFingerprintManifest,
  DiffFingerprintSummary,
} from '../schema/diff-fingerprint.js';
import {
  EvaluatorDispositionPayloadSchema,
  type EvaluatorLog,
  EvaluatorRunPayloadSchema,
  type MaterializedEvaluatorDisposition,
  type MaterializedEvaluatorRun,
} from '../schema/evaluator-run.js';
import {
  type GitImportEnrichmentPayload,
  GitImportEnrichmentPayloadSchema,
} from '../schema/git-import-enrichment.js';
import { ArtifactOriginSchema, computeMemberShasHash } from '../schema/origin.js';
import { type Plan, PlanSchema } from '../schema/plan.js';
import { prePrCheckedOutcome, PrePrCheckedPayloadSchema } from '../schema/pre-pr-checked.js';
import { SourcePlanPinSchema } from '../schema/source-plan.js';
import { type Summary, SummarySchema } from '../schema/summary.js';
export interface EventWithPayload {
  record: EventRecord;
  payload: unknown;
}
export function eventsOfType(
  events: readonly EventWithPayload[],
  type: EventType
): EventWithPayload[] {
  return events.filter((e) => e.record.type === type);
}
export interface RebuiltPlan {
  plan: Plan;
  sourceEventId: string;
}
export function latestPlanRevisionEventId(events: readonly EventWithPayload[]): string | null {
  return (
    events
      .filter(
        (event) => event.record.type === 'plan_captured' || event.record.type === 'plan_revised'
      )
      .at(-1)?.record.event_id ?? null
  );
}
interface ValidatedGitImportEnrichment {
  event: EventWithPayload;
  payload: GitImportEnrichmentPayload;
}
interface ValidatedPlanState {
  rebuilt: RebuiltPlan;
  enrichments: ValidatedGitImportEnrichment[];
}
function refuseGitImportEnrichment(
  artifactId: string,
  eventId: string | null,
  reason: string
): never {
  throw new RecoveryRefusedError(
    `artifact ${artifactId} is unreadable: git-import enrichment` +
      `${eventId ? ` event ${eventId}` : ''} ${reason} — run \`orcaops doctor\`; ` +
      'restore events.ndjson from a backup or archive mirror before reading this artifact.',
    artifactId
  );
}
function validateGitImportEnrichments(
  events: readonly EventWithPayload[],
  basePlan: Plan
): ValidatedGitImportEnrichment[] {
  const candidates = events.filter((event) => event.record.type === 'git_import_enriched');
  if (candidates.length === 0) return [];
  const origin = basePlan.origin;
  if (
    origin?.kind !== 'git-import' ||
    !origin.cluster_key ||
    !origin.member_shas ||
    !origin.member_shas_hash ||
    computeMemberShasHash(origin.member_shas) !== origin.member_shas_hash
  ) {
    refuseGitImportEnrichment(
      basePlan.artifact_id,
      null,
      'requires immutable exact-member provenance'
    );
  }
  const memberShas = new Set(origin.member_shas);
  const expectedCheckpointNumbers = basePlan.plan_steps.map((_, index) => index + 1);
  let planEventIndex = -1;
  const summaryEventIndexes: number[] = [];
  const closedCheckpointEventIndex = new Map<number, number>();
  events.forEach((event, index) => {
    if (event.record.type === 'plan_captured' || event.record.type === 'plan_revised') {
      planEventIndex = index;
    }
    if (event.record.type === 'summary_captured') summaryEventIndexes.push(index);
    if (event.record.type !== 'checkpoint_closed') return;
    const n = (
      event.payload as {
        n?: unknown;
      }
    ).n;
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) {
      closedCheckpointEventIndex.set(n, index);
    }
  });
  let priorEventId: string | null = null;
  const validated: ValidatedGitImportEnrichment[] = [];
  for (const event of candidates) {
    const parsedPayload = GitImportEnrichmentPayloadSchema.safeParse(event.payload);
    if (!parsedPayload.success) {
      refuseGitImportEnrichment(
        basePlan.artifact_id,
        event.record.event_id,
        `has an invalid payload: ${parsedPayload.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`
      );
    }
    const payload = parsedPayload.data;
    const eventIndex = events.indexOf(event);
    if (
      payload.artifact_id !== basePlan.artifact_id ||
      payload.cluster_key !== origin.cluster_key ||
      payload.member_shas_hash !== origin.member_shas_hash
    ) {
      refuseGitImportEnrichment(
        basePlan.artifact_id,
        event.record.event_id,
        'does not match the imported artifact identity'
      );
    }
    if (
      eventIndex <= planEventIndex ||
      !summaryEventIndexes.some((index) => index < eventIndex) ||
      expectedCheckpointNumbers.some(
        (n) =>
          closedCheckpointEventIndex.get(n) === undefined ||
          closedCheckpointEventIndex.get(n)! >= eventIndex
      )
    ) {
      refuseGitImportEnrichment(
        basePlan.artifact_id,
        event.record.event_id,
        'must follow a complete imported thread'
      );
    }
    if (payload.prior_enrichment_event_id !== priorEventId) {
      refuseGitImportEnrichment(
        basePlan.artifact_id,
        event.record.event_id,
        'has a stale prior_enrichment_event_id'
      );
    }
    if (
      payload.steps.length !== basePlan.plan_steps.length ||
      JSON.stringify(payload.checkpoint_summaries.map((entry) => entry.n)) !==
        JSON.stringify(expectedCheckpointNumbers)
    ) {
      refuseGitImportEnrichment(
        basePlan.artifact_id,
        event.record.event_id,
        'does not cover the imported step and checkpoint shape'
      );
    }
    if (
      payload.decisions.mode === 'replace' &&
      payload.decisions.decisions.some((decision) => !memberShas.has(decision.evidence.commit_sha))
    ) {
      refuseGitImportEnrichment(
        basePlan.artifact_id,
        event.record.event_id,
        'cites a commit outside the imported member set'
      );
    }
    validated.push({ event, payload });
    priorEventId = event.record.event_id;
  }
  return validated;
}
function rebuildValidatedPlanStateFromEvents(
  events: readonly EventWithPayload[]
): ValidatedPlanState | null {
  const planEvents: EventWithPayload[] = [];
  for (const ev of events) {
    if (ev.record.type === 'plan_captured' || ev.record.type === 'plan_revised') {
      planEvents.push(ev);
    }
  }
  if (planEvents.length === 0) return null;
  if (planEvents[0].record.type !== 'plan_captured') {
    throw new Error(
      `rebuildPlanFromEvents: first plan event is ${planEvents[0].record.type}, ` +
        `expected plan_captured (no initial capture before revision — log corruption).`
    );
  }
  const captureCount = planEvents.filter((e) => e.record.type === 'plan_captured').length;
  if (captureCount > 1) {
    throw new Error(
      `rebuildPlanFromEvents: ${captureCount} plan_captured events for the same artifact — ` +
        `log corruption (initial capture is once-only; subsequent changes are plan_revised).`
    );
  }
  const latest = planEvents[planEvents.length - 1];
  const planRaw = latest.payload as Record<string, unknown>;
  let plan = PlanSchema.parse({ ...planRaw, source_event_id: latest.record.event_id });
  let sourceEventId = latest.record.event_id;
  const enrichments = validateGitImportEnrichments(events, plan);
  for (const enrichment of enrichments) {
    const payload = enrichment.payload;
    plan = PlanSchema.parse({
      ...plan,
      label: payload.label,
      task: payload.task,
      plan_steps: plan.plan_steps.map((step, index) => ({
        ...step,
        ...payload.steps[index],
      })),
      decisions:
        payload.decisions.mode === 'replace' ? payload.decisions.decisions : plan.decisions,
      origin: { ...plan.origin, enriched_at: payload.enriched_at },
      source_event_id: enrichment.event.record.event_id,
    });
    sourceEventId = enrichment.event.record.event_id;
  }
  return { rebuilt: { plan, sourceEventId }, enrichments };
}
export function rebuildPlanFromEvents(events: readonly EventWithPayload[]): RebuiltPlan | null {
  return rebuildValidatedPlanStateFromEvents(events)?.rebuilt ?? null;
}
export interface RebuiltCheckpoint {
  checkpoint: Checkpoint;
  sourceEventId: string;
}
interface OpenEventPayload {
  artifact_id: string;
  n: number;
  declared_step_ids: string[];
  agent_session_id?: string;
  agent: string;
  policy_exceptions: PolicyException[];
  plan_revision_id: string | null;
  open_plan_revision_event_id: string;
  opened_at: string;
  head_sha: string;
  gate_audit?: {
    runs?: unknown[];
    dispositions?: unknown[];
  };
  open_unmerged_paths?: string[];
  open_unmerged_probe_failed?: true;
  open_snapshot: CheckpointSnapshotBoundary;
}
interface ClosedEventPayload {
  artifact_id: string;
  n: number;
  closed_by_agent: string;
  summary: string;
  files_changed: string[];
  decisions: unknown[];
  uncertainty: string[];
  done_criteria: DoneCriterion[];
  verification?: VerificationEntry[];
  window_overlap?: WindowOverlap;
  attribution_degraded?: AttributionDegraded;
  completed_step_ids: string[];
  head_sha: string;
  ts: string;
  close_snapshot: CheckpointSnapshotBoundary;
  diff_fingerprint_summary: DiffFingerprintSummary;
  diff_fingerprint_manifest?: DiffFingerprintManifest;
}
interface AbandonedEventPayload {
  artifact_id: string;
  n: number;
  abandoned_by_agent: string;
  reason: string;
  abandoned_at: string;
  head_sha: string;
  abandon_snapshot: CheckpointSnapshotBoundary;
}
function checkpointEvents(
  events: readonly EventWithPayload[],
  n: number,
  type: 'checkpoint_opened' | 'checkpoint_closed' | 'checkpoint_abandoned'
): EventWithPayload[] {
  return events.filter((ev) => {
    if (ev.record.type !== type) return false;
    return (
      (
        ev.payload as {
          n?: unknown;
        }
      ).n === n
    );
  });
}
function rebuildCheckpointFromEventsWithPlanState(
  events: readonly EventWithPayload[],
  n: number,
  validatedPlanState?: ValidatedPlanState | null
): RebuiltCheckpoint | null {
  const opens = checkpointEvents(events, n, 'checkpoint_opened');
  const closes = checkpointEvents(events, n, 'checkpoint_closed');
  const abandons = checkpointEvents(events, n, 'checkpoint_abandoned');
  if (opens.length === 0) {
    if (closes.length > 0 || abandons.length > 0) {
      throw new Error(
        `rebuildCheckpointFromEvents: checkpoint(n=${n}) has a ` +
          `${closes.length > 0 ? 'checkpoint_closed' : 'checkpoint_abandoned'} event with no ` +
          `matching prior checkpoint_opened — log corruption.`
      );
    }
    return null;
  }
  if (opens.length !== 1) {
    throw new Error(
      `rebuildCheckpointFromEvents: checkpoint(n=${n}) has ${opens.length} ` +
        `checkpoint_opened events; exactly one is allowed — log corruption.`
    );
  }
  if (closes.length > 1) {
    throw new Error(
      `rebuildCheckpointFromEvents: checkpoint(n=${n}) has ${closes.length} ` +
        `checkpoint_closed events; at most one is allowed — log corruption.`
    );
  }
  if (abandons.length > 1) {
    throw new Error(
      `rebuildCheckpointFromEvents: checkpoint(n=${n}) has ${abandons.length} ` +
        `checkpoint_abandoned events; at most one is allowed — log corruption.`
    );
  }
  if (closes.length === 1 && abandons.length === 1) {
    throw new Error(
      `rebuildCheckpointFromEvents: checkpoint(n=${n}) has both checkpoint_closed and ` +
        `checkpoint_abandoned terminal events — log corruption.`
    );
  }
  const openEv = opens[0];
  const openIdx = events.indexOf(openEv);
  for (let i = 0; i < openIdx; i++) {
    const prior = events[i];
    if (prior.record.type !== 'checkpoint_closed' && prior.record.type !== 'checkpoint_abandoned')
      continue;
    const p = prior.payload as {
      n?: unknown;
    };
    if (p.n === n) {
      throw new Error(
        `rebuildCheckpointFromEvents: checkpoint(n=${n}) has a ` +
          `${prior.record.type} event BEFORE the matching checkpoint_opened ` +
          `(out-of-order — log corruption).`
      );
    }
  }
  const openPayload = openEv.payload as OpenEventPayload;
  const abandonEv = abandons[0] ?? null;
  const closeEv = closes[0] ?? null;
  const decisive: 'closed' | 'abandoned' | null = closeEv
    ? 'closed'
    : abandonEv
      ? 'abandoned'
      : null;
  if (decisive === null) {
    const open: OpenCheckpoint = OpenCheckpointSchema.parse({
      schema_version: 4,
      status: 'open',
      artifact_id: openPayload.artifact_id,
      n: openPayload.n,
      declared_step_ids: openPayload.declared_step_ids,
      agent_session_id: openPayload.agent_session_id,
      agent: openPayload.agent,
      policy_exceptions: openPayload.policy_exceptions,
      plan_revision_id: openPayload.plan_revision_id,
      open_plan_revision_event_id: openPayload.open_plan_revision_event_id,
      opened_at: openPayload.opened_at,
      head_sha: openPayload.head_sha,
      open_snapshot: openPayload.open_snapshot,
      source_event_id: openEv.record.event_id,
    });
    return { checkpoint: open, sourceEventId: openEv.record.event_id };
  }
  if (decisive === 'closed' && closeEv) {
    const closePayload = closeEv.payload as ClosedEventPayload;
    const hasEnrichment = events.some((event) => event.record.type === 'git_import_enriched');
    const planState = hasEnrichment
      ? validatedPlanState === undefined
        ? rebuildValidatedPlanStateFromEvents(events)
        : validatedPlanState
      : null;
    if (hasEnrichment && !planState) {
      refuseGitImportEnrichment(
        openPayload.artifact_id,
        null,
        'cannot be projected because the imported plan is missing'
      );
    }
    const enrichment = planState?.enrichments.at(-1);
    const enrichedSummary = enrichment
      ? enrichment.payload.checkpoint_summaries.find((entry) => entry.n === n)?.summary
      : undefined;
    const sourceEventId = enrichment?.event.record.event_id ?? closeEv.record.event_id;
    const closed: ClosedCheckpoint = ClosedCheckpointSchema.parse({
      schema_version: 4,
      status: 'closed',
      artifact_id: openPayload.artifact_id,
      n: openPayload.n,
      declared_step_ids: openPayload.declared_step_ids,
      agent_session_id: openPayload.agent_session_id,
      agent: openPayload.agent,
      policy_exceptions: openPayload.policy_exceptions,
      plan_revision_id: openPayload.plan_revision_id,
      open_plan_revision_event_id: openPayload.open_plan_revision_event_id,
      opened_at: openPayload.opened_at,
      open_head_sha: openPayload.head_sha,
      open_snapshot: openPayload.open_snapshot,
      closed_at: closePayload.ts,
      closed_by_agent: closePayload.closed_by_agent,
      summary: enrichedSummary ?? closePayload.summary,
      files_changed: closePayload.files_changed,
      decisions: closePayload.decisions,
      uncertainty: closePayload.uncertainty,
      done_criteria: closePayload.done_criteria,
      ...(closePayload.verification !== undefined
        ? { verification: closePayload.verification }
        : {}),
      ...(closePayload.window_overlap !== undefined
        ? { window_overlap: closePayload.window_overlap }
        : {}),
      ...(closePayload.attribution_degraded !== undefined
        ? { attribution_degraded: closePayload.attribution_degraded }
        : {}),
      completed_step_ids: closePayload.completed_step_ids,
      head_sha: closePayload.head_sha,
      close_snapshot: closePayload.close_snapshot,
      diff_fingerprint_summary: closePayload.diff_fingerprint_summary,
      source_event_ids: { opened: openEv.record.event_id, closed: closeEv.record.event_id },
      source_event_id: sourceEventId,
    });
    return { checkpoint: closed, sourceEventId };
  }
  if (!abandonEv) {
    throw new Error(
      `rebuildCheckpointFromEvents: invariant violation — abandon decisive but no abandon event`
    );
  }
  const abandonPayload = abandonEv.payload as AbandonedEventPayload;
  const abandoned: AbandonedCheckpoint = AbandonedCheckpointSchema.parse({
    schema_version: 4,
    status: 'abandoned',
    artifact_id: openPayload.artifact_id,
    n: openPayload.n,
    declared_step_ids: openPayload.declared_step_ids,
    agent_session_id: openPayload.agent_session_id,
    agent: openPayload.agent,
    policy_exceptions: openPayload.policy_exceptions,
    plan_revision_id: openPayload.plan_revision_id,
    open_plan_revision_event_id: openPayload.open_plan_revision_event_id,
    opened_at: openPayload.opened_at,
    open_snapshot: openPayload.open_snapshot,
    abandoned_at: abandonPayload.abandoned_at,
    abandoned_by_agent: abandonPayload.abandoned_by_agent,
    reason: abandonPayload.reason,
    head_sha: abandonPayload.head_sha,
    abandon_snapshot: abandonPayload.abandon_snapshot,
    source_event_ids: { opened: openEv.record.event_id, abandoned: abandonEv.record.event_id },
    source_event_id: abandonEv.record.event_id,
  });
  return { checkpoint: abandoned, sourceEventId: abandonEv.record.event_id };
}
export function rebuildCheckpointFromEvents(
  events: readonly EventWithPayload[],
  n: number
): RebuiltCheckpoint | null {
  return rebuildCheckpointFromEventsWithPlanState(events, n);
}
export function checkpointNsInEvents(events: readonly EventWithPayload[]): number[] {
  const ns = new Set<number>();
  for (const ev of events) {
    if (
      ev.record.type === 'checkpoint_opened' ||
      ev.record.type === 'checkpoint_closed' ||
      ev.record.type === 'checkpoint_abandoned'
    ) {
      const payload = ev.payload as {
        n?: unknown;
      };
      if (typeof payload.n === 'number') ns.add(payload.n);
    }
  }
  return [...ns].sort((a, b) => a - b);
}
export function rebuildAllCheckpointsFromEvents(events: readonly EventWithPayload[]): Checkpoint[] {
  const ns = checkpointNsInEvents(events);
  const hasEnrichment = events.some((event) => event.record.type === 'git_import_enriched');
  const planState = hasEnrichment ? rebuildValidatedPlanStateFromEvents(events) : null;
  const out: Checkpoint[] = [];
  for (const n of ns) {
    const r = rebuildCheckpointFromEventsWithPlanState(events, n, planState);
    if (r) out.push(r.checkpoint);
  }
  const closedClaims = new Map<string, number>();
  for (const cp of out) {
    if (cp.status !== 'closed') continue;
    for (const stepId of cp.completed_step_ids) {
      const prior = closedClaims.get(stepId);
      if (prior !== undefined && prior !== cp.n) {
        throw new Error(
          `rebuildAllCheckpointsFromEvents: step_id ${stepId} is claimed by both ` +
            `closed cp #${prior} and closed cp #${cp.n} — log corruption.`
        );
      }
      closedClaims.set(stepId, cp.n);
    }
  }
  const openDeclares = new Map<string, number>();
  for (const cp of out) {
    if (cp.status !== 'open') continue;
    for (const stepId of cp.declared_step_ids) {
      const priorOpen = openDeclares.get(stepId);
      if (priorOpen !== undefined && priorOpen !== cp.n) {
        throw new Error(
          `rebuildAllCheckpointsFromEvents: step_id ${stepId} is declared by both ` +
            `open cp #${priorOpen} and open cp #${cp.n} — log corruption.`
        );
      }
      openDeclares.set(stepId, cp.n);
      const closedHolder = closedClaims.get(stepId);
      if (closedHolder !== undefined) {
        throw new Error(
          `rebuildAllCheckpointsFromEvents: step_id ${stepId} is declared by open cp ` +
            `#${cp.n} but already claimed by closed cp #${closedHolder} — log corruption.`
        );
      }
    }
  }
  return out;
}
export interface RebuiltSummary {
  summary: Summary;
  sourceEventId: string;
}
export function rebuildSummaryFromEvents(
  events: readonly EventWithPayload[]
): RebuiltSummary | null {
  const summaryEvents = eventsOfType(events, 'summary_captured');
  const latest = summaryEvents.length > 0 ? summaryEvents[summaryEvents.length - 1] : null;
  if (latest === null) return null;
  const summaryRaw = latest.payload as Record<string, unknown>;
  const hasEnrichment = events.some((event) => event.record.type === 'git_import_enriched');
  const planState = hasEnrichment ? rebuildValidatedPlanStateFromEvents(events) : null;
  if (hasEnrichment && !planState) {
    refuseGitImportEnrichment(
      String(summaryRaw.artifact_id ?? 'unknown'),
      null,
      'cannot be projected because the imported plan is missing'
    );
  }
  const enrichment = planState?.enrichments.at(-1);
  const enrichmentPayload = enrichment?.payload ?? null;
  const enrichmentIsLatest = enrichment
    ? events.indexOf(enrichment.event) > events.indexOf(latest)
    : false;
  const sourceEventId = enrichmentIsLatest
    ? enrichment!.event.record.event_id
    : latest.record.event_id;
  const summary = SummarySchema.parse({
    ...summaryRaw,
    ...(enrichmentPayload && enrichmentIsLatest ? { outcome: enrichmentPayload.outcome } : {}),
    source_event_id: sourceEventId,
  });
  return { summary, sourceEventId };
}
export interface RebuiltEvaluatorLog {
  log: EvaluatorLog;
  sourceEventId: string;
}
interface UnfoldedRunRow {
  payload: ReturnType<(typeof EvaluatorRunPayloadSchema)['parse']>;
  source_event_index: number;
  local_index: number;
}
interface UnfoldedDispositionRow {
  payload: ReturnType<(typeof EvaluatorDispositionPayloadSchema)['parse']>;
  source_event_index: number;
  local_index: number;
}
function walkEvaluatorRowsInOrder(events: readonly EventWithPayload[]): {
  runs: UnfoldedRunRow[];
  dispositions: UnfoldedDispositionRow[];
  lastEventId: string | null;
} {
  const runs: UnfoldedRunRow[] = [];
  const dispositions: UnfoldedDispositionRow[] = [];
  let lastEventId: string | null = null;
  events.forEach((ev, i) => {
    if (ev.record.type === 'evaluator_run_recorded') {
      const payload = EvaluatorRunPayloadSchema.parse(ev.payload);
      runs.push({ payload, source_event_index: i, local_index: 0 });
      lastEventId = ev.record.event_id;
      return;
    }
    if (ev.record.type === 'evaluator_disposition_recorded') {
      const payload = EvaluatorDispositionPayloadSchema.parse(ev.payload);
      dispositions.push({ payload, source_event_index: i, local_index: 0 });
      lastEventId = ev.record.event_id;
      return;
    }
    if (ev.record.type === 'checkpoint_opened') {
      const open = ev.payload as OpenEventPayload;
      if (!open.gate_audit) return;
      const audit = GateAuditPayloadSchema.parse(open.gate_audit);
      audit.runs.forEach((auditRun, n) => {
        const [packageId, evaluatorId] = auditRun.evaluator_ref.split('/');
        const payload = EvaluatorRunPayloadSchema.parse({
          schema: 'orcaops.evaluator_run/v1',
          run_id: auditRun.run_id,
          artifact_id: open.artifact_id,
          evaluator_ref: auditRun.evaluator_ref,
          package_id: packageId,
          evaluator_id: evaluatorId,
          phase: auditRun.phase,
          severity: auditRun.severity,
          run_status: auditRun.run_status,
          verdict: auditRun.verdict,
          body: auditRun.body,
          ...(auditRun.raw !== undefined ? { raw: auditRun.raw } : {}),
          ...(auditRun.metrics !== undefined ? { metrics: auditRun.metrics } : {}),
          ...(auditRun.provider !== undefined ? { provider: auditRun.provider } : {}),
          ...(auditRun.model !== undefined ? { model: auditRun.model } : {}),
          ...(auditRun.tokens !== undefined ? { tokens: auditRun.tokens } : {}),
          ...(auditRun.cost_usd !== undefined ? { cost_usd: auditRun.cost_usd } : {}),
          ...(auditRun.duration_ms !== undefined ? { duration_ms: auditRun.duration_ms } : {}),
          checkpoint_n: open.n,
          ...(auditRun.error !== undefined ? { error: auditRun.error } : {}),
          ts: auditRun.ts,
        });
        runs.push({ payload, source_event_index: i, local_index: n });
      });
      audit.dispositions.forEach((auditDispo, m) => {
        const payload = EvaluatorDispositionPayloadSchema.parse({
          schema: 'orcaops.evaluator_disposition/v1',
          disposition_id: auditDispo.disposition_id,
          artifact_id: open.artifact_id,
          run_id: auditDispo.run_id,
          evaluator_ref: auditDispo.evaluator_ref,
          disposition: auditDispo.disposition,
          reason: auditDispo.reason,
          agent_session_id: open.agent_session_id ?? null,
          ts: auditDispo.ts,
        });
        dispositions.push({ payload, source_event_index: i, local_index: m });
      });
      if (audit.runs.length > 0 || audit.dispositions.length > 0) {
        lastEventId = ev.record.event_id;
      }
    }
  });
  return { runs, dispositions, lastEventId };
}
export function rebuildEvaluatorLogFromEvents(
  events: readonly EventWithPayload[],
  artifactId: string
): RebuiltEvaluatorLog | null {
  const { runs: runRows, dispositions: dispoRows, lastEventId } = walkEvaluatorRowsInOrder(events);
  if (events.length === 0) return null;
  const effectiveLastEventId = lastEventId ?? events[events.length - 1].record.event_id;
  if (runRows.length === 0 && dispoRows.length === 0) {
    return {
      log: {
        schema_version: 1,
        artifact_id: artifactId,
        runs: [],
        dispositions: [],
        source_event_id: effectiveLastEventId,
      },
      sourceEventId: effectiveLastEventId,
    };
  }
  const dispositionsByRunId = new Map<string, (typeof dispoRows)[number]>();
  for (const d of dispoRows) {
    dispositionsByRunId.set(d.payload.run_id, d);
  }
  const materializedRuns: MaterializedEvaluatorRun[] = runRows.map((r) => {
    const blockingEligible = isBlockingEligible(r.payload);
    let disposition: MaterializedEvaluatorRun['disposition'];
    if (!blockingEligible) {
      disposition = null;
    } else {
      const d = dispositionsByRunId.get(r.payload.run_id);
      disposition = d === undefined ? 'unresolved' : d.payload.disposition;
    }
    return {
      ...r.payload,
      disposition,
      source_event_index: r.source_event_index,
      local_kind_rank: 0 as const,
      local_index: r.local_index,
    };
  });
  const materializedDispositions: MaterializedEvaluatorDisposition[] = dispoRows.map((d) => ({
    ...d.payload,
    source_event_index: d.source_event_index,
    local_kind_rank: 1 as const,
    local_index: d.local_index,
  }));
  return {
    log: {
      schema_version: 1,
      artifact_id: artifactId,
      runs: materializedRuns,
      dispositions: materializedDispositions,
      source_event_id: effectiveLastEventId,
    },
    sourceEventId: effectiveLastEventId,
  };
}
function isBlockingEligible(run: {
  severity: string;
  run_status: string;
  verdict: string | null;
}): boolean {
  return run.severity === 'block' && run.run_status === 'completed' && run.verdict === 'violation';
}
export function computeOpenBlocksByRef(events: readonly EventWithPayload[]): Set<string> {
  const { runs, dispositions } = walkEvaluatorRowsInOrder(events);
  type Sortable =
    | {
        kind: 'run';
        index: number;
        row: (typeof runs)[number];
      }
    | {
        kind: 'disposition';
        index: number;
        row: (typeof dispositions)[number];
      };
  const sortable: Sortable[] = [
    ...runs.map((row, i): Sortable => ({ kind: 'run' as const, index: i, row })),
    ...dispositions.map((row, i): Sortable => ({ kind: 'disposition' as const, index: i, row })),
  ];
  sortable.sort((a, b) => {
    if (a.row.source_event_index !== b.row.source_event_index) {
      return a.row.source_event_index - b.row.source_event_index;
    }
    const aRank = a.kind === 'run' ? 0 : 1;
    const bRank = b.kind === 'run' ? 0 : 1;
    if (aRank !== bRank) return aRank - bRank;
    return a.row.local_index - b.row.local_index;
  });
  const openBlockByRef = new Map<
    string,
    {
      runId: string;
      kind: 'violation' | 'error';
    }
  >();
  for (const entry of sortable) {
    if (entry.kind === 'run') {
      const { payload } = entry.row;
      const failureKind = blockingEvaluatorFailureKind(payload);
      if (failureKind !== null) {
        openBlockByRef.set(payload.evaluator_ref, {
          runId: payload.run_id,
          kind: failureKind,
        });
      } else if (
        payload.severity === 'block' &&
        payload.run_status === 'completed' &&
        (payload.verdict === 'pass' || payload.verdict === 'info')
      ) {
        openBlockByRef.delete(payload.evaluator_ref);
      }
    } else {
      const { payload } = entry.row;
      const current = openBlockByRef.get(payload.evaluator_ref);
      if (current?.kind === 'violation' && current.runId === payload.run_id) {
        openBlockByRef.delete(payload.evaluator_ref);
      }
    }
  }
  return new Set(openBlockByRef.keys());
}
export interface RebuiltArtifactJson {
  json: ArtifactJson;
  sourceEventId: string;
  openBlocks: string[];
}
export function rebuildArtifactJsonFromEvents(
  events: readonly EventWithPayload[]
): RebuiltArtifactJson | null {
  const planEvent = events.find((e) => e.record.type === 'plan_captured');
  if (!planEvent) return null;
  const planPayload = planEvent.payload as {
    artifact_id?: unknown;
    branch?: unknown;
    base_sha?: unknown;
    started_at?: unknown;
    agent_session_id?: unknown;
    source_plan?: unknown;
    baseline_seed_tree_sha?: unknown;
    superseded_artifact_id?: unknown;
    origin?: unknown;
  };
  const artifactId = String(planPayload.artifact_id ?? '');
  const branch = String(planPayload.branch ?? '');
  const baseSha = String(planPayload.base_sha ?? '');
  const createdAt = String(planPayload.started_at ?? planEvent.record.ts);
  const createdBySessionId =
    typeof planPayload.agent_session_id === 'string' ? planPayload.agent_session_id : null;
  const rawPin = planPayload.source_plan ?? null;
  const sourcePlan = SourcePlanPinSchema.nullable().parse(rawPin);
  const baselineSeedTreeSha =
    typeof planPayload.baseline_seed_tree_sha === 'string'
      ? planPayload.baseline_seed_tree_sha
      : null;
  const supersededArtifactId =
    typeof planPayload.superseded_artifact_id === 'string'
      ? planPayload.superseded_artifact_id
      : null;
  const initialOrigin =
    planPayload.origin === undefined ? undefined : ArtifactOriginSchema.parse(planPayload.origin);
  const hasEnrichment = events.some((event) => event.record.type === 'git_import_enriched');
  const planState = hasEnrichment ? rebuildValidatedPlanStateFromEvents(events) : null;
  const origin = planState?.rebuilt.plan.origin ?? initialOrigin;
  const branchLineage: BranchLineageEntry[] = [
    { branch, head_sha: baseSha, ts: createdAt, event: 'created' },
  ];
  let updatedAt = createdAt;
  const seenClosedNs = new Set<number>();
  let latestEventId = planEvent.record.event_id;
  let hasClosedCheckpoint = false;
  let hasSummary = false;
  let planRevisionCount = 0;
  let planLastRevisedAt: string | null = null;
  let prePrCheckedHeadSha: string | null = null;
  let prePrCheckedSourceEventId: string | null = null;
  for (const ev of events) {
    switch (ev.record.type) {
      case 'plan_captured':
        latestEventId = ev.record.event_id;
        break;
      case 'plan_revised':
        planRevisionCount += 1;
        planLastRevisedAt = ev.record.ts;
        updatedAt = ev.record.ts;
        latestEventId = ev.record.event_id;
        break;
      case 'git_import_enriched':
        updatedAt = ev.record.ts;
        latestEventId = ev.record.event_id;
        break;
      case 'checkpoint_opened':
        updatedAt = ev.record.ts;
        latestEventId = ev.record.event_id;
        break;
      case 'checkpoint_closed': {
        const cp = ev.payload as {
          n?: number;
        };
        if (typeof cp.n === 'number' && !seenClosedNs.has(cp.n)) {
          seenClosedNs.add(cp.n);
        }
        hasClosedCheckpoint = true;
        updatedAt = ev.record.ts;
        latestEventId = ev.record.event_id;
        break;
      }
      case 'checkpoint_abandoned':
        updatedAt = ev.record.ts;
        latestEventId = ev.record.event_id;
        break;
      case 'summary_captured':
        hasSummary = true;
        updatedAt = ev.record.ts;
        latestEventId = ev.record.event_id;
        break;
      case 'branch_lineage_updated': {
        const entry = BranchLineageEntrySchema.parse(ev.payload);
        const tail = branchLineage[branchLineage.length - 1];
        const isDuplicate =
          tail &&
          tail.branch === entry.branch &&
          tail.head_sha === entry.head_sha &&
          tail.event === entry.event;
        if (!isDuplicate) branchLineage.push(entry);
        updatedAt = ev.record.ts;
        latestEventId = ev.record.event_id;
        break;
      }
      case 'evaluator_run_recorded':
      case 'evaluator_disposition_recorded':
        updatedAt = ev.record.ts;
        latestEventId = ev.record.event_id;
        break;
      case 'block_acknowledged':
      case 'block_dismissed':
        updatedAt = ev.record.ts;
        latestEventId = ev.record.event_id;
        break;
      case 'pre_pr_checked': {
        const parsed = PrePrCheckedPayloadSchema.safeParse(ev.payload);
        if (parsed.success && prePrCheckedOutcome(parsed.data) === 'passed') {
          prePrCheckedHeadSha = parsed.data.head_sha;
          prePrCheckedSourceEventId = ev.record.event_id;
        }
        updatedAt = ev.record.ts;
        latestEventId = ev.record.event_id;
        break;
      }
      case 'pin_displaced':
        updatedAt = ev.record.ts;
        latestEventId = ev.record.event_id;
        break;
    }
  }
  const openBlocks = computeOpenBlocksByRef(events);
  const state: ArtifactState =
    openBlocks.size > 0
      ? 'blocked'
      : hasSummary
        ? 'summarized'
        : hasClosedCheckpoint
          ? 'active'
          : 'planned';
  const json: ArtifactJson = {
    schema_version: 1,
    id: artifactId,
    state,
    branch_lineage: branchLineage,
    created_by_session_id: createdBySessionId,
    created_at: createdAt,
    updated_at: updatedAt,
    checkpoint_count: seenClosedNs.size,
    plan_revision_count: planRevisionCount,
    plan_last_revised_at: planLastRevisedAt,
    source_event_id: latestEventId,
    source_plan: sourcePlan,
    pre_pr_checked_head_sha: prePrCheckedHeadSha,
    pre_pr_checked_source_event_id: prePrCheckedSourceEventId,
    baseline_seed_tree_sha: baselineSeedTreeSha,
    superseded_artifact_id: supersededArtifactId,
    ...(origin !== undefined ? { origin } : {}),
  };
  return {
    json,
    sourceEventId: latestEventId,
    openBlocks: [...openBlocks].sort(),
  };
}
export {
  CheckpointSchema,
  type Checkpoint,
  type OpenCheckpoint,
  type ClosedCheckpoint,
  type AbandonedCheckpoint,
};
