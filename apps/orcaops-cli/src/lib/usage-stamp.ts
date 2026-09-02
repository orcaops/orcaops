import { createHash } from 'node:crypto';

import { type UsageBaselineKind, UsageLedger } from '@orcaops/storage';

import { resolveAgentSession } from './coding-session.js';
import { buildContext, type CliContext } from './context.js';
import { getInvocationCwd, getInvocationEnv } from './invocation-context.js';

/**
 * The CLI side of coding-agent usage tracking: read the agent's own token
 * usage and record it in the repo-level ledger. Everything here is
 * **best-effort and never throws** — usage tracking must never fail a capture
 * command. With no resolvable agent session (headless, an agent without a
 * usage source, or no fresh discovery match) or no usage data, it is a no-op.
 *
 * Which agent is stamped comes from {@link resolveAgentSession}: direct env
 * evidence first, then the runtime-resolved invoking agent via on-disk discovery.
 */

/**
 * A description of one usage stamp, returned by a command as a private
 * `usageStamp` field. `runCaptureWithSync` consumes it once (before the eager
 * push) and strips it from the emitted JSON — it never reaches the user.
 */
export interface UsageStampDescriptor {
  /** Lifecycle event label, e.g. `plan`, `checkpoint_open`, `plan_review`. */
  lifecycle_event: string;
  artifactId?: string | null;
  /** Canonical source-plan ref id (`cloud:<ext>` / `local:<hash>`), if any. */
  sourcePlanRefId?: string | null;
  checkpoint_n?: number | null;
  baselineHint: UsageBaselineKind;
  /** ISO transcript read-cutoff. NOT idempotency material. */
  asOf: string;
  /** The verb-specific, content-derived idempotency key. */
  stableEventId: string;
  /** `--count-whole-session`: force a whole-session first delta. */
  countWholeSession?: boolean;
}

/**
 * Build a namespaced, content-derived idempotency key: all parts
 * hashed under sha256 so a retry of the same authoring interval dedups, while a
 * genuinely distinct one (different version / body / target) mints a new key.
 */
export function usageStampKey(...parts: Array<string | number | null | undefined>): string {
  return createHash('sha256')
    .update(JSON.stringify(parts.map((p) => String(p ?? ''))), 'utf8')
    .digest('hex');
}

function usageLedger(ctx: CliContext): UsageLedger {
  // Reuse the artifact store's lock instance (same locksDir); the ledger locks
  // on a synthetic repo-wide id distinct from any artifact id.
  return new UsageLedger({
    repoRoot: ctx.store.repoRoot,
    store: ctx.store.store,
    lock: ctx.store.lock,
    mirror: ctx.archive,
  });
}

/** Record one usage snapshot for the current session. Best-effort. */
export async function stampUsage(ctx: CliContext, d: UsageStampDescriptor): Promise<void> {
  try {
    const resolved = await resolveAgentSession({
      env: getInvocationEnv(),
      cwd: getInvocationCwd(),
      // Runtime-resolved invoking agent (config v3 removed static config.agent).
      // Only the discovery-fallback tier consults this hint; the direct
      // env-evidence tier runs first regardless, so multi-agent usage sources
      // (codex / opencode / copilot) still resolve by their own session env.
      invokingAgent: ctx.invokingAgent.agent,
      now: d.asOf,
    });
    if (!resolved) return; // headless / no active agent session → no-op
    const snapshot = await resolved.source.readUsage(resolved.sessionId, {
      until: d.asOf,
      cwd: getInvocationCwd(),
    });
    if (!snapshot) return; // no transcript / no usage → no-op

    await usageLedger(ctx).appendUsageSnapshot({
      agent: resolved.agent,
      session_id: resolved.sessionId,
      artifact_id: d.artifactId ?? null,
      source_plan_ref_id: d.sourcePlanRefId ?? null,
      lifecycle_event: d.lifecycle_event,
      checkpoint_n: d.checkpoint_n ?? null,
      cumulative_usage: snapshot.total,
      model_breakdown: snapshot.modelBreakdown.map((m) => ({
        model: m.model,
        ...(m.speed !== undefined ? { speed: m.speed } : {}),
        ...(m.service_tier !== undefined ? { service_tier: m.service_tier } : {}),
        ...(m.inference_geo !== undefined ? { inference_geo: m.inference_geo } : {}),
        cumulative: m.usage,
      })),
      record_count: snapshot.recordCount,
      as_of: snapshot.asOf,
      ts: d.asOf,
      baseline_hint: d.countWholeSession ? 'whole_session' : d.baselineHint,
      idempotency_key: d.stableEventId,
    });
  } catch {
    // best-effort: usage tracking must never fail a capture command
  }
}

