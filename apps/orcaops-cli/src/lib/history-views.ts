import { computeCoverage } from '@orcaops/core';
import type { ArtifactOriginKind, EvaluatorRunStatsRow, StepClaims } from '@orcaops/storage';

export interface StepView {
  step_id: string;
  idx: number;
  text: string;
  label: string;
  acceptance_criteria: Array<{ criterion_id: string; text: string }>;
}

export type StepClaimState =
  | { state: 'claimed'; checkpoint_n: number }
  | { state: 'declared_by_open_checkpoint'; checkpoint_n: number }
  | { state: 'unclaimed' }
  | { state: 'not_claimable_dropped' };

export interface StepBriefInput {
  artifactId: string;
  stepId: string;
  /** `git-import` marks synthesized history; null for live captures. */
  origin: ArtifactOriginKind | null;
  /** Latest plan revision (steps carry PARSED acceptance criteria). */
  latest: {
    revision_n: number;
    steps: StepView[];
    non_goals: unknown[];
    touched_scope: string[];
  };
  /**
   * When the step is absent from the latest revision: the last revision
   * that contained it (already resolved by the caller), else null.
   */
  lastPresent: { revision_n: number; step: StepView } | null;
  claims: StepClaims;
  closedCheckpoints: ReadonlyArray<{
    n: number;
    closed_at: string;
    summary: string;
    completed_step_ids: readonly string[];
    done_criteria: ReadonlyArray<{ criterion_id: string; evidence: string }>;
  }>;
}

export interface StepBrief {
  artifact_id: string;
  /** `git-import` when the brief serves synthesized history; null for live captures. */
  origin: ArtifactOriginKind | null;
  step: {
    step_id: string;
    text: string;
    label: string;
    acceptance_criteria: Array<{ criterion_id: string; text: string }>;
    dropped_in_latest_revision: boolean;
    last_present_revision_n: number;
  };
  claim_state: StepClaimState;
  related_closed_checkpoints: Array<{
    n: number;
    closed_at: string;
    summary: string;
    done_criteria: Array<{ criterion_id: string; evidence: string }>;
  }>;
  guardrails: { non_goals: unknown[]; touched_scope: string[] };
  siblings: Array<{ step_id: string; label: string; claim_state: StepClaimState }>;
  /** Present only for dropped steps: the dispatchability warning. */
  note?: string;
}

function claimStateFor(stepId: string, claims: StepClaims, dropped: boolean): StepClaimState {
  if (dropped) return { state: 'not_claimable_dropped' };
  if (claims.closedClaimed.includes(stepId)) {
    // Attribution of WHICH cp claimed it happens in buildStepBrief where the
    // closed cps are in hand; this branch is refined there.
    return { state: 'claimed', checkpoint_n: -1 };
  }
  const open = claims.openDeclared.find((o) => o.declared.includes(stepId));
  if (open) return { state: 'declared_by_open_checkpoint', checkpoint_n: open.n };
  return { state: 'unclaimed' };
}

