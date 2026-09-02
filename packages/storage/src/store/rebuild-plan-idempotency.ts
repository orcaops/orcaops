import { readdir } from 'node:fs/promises';

import type { Store } from './sqlite.js';
import { artifactPathsFor, artifactsRoot } from '../artifacts/paths.js';
import { readEventLog } from '../events/event-log.js';
import { assertSafePathSegment } from '../paths/containment.js';
import type { Config } from '../schema/config.js';

/**
 * Rebuild the `plan_idempotency` table by scanning every artifact's
 * `events.ndjson` for `plan_captured` events.
 *
 * SQLite's role is a purely derived index, so losing `store.db` is
 * never data loss — only an index rebuild on
 * next read. This helper is the rebuild path for the
 * `plan_idempotency` portion of that index, called automatically when
 * the table is missing on first read OR explicitly via
 * `orcaops doctor --rebuild-index`.
 *
 * Behavior:
 *   - Truncates the existing table first (idempotent rebuild).
 *   - Walks every artifact dir at `<repoRoot>/<artifacts.path>/<id>/`
 *     (flat layout).
 *   - For each artifact, reads its event log via `readEventLog` so
 *     corrupt entries are filtered out (the reader's checksum +
 *     sidecar verification both apply).
 *   - For each `plan_captured` event found, reinserts
 *     `(idempotency_key, artifact_id, created_at)`.
 *   - Returns counts for diagnostics.
 *
 * Conflict handling: if the same `idempotency_key` appears across
 * multiple artifacts (which would only happen via filesystem-level
 * corruption — the project-wide table prevents it at write time),
 * the first artifact wins the slot and subsequent collisions land
 * in `result.conflicts` for the caller to surface. The helper does
 * NOT silently keep one and drop the other — both artifacts remain
 * on disk; only the lookup table is one-to-one.
 */

export interface RebuildPlanIdempotencyResult {
  artifactsScanned: number;
  plansIndexed: number;
  /** Empty in normal operation; non-empty signals filesystem-level corruption. */
  conflicts: Array<{
    idempotency_key: string;
    artifact_ids: string[];
  }>;
}

export interface RebuildPlanIdempotencyOptions {
  repoRoot: string;
  config: Config;
  store: Store;
}

export async function rebuildPlanIdempotency(
  opts: RebuildPlanIdempotencyOptions
): Promise<RebuildPlanIdempotencyResult> {
  const { repoRoot, config, store } = opts;

  store.truncatePlanIdempotency();

  const result: RebuildPlanIdempotencyResult = {
    artifactsScanned: 0,
    plansIndexed: 0,
    conflicts: [],
  };

  const root = artifactsRoot(repoRoot, config);

  let artifactIds: string[];
  try {
    artifactIds = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw err;
  }

  // Coalesce same-key duplicates across multiple artifacts into one
  // conflict entry per key.
  const seenByKey = new Map<string, string[]>();

  for (const artifactId of artifactIds) {
    result.artifactsScanned += 1;
    try {
      assertSafePathSegment(artifactId, 'artifact id');
    } catch {
      continue;
    }
    const paths = artifactPathsFor(repoRoot, config, artifactId);
    const { events } = await readEventLog({
      eventLogPath: paths.eventsNdjson,
      sidecarsDir: paths.sidecarsDir,
      containmentRoot: repoRoot,
    });

    for (const ev of events) {
      if (ev.type !== 'plan_captured') continue;
      const key = ev.idempotency_key;
      const prior = seenByKey.get(key);
      if (prior !== undefined) {
        if (!prior.includes(artifactId)) prior.push(artifactId);
        continue;
      }
      seenByKey.set(key, [artifactId]);
      store.insertPlanIdempotency({
        idempotency_key: key,
        artifact_id: artifactId,
        created_at: ev.ts,
      });
      result.plansIndexed += 1;
    }
  }

  for (const [key, artifactIds] of seenByKey) {
    if (artifactIds.length > 1) {
      result.conflicts.push({ idempotency_key: key, artifact_ids: artifactIds });
    }
  }

  return result;
}
