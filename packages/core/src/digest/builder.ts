import {
  adjudicateOverlapGroups,
  type ArchivedArtifactThread,
  artifactPathsFor,
  ArtifactStore,
  atomicWriteFile,
  type AttributionDegraded,
  type Checkpoint,
  type EvaluatorLog,
  type MaterializedEvaluatorDisposition,
  type MaterializedEvaluatorRun,
  type NonGoal,
  type Plan,
  PlanSchema,
  redactSecretsInObject,
  type SourcePlanPin,
  type Summary,
  type VerificationEntry,
  type WindowOverlap,
} from '@orcaops/storage';

import { computeCoverage } from '../lifecycle/coverage.js';
import {
  formatUsageDetail,
  isRichUsageDetail,
  sessionDetailKey,
  type SessionUsageDetail,
  sessionUsageDetailByKey,
  usageDetailFingerprint,
} from '../usage/session-usage-detail.js';

/**
 * Does an evaluator ref name a plan-conformance evaluator? Its
 * row is hoisted into the near-top "plan conformance" section and filtered
 * OUT of release_checks / process_notes so it never renders twice. A
 * substring, not an exact id list, so a phase-id rename can't silently break
 * hoisting; the pack contract test guards that the spec ids honour the
 * `plan-conformance-` stem this relies on.
 *
 * The digest is now the ONLY consumer of this convention. `buildContextBlock`
 * used to gate the pinned-plan render on the same substring, which meant an
 * evaluator from any other pack silently got a prompt without the plan it was
 * asked to grade; it now renders whatever the spec's
 * `engine.additional_context_sections` declares. Presentation is a fair thing
 * to infer from a name — prompt content is not.
 */
function isPlanConformanceRef(ref: string): boolean {
  return ref.includes('/plan-conformance-');
}

export interface DigestDecision {
  decision: string;
  reason: string;
  /**
   * Provenance:
   *   - 'plan'       — captured in plan mode; carries `revision_n`.
   *   - 'checkpoint' — captured at checkpoint-close; carries `checkpoint`.
   */
  source: 'plan' | 'checkpoint';
  /** Set when `source === 'checkpoint'` — the cp the decision was recorded in. */
  checkpoint?: number;
  /** Set when `source === 'plan'` — the plan revision the decision was made at. */
  revision_n?: number;
  /**
   * Rejected alternatives that informed the decision. Rendered as
   * sub-bullets under the decision; absent/empty when the agent didn't
   * record any.
   */
  alternatives_considered?: Array<{ option: string; rejected_because: string }>;
}

/**
 * A `block`-severity violation resolved by acknowledgement.
 * Surfaced near the top of the digest because "this branch overrode a
 * guardrail, here's why" is high reviewer signal. Derived from the
 * evaluator disposition log (the historical acknowledgement event), not
 * the latest-row collapse — so it survives the evaluator later passing.
 */
export interface DigestAcknowledgedBlock {
  evaluator_ref: string;
  phase: 'post-plan' | 'post-plan-revision' | 'checkpoint-open' | 'checkpoint-close' | 'pre-pr';
  /** The acknowledgement reason. */
  reason?: string;
  /** Body of the acknowledged violation run. */
  original_violation_body?: string;
}

export interface DigestAcceptedWarning {
  review_id: string;
  run_id: string;
  evaluator_ref: string;
  reason: string;
}

export interface DigestUncertainty {
  item: string;
  checkpoint: number;
}

/**
 * Content-free summary of the pinned source plan. Carries
 * only presence + provenance — NEVER `content` — because the CLI emits
 * `DigestData` verbatim in `orcaops digest --json`, and the full pinned
 * plan must not leak there. `null` on DigestData means "no plan pinned".
 */
export interface DigestSourcePlan {
  pinned: true;
  locator: string;
  hash: string;
  /**
   * Type guard — the digest summary is content-free (the CLI emits
   * DigestData verbatim in `digest --json`, so the full pinned plan must not
   * leak). Typing `content` as `never` makes a future spread of the storage
   * pin — `{ ...sourcePlan }`, which carries `content: string` — a compile
   * error. `satisfies` / excess-property checks would miss this (spreads
   * bypass them); an assignability constraint does not.
   */
  content?: never;
}

/**
 * Effective status of an evaluator row in the digest. Synthesized from
 * the materialized projection's run_status + verdict + disposition
 * triplet so the digest reader sees one familiar value per row:
 *
 *   - `pass` / `info` — run_status:completed, no resolution needed
 *   - `violation` — run_status:completed AND verdict:violation AND
 *     disposition is null OR unresolved
 *   - `acknowledged` / `dismissed` / `policy-excepted` — blocking-
 *     eligible AND the latest disposition row carries that value
 *   - `error` — run_status:error (the engine failed; verdict is null)
 *   - `skipped` — run_status:skipped (filter excluded the evaluator)
 */
export type DigestEvaluatorStatus =
  | 'pass'
  | 'info'
  | 'violation'
  | 'acknowledged'
  | 'dismissed'
  | 'policy-excepted'
  | 'error'
  | 'skipped';

export interface DigestEvaluatorRow {
  /** Resolved evaluator ref (`<pack>/<id>`). */
  evaluator_ref: string;
  phase: 'post-plan' | 'post-plan-revision' | 'checkpoint-open' | 'checkpoint-close' | 'pre-pr';
  severity: 'info' | 'warn' | 'block';
  status: DigestEvaluatorStatus;
  /** Latest run's body. */
  body: string;
  /** ISO timestamp of the latest run (NOT the disposition). */
  ts: string;
  /** When status maps to a disposition, the disposition reason. */
  ackReason?: string;
  /**
   * When the row carries a disposition (acknowledged / dismissed /
   * policy-excepted), the body of the underlying violation run so
   * reviewers see what was resolved, not just the resolution message.
   */
  originalViolationBody?: string;
  /**
   * Evaluator's spec description (joined onto one line). Rendered
   * inline for non-pass rows in process notes; the release-checks
   * table relies on the body alone since the evaluator ref + non-pass
   * body is enough context.
   */
  description?: string;
  /**
   * Set when the latest run is a fresh `violation` AND one or more
   * earlier runs against this same evaluator_ref were already
   * resolved (acknowledged / dismissed / policy-excepted). The
   * reviewer wants to know "we resolved this before and it's back."
   * Surfaced as a markdown footnote under the row body.
   *
   * Absent when there's no prior-resolved history or when the latest
   * status is itself a disposition (the disposition's ackReason
   * already speaks to that resolution).
   */
  prior_resolved?: {
    count: number;
    last_disposition: 'acknowledged' | 'dismissed' | 'policy-excepted';
    last_reason?: string;
  };
}

export interface DigestCheckpointBlock {
  n: number;
  ts: string;
  /** The agent's narrative for this checkpoint. */
  summary: string;
  files_changed: string[];
  verification?: VerificationEntry[];
  /** Invoking agent at open time; null on pre-attribution checkpoints. */
  agent?: string | null;
  /** Invoking agent at close time (cross-agent handoffs may differ from `agent`). */
  closed_by_agent?: string | null;
  /**
   * The segment-refined claims partition record, present
   * only when this close detected a concurrent checkpoint window. The
   * digest renders it as a per-checkpoint attribution-trust section —
   * reviewers must see ambiguity and unattributed in-window work.
   */
  window_overlap?: WindowOverlap;
  /**
   * Unmerged-index degradation record, present when the close's window
   * touched an unmerged index or its probe failed. Reviewers must see which
   * paths were excluded from exact per-line attribution — and that a failed
   * probe leaves the whole window unverified.
   */
  attribution_degraded?: AttributionDegraded;
  /**
   * True when this checkpoint's overlap GROUP has since fully closed
   * (every member finalized), per the adjudication read model. `window_overlap`
   * above is a close-time SNAPSHOT — a non-last member keeps its provisional
   * `pending` / `own_claim_pending` state forever; this flag lets the renderer
   * add a "group resolved" legend so a reader doesn't mistake the snapshot for a
   * live unresolved state. Read-model overlay only; the hashable manifest
   * `window_overlap` is untouched, so hash-neutral.
   */
  overlap_finalized?: boolean;
}

export interface DigestPolicyException {
  cp_n: number;
  evaluator_ref: string;
  reason: string;
}

/**
 * A single acceptance-criterion removal across the plan's
 * revision history. `revision_n` is the revision that dropped it; `text` is
 * the criterion's last text before removal (carried on `criterion_lineage`
 * so the digest renders the dropped rubric without a back-read).
 */
