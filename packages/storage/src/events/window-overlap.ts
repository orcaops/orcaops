/**
 * Window-overlap detection for the segment-refined claims partition.
 *
 * Extracts the checkpoint interval scan that `getHwmBaseline` pioneered
 * (event-log INDEX order, never timestamps — `toISOString()` ties at ms
 * resolution are nondeterministic) into a shared single-pass helper, and
 * builds on it the overlap context the close path feeds to the segment
 * partition: which sibling checkpoints' intervals intersect the closing
 * cp's, their close-time `files_changed` claims (the attribution claims),
 * and the ordered boundary list (event indices + snapshot tree SHAs)
 * that slices the overlap window into segments.
 *
 * Storage stays git-free: this module reads ONLY the in-lock event log.
 * Segment tree-diffing happens in core/CLI against the tree SHAs
 * returned here.
 */

/** Minimal structural view of a loaded event the scan reads. */
export interface WindowScanEvent {
  record: { type: string };
  /** Resolved event payload (sidecar already inlined upstream). */
  payload: unknown;
}

/** One checkpoint's interval, as folded from the event log. */
export interface CpIntervalScan {
  n: number;
  /** Index of the cp's (earliest) checkpoint_opened event. */
  openIdx: number;
  /** Index of the cp's close/abandon event, or null while still open. */
  endIdx: number | null;
  status: 'open' | 'closed' | 'abandoned';
  /** close_snapshot/abandon_snapshot tree_sha for a finalized cp; null otherwise. */
  terminalTreeSha: string | null;
  /** open_snapshot tree_sha (null when the open snapshot was skipped/failed). */
  openTreeSha: string | null;
  /** Close-time `files_changed` claim; empty until closed. */
  filesChanged: string[];
}

function readN(payload: unknown): number | null {
  const n = (payload as { n?: unknown } | null)?.n;
  return typeof n === 'number' ? n : null;
}

function readBoundaryTreeSha(
  payload: unknown,
  key: 'open_snapshot' | 'close_snapshot' | 'abandon_snapshot'
): string | null {
  const boundary = (payload as Record<string, unknown> | null)?.[key] as
    | { tree_sha?: string | null }
    | undefined;
  return boundary?.tree_sha ?? null;
}

function readFilesChanged(payload: unknown): string[] {
  const files = (payload as { files_changed?: unknown } | null)?.files_changed;
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : [];
}

/**
 * Single indexed scan → one interval per checkpoint `n`. `getHwmBaseline`
 * delegates here; its test suite is the regression gate for these semantics:
 *   - the EARLIEST open is kept as the interval start (widest window =
 *     safest overlap detection); a re-issued open does not shrink it;
 *   - a close/abandon without a preceding open for that `n` is ignored;
 *   - a later duplicate close/abandon overwrites `endIdx` (last wins).
 */
export function scanCheckpointIntervals(
  events: readonly WindowScanEvent[]
): Map<number, CpIntervalScan> {
  const byN = new Map<number, CpIntervalScan>();
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const type = ev.record.type;
    if (type === 'checkpoint_opened') {
      const n = readN(ev.payload);
      if (n === null) continue;
      if (!byN.has(n)) {
        byN.set(n, {
          n,
          openIdx: i,
          endIdx: null,
          status: 'open',
          terminalTreeSha: null,
          openTreeSha: readBoundaryTreeSha(ev.payload, 'open_snapshot'),
          filesChanged: [],
        });
      }
    } else if (type === 'checkpoint_closed') {
      const n = readN(ev.payload);
      if (n === null) continue;
      const iv = byN.get(n);
      if (iv !== undefined) {
        iv.endIdx = i;
        iv.status = 'closed';
        iv.terminalTreeSha = readBoundaryTreeSha(ev.payload, 'close_snapshot');
        iv.filesChanged = readFilesChanged(ev.payload);
      }
    } else if (type === 'checkpoint_abandoned') {
      const n = readN(ev.payload);
      if (n === null) continue;
      const iv = byN.get(n);
      if (iv !== undefined) {
        iv.endIdx = i;
        iv.status = 'abandoned';
        iv.terminalTreeSha = readBoundaryTreeSha(ev.payload, 'abandon_snapshot');
      }
    }
  }
  return byN;
}

