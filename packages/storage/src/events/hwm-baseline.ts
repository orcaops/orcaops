/**
 * High-water-mark (HWM) baseline resolution for empty-fence recovery.
 *
 * When a checkpoint closes over an EMPTY open→close fence yet claims changed
 * files, the close path can recover per-line attribution by re-diffing from a
 * baseline tree to the real close tree, scoped to the declared files. This
 * module resolves that baseline purely from the in-lock event log — no I/O, no
 * projection reads — so the storage close path can call it under the artifact
 * lock without racing.
 *
 * The baseline is the terminal tree of the highest-`n` FINALIZED checkpoint
 * before the one being closed. "Finalized" means CLOSED or ABANDONED — an
 * abandoned cp's edits are real, un-attributed tree mutations, so its abandon
 * tree is the true high-water mark; skipping it would re-attribute that work to
 * the current cp.
 *
 * Three distinct outcomes (the caller must NOT collapse them):
 *   - No prior finalized cp        → { hwmBaselineTreeSha: null, recoveryBlocked: false }
 *                                     Nothing accounted/moved-past yet; the
 *                                     caller may safely fall back to the seed.
 *   - Prior finalized, tree present → { hwmBaselineTreeSha: <tree>, recoveryBlocked: false }
 *   - Prior finalized, tree null    → { hwmBaselineTreeSha: null, recoveryBlocked: true }
 *                                     The HWM cp's terminal snapshot was
 *                                     skipped/errored; diffing from an older
 *                                     baseline or the seed would double-count.
 *
 * Plus a concurrency guard: recovery is blocked entirely (incl. the seed path)
 * when the current cp's interval overlapped ANY other cp's interval — even one
 * already closed or abandoned before this close. Overlap is computed from
 * EVENT-LOG ORDER, not timestamps (`toISOString()` ties at ms resolution are
 * nondeterministic).
 */

import { type CpIntervalScan, scanCheckpointIntervals } from './window-overlap.js';

/** Minimal structural view of a loaded event the HWM scan reads. */
export interface HwmBaselineEvent {
  record: { type: string };
  /** Resolved event payload (sidecar already inlined upstream). */
  payload: unknown;
}

export interface HwmBaselineResult {
  /** Baseline tree to diff recovery from, or null (seed path OR blocked). */
  hwmBaselineTreeSha: string | null;
  /** When true, the caller MUST NOT recover — not even from the seed. */
  recoveryBlocked: boolean;
}

/**
 * Resolve the HWM baseline for the checkpoint currently being closed.
 *
 * @param events         Append-ordered loaded events. The current cp's close
 *                       event is NOT yet present (it is appended after the close
 *                       callback runs), so the current interval ends at
 *                       `events.length`.
 * @param currentN       `n` of the checkpoint being closed.
 * @param currentOpenIdx Index of the current cp's checkpoint_opened event in
 *                       `events` (its interval start).
 */
export function getHwmBaseline(
  events: readonly HwmBaselineEvent[],
  currentN: number,
  currentOpenIdx: number
): HwmBaselineResult {
  // 1. Single indexed scan → one interval per checkpoint n. Lives in
  //    window-overlap.ts so the overlap detector shares it; this suite pins
  //    its semantics.
  const byN: ReadonlyMap<number, CpIntervalScan> = scanCheckpointIntervals(events);

  // 2. Concurrency guard. The current cp's interval is [currentOpenIdx,
  //    currentCloseIdx] with currentCloseIdx = events.length (close not yet
  //    appended). Any other cp whose interval intersects it — including one
  //    already closed/abandoned before this close, and still-open (open-ended)
  //    ones — means the prior close tree is not a clean HWM: block entirely.
  const currentCloseIdx = events.length;
  for (const iv of byN.values()) {
    if (iv.n === currentN) continue;
    const otherEnd = iv.endIdx ?? Number.POSITIVE_INFINITY; // still-open ⇒ open-ended
    if (currentOpenIdx <= otherEnd && iv.openIdx <= currentCloseIdx) {
      return { hwmBaselineTreeSha: null, recoveryBlocked: true };
    }
  }

  // 3. HWM = the LATEST-finalized cp (greatest terminal event index) with
  //    n < currentN — the true high-water mark. The worktree is cumulative, so
  //    the most-recently-CLOSED tree is the baseline, NOT the highest-n cp:
  //    under out-of-order concurrent closes (a lower-n cp closing AFTER a
  //    higher-n one) highest-n diverges from latest-tree and recovery would
  //    diff from a stale baseline (wrong attribution). The step-2 overlap guard
  //    already returned if any other interval intersects the current one, so
  //    every candidate here ended before currentOpenIdx; the null-terminal-tree
  //    check below then keys on this latest-closing cp (the tree the current cp
  //    actually started from).
  let hwm: CpIntervalScan | null = null;
  for (const iv of byN.values()) {
    if (iv.n >= currentN) continue;
    if (iv.status !== 'closed' && iv.status !== 'abandoned') continue;
    if (hwm === null || (iv.endIdx ?? -1) > (hwm.endIdx ?? -1)) hwm = iv;
  }
  if (hwm === null) {
    // Nothing finalized before this cp → safe to fall back to the seed.
    return { hwmBaselineTreeSha: null, recoveryBlocked: false };
  }
  if (hwm.terminalTreeSha === null) {
    // The HWM cp's terminal snapshot was skipped/errored — diffing from an
    // older baseline or the seed would re-attribute this cp's (and the HWM
    // cp's) work. Warning-only.
    return { hwmBaselineTreeSha: null, recoveryBlocked: true };
  }
  return { hwmBaselineTreeSha: hwm.terminalTreeSha, recoveryBlocked: false };
}