/** Assemble the brief. Pure — unit-tested directly. */
export function buildStepBrief(input: StepBriefInput): StepBrief {
  const inLatest = input.latest.steps.find((s) => s.step_id === input.stepId);
  const dropped = inLatest === undefined;
  const resolved = inLatest ?? input.lastPresent?.step;
  if (resolved === undefined) {
    throw new Error(`step ${input.stepId} resolved by neither latest nor historical revision`);
  }
  const lastPresentRevision = dropped ? input.lastPresent!.revision_n : input.latest.revision_n;

  const withClaimCp = (state: StepClaimState, stepId: string): StepClaimState => {
    if (state.state !== 'claimed') return state;
    const cp = input.closedCheckpoints.find((c) => c.completed_step_ids.includes(stepId));
    return { state: 'claimed', checkpoint_n: cp?.n ?? -1 };
  };

  const claim_state = withClaimCp(claimStateFor(input.stepId, input.claims, dropped), input.stepId);

  const criterionIds = new Set(resolved.acceptance_criteria.map((c) => c.criterion_id));
  const related_closed_checkpoints = input.closedCheckpoints
    .map((cp) => ({
      n: cp.n,
      closed_at: cp.closed_at,
      summary: cp.summary,
      done_criteria: cp.done_criteria.filter((d) => criterionIds.has(d.criterion_id)),
      claimed: cp.completed_step_ids.includes(input.stepId),
    }))
    .filter((cp) => cp.claimed || cp.done_criteria.length > 0)
    .map(({ claimed: _claimed, ...cp }) => cp);

  const siblings = input.latest.steps
    .filter((s) => s.step_id !== input.stepId)
    .map((s) => ({
      step_id: s.step_id,
      label: s.label,
      claim_state: withClaimCp(claimStateFor(s.step_id, input.claims, false), s.step_id),
    }));

  return {
    artifact_id: input.artifactId,
    origin: input.origin,
    step: {
      step_id: input.stepId,
      text: resolved.text,
      label: resolved.label,
      acceptance_criteria: resolved.acceptance_criteria,
      dropped_in_latest_revision: dropped,
      last_present_revision_n: lastPresentRevision,
    },
    claim_state,
    related_closed_checkpoints,
    guardrails: {
      non_goals: input.latest.non_goals,
      touched_scope: input.latest.touched_scope,
    },
    siblings,
    ...(dropped
      ? {
          note:
            `This step was dropped in a plan revision (last present in revision ` +
            `${lastPresentRevision}). It is informational-only: checkpoint opens validate ` +
            `declared_step_ids against the ACTIVE revision, so a dropped step can never be ` +
            `claimed or dispatched.`,
        }
      : {}),
  };
}

export interface DecisionRecord {
  source: 'plan' | 'checkpoint' | 'summary_deferred';
  /** Best-known timestamp; null only when a plan revision row is missing. */
  ts: string | null;
  decision: string;
  reason: string | null;
  alternatives_considered?: Array<{ option: string; rejected_because: string }>;
  evidence?: { kind: 'git-commit'; commit_sha: string; quote: string };
  /** Plan records: the revision that added the decision. */
  revision_n?: number;
  /** Checkpoint records: the closing checkpoint's n. */
  checkpoint_n?: number;
}

export interface CollectDecisionsInput {
  /** Latest plan revision's cumulative decisions (each stamped revision_n). */
  planDecisions: ReadonlyArray<{
    decision: string;
    reason?: string | null;
    alternatives_considered?: ReadonlyArray<{ option: string; rejected_because: string }>;
    evidence?: { kind: 'git-commit'; commit_sha: string; quote: string };
    revision_n: number;
  }>;
  /** revision_n → captured_at (from listPlanRevisions). */
  revisionCapturedAt: ReadonlyMap<number, string>;
  closedCheckpoints: ReadonlyArray<{
    n: number;
    closed_at: string;
    decisions: readonly unknown[];
  }>;
  /** Summary deferred_decisions (plain strings per the Summary schema). */
  deferredDecisions: readonly string[];
  summaryTs: string | null;
}

export interface RecordWindow {
  lower?: string;
  upper?: string;
}

/**
 * Intersect the two flag pairs into one record window: lower = the latest
 * provided lower bound, upper = the earliest provided upper bound. No flags
 * ⇒ empty window ⇒ all records.
 */
export function recordWindowFromFlags(w: {
  since?: string;
  until?: string;
  activeSince?: string;
  activeUntil?: string;
}): RecordWindow {
  const lowers = [w.since, w.activeSince].filter((x): x is string => x !== undefined);
  const uppers = [w.until, w.activeUntil].filter((x): x is string => x !== undefined);
  return {
    ...(lowers.length > 0 ? { lower: lowers.reduce((a, b) => (a > b ? a : b)) } : {}),
    ...(uppers.length > 0 ? { upper: uppers.reduce((a, b) => (a < b ? a : b)) } : {}),
  };
}

