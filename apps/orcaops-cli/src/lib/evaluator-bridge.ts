import { run } from 'effection';

import {
  type AbandonedCheckpointContext,
  type CheckpointContext,
  type ClosedCheckpointContext,
  type EvaluatorContext,
  type EvaluatorPhase,
  type EvaluatorRunPayload,
  isBlockingEvaluatorFailure,
  type OpenCheckpointContext,
  type PlanContext,
  type RepoContext,
  type SourcePlanContext,
  type SummaryContext,
} from '@orcaops/evaluator-protocol';
import { createParamsValidator, dispatchEvaluators } from '@orcaops/evaluator-runner';
import { buildLLMClient } from '@orcaops/llm';
import {
  type AbandonedCheckpoint,
  type Checkpoint,
  type ClosedCheckpoint,
  type LifecycleFiresAt,
  type OpenCheckpoint,
  type Plan,
  type ProposedOpenCheckpoint,
  type SourcePlanPin,
  type Summary,
  uuidv7,
  withNonDerivableWriteLease,
} from '@orcaops/storage';

import type { CliContext } from './context.js';
import { discoverEvaluatorsForCli } from './evaluator-discovery.js';
import { computePackTrustDecisions } from './evaluator-grants.js';
import { reconcileLifecycleEvaluatorInventory } from './evaluator-inventory.js';
import { CLI_ROOT } from './evaluators-config.js';
import { getInvocationEnv } from './invocation-context.js';
import { computePrePrReviewFingerprints, type PrePrReviewFingerprints } from './pre-pr-review.js';
import { writeTerminalSafeStderr } from '../io/output.js';

export interface RunLifecycleOptions {
  ctx: CliContext;
  artifactId: string;
  firesAt: EvaluatorPhase;
  /** Pin revision evaluators to the plan that caused this lifecycle pass. */
  planOverride?: Plan;
  /** Pin the immediately-prior revision paired with planOverride. */
  priorPlanOverride?: Plan | null;
  /** Required when firesAt is checkpoint-open or checkpoint-close. */
  checkpointN?: number;
  /** When true, force the deterministic LLM client (no spawn). */
  noLlm?: boolean;
  /** Pre-append checkpoint-open: synthesize the proposed open cp. */
  proposedOpenCheckpoint?: OpenCheckpoint | ProposedOpenCheckpoint;
  /** Skip persistence (results returned in-memory only). */
  dryRun?: boolean;
}

export interface RunLifecycleResult {
  evaluator_results: EvaluatorRunPayload[];
  blocking: boolean;
  pre_pr_review?: PrePrReviewFingerprints;
}

export interface LifecycleCompletionKey {
  artifactId: string;
  firesAt: LifecycleFiresAt;
  sequenceN?: number;
}

export function hasLifecycleCompletion(ctx: CliContext, key: LifecycleCompletionKey): boolean {
  return ctx.store.store.hasLifecycle({
    artifact_id: key.artifactId,
    fires_at: key.firesAt,
    cp_n: key.sequenceN,
  });
}

export async function recordLifecycleCompletion(
  ctx: CliContext,
  key: LifecycleCompletionKey
): Promise<void> {
  const completedAt = new Date().toISOString();
  await withNonDerivableWriteLease(
    ctx.repoRoot,
    () =>
      ctx.store.store.recordLifecycle({
        artifact_id: key.artifactId,
        fires_at: key.firesAt,
        cp_n: key.sequenceN,
        triggered_at: completedAt,
      }),
    { retryOnLeaseLoss: true }
  );
}

/**
 * The capture-side bridge into the new @orcaops/evaluator-runner.
 *
 * Discovers evaluators from `.orcaops/evaluators.yaml` + declared packs,
 * builds the EvaluatorContext from the artifact's projections + git
 * state, dispatches eligible evaluators through the bounded parallel
 * pool, and persists each EvaluatorRunPayload via the storage
 * event-first projection writer.
 *
 * `blocking` reflects the materialized disposition column on the
 * rebuilt projection — a `block`-severity run with a `violation`
 * verdict surfaces as `disposition: 'unresolved'` until an
 * acknowledgement / dismissal / policy-exception is recorded. Pre-write
 * blocks (e.g., the checkpoint-open gate) consume this via the
 * `dryRun` path: dispositions are computed from the in-memory runs
 * (no storage round-trip) so the caller can refuse the append before
 * any event lands.
 */
