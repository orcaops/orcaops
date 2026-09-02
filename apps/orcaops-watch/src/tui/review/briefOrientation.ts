// The branch-level facts the Brief's left pane states, derived once.
//
// Each of these has a wrong source that looks right, which is why they live
// here with their reasoning rather than inline in the renderer.

import {
  CITATION_KIND,
  type Floor,
  UNCERTAINTY_STATE,
  type UncertaintyState,
} from '@orcaops/review-core';

export interface BriefReviewScope {
  files: number;
  added: number;
  removed: number;
}

/**
 * The size of the change under review — as REVIEW SCOPE, not as raw Git.
 *
 * `floor.coverage.items` is the pinned scope: it includes EXCLUDED and
 * UNREVIEWABLE hunks, and it is the same truth COVERAGE and Flat Files already
 * read. Summing the rows the reader's pages own would look equivalent and quietly
 * omit Unassigned and non-reviewable changes — the reviewer would be told the
 * branch is smaller than it is, in the one place they go to size it up.
 *
 * The label matters as much as the number: these totals describe what this
 * review retained, not what `git diff` would print.
 */
export function briefReviewScope(floor: Floor): BriefReviewScope {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const item of floor.coverage.items) {
    files.add(item.file);
    added += item.added_lines;
    removed += item.removed_lines;
  }
  return { files: files.size, added, removed };
}

/** Coverage as a percentage of reviewable rows, or null when there is nothing to match. */
export function briefCoveragePercent(floor: Floor): number | null {
  const summary = floor.coverage.summary;
  if (summary.reviewable_rows === 0) return null;
  return Math.round((summary.matched_rows / summary.reviewable_rows) * 100);
}

/**
 * How a coverage percentage should read: high is healthy (green), a large
 * unmatched remainder is a warning (amber), and a mostly-unmatched review is a
 * problem (red). The colour is what a reviewer scans; the number confirms it.
 */
export function coverageTone(pct: number): 'positive' | 'attention' | 'danger' {
  if (pct >= 90) return 'positive';
  if (pct >= 60) return 'attention';
  return 'danger';
}

export interface BriefPlanStatus {
  claimed: number;
  total: number;
}

/**
 * How much of the captured plan actually landed.
 *
 * A compact status only: the unclaimed steps already render as amber warnings
 * inside COVERAGE, and listing them twice would make a two-line fact look like
 * two separate problems.
 */
export function briefPlanStatus(floor: Floor): BriefPlanStatus | null {
  const total = floor.plan_coverage.length;
  if (total === 0) return null;
  return { claimed: floor.plan_coverage.filter((step) => !step.unclaimed).length, total };
}

export interface BriefUncertaintyStates {
  total: number;
  open: number;
  acknowledged: number;
  resolved: number;
}

/**
 * Ledger disposition of the uncertainties THIS floor still carries.
 *
 * Two traps here, and both produce a plausible wrong number.
 *
 * The domain is the FLOOR, not the ledger. `ledger.uncertainties` is append-only
 * and retains entries for citations a re-floor removed, so counting its values
 * reports work that is no longer in the review.
 *
 * And all three states are enumerated. `UNCERTAINTY_STATE` is OPEN | ACKNOWLEDGED
 * | RESOLVED, so "resolved" is not the complement of "open" — reporting a pair
 * silently folds ACKNOWLEDGED into whichever side the reader assumes.
 */
export function briefUncertaintyStates(
  floor: Floor,
  states: ReadonlyMap<string, UncertaintyState>
): BriefUncertaintyStates {
  const current = floor.citations.filter(
    (citation) => citation.kind === CITATION_KIND.CHECKPOINT_UNCERTAINTY
  );
  const counts = { total: current.length, open: 0, acknowledged: 0, resolved: 0 };
  for (const citation of current) {
    // Absent from the ledger means nobody has dispositioned it yet, which is OPEN.
    const state = states.get(citation.id) ?? UNCERTAINTY_STATE.OPEN;
    if (state === UNCERTAINTY_STATE.RESOLVED) counts.resolved += 1;
    else if (state === UNCERTAINTY_STATE.ACKNOWLEDGED) counts.acknowledged += 1;
    else counts.open += 1;
  }
  return counts;
}

export interface UncertaintySegments {
  open: number;
  acknowledged: number;
  resolved: number;
}

/**
 * Cell widths for a segmented uncertainty meter across a fixed-width bar.
 *
 * Every uncertainty is in exactly one of the three states, so the segments fill
 * the whole bar with no remainder. Largest-remainder apportionment keeps them
 * summing to `width` exactly while tracking the counts, so the visible split IS
 * the disposition — open, acknowledged, resolved.
 */
export function uncertaintySegments(
  open: number,
  acknowledged: number,
  resolved: number,
  width: number
): UncertaintySegments {
  const total = open + acknowledged + resolved;
  if (total <= 0 || width <= 0) return { open: 0, acknowledged: 0, resolved: 0 };
  const raw = [open, acknowledged, resolved].map((n) => (n / total) * width);
  const cells = raw.map((value) => Math.floor(value));
  let remainder = width - cells.reduce((sum, value) => sum + value, 0);
  const byFraction = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let k = 0; remainder > 0 && k < byFraction.length; k += 1) {
    cells[byFraction[k]!.index] += 1;
    remainder -= 1;
  }
  return { open: cells[0]!, acknowledged: cells[1]!, resolved: cells[2]! };
}

/**
 * Composition outcomes, which are a DIFFERENT system from the ledger states above.
 *
 * `RESOLUTION_OUTCOME` is DECIDED | IMPLEMENTED | ACCEPTED_RISK | DEFERRED — what
 * the narrative recorded about an uncertainty — while the ledger tracks whether
 * the reviewer has dispositioned it. Neither is the complement of the other, so
 * they render as separate lines and never as one merged tally.
 */
export function briefOutcomeSummary(counts: Readonly<Record<string, number>>): string | null {
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([outcome, count]) => `${outcome.toLowerCase().replace(/_/gu, ' ')} ${count}`);
  return parts.length === 0 ? null : parts.join(' · ');
}