/**
 * Merge one artifact's decision records from the three sources and filter
 * them to the record window. Pure — unit-tested directly.
 */
export function collectArtifactDecisions(
  input: CollectDecisionsInput,
  window: RecordWindow = {}
): DecisionRecord[] {
  const records: DecisionRecord[] = [];

  for (const d of input.planDecisions) {
    records.push({
      source: 'plan',
      ts: input.revisionCapturedAt.get(d.revision_n) ?? null,
      decision: d.decision,
      reason: d.reason ?? null,
      ...(d.alternatives_considered && d.alternatives_considered.length > 0
        ? { alternatives_considered: [...d.alternatives_considered] }
        : {}),
      ...(d.evidence ? { evidence: d.evidence } : {}),
      revision_n: d.revision_n,
    });
  }

  for (const cp of input.closedCheckpoints) {
    for (const raw of cp.decisions) {
      if (raw === null || typeof raw !== 'object') continue;
      const d = raw as {
        decision?: unknown;
        reason?: unknown;
        alternatives_considered?: unknown;
      };
      if (typeof d.decision !== 'string' || d.decision.length === 0) continue;
      const alts = Array.isArray(d.alternatives_considered)
        ? (d.alternatives_considered as Array<{ option: string; rejected_because: string }>)
        : [];
      records.push({
        source: 'checkpoint',
        ts: cp.closed_at,
        decision: d.decision,
        reason: typeof d.reason === 'string' ? d.reason : null,
        ...(alts.length > 0 ? { alternatives_considered: alts } : {}),
        checkpoint_n: cp.n,
      });
    }
  }

  for (const text of input.deferredDecisions) {
    records.push({
      source: 'summary_deferred',
      ts: input.summaryTs,
      decision: text,
      reason: null,
    });
  }

  if (window.lower === undefined && window.upper === undefined) return records;
  // A record whose ts is unknown cannot be shown to lie inside the window —
  // drop it rather than guess.
  return records.filter(
    (r) =>
      r.ts !== null &&
      (window.lower === undefined || r.ts >= window.lower) &&
      (window.upper === undefined || r.ts <= window.upper)
  );
}

export interface LooseEndsInput {
  planSteps: ReadonlyArray<{ step_id: string; label: string; text: string }>;
  closedCheckpoints: ReadonlyArray<{
    n: number;
    closed_at: string;
    completed_step_ids: readonly string[];
    uncertainty: readonly string[];
  }>;
  openCheckpoints: ReadonlyArray<{
    n: number;
    opened_at: string;
    declared_step_ids: readonly string[];
  }>;
  summary: {
    open_items: readonly string[];
    deferred_decisions: readonly string[];
    ts: string;
  } | null;
  /**
   * True when the summary exists but could not be read (recovery
   * refusal) — distinct from `summary: null` (never captured). The
   * open items and deferred decisions are UNKNOWN, not empty.
   */
  summaryUnreadable?: boolean;
  /** True when the artifact log itself refused recovery. */
  artifactUnreadable?: boolean;
  /** ISO now, for open-checkpoint age computation. */
  now: string;
}

export interface ArtifactLooseEnds {
  open_items: Array<{ text: string; ts: string }>;
  deferred_decisions: Array<{ text: string; ts: string }>;
  uncertainty: Array<{ checkpoint_n: number; closed_at: string; entries: string[] }>;
  uncovered_steps: Array<{ step_id: string; label: string; text: string }>;
  open_checkpoints: Array<{ n: number; opened_at: string; age_seconds: number }>;
  no_summary: boolean;
  /** The summary exists but is unreadable — findings from it are unknown. */
  summary_unreadable: boolean;
  finding_count: number;
}