export async function runLifecycleEvaluators(
  opts: RunLifecycleOptions
): Promise<RunLifecycleResult> {
  const {
    ctx,
    artifactId,
    firesAt,
    checkpointN,
    dryRun,
    proposedOpenCheckpoint,
    noLlm,
    planOverride,
    priorPlanOverride,
  } = opts;

  const {
    config,
    evaluators: discovered,
    errors: discoveryErrors,
  } = await discoverEvaluatorsForCli(ctx.repoRoot);
  const maxConcurrent = config?.runtime.max_concurrent ?? 4;

  const eligible = discovered.filter((e) => e.enabled && e.phase === firesAt);
  const baseContext =
    eligible.length > 0 || firesAt === 'pre-pr'
      ? await buildBaseContext({
          ctx,
          artifactId,
          firesAt,
          checkpointN,
          proposedOpenCheckpoint,
          planOverride,
          priorPlanOverride,
        })
      : null;
  const prePrReview =
    firesAt === 'pre-pr' && baseContext !== null
      ? await computePrePrReviewFingerprints({ ctx, evaluators: eligible, context: baseContext })
      : undefined;
  // Consent decisions for every pack with an eligible evaluator, verified
  // from user-local grants / the installation manifest — never from repo
  // config (see docs/evaluator-consent.md). Dispatch fails closed per
  // evaluator on a missing or capability-short decision.
  const eligiblePackageIds = new Set(eligible.map((e) => e.package_id));
  const trust = await computePackTrustDecisions({
    packs: (config?.packages ?? [])
      .filter((entry) => eligiblePackageIds.has(entry.id))
      .map((entry) => ({
        packageId: entry.id,
        source: entry.source,
      })),
    repoRoot: ctx.repoRoot,
    cliRoot: CLI_ROOT,
    warn: (msg) => writeTerminalSafeStderr(`${msg}\n`),
  });
  if (eligible.length === 0 && config === null) {
    return {
      evaluator_results: [],
      blocking: false,
      ...(prePrReview === undefined ? {} : { pre_pr_review: prePrReview }),
    };
  }
  let dispatchedRuns: EvaluatorRunPayload[] = [];
  if (eligible.length > 0) {
    if (baseContext === null) {
      throw new Error(`missing evaluator context for ${firesAt}`);
    }
    const llm = await run(function* () {
      return yield* buildLLMClient(ctx.config.llm, {
        ...(noLlm !== undefined ? { noLlm } : {}),
        env: getInvocationEnv(),
      });
    });

    // `createParamsValidator()` types params as `Record<string, unknown>`
    // while `validateRaw` accepts `unknown` (envelope raw can be any
    // shape). Both ajv-compiled validators do runtime work — only the
    // input type narrows. Adapt at the boundary.
    const validator = createParamsValidator();
    const dispatched = await dispatchEvaluators({
      evaluators: eligible,
      context: baseContext,
      llm,
      trust,
      maxConcurrent,
      runIdFactory: uuidv7,
      validateRaw: (raw, schema) => validator(raw as Record<string, unknown>, schema),
    });
    dispatchedRuns = dispatched.runs;
  }

  const inventory = reconcileLifecycleEvaluatorInventory({
    artifactId,
    phase: firesAt,
    checkpointN,
    config,
    discovered,
    eligible,
    dispatchedRuns,
    discoveryErrors,
    runIdFactory: uuidv7,
    now: new Date().toISOString(),
  });

  // Stamp checkpoint_n on runs for the cp phases so cloud sync can
  // resolve the parent Checkpoint id. The dispatch layer doesn't have
  // checkpointN in scope; threading it through every engine option
  // would duplicate it five ways.
  const stampedRuns = inventory.runs.map((r): EvaluatorRunPayload => {
    if (
      checkpointN === undefined ||
      (firesAt !== 'checkpoint-open' && firesAt !== 'checkpoint-close')
    ) {
      return r;
    }
    return { ...r, checkpoint_n: checkpointN };
  });

  if (dryRun) {
    return {
      evaluator_results: stampedRuns,
      blocking: computeDryRunBlocking(stampedRuns),
      ...(prePrReview === undefined ? {} : { pre_pr_review: prePrReview }),
    };
  }

  for (const runPayload of stampedRuns) {
    await ctx.store.writeEvaluatorRunPayload(artifactId, runPayload, {
      idempotencyKey: uuidv7(),
    });
  }

  const log = await ctx.store.readEvaluatorLog(artifactId);
  const writtenRunIds = new Set(stampedRuns.map((r) => r.run_id));
  const blocking =
    stampedRuns.some(isBlockingEvaluatorFailure) ||
    (log !== null &&
      log.runs.some((r) => writtenRunIds.has(r.run_id) && r.disposition === 'unresolved'));

  return {
    evaluator_results: stampedRuns,
    blocking,
    ...(prePrReview === undefined ? {} : { pre_pr_review: prePrReview }),
  };
}