export interface DigestCriterionRemoval {
  revision_n: number;
  step_label: string;
  text: string;
}

/**
 * A single same-id criterion rewrite (a silent rubric-weakening
 * vector). `revision_n` made the change; `prior_text`→`new_text` is the diff.
 */
export interface DigestCriterionRewrite {
  revision_n: number;
  step_label: string;
  prior_text: string;
  new_text: string;
}

/** Criterion removals + rewrites aggregated across ALL revisions. */
export interface DigestCriterionChanges {
  removed: DigestCriterionRemoval[];
  rewritten: DigestCriterionRewrite[];
}

/**
 * Coding-agent token usage for the digest: the exact
 * `(agent, session_id)` session total is the accounting base; per-artifact
 * attribution is an explicitly-labelled, order-independent estimate that is
 * never additive across artifacts. Tokens only — USD is the cloud's job, which
 * must roll up from the session total, never by summing per-artifact estimates.
 * Read LIVE from the repo-level ledger at build time.
 */
export interface DigestUsage {
  has_usage: boolean;
  sessions: Array<{
    agent: string;
    session_id: string;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    record_count: number;
    /** High-water open dimensions + the per-rate-class split. Present
     *  only when the session captured dimensions or a non-default rate class. */
    detail?: SessionUsageDetail;
  }>;
  attributed_estimate: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
}

export interface DigestData {
  artifact_id: string;
  branch: string;
  task: string;
  /** Provenance marker for synthesized history; null for live captures. */
  origin: NonNullable<Plan['origin']> | null;
  /**
   * The authoring agent (`plan.agent`, runtime-resolved at capture).
   * Per-event attribution renders only when it differs from this, so
   * single-agent threads stay noise-free.
   */
  authoring_agent: string;
  /** Invoking agent of the summary capture; null pre-attribution / no summary. */
  summarized_by: string | null;
  /**
   * Plan-level short headline — the consumer-facing name for the
   * thread. 1–70 chars, single line. Surfaces as the digest H1
   * subtitle and is the primary candidate for PR title synthesis.
   */
  label: string;
  base_sha: string;
  started_at: string;
  completed_at: string | null;
  is_complete: boolean;
  /** "Every latest plan step_id is claimed by some closed cp's completed_step_ids." */
  plan_coverage_complete: boolean;
  /** Latest-plan steps not claimed complete by any closed checkpoint, in plan order. */
  uncompleted_steps: Array<{ step_id: string; label: string }>;
  /** Number of plan revisions after the initial capture (0 = no revisions). */
  plan_revision_count: number;
  /**
   * Pinned source plan summary, or `null` when the artifact
   * didn't opt in via `--source-plan`. Content-free — see DigestSourcePlan.
   */
  source_plan: DigestSourcePlan | null;
  /**
   * The hoisted plan-conformance row — the latest conformance
   * verdict surfaced near the top. `null` when no conformance row applies:
   * either none ran, OR the artifact is unpinned (force-null, so this never
   * exposes a stale row that the markdown's "no source plan" note hides).
   */
  plan_conformance: DigestEvaluatorRow | null;
  touched_scope: string[];
  plan_steps: string[];
  plan_step_ids: string[];
  plan_step_labels: string[];
  /** Labels of steps that have NO acceptance criteria. */
  plan_steps_without_criteria: string[];
  /**
   * True when a `step-coverage` evaluator run exists for
   * this artifact. Gates the all-missing-criteria UNVERIFIED note so it
   * fires only when delivery-coverage is actually in play.
   */
  step_coverage_active: boolean;
  /**
   * Acceptance criteria removed or rewritten across ALL plan
   * revisions (not just the latest — a later clean revision must not hide an
   * earlier narrowing). Each entry is tagged with the `revision_n` that made
   * the change and carries the prior text (removed) or prior→new (rewritten)
   * so the digest renders the dropped/weakened rubric without a back-read.
   * Both empty on an unrevised plan; the section stays silent then.
   */
  criterion_changes: DigestCriterionChanges;
  non_goals: NonGoal[];
  checkpoint_count: number;
  files_changed: string[];
  checkpoints: DigestCheckpointBlock[];
  /**
   * Block-severity violations resolved by acknowledgement.
   * Rendered near the top of the digest. Empty when none.
   */
  acknowledged_blocks: DigestAcknowledgedBlock[];
  accepted_warnings: DigestAcceptedWarning[];
  decisions: DigestDecision[];
  /**
   * Merge-relevant evaluator verdicts:
   *   - phase == 'pre-pr' (any status), OR
   *   - phase == 'checkpoint-open' AND severity == 'block', OR
   *   - phase == 'checkpoint-close' AND severity == 'block'
   */
  release_checks: DigestEvaluatorRow[];
  process_notes: DigestEvaluatorRow[];
  /**
   * The summary's `outcome` — what actually happened, the counterpart to the
   * plan intent in `task`. Null until the thread is summarized. Without this
   * the digest silently drops the whole reviewer-facing outcome, including any
   * dispositions an amended summary added.
   */
  outcome: string | null;
  open_items: string[];
  /**
   * Uncertainty recorded on checkpoints. NOT open work: the schema encodes no
   * resolution status, so an entry here may be resolved, accepted, or genuinely
   * outstanding. Rendered under its own heading for exactly that reason — see
   * the `## checkpoint uncertainties` block in renderDigestMarkdown.
   */
  open_uncertainty: DigestUncertainty[];
  policy_exceptions: DigestPolicyException[];
  deferred_decisions: string[];
  tests_written: string[];
  tests_run: string[];
  /** Coding-agent usage, read live from the ledger at build. */
  usage?: DigestUsage;
}

export interface DigestOutput {
  data: DigestData;
  markdown: string;
  /**
   * The artifact `source_event_id` the digest content was built from,
   * captured from the SAME `readArtifact` that produced the content (see
   * `buildDigest`). `writeDigest` records this in the staleness sidecar.
   * Taking it from a second, later read would let a concurrent event landing
   * mid-build stamp a newer id than the content reflects, making a
   * genuinely-stale digest read as current (TOCTOU). Kept on this wrapper
   * (not `DigestData`) so it never leaks into `digest --json` / the FTS index.
   */
  source_event_id: string;
  /**
   * Fingerprint of the usage state this digest reflects. Recorded in the
   * staleness sidecar so a usage-only change (which doesn't move
   * `source_event_id`) still marks a cached digest stale.
   */
  usage_fingerprint: string;
}

export interface BuildDigestOptions {
  store: ArtifactStore;
  artifactId: string;
  /**
   * Optional ref → description map (from `discoverEvaluators`). When
   * provided, the digest renders the description inline next to
   * non-pass rows in the process-notes section. Keys are resolved
   * refs (`<pack>/<id>`).
   */
  evaluatorDescriptions?: ReadonlyMap<string, string>;
  /**
   * Apply secret redaction to the digest output (data + rendered
   * markdown + cached digest.md). Defaults to `true`. Redaction is
   * output-only; capture payloads on disk are untouched.
   */
  redactSecrets?: boolean;
}

/**
 * Walk every plan revision (0..latest) and aggregate the
 * acceptance-criterion removals + same-id rewrites recorded on each
 * revision's `criterion_lineage`. Aggregating across ALL revisions (not just
 * the latest) is the point: a later clean revision would otherwise hide an
 * earlier narrowing — exactly the silent-shrink vector this closes. The lineage
 * carries the prior text (removed) and prior→new text (rewritten) so the
 * digest renders the dropped/weakened rubric without re-reading old plans.
 *
 * `step_label` resolves from the revision that made the change (its
 * `prior_step_id` → that revision's step label), falling back to the step_id
 * when the step was itself dropped in the same revision.
 */
async function collectCriterionChanges(
  store: ArtifactStore,
  artifactId: string,
  latest: Plan
): Promise<DigestCriterionChanges> {
  const removed: DigestCriterionRemoval[] = [];
  const rewritten: DigestCriterionRewrite[] = [];
  // revision_n 0 is the initial capture (lineage always empty there); start at
  // 1, but readPlanRevision tolerates 0 too. Bounded by latest.revision_n.
  for (let n = 1; n <= latest.revision_n; n++) {
    const rev = n === latest.revision_n ? latest : await store.readPlanRevision(artifactId, n);
    if (!rev) continue;
    const labelFor = (stepId: string): string =>
      rev.plan_steps.find((s) => s.step_id === stepId)?.label ?? stepId;
    for (const r of rev.criterion_lineage.removed) {
      removed.push({ revision_n: n, step_label: labelFor(r.prior_step_id), text: r.text });
    }
    for (const r of rev.criterion_lineage.rewritten) {
      rewritten.push({
        revision_n: n,
        step_label: labelFor(r.prior_step_id),
        prior_text: r.prior_text,
        new_text: r.new_text,
      });
    }
  }
  return { removed, rewritten };
}

