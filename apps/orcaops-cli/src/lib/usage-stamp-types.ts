import type { UsageBaselineKind } from '@orcaops/storage';

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