/**
 * Pre-write blocking includes completed block-severity violations and
 * block-severity infrastructure errors. Errors cannot receive dispositions;
 * they must be fixed and retried.
 */
function computeDryRunBlocking(runs: readonly EvaluatorRunPayload[]): boolean {
  return runs.some(isBlockingEvaluatorFailure);
}

/**
 * Public helper: build the EvaluatorContext for a given artifact + phase
 * (with optional checkpoint scope and proposed-open synthesis).
 *
 * Exported so the checkpoint-open gate can reuse the exact same
 * context shape as the bridge's `runLifecycleEvaluators` without
 * re-implementing the projection-read + checkpoint-context plumbing.
 */
export async function buildEvaluatorContext(opts: {
  ctx: CliContext;
  artifactId: string;
  firesAt: EvaluatorPhase;
  checkpointN?: number;
  proposedOpenCheckpoint?: OpenCheckpoint | ProposedOpenCheckpoint;
  planOverride?: Plan;
  priorPlanOverride?: Plan | null;
}): Promise<EvaluatorContext> {
  return buildBaseContext(opts);
}

async function buildBaseContext(opts: {
  ctx: CliContext;
  artifactId: string;
  firesAt: EvaluatorPhase;
  checkpointN?: number;
  proposedOpenCheckpoint?: OpenCheckpoint | ProposedOpenCheckpoint;
  planOverride?: Plan;
  priorPlanOverride?: Plan | null;
}): Promise<EvaluatorContext> {
  const {
    ctx,
    artifactId,
    firesAt,
    checkpointN,
    proposedOpenCheckpoint,
    planOverride,
    priorPlanOverride,
  } = opts;

  const plan = planOverride ?? (await ctx.store.readPlan(artifactId));
  if (!plan) {
    throw new Error(
      `Cannot build evaluator context: artifact "${artifactId}" has no plan projection.`
    );
  }
  const allCheckpoints = await ctx.store.readCheckpoints(artifactId);
  const summary = await ctx.store.readSummary(artifactId);
  // The pinned source plan lives on artifact.json (set-once off
  // the plan_captured event), not on the Plan projection. Read it here and
  // thread it artifact-level into the context for `plan-conformance`.
  // `null` (explicit, not omitted) when the artifact didn't opt in — the
  // EvaluatorContext schema is `.strict()`.
  const artifact = await ctx.store.readArtifact(artifactId);

  // Post-plan-revision evaluators (revision-non-goals-stable etc.)
  // compare current plan against the immediately-prior revision to
  // detect scope drift. Other phases get null — the three revision
  // checkers are the only consumers today and they only fire on
  // post-plan-revision. `revision_n === 0` is the initial capture
  // (no prior exists).
  const priorPlan: Plan | null =
    priorPlanOverride !== undefined
      ? priorPlanOverride
      : firesAt === 'post-plan-revision' && plan.revision_n > 0
        ? await ctx.store.readPlanRevision(artifactId, plan.revision_n - 1)
        : null;

  const closedCheckpoints = allCheckpoints.filter(
    (c): c is ClosedCheckpoint => c.status === 'closed'
  );
  const openCheckpoints = allCheckpoints.filter((c): c is OpenCheckpoint => c.status === 'open');
  const abandonedCheckpoints = allCheckpoints.filter(
    (c): c is AbandonedCheckpoint => c.status === 'abandoned'
  );

  let currentCheckpoint: CheckpointContext | null = null;
  if (firesAt === 'checkpoint-close' && checkpointN !== undefined) {
    const target = closedCheckpoints.find((c) => c.n === checkpointN);
    if (target) currentCheckpoint = toCheckpointContext(target);
  } else if (firesAt === 'checkpoint-open') {
    if (proposedOpenCheckpoint) {
      currentCheckpoint = toCheckpointContext(proposedOpenCheckpoint);
    } else if (checkpointN !== undefined) {
      const target = openCheckpoints.find((c) => c.n === checkpointN);
      if (target) currentCheckpoint = toCheckpointContext(target);
    }
  }

  let changedFiles: string[] = [];
  if (firesAt === 'checkpoint-close' && currentCheckpoint?.status === 'closed') {
    changedFiles = [...currentCheckpoint.files_changed];
  } else if (firesAt === 'pre-pr') {
    const seen = new Set<string>();
    for (const cp of closedCheckpoints) {
      for (const f of cp.files_changed) {
        if (seen.has(f)) continue;
        seen.add(f);
        changedFiles.push(f);
      }
    }
  }

  const headSha = await ctx.repo.getHeadSha();
  const repoContext: RepoContext = {
    root: ctx.repoRoot,
    branch: plan.branch,
    base_sha: plan.base_sha,
    head_sha: headSha,
  };

  return {
    schema: 'orcaops.evaluator_context/v1',
    run_id: uuidv7(),
    evaluator_ref: '<base>',
    phase: firesAt,
    artifact_id: artifactId,
    checkpoint_n: checkpointN ?? null,
    repo: repoContext,
    plan: toPlanContext(plan),
    prior_plan: priorPlan !== null ? toPlanContext(priorPlan) : null,
    source_plan: artifact?.source_plan != null ? toSourcePlanContext(artifact.source_plan) : null,
    current_checkpoint: currentCheckpoint,
    closed_checkpoints: closedCheckpoints.map(toCheckpointContext),
    open_checkpoints: openCheckpoints.map(toCheckpointContext),
    abandoned_checkpoints: abandonedCheckpoints.map(toCheckpointContext),
    summary: summary !== null ? toSummaryContext(summary) : null,
    changed_files: changedFiles,
    params: {},
  };
}