function collectCriterionChangesFromPlans(plans: readonly Plan[]): DigestCriterionChanges {
  const removed: DigestCriterionRemoval[] = [];
  const rewritten: DigestCriterionRewrite[] = [];
  for (const plan of plans) {
    if (plan.revision_n === 0) continue;
    const labelFor = (stepId: string): string =>
      plan.plan_steps.find((step) => step.step_id === stepId)?.label ?? stepId;
    for (const item of plan.criterion_lineage.removed) {
      removed.push({
        revision_n: plan.revision_n,
        step_label: labelFor(item.prior_step_id),
        text: item.text,
      });
    }
    for (const item of plan.criterion_lineage.rewritten) {
      rewritten.push({
        revision_n: plan.revision_n,
        step_label: labelFor(item.prior_step_id),
        prior_text: item.prior_text,
        new_text: item.new_text,
      });
    }
  }
  return { removed, rewritten };
}

function finishDigest(input: {
  plan: Plan;
  checkpoints: Checkpoint[];
  summary: Summary | null;
  evalLog: EvaluatorLog | null;
  sourcePlan: SourcePlanPin | null;
  sourceEventId: string;
  criterionChanges: DigestCriterionChanges;
  overlapAdjudication: ReadonlyMap<number, { finalized: boolean }>;
  usage: DigestUsage;
  evaluatorDescriptions?: ReadonlyMap<string, string>;
  redactSecrets?: boolean;
}): DigestOutput {
  const composed = composeDigestData({
    plan: input.plan,
    checkpoints: input.checkpoints,
    summary: input.summary,
    evalLog: input.evalLog,
    sourcePlan: input.sourcePlan,
    criterionChanges: input.criterionChanges,
    evaluatorDescriptions: input.evaluatorDescriptions,
  });
  const rawData: DigestData = {
    ...composed,
    checkpoints: composed.checkpoints.map((cp) =>
      cp.window_overlap !== undefined && input.overlapAdjudication.get(cp.n)?.finalized === true
        ? { ...cp, overlap_finalized: true }
        : cp
    ),
  };
  const redacted =
    input.redactSecrets === false ? rawData : redactSecretsInObject<DigestData>(rawData);
  const data: DigestData = { ...redacted, usage: input.usage };
  return {
    data,
    markdown: renderDigestMarkdown(data),
    source_event_id: input.sourceEventId,
    usage_fingerprint: usageFingerprint(input.usage),
  };
}

/**
 * Read the artifact thread for `artifactId` and assemble the digest
 * data + rendered markdown. Pure read — does not write to disk. Use
 * `writeDigest` to persist to `<artifact>/digest.md`.
 */
export async function buildDigest(opts: BuildDigestOptions): Promise<DigestOutput> {
  // Read the artifact (source_event_id + the pinned source_plan) FIRST, before
  // the content reads below, so the recorded source_event_id is the OLDEST
  // observation of the thread. A concurrent append during the content reads can
  // then only make the digest read STALE (a harmless regenerate), never falsely
  // current (the false-fresh direction is the dangerous one; reading the id
  // AFTER the content would reopen that window). source_plan is pinned at
  // capture and immutable, so reading it here loses nothing.
  const artifact = await opts.store.readArtifact(opts.artifactId);

  const plan = await opts.store.readPlan(opts.artifactId);
  if (!plan) {
    throw new Error(`Cannot build digest: artifact "${opts.artifactId}" has no plan.`);
  }
  if (!artifact) {
    throw new Error(
      `Cannot build digest: artifact "${opts.artifactId}" has no artifact projection.`
    );
  }
  const checkpoints = await opts.store.readCheckpoints(opts.artifactId);
  const summary = await opts.store.readSummary(opts.artifactId);
  const evalLog = await opts.store.readEvaluatorLog(opts.artifactId);

  // Aggregate criterion removals/rewritten across ALL revisions.
  // The walk needs store access (per-revision `criterion_lineage`), so it lives
  // here rather than in the pure `composeDigestData`. A later clean revision
  // must NOT hide an earlier narrowing, so we union every revision's lineage.
  const criterionChanges = await collectCriterionChanges(opts.store, opts.artifactId, plan);

  // Fold the window-overlap adjudication (the resolved GROUP state) so the
  // renderer can flag a per-checkpoint snapshot whose group has since fully
  // closed. Read-model overlay attached POST-compose — composeDigestData stays
  // pure and the hashable manifest is untouched.
  const overlapAdjudication = await opts.store.adjudicateWindowOverlap(opts.artifactId);

  const usage = buildDigestUsage(opts.store.store, opts.artifactId);
  return finishDigest({
    plan,
    checkpoints,
    summary,
    evalLog,
    sourcePlan: artifact.source_plan ?? null,
    sourceEventId: artifact.source_event_id,
    criterionChanges,
    overlapAdjudication,
    usage,
    evaluatorDescriptions: opts.evaluatorDescriptions,
    redactSecrets: opts.redactSecrets,
  });
}

export interface BuildArchivedDigestOptions {
  thread: ArchivedArtifactThread;
  store: ArtifactStore['store'];
  evaluatorDescriptions?: ReadonlyMap<string, string>;
  redactSecrets?: boolean;
}

/** Build a digest from an archive-rebuilt thread without restoring or caching it. */
export function buildArchivedDigest(opts: BuildArchivedDigestOptions): DigestOutput {
  const { thread } = opts;
  if (!thread.plan) {
    throw new Error(`Cannot build digest: artifact "${thread.artifactId}" has no plan.`);
  }
  if (!thread.artifactJson) {
    throw new Error(
      `Cannot build digest: artifact "${thread.artifactId}" has no artifact projection.`
    );
  }
  const plans = thread.events
    .filter(
      (event) => event.record.type === 'plan_captured' || event.record.type === 'plan_revised'
    )
    .map((event) =>
      PlanSchema.parse({
        ...(event.payload as Record<string, unknown>),
        source_event_id: event.record.event_id,
      })
    );
  const overlapAdjudication = adjudicateOverlapGroups(
    thread.checkpoints.map((checkpoint) => ({
      n: checkpoint.n,
      status: checkpoint.status,
      filesChanged: checkpoint.status === 'closed' ? checkpoint.files_changed : [],
      ...(checkpoint.status === 'closed' && checkpoint.window_overlap !== undefined
        ? { windowOverlap: checkpoint.window_overlap }
        : {}),
    }))
  );
  return finishDigest({
    plan: thread.plan,
    checkpoints: thread.checkpoints,
    summary: thread.summary,
    evalLog: thread.evaluatorLog,
    sourcePlan: thread.artifactJson.source_plan ?? null,
    sourceEventId: thread.artifactJson.source_event_id,
    criterionChanges: collectCriterionChangesFromPlans(plans),
    overlapAdjudication,
    usage: buildDigestUsage(opts.store, thread.artifactId),
    evaluatorDescriptions: opts.evaluatorDescriptions,
    redactSecrets: opts.redactSecrets,
  });
}

/**
 * Build + persist the digest to `<artifact>/digest.md`. Returns the
 * digest output AND the absolute file path. Also re-indexes the
 * digest in FTS5 so users can search digest content alongside other
 * artifact bodies; the index-write boundary re-redacts for defense
 * in depth.
 */
export async function writeDigest(
  opts: BuildDigestOptions
): Promise<DigestOutput & { path: string }> {
  const out = await buildDigest(opts);
  const paths = artifactPathsFor(opts.store.repoRoot, opts.store.config, out.data.artifact_id);
  await atomicWriteFile(paths.digestMd, out.markdown, opts.store.repoRoot);
  // Staleness sidecar: record the artifact source_event_id this digest was
  // built from, so the next-step hint can tell whether the cached digest is
  // current (compare against the live source_event_id — no mtimes). The
  // digest itself stays event-less / regenerable.
  //
  // The id is taken from `out.source_event_id` — the SAME readArtifact that
  // produced the content — NOT a second read here. A second read could
  // observe an event a concurrent capture appended between the content read
  // and now, stamping a newer id than the markdown reflects, so a
  // genuinely-stale digest would later read as current (TOCTOU).
  await atomicWriteFile(
    paths.digestMeta,
    JSON.stringify({
      source_event_id: out.source_event_id,
      usage_fingerprint: out.usage_fingerprint,
    }) + '\n',
    opts.store.repoRoot
  );
  opts.store.store.replaceSearchEntry({
    artifact_id: out.data.artifact_id,
    source: 'digest',
    branch: out.data.branch,
    ts: out.data.completed_at ?? out.data.started_at,
    content: out.markdown,
  });
  return { ...out, path: paths.digestMd };
}