/**
 * Link a pinned source plan to an artifact at capture (idempotent on
 * `(ref, artifact)`). Best-effort — a link failure must not fail capture.
 */
export async function stampSourcePlanLink(
  ctx: CliContext,
  input: {
    canonical_ref_id: string;
    artifact_id: string;
    linked_at: string;
    pinned_version?: string | null;
  }
): Promise<void> {
  try {
    await usageLedger(ctx).appendSourcePlanLink({
      canonical_ref_id: input.canonical_ref_id,
      artifact_id: input.artifact_id,
      linked_at: input.linked_at,
      pinned_version: input.pinned_version ?? null,
      idempotency_key: usageStampKey(input.canonical_ref_id, 'link', input.artifact_id),
    });
  } catch {
    // best-effort
  }
}

/**
 * Stamp usage for a plan-review verb. These run OUTSIDE the capture funnel
 * (`withReviewCloud` closes its store before the action emits), so this builds
 * its own short-lived context, stamps, and closes it. Best-effort.
 */
export async function stampPlanReviewUsage(d: UsageStampDescriptor): Promise<void> {
  let ctx: CliContext | undefined;
  try {
    ctx = await buildContext();
    await stampUsage(ctx, d);
  } catch {
    // best-effort
  } finally {
    ctx?.store.close();
  }
}

/**
 * Build a plan-review usage descriptor: source-plan-scoped (so the usage joins
 * to the artifact when it later pins this plan), keyed by the verb + a
 * per-call discriminator so distinct authoring intervals each stamp.
 */
export function reviewUsageStamp(
  verb: string,
  externalId: string,
  ...discriminators: Array<string | number | null | undefined>
): UsageStampDescriptor {
  return {
    lifecycle_event: 'plan_review',
    sourcePlanRefId: `cloud:${externalId}`,
    baselineHint: 'prior_same_source_plan',
    asOf: new Date().toISOString(),
    stableEventId: usageStampKey(externalId, verb, ...discriminators),
  };
}

/**
 * Build an artifact-scoped lifecycle usage descriptor for the capture funnel
 * (summary / pre-pr-check / plan revise / checkpoint abandon). Centralizes the
 * `usageStampKey(artifactId, event, discriminator)` idempotency-key convention
 * the artifact-scoped sites share — the counterpart to `reviewUsageStamp` for
 * the source-plan-scoped plan-review verbs. Callers attach the result as the
 * private `usageStamp` field on their **success/created return only**; replay
 * arms return earlier without it, so a replay never re-stamps.
 */
export function lifecycleUsageStamp(args: {
  /** Lifecycle event label, e.g. `summary`, `pre_pr_check`, `plan_revision`. */
  event: string;
  artifactId: string;
  baselineHint: UsageBaselineKind;
  /** ISO transcript read-cutoff. NOT idempotency material. */
  asOf: string;
  /** Verb-specific discriminator hashed after (artifactId, event) into the key. */
  discriminator: string | number | null | undefined;
  checkpoint_n?: number | null;
}): UsageStampDescriptor {
  return {
    lifecycle_event: args.event,
    artifactId: args.artifactId,
    checkpoint_n: args.checkpoint_n ?? null,
    baselineHint: args.baselineHint,
    asOf: args.asOf,
    stableEventId: usageStampKey(args.artifactId, args.event, args.discriminator),
  };
}