function toPlanContext(plan: Plan): PlanContext {
  return {
    task: plan.task,
    label: plan.label,
    branch: plan.branch,
    base_sha: plan.base_sha,
    agent: plan.agent,
    agent_session_id: plan.agent_session_id,
    plan_steps: plan.plan_steps.map((s) => ({
      step_id: s.step_id,
      text: s.text,
      label: s.label,
      acceptance_criteria: s.acceptance_criteria.map((c) => ({
        criterion_id: c.criterion_id,
        text: c.text,
      })),
    })),
    touched_scope: [...plan.touched_scope],
    // PlanContext.non_goals is structured `NonGoalContext[]`
    // (text + rationale + source_refs), unified with storage. No flatten —
    // the conformance judge needs rationale/source_refs to tell a declared
    // exclusion from a silent gap.
    non_goals: plan.non_goals.map((ng) => ({
      text: ng.text,
      rationale: ng.rationale,
      source_refs: [...ng.source_refs],
    })),
    // Map to the base shape, STRIPPING the storage-only `revision_n` —
    // DecisionContextSchema is `.strict()` and would throw on an extra key.
    // Conditional `alternatives_considered` mirrors the digest builder.
    decisions: plan.decisions.map((d) => ({
      decision: d.decision,
      reason: d.reason,
      ...(d.alternatives_considered && d.alternatives_considered.length > 0
        ? {
            alternatives_considered: d.alternatives_considered.map((a) => ({
              option: a.option,
              rejected_because: a.rejected_because,
            })),
          }
        : {}),
    })),
    revision_n: plan.revision_n,
    revised_at: plan.revised_at,
    rationale: plan.rationale,
    step_lineage: {
      added: [...plan.step_lineage.added],
      dropped: [...plan.step_lineage.dropped],
      unchanged: [...plan.step_lineage.unchanged],
      rewritten: plan.step_lineage.rewritten.map((r) => ({ ...r })),
    },
    started_at: plan.started_at,
  };
}