/** Assemble one artifact's current loose ends. Pure — unit-tested directly. */
export function collectLooseEnds(input: LooseEndsInput): ArtifactLooseEnds {
  const summaryTs = input.summary?.ts ?? '';
  const open_items = (input.summary?.open_items ?? []).map((text) => ({ text, ts: summaryTs }));
  const deferred_decisions = (input.summary?.deferred_decisions ?? []).map((text) => ({
    text,
    ts: summaryTs,
  }));

  const uncertainty = input.closedCheckpoints
    .filter((cp) => cp.uncertainty.length > 0)
    .map((cp) => ({
      checkpoint_n: cp.n,
      closed_at: cp.closed_at,
      entries: [...cp.uncertainty],
    }));

  const coverage = computeCoverage({
    planStepIds: input.planSteps.map((s) => s.step_id),
    closedCheckpoints: input.closedCheckpoints,
    openCheckpoints: input.openCheckpoints,
  });
  const stepById = new Map(input.planSteps.map((s) => [s.step_id, s]));
  const uncovered_steps = coverage.uncovered_step_ids.map((id) => {
    const s = stepById.get(id);
    return { step_id: id, label: s?.label ?? '(unknown)', text: s?.text ?? '(unknown)' };
  });

  const nowMs = Date.parse(input.now);
  const open_checkpoints = input.openCheckpoints.map((cp) => ({
    n: cp.n,
    opened_at: cp.opened_at,
    age_seconds: Math.max(0, Math.floor((nowMs - Date.parse(cp.opened_at)) / 1000)),
  }));

  const summary_unreadable = input.summaryUnreadable === true;
  // An unreadable summary is NOT "no summary": the artifact was closed
  // out, and its recorded open items are unknown rather than empty.
  const no_summary = input.summary === null && !summary_unreadable;
  const finding_count =
    open_items.length +
    deferred_decisions.length +
    uncertainty.reduce((acc, u) => acc + u.entries.length, 0) +
    uncovered_steps.length +
    open_checkpoints.length +
    // A plan with no summary is itself a loose end — "captured then
    // forgotten" must stay visible even with zero other findings.
    (no_summary ? 1 : 0) +
    // An unreadable summary is a finding too: the recorded loose ends
    // exist but cannot be served.
    (summary_unreadable ? 1 : 0) +
    // Log refusal is independently material even when every derivable
    // loose-end bucket happens to be empty.
    (input.artifactUnreadable === true ? 1 : 0);

  return {
    open_items,
    deferred_decisions,
    uncertainty,
    uncovered_steps,
    open_checkpoints,
    no_summary,
    summary_unreadable,
    finding_count,
  };
}

/** One evaluator's run counts + graded pass rate. */
export interface EvaluatorRateRow extends EvaluatorRunStatsRow {
  /**
   * pass / (pass + violation) over completed runs; null when nothing was
   * graded (`info` verdicts, errors, and skips are not graded outcomes).
   */
  pass_rate: number | null;
}

/** Add `pass_rate` to raw per-evaluator counts. Exported for unit tests. */
export function computeEvaluatorRates(
  rows: ReadonlyArray<EvaluatorRunStatsRow>
): EvaluatorRateRow[] {
  return rows.map((r) => {
    const graded = r.pass + r.violation;
    return { ...r, pass_rate: graded === 0 ? null : r.pass / graded };
  });
}

export interface RevisionChurn {
  artifacts_with_plan: number;
  /** Artifacts whose plan was revised at least once (max revision_n > 0). */
  revised_artifacts: number;
  max_revisions: number;
  mean_revisions: number;
  /** revision-count -> artifact count, e.g. {"0": 5, "2": 1}. */
  histogram: Record<string, number>;
}

