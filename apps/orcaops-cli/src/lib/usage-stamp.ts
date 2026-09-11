import { createHash } from 'node:crypto';

import type { UsageBaselineKind } from '@orcaops/storage';

import type { UsageStampDescriptor } from './usage-stamp-types.js';

export type { UsageStampDescriptor } from './usage-stamp-types.js';

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