/** One lifecycle boundary of the overlap group, in event-index order. */
export interface OverlapBoundary {
  /** Event index — the segment ordering key (log order, not wall clock). */
  eventIdx: number;
  /** Checkpoint the boundary belongs to. */
  n: number;
  phase: 'open' | 'close' | 'abandon';
  /**
   * Worktree tree SHA snapshotted at this boundary, or null when the
   * snapshot was skipped/failed — segments touching a null boundary
   * degrade to claims-only (disclosed), never guessed.
   */
  treeSha: string | null;
}

/** A sibling checkpoint whose interval intersects the closing cp's. */
export interface OverlapSibling {
  n: number;
  status: 'open' | 'closed' | 'abandoned';
  /** Close-time claim; [] while open or abandoned. */
  filesChanged: string[];
}

export interface WindowOverlapContext {
  currentN: number;
  /** Event index of the current cp's checkpoint_opened event. */
  currentOpenIdx: number;
  /**
   * The current close's virtual event index (`events.length` — the close
   * event is not appended yet). The current cp's close boundary tree is
   * supplied by the close callback, which snapshots it in-lock.
   */
  currentCloseIdx: number;
  /** Intersecting siblings, ascending open order. */
  siblings: OverlapSibling[];
  /**
   * Ordered boundaries of the group (current cp's open + every sibling's
   * open and, when finalized, close/abandon). The current cp's own close
   * is NOT here — it is the newest boundary and its tree exists only
   * after the callback's snapshot; the callback appends it.
   */
  boundaries: OverlapBoundary[];
}

/**
 * Detect whether the checkpoint being closed overlapped any sibling
 * interval in the same artifact's event log, and if so return the full
 * partition context. Returns null when no interval intersects — the
 * close path then behaves byte-identically to a non-overlapping close.
 *
 * Overlap predicate is EXACTLY the hwm concurrency guard's: intervals
 * intersect when `currentOpenIdx <= otherEnd && other.openIdx <=
 * currentCloseIdx`, with a still-open sibling treated as open-ended.
 */
export function detectWindowOverlap(
  events: readonly WindowScanEvent[],
  currentN: number,
  currentOpenIdx: number
): WindowOverlapContext | null {
  const byN = scanCheckpointIntervals(events);
  const currentCloseIdx = events.length;

  const siblings: CpIntervalScan[] = [];
  for (const iv of byN.values()) {
    if (iv.n === currentN) continue;
    const otherEnd = iv.endIdx ?? Number.POSITIVE_INFINITY;
    if (currentOpenIdx <= otherEnd && iv.openIdx <= currentCloseIdx) {
      siblings.push(iv);
    }
  }
  if (siblings.length === 0) return null;
  siblings.sort((a, b) => a.openIdx - b.openIdx);

  const boundaries: OverlapBoundary[] = [];
  const current = byN.get(currentN);
  boundaries.push({
    eventIdx: currentOpenIdx,
    n: currentN,
    phase: 'open',
    treeSha: current?.openTreeSha ?? null,
  });
  for (const s of siblings) {
    boundaries.push({ eventIdx: s.openIdx, n: s.n, phase: 'open', treeSha: s.openTreeSha });
    if (s.endIdx !== null) {
      boundaries.push({
        eventIdx: s.endIdx,
        n: s.n,
        phase: s.status === 'abandoned' ? 'abandon' : 'close',
        treeSha: s.terminalTreeSha,
      });
    }
  }
  boundaries.sort((a, b) => a.eventIdx - b.eventIdx);

  return {
    currentN,
    currentOpenIdx,
    currentCloseIdx,
    siblings: siblings.map((s) => ({
      n: s.n,
      status: s.status,
      filesChanged: [...s.filesChanged],
    })),
    boundaries,
  };
}