/** Churn rollup over per-artifact latest revision_n. Exported for unit tests. */
export function computeRevisionChurn(
  counts: ReadonlyArray<{ max_revision_n: number }>
): RevisionChurn {
  const histogram: Record<string, number> = {};
  let max = 0;
  let sum = 0;
  let revised = 0;
  for (const c of counts) {
    const key = String(c.max_revision_n);
    histogram[key] = (histogram[key] ?? 0) + 1;
    max = Math.max(max, c.max_revision_n);
    sum += c.max_revision_n;
    if (c.max_revision_n > 0) revised += 1;
  }
  return {
    artifacts_with_plan: counts.length,
    revised_artifacts: revised,
    max_revisions: max,
    mean_revisions: counts.length === 0 ? 0 : sum / counts.length,
    histogram,
  };
}

export interface DurationStats {
  closed_total: number;
  min_ms: number | null;
  max_ms: number | null;
  mean_ms: number | null;
  median_ms: number | null;
  p90_ms: number | null;
}

/**
 * Duration aggregates over closed-checkpoint intervals (`closed_at −
 * opened_at`, ms). Median averages the two middles on even counts; p90 is
 * the nearest-rank percentile (`sorted[ceil(0.9·n) − 1]`). Exported for
 * unit tests (seeded-timestamp store tests pin the interval source).
 */
export function computeDurationStats(
  intervals: ReadonlyArray<{ opened_at: string; closed_at: string }>
): DurationStats {
  const durations = intervals
    .map((i) => new Date(i.closed_at).getTime() - new Date(i.opened_at).getTime())
    .sort((a, b) => a - b);
  const n = durations.length;
  if (n === 0) {
    return {
      closed_total: 0,
      min_ms: null,
      max_ms: null,
      mean_ms: null,
      median_ms: null,
      p90_ms: null,
    };
  }
  const median =
    n % 2 === 1 ? durations[(n - 1) / 2] : (durations[n / 2 - 1] + durations[n / 2]) / 2;
  return {
    closed_total: n,
    min_ms: durations[0],
    max_ms: durations[n - 1],
    mean_ms: durations.reduce((a, b) => a + b, 0) / n,
    median_ms: median,
    p90_ms: durations[Math.ceil(0.9 * n) - 1],
  };
}

function describeClaim(c: StepClaimState): string {
  switch (c.state) {
    case 'claimed':
      return `claimed by cp #${c.checkpoint_n}`;
    case 'declared_by_open_checkpoint':
      return `declared by OPEN cp #${c.checkpoint_n}`;
    case 'unclaimed':
      return 'unclaimed';
    case 'not_claimable_dropped':
      return 'dropped (not claimable)';
  }
}

export function renderStepBrief(brief: StepBrief): string {
  const lines: string[] = [];
  lines.push(`Step brief — ${brief.step.label} (artifact ${brief.artifact_id})`);
  if (brief.origin === 'git-import') {
    lines.push('  origin:       imported from git history (synthesized)');
  }
  lines.push(`  step_id:      ${brief.step.step_id}`);
  lines.push(`  text:         ${brief.step.text}`);
  lines.push(`  claim state:  ${describeClaim(brief.claim_state)}`);
  if (brief.step.dropped_in_latest_revision) {
    lines.push(`  DROPPED:      last present in revision ${brief.step.last_present_revision_n}`);
  }
  if (brief.step.acceptance_criteria.length > 0) {
    lines.push('  acceptance criteria:');
    for (const c of brief.step.acceptance_criteria) lines.push(`    - ${c.text}`);
  }
  for (const cp of brief.related_closed_checkpoints) {
    lines.push(`  related cp #${cp.n} (${cp.closed_at}): ${cp.summary}`);
    for (const d of cp.done_criteria) lines.push(`    evidence: ${d.evidence}`);
  }
  lines.push(`  touched_scope: ${brief.guardrails.touched_scope.join(', ') || '(none)'}`);
  if (brief.siblings.length > 0) {
    lines.push('  siblings:');
    for (const s of brief.siblings) lines.push(`    - ${s.label}: ${describeClaim(s.claim_state)}`);
  }
  if (brief.note) lines.push(`  note: ${brief.note}`);
  lines.push('');
  return lines.join('\n');
}