/**
 * Read the artifact's coding-agent usage LIVE from the repo-level ledger:
 * exact session totals (the accounting base) + the estimated attributed slice.
 */
export function buildDigestUsage(store: ArtifactStore['store'], artifactId: string): DigestUsage {
  const sessions = store.artifactCodingSessions(artifactId);
  const a = store.attributedArtifactUsage(artifactId);
  // Per-session high-water dimensions + rate-class split (the exact figures; the
  // attributed_estimate below stays scalar-only). Attached only when it adds
  // something beyond the scalar total (dimensions or a non-default rate class),
  // so all-standard sessions render — and fingerprint — exactly as before.
  const detailByKey = sessionUsageDetailByKey(store.artifactSessionModelBreakdowns(artifactId));
  return {
    has_usage: sessions.length > 0,
    sessions: sessions.map((s) => {
      const detail = detailByKey.get(sessionDetailKey(s.agent, s.session_id));
      const rich = isRichUsageDetail(detail);
      return {
        agent: s.agent,
        session_id: s.session_id,
        input_tokens: s.cumulative_input_tokens,
        output_tokens: s.cumulative_output_tokens,
        cache_creation_input_tokens: s.cumulative_cache_creation_input_tokens,
        cache_read_input_tokens: s.cumulative_cache_read_input_tokens,
        record_count: s.record_count,
        ...(rich ? { detail } : {}),
      };
    }),
    attributed_estimate: {
      input_tokens: a.input_tokens,
      output_tokens: a.output_tokens,
      cache_creation_input_tokens: a.cache_creation_input_tokens,
      cache_read_input_tokens: a.cache_read_input_tokens,
    },
  };
}

/**
 * Stable fingerprint of a {@link DigestUsage} (sessions are pre-sorted by the
 * store query, so the order is deterministic). Used by the digest staleness
 * sidecar so a usage-only change marks a cached digest stale.
 */
export function usageFingerprint(u: DigestUsage): string {
  const parts = u.sessions.map((s) => {
    const base =
      `${s.agent}:${s.session_id}:${s.input_tokens}:${s.output_tokens}:` +
      `${s.cache_creation_input_tokens}:${s.cache_read_input_tokens}:${s.record_count}`;
    // Fold the rich detail so a dimensions/rate-class-only change marks the
    // cached digest stale; appended only when present so a session with no rich
    // data keeps its scalar-only fingerprint (no spurious staleness).
    const df = usageDetailFingerprint(s.detail);
    return df ? `${base}:${df}` : base;
  });
  const a = u.attributed_estimate;
  parts.push(
    `@:${a.input_tokens}:${a.output_tokens}:${a.cache_creation_input_tokens}:${a.cache_read_input_tokens}`
  );
  return parts.join('|');
}

interface ComposeOpts {
  plan: Plan;
  checkpoints: Checkpoint[];
  summary: Summary | null;
  evalLog: EvaluatorLog | null;
  sourcePlan: SourcePlanPin | null;
  /**
   * Criterion removals/rewrites aggregated across ALL plan
   * revisions by `buildDigest` (which has store access for the revision walk).
   * Empty on an unrevised plan.
   */
  criterionChanges: DigestCriterionChanges;
  evaluatorDescriptions?: ReadonlyMap<string, string>;
}

function composeDigestData(o: ComposeOpts): DigestData {
  const sorted = [...o.checkpoints].filter((c) => c.status === 'closed').sort((a, b) => a.n - b.n);

  // Policy exceptions surface from BOTH closed AND abandoned cps
  // (both persisted past open-time). Open cps are in-flight; their
  // bypasses don't surface yet.
  const persistedCps = [...o.checkpoints]
    .filter((c) => c.status === 'closed' || c.status === 'abandoned')
    .sort((a, b) => a.n - b.n);
  const policy_exceptions: DigestPolicyException[] = [];
  for (const cp of persistedCps) {
    for (const pe of cp.policy_exceptions) {
      policy_exceptions.push({ cp_n: cp.n, evaluator_ref: pe.evaluator, reason: pe.reason });
    }
  }

  const filesSeen = new Set<string>();
  const filesChanged: string[] = [];
  for (const cp of sorted) {
    for (const f of cp.files_changed) {
      if (!filesSeen.has(f)) {
        filesSeen.add(f);
        filesChanged.push(f);
      }
    }
  }

  const checkpointBlocks: DigestCheckpointBlock[] = sorted.map((cp) => ({
    n: cp.n,
    ts: cp.closed_at,
    summary: cp.summary,
    files_changed: cp.files_changed,
    ...(cp.verification !== undefined ? { verification: cp.verification } : {}),
    agent: cp.agent ?? null,
    closed_by_agent: cp.closed_by_agent ?? null,
    // Optional-absent: only overlap-partitioned closes.
    ...(cp.window_overlap !== undefined ? { window_overlap: cp.window_overlap } : {}),
    // Optional-absent: only unmerged-degraded closes.
    ...(cp.attribution_degraded !== undefined
      ? { attribution_degraded: cp.attribution_degraded }
      : {}),
  }));

  const decisions: DigestDecision[] = [];
  // Plan-time decisions first (the up-front architectural choices), then
  // checkpoint-close decisions in cp order. Each carries its source so the
  // render distinguishes "plan rev N" from "cp N".
  for (const d of o.plan.decisions) {
    decisions.push({
      decision: d.decision,
      reason: d.reason,
      source: 'plan',
      revision_n: d.revision_n,
      ...(d.alternatives_considered && d.alternatives_considered.length > 0
        ? { alternatives_considered: d.alternatives_considered }
        : {}),
    });
  }
  for (const cp of sorted) {
    for (const d of cp.decisions) {
      decisions.push({
        decision: d.decision,
        reason: d.reason,
        source: 'checkpoint',
        checkpoint: cp.n,
        ...(d.alternatives_considered && d.alternatives_considered.length > 0
          ? { alternatives_considered: d.alternatives_considered }
          : {}),
      });
    }
  }

  const openItems = o.summary?.open_items ?? [];
  // isCoveredBy is a DEDUPLICATOR, not a resolution mechanism: an uncertainty
  // the summary restated as an open item is dropped here so it renders once,
  // under `## open items`, where the summary has promoted it to declared
  // outstanding work. It is NOT a way to mark an uncertainty resolved — nothing
  // in the schema encodes that, which is why the uncertainty section's heading
  // disclaims resolution status instead of implying one.
  const openUncertainty: DigestUncertainty[] = [];
  for (const cp of sorted) {
    for (const u of cp.uncertainty) {
      if (!isCoveredBy(u, openItems)) {
        openUncertainty.push({ item: u, checkpoint: cp.n });
      }
    }
  }

  const collapsed = collapseEvaluatorRuns(o.evalLog, o.evaluatorDescriptions);
  // Hoist the plan-conformance row to the near-top section and
  // exclude its refs from release_checks / process_notes so it never renders
  // twice. selectConformanceRow prefers pre-pr, else the most recent.
  const conformanceRow = selectConformanceRow(
    collapsed.filter((r) => isPlanConformanceRef(r.evaluator_ref))
  );
  const release_checks: DigestEvaluatorRow[] = [];
  const process_notes: DigestEvaluatorRow[] = [];
  for (const row of collapsed) {
    if (isPlanConformanceRef(row.evaluator_ref)) continue;
    if (isReleaseRelevant(row)) release_checks.push(row);
    else process_notes.push(row);
  }

  // Content-free source-plan summary (never `content` — DigestData is
  // emitted verbatim in `digest --json`). plan_conformance is meaningful
  // ONLY when pinned: force it null on unpinned artifacts so the JSON can't
  // expose a stale conformance row the markdown's "no source plan" note hides.
  const source_plan: DigestSourcePlan | null =
    o.sourcePlan !== null
      ? { pinned: true, locator: o.sourcePlan.source_ref.locator, hash: o.sourcePlan.hash }
      : null;
  const plan_conformance = source_plan !== null ? conformanceRow : null;

  const acknowledged_blocks = collectAcknowledgedBlocks(o.evalLog);

  const coverage = computeCoverage({
    planStepIds: o.plan.plan_steps.map((step) => step.step_id),
    closedCheckpoints: sorted,
    openCheckpoints: o.checkpoints.filter((checkpoint) => checkpoint.status === 'open'),
  });
  const uncompletedStepIds = new Set(coverage.uncompleted_step_ids);

  return {
    artifact_id: o.plan.artifact_id,
    branch: o.plan.branch,
    task: o.plan.task,
    origin: o.plan.origin ?? null,
    authoring_agent: o.plan.agent,
    summarized_by: o.summary?.agent ?? null,
    label: o.plan.label,
    base_sha: o.plan.base_sha,
    started_at: o.plan.started_at,
    completed_at: o.summary?.ts ?? null,
    is_complete: o.summary !== null,
    plan_coverage_complete: coverage.plan_coverage_complete,
    uncompleted_steps: o.plan.plan_steps
      .filter((step) => uncompletedStepIds.has(step.step_id))
      .map((step) => ({ step_id: step.step_id, label: step.label })),
    plan_revision_count: o.plan.revision_n,
    touched_scope: o.plan.touched_scope,
    source_plan,
    plan_conformance,
    plan_steps: o.plan.plan_steps.map((s) => s.text),
    plan_step_ids: o.plan.plan_steps.map((s) => s.step_id),
    plan_step_labels: o.plan.plan_steps.map((s) => s.label),
    plan_steps_without_criteria: o.plan.plan_steps
      .filter((s) => s.acceptance_criteria.length === 0)
      .map((s) => s.label),
    // Step-coverage is "active" when a step-coverage run was
    // surfaced (it rides release_checks at pre-pr; process_notes otherwise).
    step_coverage_active: [...release_checks, ...process_notes].some((r) =>
      r.evaluator_ref.includes('step-coverage')
    ),
    criterion_changes: o.criterionChanges,
    non_goals: o.plan.non_goals,
    checkpoint_count: sorted.length,
    files_changed: filesChanged,
    checkpoints: checkpointBlocks,
    acknowledged_blocks,
    accepted_warnings: o.summary?.accepted_warnings ?? [],
    decisions,
    release_checks,
    process_notes,
    outcome: o.summary?.outcome ?? null,
    open_items: openItems,
    open_uncertainty: openUncertainty,
    policy_exceptions,
    deferred_decisions: o.summary?.deferred_decisions ?? [],
    tests_written: o.summary?.tests_written ?? [],
    tests_run: o.summary?.tests_run ?? [],
  };
}

