import path from 'node:path';

// The plan-review harness is verb-agnostic (credential store + injected cloud target
// + client + authoritative org) — re-exported rather than cloned.
export { type ReviewCloudContext, withReviewCloud } from '../plan/review/shared.js';

/** Repo-local cache root for review-feedback pulls + watch cursors. */
export function reviewFeedbackCacheDir(repoRoot: string): string {
  return path.join(repoRoot, '.orcaops', 'cache');
}
