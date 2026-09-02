import type { SourcePlanPin, SourceRef } from '../schema/source-plan.js';

/**
 * Canonical, **version/path-independent** join identity for a source plan.
 * Usage stamped across a review cycle (upload → propose →
 * push → pull, all at different versions) must attribute to the same artifact
 * when it later pins that plan, so the join key ignores version (cloud) and
 * path (local):
 *
 *  - cloud → `cloud:<externalId>`  (the `locator`; version dropped)
 *  - local → `local:<contentHash>` (the pin's sha256; path dropped)
 *
 * Takes the resolved pin because the local case needs the content hash, which
 * the bare `source_ref` does not carry.
 */
export function canonicalSourcePlanRefId(pin: Pick<SourcePlanPin, 'source_ref' | 'hash'>): string {
  return canonicalRefIdFrom(pin.source_ref, pin.hash);
}

/** Lower-level variant when the ref and content hash are held separately. */
export function canonicalRefIdFrom(ref: SourceRef, contentHash: string): string {
  return ref.kind === 'cloud' ? `cloud:${ref.locator}` : `local:${contentHash}`;
}