/**
 * A row is merge-relevant iff:
 *   - phase === 'pre-pr' (any status), OR
 *   - phase === 'checkpoint-close' AND severity === 'block', OR
 *   - phase === 'checkpoint-open' AND severity === 'block'
 *
 * Severity is the evaluator author's chosen merge-relevance signal —
 * pick severity:block to surface at merge time.
 */
/**
 * Pick the single plan-conformance row to hoist: prefer the
 * `pre-pr` row (the final, most-authoritative drift check); otherwise the
 * most recent by `ts`, with evaluator_ref as a deterministic tie-break.
 * Returns `null` when no conformance row exists.
 */
function selectConformanceRow(rows: DigestEvaluatorRow[]): DigestEvaluatorRow | null {
  if (rows.length === 0) return null;
  const prePr = rows.find((r) => r.phase === 'pre-pr');
  if (prePr) return prePr;
  return [...rows].sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
    return a.evaluator_ref < b.evaluator_ref ? 1 : -1;
  })[0];
}

function isReleaseRelevant(row: DigestEvaluatorRow): boolean {
  if (row.phase === 'pre-pr') return true;
  if (row.phase === 'checkpoint-close' && row.severity === 'block') return true;
  if (row.phase === 'checkpoint-open' && row.severity === 'block') return true;
  return false;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

function isCoveredBy(item: string, pool: string[]): boolean {
  const itemTokens = tokenize(item);
  if (itemTokens.length === 0) return false;
  const itemHaystack = item.toLowerCase();
  for (const candidate of pool) {
    if (overlapRatio(itemTokens, candidate.toLowerCase()) >= 0.6) return true;
    const candidateTokens = tokenize(candidate);
    if (candidateTokens.length === 0) continue;
    if (overlapRatio(candidateTokens, itemHaystack) >= 0.6) return true;
  }
  return false;
}

function overlapRatio(tokens: string[], haystack: string): number {
  const matches = tokens.filter((t) => haystack.includes(t)).length;
  return matches / tokens.length;
}

export function demoteBodyHeadings(body: string, levels: number): string {
  if (levels <= 0) return body;
  let inFence = false;
  return body
    .split('\n')
    .map((line) => {
      if (/^```/.test(line.trim())) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const match = /^(#{1,6})(\s+)/.exec(line);
      if (!match) return line;
      const newDepth = Math.min(6, match[1].length + levels);
      return '#'.repeat(newDepth) + match[2] + line.slice(match[0].length);
    })
    .join('\n');
}

/**
 * Reduce the materialized projection into one row per evaluator_ref
 * (latest by order_key). Synthesizes an effective DigestEvaluatorStatus
 * from the run's run_status / verdict / disposition triplet. When the
 * row carries a disposition, attaches the
 * disposition reason + the underlying violation body so reviewers see
 * what was resolved.
 */
function collapseEvaluatorRuns(
  log: EvaluatorLog | null,
  descriptions?: ReadonlyMap<string, string>
): DigestEvaluatorRow[] {
  if (log === null) return [];

  // Index dispositions by run_id, latest-wins (order_key ascending; the
  // last one for a given run_id is the most recent).
  const dispositionByRunId = new Map<string, MaterializedEvaluatorDisposition>();
  const sortedDispositions = [...log.dispositions].sort(orderKeyAsc);
  for (const d of sortedDispositions) {
    dispositionByRunId.set(d.run_id, d);
  }

  // Group runs by evaluator_ref; the LATEST per group wins. Also track
  // the most recent prior violation per ref so acknowledged/dismissed/
  // policy-excepted rows can attach the original body.
  const runsByRef = new Map<string, MaterializedEvaluatorRun[]>();
  const sortedRuns = [...log.runs].sort(orderKeyAsc);
  for (const r of sortedRuns) {
    const arr = runsByRef.get(r.evaluator_ref) ?? [];
    arr.push(r);
    runsByRef.set(r.evaluator_ref, arr);
  }

  const rows: DigestEvaluatorRow[] = [];
  for (const [ref, list] of runsByRef) {
    const latest = list[list.length - 1];
    const status = synthesizeStatus(latest);
    let ackReason: string | undefined;
    let originalViolationBody: string | undefined;
    if (status === 'acknowledged' || status === 'dismissed' || status === 'policy-excepted') {
      const dispo = dispositionByRunId.get(latest.run_id);
      ackReason = dispo?.reason;
      // The latest run IS the violation (the disposition references
      // it by run_id) — so the body to surface is the run's own body.
      originalViolationBody = latest.body;
    }
    const row: DigestEvaluatorRow = {
      evaluator_ref: ref,
      phase: latest.phase,
      severity: latest.severity,
      status,
      body: latest.body,
      ts: latest.ts,
    };
    if (ackReason !== undefined) row.ackReason = ackReason;
    if (originalViolationBody !== undefined) row.originalViolationBody = originalViolationBody;
    const desc = descriptions?.get(ref);
    if (desc !== undefined) row.description = desc.replace(/\s+/g, ' ').trim();
    // prior_resolved footnote. When the latest is a fresh
    // `violation`, walk prior runs for the same ref and count those
    // that were resolved via a disposition. Captures the "we already
    // resolved this before; it's back" signal.
    if (status === 'violation' && list.length > 1) {
      const RESOLVED = new Set<MaterializedEvaluatorDisposition['disposition']>([
        'acknowledged',
        'dismissed',
        'policy-excepted',
      ]);
      const priorResolved: MaterializedEvaluatorDisposition[] = [];
      for (let i = 0; i < list.length - 1; i++) {
        const prior = list[i];
        const dispo = dispositionByRunId.get(prior.run_id);
        if (dispo && RESOLVED.has(dispo.disposition)) {
          priorResolved.push(dispo);
        }
      }
      if (priorResolved.length > 0) {
        // Sort by order_key so "last" means most-recent resolution.
        const sorted = priorResolved.sort(orderKeyAsc);
        const last = sorted[sorted.length - 1];
        row.prior_resolved = {
          count: priorResolved.length,
          last_disposition: last.disposition as 'acknowledged' | 'dismissed' | 'policy-excepted',
          ...(last.reason ? { last_reason: last.reason } : {}),
        };
      }
    }
    rows.push(row);
  }
  return rows.sort((a, b) => a.evaluator_ref.localeCompare(b.evaluator_ref));
}

/**
 * Block-severity violations whose CURRENT resolution is an
 * acknowledgement. Derived from the disposition log — NOT from
 * `collapseEvaluatorRuns`, which keeps only the latest run per
 * evaluator_ref and would lose an acknowledged block once a later run
 * of the same evaluator passes. Keying off the acknowledged run_id
 * preserves the historical "this branch overrode a guardrail" signal.
 */
function collectAcknowledgedBlocks(log: EvaluatorLog | null): DigestAcknowledgedBlock[] {
  if (log === null) return [];

  // Latest disposition per run_id (order_key ascending; last wins),
  // mirroring collapseEvaluatorRuns' resolution rule.
  const latestDispoByRunId = new Map<string, MaterializedEvaluatorDisposition>();
  for (const d of [...log.dispositions].sort(orderKeyAsc)) {
    latestDispoByRunId.set(d.run_id, d);
  }
  const runById = new Map<string, MaterializedEvaluatorRun>();
  for (const r of log.runs) runById.set(r.run_id, r);

  const out: DigestAcknowledgedBlock[] = [];
  for (const [runId, dispo] of latestDispoByRunId) {
    if (dispo.disposition !== 'acknowledged') continue;
    const run = runById.get(runId);
    if (!run || run.severity !== 'block') continue;
    out.push({
      evaluator_ref: run.evaluator_ref,
      phase: run.phase,
      ...(dispo.reason ? { reason: dispo.reason } : {}),
      original_violation_body: run.body,
    });
  }
  return out.sort((a, b) => a.evaluator_ref.localeCompare(b.evaluator_ref));
}

function orderKeyAsc(
  a: { source_event_index: number; local_kind_rank: number; local_index: number },
  b: { source_event_index: number; local_kind_rank: number; local_index: number }
): number {
  if (a.source_event_index !== b.source_event_index) {
    return a.source_event_index - b.source_event_index;
  }
  if (a.local_kind_rank !== b.local_kind_rank) return a.local_kind_rank - b.local_kind_rank;
  return a.local_index - b.local_index;
}

function synthesizeStatus(r: MaterializedEvaluatorRun): DigestEvaluatorStatus {
  if (r.run_status === 'error') return 'error';
  if (r.run_status === 'skipped') return 'skipped';
  // run_status === 'completed' from here on.
  if (r.disposition !== null && r.disposition !== 'unresolved') {
    return r.disposition;
  }
  if (r.verdict === 'pass') return 'pass';
  if (r.verdict === 'info') return 'info';
  // verdict === 'violation' — unresolved or non-blocking-eligible.
  return 'violation';
}

// ── Markdown renderer ────────────────────────────────────────────────────

function renderDigestMarkdown(d: DigestData): string {
  const lines: string[] = [];
  // "(captured)" asserts live captured reasoning. Imported artifacts carry
  // synthesized content, so their section tags must agree with the banner
  // above them rather than contradict it.
  const provenanceTag = d.origin?.kind === 'git-import' ? '_(imported)_' : '_(captured)_';

  const cpLabel = d.checkpoint_count === 1 ? '1 checkpoint' : `${d.checkpoint_count} checkpoints`;
  lines.push(`# digest — \`${d.branch}\` / \`${d.artifact_id}\` (${cpLabel})`);
  lines.push('');
  lines.push(`> **${d.label}**`);
  lines.push('');
  if (d.origin?.kind === 'git-import') {
    const authors = d.origin.authors.length > 0 ? d.origin.authors.join(', ') : 'unknown';
    lines.push(
      '> **Imported from git history (synthesized, not captured reasoning).** ' +
        `Commit authors: ${authors}.`
    );
    lines.push('');
  }
  // Cross-agent handoff marker — only when the summarizer differs from
  // the authoring agent (single-agent threads stay noise-free).
  if (d.summarized_by && d.summarized_by !== d.authoring_agent) {
    lines.push(`> _authored by \`${d.authoring_agent}\`; summarized by \`${d.summarized_by}\`_`);
    lines.push('');
  }
  if (!d.is_complete) {
    lines.push('> _Thread is incomplete — no summary captured yet._');
    lines.push('');
  }

  if (d.uncompleted_steps.length > 0) {
    lines.push('## ⚠ incomplete plan steps');
    lines.push('');
    lines.push('These latest-plan steps are not claimed complete by any closed checkpoint:');
    lines.push('');
    for (const step of d.uncompleted_steps) {
      lines.push(`- \`${step.step_id}\` — ${step.label}`);
    }
    lines.push('');
  }

  if (d.usage && d.usage.has_usage) {
    lines.push('## agent usage');
    lines.push('');
    lines.push(
      'Exact session total(s) are the accounting base; per-artifact attribution ' +
        'is an **estimate** (USD priced by the cloud — no local pricing):'
    );
    lines.push('');
    for (const s of d.usage.sessions) {
      lines.push(
        `- \`${s.agent}/${s.session_id.slice(0, 8)}\` **exact session total**: ` +
          `in ${s.input_tokens} · out ${s.output_tokens} · ` +
          `cache-write ${s.cache_creation_input_tokens} · cache-read ${s.cache_read_input_tokens} ` +
          `(${s.record_count} records)`
      );
      const detail = formatUsageDetail(s.detail);
      if (detail) lines.push(`  - ${detail}`);
    }
    const a = d.usage.attributed_estimate;
    lines.push(
      `- _attributed to this artifact (**estimated** — shared across linked plans, not additive)_: ` +
        `in ${a.input_tokens} · out ${a.output_tokens} · ` +
        `cache-write ${a.cache_creation_input_tokens} · cache-read ${a.cache_read_input_tokens}`
    );
    lines.push('');
  }

  if (d.acknowledged_blocks.length > 0) {
    const n = d.acknowledged_blocks.length;
    lines.push(`## ⚠ block${n === 1 ? '' : 's'} resolved by acknowledgement`);
    lines.push('');
    lines.push(
      `This branch had ${n} block-severity violation${n === 1 ? '' : 's'} resolved by ` +
        `acknowledgement — a guardrail was deliberately overridden. Reasons below.`
    );
    lines.push('');
    for (const b of d.acknowledged_blocks) {
      lines.push(`- **\`${b.evaluator_ref}\`** _(${b.phase})_${b.reason ? ` — ${b.reason}` : ''}`);
      if (b.original_violation_body) {
        const body = demoteBodyHeadings(b.original_violation_body.trim(), 3);
        for (const bl of body.split('\n')) lines.push(`  > ${bl}`);
      }
    }
    lines.push('');
  }

  if (d.accepted_warnings.length > 0) {
    lines.push('## ⚠ pre-PR warnings accepted for finalization');
    lines.push('');
    lines.push('These exact warning findings were reviewed and deliberately accepted:');
    lines.push('');
    for (const warning of d.accepted_warnings) {
      lines.push(
        `- **\`${warning.evaluator_ref}\`** — ${warning.reason} ` +
          `_(review \`${warning.review_id}\`, run \`${warning.run_id}\`)_`
      );
    }
    lines.push('');
  }

  // Plan-level conformance, near the top.
  // Five states keyed on source_plan (presence) × plan_conformance (row):
  // no-pin / pinned-no-run / skipped / error / verdict.
  // None renders blank — a blank section reads as a silent pass.
  if (d.source_plan === null) {
    lines.push('## ⚠ no source plan pinned');
    lines.push('');
    lines.push(
      'No source plan was pinned (`--source-plan`), so plan-level scope ' +
        'conformance was not checked — a narrowed plan would not be flagged here.'
    );
    lines.push('');
  } else {
    lines.push('## plan conformance');
    lines.push('');
    lines.push(`Source plan: \`${d.source_plan.locator}\``);
    lines.push('');
    if (d.plan_conformance === null) {
      lines.push(
        '⚠ A source plan is pinned, but `plan-conformance` did not run — ' +
          'plan-level conformance is unverified for this artifact. The usual ' +
          'cause is that the evaluator is disabled: check ' +
          '`core/plan-conformance-*` in `.orcaops/evaluators.yaml`.'
      );
    } else if (d.plan_conformance.status === 'skipped') {
      const rawReason = d.plan_conformance.body
        .replace(/^SKIPPED\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim();
      const reason = /no LLM provider (?:is configured|executed)/.test(rawReason)
        ? 'no LLM was configured'
        : rawReason || 'the evaluator skipped';
      lines.push(
        `⚠ \`plan-conformance\` was not checked — ${reason.replace(/[.]+$/, '')}. ` +
          'Plan-level conformance is UNVERIFIED.'
      );
    } else if (d.plan_conformance.status === 'error') {
      // The run errored/timed out (e.g. an over-large source-plan pin). Its
      // body is a raw `ERROR (…)` payload, NOT a verdict — render it as
      // explicitly UNVERIFIED so it never reads as a clean pass. (Suppressing
      // the raw body is the point, mirroring the skipped branch above.)
      lines.push(
        '⚠ plan conformance did NOT complete (errored/timed out) — plan-level ' +
          'conformance is UNVERIFIED for this artifact.'
      );
    } else {
      // Real verdict — render the judge's body (headings demoted to nest).
      const body = demoteBodyHeadings(d.plan_conformance.body.trim(), 2);
      for (const bl of body.split('\n')) lines.push(bl);
    }
    lines.push('');
  }

  // When acceptance criteria are in use (some step has them),
  // flag the steps that have none — those are not coverage-graded by the
  // step-coverage evaluator. Silent when no step has criteria (the feature
  // isn't in use) or when every step has them.
  if (
    d.plan_steps_without_criteria.length > 0 &&
    d.plan_steps_without_criteria.length < d.plan_steps.length
  ) {
    lines.push('## ⚠ steps without acceptance criteria');
    lines.push('');
    lines.push(
      'These steps have no acceptance criteria, so delivery-coverage ' +
        '(`step-coverage`) does not grade them:'
    );
    for (const label of d.plan_steps_without_criteria) {
      lines.push(`- ${label}`);
    }
    lines.push('');
  }

  // When step-coverage is ACTIVE (a step-coverage run exists for
  // this artifact) but EVERY plan step lacks acceptance criteria, nothing was
  // coverage-graded — the maximal coverage-dodge that the per-step note above
  // (which only fires when SOME but not all steps lack criteria) cannot catch.
  // Surface it loudly as UNVERIFIED rather than staying silent. Gated on
  // step_coverage_active so the existing criteria-free artifacts (no step-coverage
  // run) are not spammed.
  if (
    d.step_coverage_active &&
    d.plan_steps.length > 0 &&
    d.plan_steps_without_criteria.length === d.plan_steps.length
  ) {
    lines.push('## ⚠ delivery coverage UNVERIFIED');
    lines.push('');
    lines.push(
      'A `step-coverage` evaluator ran, but no plan step declares acceptance ' +
        'criteria — so 0 of ' +
        `${d.plan_steps.length} steps were coverage-graded. Delivery against the ` +
        'plan is UNVERIFIED for this artifact.'
    );
    lines.push('');
  }

  // Acceptance criteria removed or rewritten across the plan's
  // revision history. Aggregated across ALL revisions (a later clean revision
  // must not hide an earlier narrowing), each tagged with the revision that
  // changed it. Silent when the plan was never revised or no criteria changed.
  if (d.criterion_changes.removed.length > 0 || d.criterion_changes.rewritten.length > 0) {
    lines.push('## ⚠ acceptance criteria changed mid-flight');
    lines.push('');
    lines.push(
      'Acceptance criteria were removed or rewritten after the initial plan. ' +
        'Each change is shown with the revision that made it, so a narrowed rubric ' +
        'stays visible even if a later revision looks clean:'
    );
    lines.push('');
    for (const r of d.criterion_changes.removed) {
      lines.push(`- **removed** _(rev ${r.revision_n}, step "${r.step_label}")_: ${r.text}`);
    }
    for (const r of d.criterion_changes.rewritten) {
      lines.push(
        `- **rewritten** _(rev ${r.revision_n}, step "${r.step_label}")_: ` +
          `${r.prior_text} → ${r.new_text}`
      );
    }
    lines.push('');
  }

  // Outcome is the counterpart to `## why`'s intent — what actually happened —
  // so it reads above the checkpoint walk rather than below it. Guarded, so an
  // unsummarized thread stays silent (the incomplete-thread blockquote covers
  // that case already).
  if (d.outcome !== null && d.outcome.length > 0) {
    lines.push(`## outcome  ${provenanceTag}`);
    lines.push('');
    lines.push(d.outcome);
    lines.push('');
  }

  lines.push(`## why  ${provenanceTag}`);
  lines.push('');
  lines.push(d.task);
  lines.push('');

  if (d.non_goals.length > 0) {
    lines.push(`## non-goals  ${provenanceTag}`);
    lines.push('');
    // Render the structured exclusion — text + rationale,
    // plus the source-plan item(s) it excludes when named. This is the
    // audit surface that makes a dropped scope item visible and
    // justified rather than a free-text escape hatch.
    for (const ng of d.non_goals) {
      lines.push(`- ${ng.text}`);
      lines.push(`  - rationale: ${ng.rationale}`);
      if (ng.source_refs.length > 0) {
        lines.push(`  - excludes: ${ng.source_refs.join(', ')}`);
      }
    }
    lines.push('');
  }

  lines.push('## what changed  _(inferred from checkpoints)_');
  lines.push('');
  if (d.checkpoints.length === 0) {
    lines.push('_No checkpoints captured._');
    lines.push('');
  } else {
    const exceptionsByCp = new Map<number, DigestPolicyException[]>();
    for (const pe of d.policy_exceptions) {
      const arr = exceptionsByCp.get(pe.cp_n) ?? [];
      arr.push(pe);
      exceptionsByCp.set(pe.cp_n, arr);
    }
    for (const cp of d.checkpoints) {
      // Attribution suffix only for cross-agent handoffs: prefer the
      // close-time agent (who finished the work), noting a differing
      // opener when the two disagree.
      const by = cp.closed_by_agent ?? cp.agent;
      const opener =
        cp.agent && cp.closed_by_agent && cp.agent !== cp.closed_by_agent
          ? ` (opened by \`${cp.agent}\`)`
          : '';
      const attribution =
        by && (by !== d.authoring_agent || opener) ? ` — by \`${by}\`${opener}` : '';
      lines.push(`### checkpoint ${cp.n}${attribution}`);
      lines.push('');
      lines.push(cp.summary);
      lines.push('');
      if (cp.files_changed.length > 0) {
        lines.push('**Files:**');
        lines.push('');
        for (const f of cp.files_changed) lines.push(`- \`${f}\``);
        lines.push('');
      }
      const exceptions = exceptionsByCp.get(cp.n);
      if (exceptions && exceptions.length > 0) {
        lines.push('**Policy exceptions:**');
        lines.push('');
        for (const pe of exceptions) {
          lines.push(`- \`${pe.evaluator_ref}\` — ${pe.reason}`);
        }
        lines.push('');
      }
      // Attribution-trust section for overlap-partitioned
      // closes. Reviewers must see this — flagged files are weak or
      // provisional evidence, and unattributed in-window work is the
      // same finding class as `diff --reconcile` uncovered commits.
      const wo = cp.window_overlap;
      if (wo !== undefined) {
        lines.push('**⚠ Concurrent checkpoint window (attribution partitioned):**');
        lines.push('');
        const woFile = (f: { file_before: string | null; file_after: string | null }): string =>
          f.file_after ?? f.file_before ?? '(unknown)';
        if (wo.siblings.length > 0) {
          lines.push(`- overlapped checkpoint(s): ${wo.siblings.map((s) => `#${s}`).join(', ')}`);
        }
        if (wo.cross_artifact_siblings.length > 0) {
          lines.push(
            `- cross-artifact overlap (claims-only): ${wo.cross_artifact_siblings
              .map((s) => `${s.artifact_id.slice(0, 8)}#${s.n}`)
              .join(', ')}`
          );
        }
        if (wo.pending) {
          lines.push(
            '- **pending** — the overlap group has not fully closed; provisional states unresolved'
          );
        }
        if (wo.ambiguous_files.length > 0) {
          lines.push(
            `- ambiguous (claimed by concurrent checkpoints): ${wo.ambiguous_files.map((f) => `\`${woFile(f)}\``).join(', ')}`
          );
        }
        if (wo.mixed_segment.length > 0) {
          lines.push(
            `- mixed exclusive/concurrent evidence: ${wo.mixed_segment.map((f) => `\`${woFile(f)}\``).join(', ')}`
          );
        }
        if (wo.own_claim_pending.length > 0) {
          lines.push(
            `- own-claim pending (unconfirmed): ${wo.own_claim_pending.map((f) => `\`${woFile(f)}\``).join(', ')}`
          );
        }
        if (wo.rejected_claims.length > 0) {
          lines.push(
            `- rejected claims (contradicted by segment evidence): ${wo.rejected_claims.map((f) => `\`${f}\``).join(', ')}`
          );
        }
        if (wo.segment_attributed.length > 0) {
          lines.push(
            `- unreported but segment-attributed: ${wo.segment_attributed.map((f) => `\`${f}\``).join(', ')}`
          );
        }
        const unclaimedDrops = wo.dropped_files
          .filter((f) => f.status === 'unclaimed')
          .map((f) => woFile(f));
        const loud = [...new Set([...unclaimedDrops, ...wo.unattributed_in_window])].sort();
        if (loud.length > 0) {
          lines.push(
            `- **UNATTRIBUTED in-window work** (no owner): ${loud.map((f) => `\`${f}\``).join(', ')}`
          );
        }
        if (wo.degradations.length > 0) {
          lines.push(`- degradations: ${wo.degradations.join(', ')}`);
        }
        // The stored window_overlap is a close-time SNAPSHOT. If the group
        // has since fully closed, add a legend so a reader doesn't read the
        // provisional pending / own-claim-pending states above as still live.
        // We deliberately do NOT name the resolving checkpoint: `n` is assigned
        // at OPEN, so the first closer (this provisional snapshot) can carry a
        // HIGHER n than the checkpoint that closed last and resolved the group —
        // close order is not derivable from n.
        if (cp.overlap_finalized === true && (wo.pending || wo.own_claim_pending.length > 0)) {
          const elsewhere =
            wo.cross_artifact_siblings.length > 0
              ? ' Some members are in other artifacts not shown here.'
              : '';
          lines.push(
            `- ✓ **group resolved** — this overlap group has since fully closed; the ` +
              `provisional states above were finalized once every member closed.${elsewhere} ` +
              `See the other checkpoint sections and \`orcaops diff --attribution\` for the ` +
              `adjudicated attribution.`
          );
        }
        lines.push('');
      }
    }
  }

  if (d.policy_exceptions.length > 0) {
    lines.push('## policy exceptions');
    lines.push('');
    for (const pe of d.policy_exceptions) {
      lines.push(`- **cp ${pe.cp_n}** \`${pe.evaluator_ref}\` — ${pe.reason}`);
    }
    lines.push('');
  }

  lines.push(`## key decisions  ${provenanceTag}`);
  lines.push('');
  if (d.decisions.length === 0) {
    lines.push('_None recorded._');
  } else {
    for (const dec of d.decisions) {
      const provenance =
        dec.source === 'plan' ? `plan rev ${dec.revision_n}` : `cp ${dec.checkpoint}`;
      lines.push(`- **${dec.decision}** _(${provenance})_`);
      lines.push(`  - ${dec.reason}`);
      if (dec.alternatives_considered && dec.alternatives_considered.length > 0) {
        for (const alt of dec.alternatives_considered) {
          lines.push(
            `  - _considered_ **${alt.option}** — rejected because ${alt.rejected_because}`
          );
        }
      }
    }
  }
  lines.push('');

  // Deferred decisions are *unresolved* choices — render as their own group
  // adjacent to key decisions, NOT folded into "open items" (which would read
  // as settled). Only when present, to avoid churning decision-free digests.
  if (d.deferred_decisions.length > 0) {
    lines.push('## deferred decisions  _(unresolved)_');
    lines.push('');
    for (const dd of d.deferred_decisions) {
      lines.push(`- ${dd}`);
    }
    lines.push('');
  }

  lines.push('## release checks');
  lines.push('');
  lines.push('_merge-relevant evaluator results_');
  lines.push('');
  if (d.release_checks.length === 0) {
    lines.push(
      '_No release-relevant checks ran. (Add a `pre-pr` evaluator or a block-severity checkpoint-close evaluator to surface findings here.)_'
    );
    lines.push('');
  } else {
    lines.push('| evaluator | phase | severity | status |');
    lines.push('|---|---|---|---|');
    for (const r of d.release_checks) {
      lines.push(`| ${r.evaluator_ref} | ${r.phase} | ${r.severity} | ${r.status} |`);
    }
    lines.push('');
    const nonPass = d.release_checks.filter((r) => r.status !== 'pass');
    for (const r of nonPass) {
      lines.push(`### ${r.evaluator_ref} (${r.status})`);
      lines.push('');
      if (r.ackReason) {
        lines.push(`**${capitalize(r.status)}:** ${r.ackReason}`);
        lines.push('');
      }
      const expansionBody =
        (r.status === 'acknowledged' ||
          r.status === 'dismissed' ||
          r.status === 'policy-excepted') &&
        r.originalViolationBody
          ? r.originalViolationBody
          : r.body;
      lines.push(demoteBodyHeadings(expansionBody.trim(), 2));
      lines.push('');
      if (r.prior_resolved !== undefined) {
        lines.push(renderPriorResolvedFootnote(r.prior_resolved));
        lines.push('');
      }
    }
  }

  lines.push('## process notes');
  lines.push('');
  lines.push('_planning and execution hygiene_');
  lines.push('');
  if (d.process_notes.length === 0) {
    lines.push('_No process checks ran._');
    lines.push('');
  } else {
    const passes = d.process_notes.filter((r) => r.status === 'pass');
    const nonPass = d.process_notes.filter((r) => r.status !== 'pass');
    if (nonPass.length === 0) {
      lines.push(`_All ${passes.length} process check${passes.length === 1 ? '' : 's'} passed._`);
      lines.push('');
    } else {
      lines.push(
        `⚠ ${nonPass.length} of ${d.process_notes.length} process check${d.process_notes.length === 1 ? '' : 's'} flagged a concern.`
      );
      lines.push('');
      for (const r of nonPass) {
        lines.push(`### ${r.evaluator_ref} (${r.status}, ${r.phase})`);
        lines.push('');
        if (r.description) {
          lines.push(`_${r.description}_`);
          lines.push('');
        }
        if (r.ackReason) {
          lines.push(`**${capitalize(r.status)}:** ${r.ackReason}`);
          lines.push('');
        }
        const expansionBody =
          (r.status === 'acknowledged' ||
            r.status === 'dismissed' ||
            r.status === 'policy-excepted') &&
          r.originalViolationBody
            ? r.originalViolationBody
            : r.body;
        lines.push(demoteBodyHeadings(expansionBody.trim(), 2));
        lines.push('');
        if (r.prior_resolved !== undefined) {
          lines.push(renderPriorResolvedFootnote(r.prior_resolved));
          lines.push('');
        }
      }
      if (passes.length > 0) {
        const tally = passes
          .map((r) => `${r.evaluator_ref} (${r.phase}, ${r.severity})`)
          .join(', ');
        lines.push(`_Passed: ${tally}._`);
        lines.push('');
      }
    }
  }

  // Open items are what the SUMMARY declares still outstanding. Checkpoint
  // uncertainty is a different thing and gets its own section below: the schema
  // records no resolution status for it, so filing it under "open items"
  // asserted something unknowable — and folding it in also meant a summary that
  // resolved an uncertainty could never say so.
  lines.push(`## open items  ${provenanceTag}`);
  lines.push('');
  if (d.open_items.length === 0) {
    lines.push('_None._');
  } else {
    for (const it of d.open_items) lines.push(`- ${it} _(from summary)_`);
  }
  lines.push('');

  if (d.open_uncertainty.length > 0) {
    lines.push('## checkpoint uncertainties  _(resolution status not encoded)_');
    lines.push('');
    for (const u of d.open_uncertainty) lines.push(`- ${u.item} _(from cp ${u.checkpoint})_`);
    lines.push('');
  }

  lines.push(`## tests  ${provenanceTag}`);
  lines.push('');
  if (d.tests_written.length === 0 && d.tests_run.length === 0) {
    lines.push('_No tests recorded in summary._');
  } else {
    if (d.tests_written.length > 0) {
      lines.push('**Written:**');
      lines.push('');
      for (const t of d.tests_written) lines.push(`- \`${t}\``);
      lines.push('');
    }
    if (d.tests_run.length > 0) {
      lines.push('**Run:**');
      lines.push('');
      for (const t of d.tests_run) lines.push(`- \`${t}\``);
    }
  }
  lines.push('');

  return lines.join('\n');
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function renderPriorResolvedFootnote(p: NonNullable<DigestEvaluatorRow['prior_resolved']>): string {
  const reasonSuffix = p.last_reason ? ` — ${p.last_reason}` : '';
  return (
    `> _Note: this evaluator was previously resolved ${p.count} time(s); ` +
    `last resolution: ${p.last_disposition}${reasonSuffix}_`
  );
}