// Explicit mapper (matches the other toX helpers) rather than a
// structural `?? null` assignment — maps each field by name so a future
// drift between the storage SourcePlanPin and the protocol
// SourcePlanContext is a compile error here, not a silent shape mismatch.
// Unlike the digest summary, the evaluator context DOES carry `content`
// (the pinned plan the conformance judge reads).
function toSourcePlanContext(pin: SourcePlanPin): SourcePlanContext {
  return {
    source_ref: {
      kind: pin.source_ref.kind,
      locator: pin.source_ref.locator,
      ...(pin.source_ref.version !== undefined ? { version: pin.source_ref.version } : {}),
    },
    content: pin.content,
    hash: pin.hash,
  };
}

function toCheckpointContext(
  cp: Checkpoint | OpenCheckpoint | ProposedOpenCheckpoint
): CheckpointContext {
  if (cp.status === 'open') return toOpenCheckpointContext(cp);
  if (cp.status === 'closed') return toClosedCheckpointContext(cp);
  return toAbandonedCheckpointContext(cp);
}

function toOpenCheckpointContext(
  cp: OpenCheckpoint | ProposedOpenCheckpoint
): OpenCheckpointContext {
  return {
    status: 'open',
    n: cp.n,
    declared_step_ids: [...cp.declared_step_ids],
    agent_session_id: cp.agent_session_id ?? null,
    policy_exceptions: cp.policy_exceptions.map((e) => ({ ...e })),
    plan_revision_id: cp.plan_revision_id,
    head_sha: cp.head_sha,
    opened_at: cp.opened_at,
  };
}

function toClosedCheckpointContext(cp: ClosedCheckpoint): ClosedCheckpointContext {
  return {
    status: 'closed',
    n: cp.n,
    declared_step_ids: [...cp.declared_step_ids],
    completed_step_ids: [...cp.completed_step_ids],
    agent_session_id: cp.agent_session_id ?? null,
    policy_exceptions: cp.policy_exceptions.map((e) => ({ ...e })),
    plan_revision_id: cp.plan_revision_id,
    summary: cp.summary,
    files_changed: [...cp.files_changed],
    // Explicit field pick (not a blind spread): the context's
    // DecisionContextSchema is `.strict()`, so only fields it declares
    // may cross. `alternatives_considered` is carried when present (the
    // secret scanner walks it); any future stored-decision field stays
    // out of the context until deliberately added here.
    decisions: cp.decisions.map((d) => ({
      decision: d.decision,
      reason: d.reason,
      ...(d.alternatives_considered
        ? { alternatives_considered: d.alternatives_considered.map((a) => ({ ...a })) }
        : {}),
    })),
    uncertainty: [...cp.uncertainty],
    done_criteria: cp.done_criteria.map((d) => ({
      criterion_id: d.criterion_id,
      evidence: d.evidence,
    })),
    // OMIT-WHEN-EMPTY: pack runtimes re-validate the context
    // file with their OWN installed copy of the strict schema — an
    // always-present `verification` key would break every closed-cp
    // dispatch under a separately-built older pack. Absence re-hydrates
    // to [] via the new schema's `.default([])`; the cast covers the
    // deliberately-absent key against the z.infer output type.
    ...((cp.verification ?? []).length > 0
      ? { verification: (cp.verification ?? []).map((v) => ({ ...v })) }
      : {}),
    head_sha: cp.head_sha,
    opened_at: cp.opened_at,
    closed_at: cp.closed_at,
  } as ClosedCheckpointContext;
}

function toAbandonedCheckpointContext(cp: AbandonedCheckpoint): AbandonedCheckpointContext {
  return {
    status: 'abandoned',
    n: cp.n,
    declared_step_ids: [...cp.declared_step_ids],
    agent_session_id: cp.agent_session_id ?? null,
    head_sha: cp.head_sha,
    reason: cp.reason,
    opened_at: cp.opened_at,
    abandoned_at: cp.abandoned_at,
  };
}

function toSummaryContext(s: Summary): SummaryContext {
  return {
    outcome: s.outcome,
    open_items: [...s.open_items],
    tests_written: [...s.tests_written],
    tests_run: [...s.tests_run],
    deferred_decisions: [...s.deferred_decisions],
    written_at: s.ts,
  };
}
