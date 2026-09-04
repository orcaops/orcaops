import { stat } from 'node:fs/promises';

import { assertResolvedWithin, loadEventsWithPayloads, readEventLog } from '@orcaops/storage';

/** Summed diff line-counts for one checkpoint (from its close manifest hunks). */
export interface DiffStat {
  added: number;
  removed: number;
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  byCpN: Map<number, DiffStat>;
}

interface ClosedFingerprintPayload {
  n?: number;
  diff_fingerprint_manifest?: {
    hunks?: Array<{ added_line_count?: number; deleted_line_count?: number }>;
  };
}

/**
 * Reads per-checkpoint diff line-counts by summing each `checkpoint_closed`
 * event's diff-fingerprint manifest hunks (`added_line_count` / `deleted_line_count`).
 * Line tallies live ONLY in the event-log manifest (never in sqlite), so a full
 * `readEventLog` (checksum + sidecar verification) is required — hence the cache
 * by (path, size, mtime_ms): an unchanged log costs zero reads, and the engine
 * keeps one reader across ticks. A closed cp whose manifest is absent (skipped
 * capture, or a corrupt sidecar dropped by readEventLog) is simply omitted from
 * the map, so the snapshot leaves its counts null ("unknown", not zero).
 */
export class DiffStatReader {
  private readonly cache = new Map<string, CacheEntry>();

  async read(
    eventsPath: string,
    sidecarsDir: string,
    containmentRoot?: string,
    failOnReadError = false
  ): Promise<Map<number, DiffStat>> {
    let size: number;
    let mtimeMs: number;
    try {
      const statPath =
        containmentRoot === undefined
          ? eventsPath
          : assertResolvedWithin(eventsPath, containmentRoot, 'watch event log', {
              rejectSymlinks: true,
            });
      const st = await stat(statPath);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch (error) {
      if (failOnReadError && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return new Map(); // absent — sibling-worktree row whose log lives elsewhere, or not yet written
    }
    // Keyed by BOTH inputs read() consumes: the same log resolved against a
    // different sidecar root is a different result (spilled payloads live in
    // the sidecars). NUL cannot appear in a filesystem path.
    const key = `${eventsPath}\u0000${sidecarsDir}\u0000${containmentRoot ?? ''}`;
    const cached = this.cache.get(key);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
      return cached.byCpN;
    }
    const byCpN = await computeDiffStats(eventsPath, sidecarsDir, containmentRoot, failOnReadError);
    this.cache.set(key, { size, mtimeMs, byCpN });
    return byCpN;
  }
}

async function computeDiffStats(
  eventsPath: string,
  sidecarsDir: string,
  containmentRoot?: string,
  failOnReadError = false
): Promise<Map<number, DiffStat>> {
  const byCpN = new Map<number, DiffStat>();
  let loaded;
  try {
    const { events } = await readEventLog({
      eventLogPath: eventsPath,
      sidecarsDir,
      containmentRoot,
    });
    loaded = await loadEventsWithPayloads(events, { sidecarsDir, containmentRoot });
  } catch (error) {
    if (failOnReadError && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return byCpN; // torn/corrupt log — degrade to "unknown" for every cp
  }
  for (const { record, payload } of loaded) {
    if (record.type !== 'checkpoint_closed') continue;
    const p = payload as ClosedFingerprintPayload;
    if (typeof p.n !== 'number') continue;
    const hunks = p.diff_fingerprint_manifest?.hunks;
    if (!Array.isArray(hunks)) continue; // no manifest → leave this cp null
    let added = 0;
    let removed = 0;
    for (const h of hunks) {
      added += typeof h.added_line_count === 'number' ? h.added_line_count : 0;
      removed += typeof h.deleted_line_count === 'number' ? h.deleted_line_count : 0;
    }
    // Last close for a given n wins (a re-closed cp appends a fresh event).
    byCpN.set(p.n, { added, removed });
  }
  return byCpN;
}
