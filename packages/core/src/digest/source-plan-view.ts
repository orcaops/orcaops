import type { SourcePlanPin, SourceRef } from '@orcaops/storage';

/**
 * Content-free projection of a pinned source plan, for the read surfaces
 * that confirm a pin attached — the `capture plan` response echo, `show`,
 * and `status`. Generalizes the digest's `DigestSourcePlan` (which carries
 * only a bare `locator`) to the FULL `source_ref`, so a reader can tell a
 * cloud pin from a local one and see the pinned version — the
 * disambiguation a bare locator can't give, and exactly what "did my
 * `cloud:<id>@<version>` pin attach?" needs to answer.
 *
 * NEVER carries `content`: these surfaces emit the view verbatim in
 * `--json`, and the full pinned plan body (`SourcePlanPin.content`, up to
 * the entire slice plan) must not leak there. `content?: never` makes a
 * `{ ...pin }` spread — which would drag `content: string` along — a
 * compile error. That's an assignability constraint a `satisfies` or
 * excess-property check would miss, since spreads bypass them; the same
 * guard `DigestSourcePlan` uses.
 */
export interface SourcePlanView {
  pinned: true;
  /** Full provenance: kind (cloud/local), locator, version, and (cloud) origin. */
  source_ref: SourceRef;
  /** sha256 hex digest of the pinned `content` — provenance, never the body. */
  hash: string;
  /** Leak-guard — see the interface doc. */
  content?: never;
}

/**
 * Project a stored pin to its content-free view, or `null` when nothing is
 * pinned. Pure and total: every read surface that already holds an
 * `artifact.json` (or the freshly-resolved pin at capture) can call this
 * without re-reading or hand-guarding for `content`.
 */
export function sourcePlanView(pin: SourcePlanPin | null): SourcePlanView | null {
  if (pin === null) return null;
  return { pinned: true, source_ref: pin.source_ref, hash: pin.hash };
}
