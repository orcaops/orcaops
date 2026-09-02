import { readdir, readFile } from 'node:fs/promises';

import type { Store } from './sqlite.js';
import { artifactPathsFor, artifactsRoot } from '../artifacts/paths.js';
import { assertSafePathSegment } from '../paths/containment.js';
import { ArtifactJsonSchema } from '../schema/artifact-json.js';
import type { Config } from '../schema/config.js';

/**
 * Rebuild the lineage indexes by scanning every artifact.json on disk.
 *
 * Two derived tables are repopulated together because they share a
 * source (artifact.json) and a scan loop:
 *
 *   - `lineage_by_latest_sha` — one row per artifact, keyed on the
 *     tail entry's SHA. Backs `orcaops lineage`'s O(matches) rebase
 *     lookup. A 200-artifact / <500 ms sync benchmark is the
 *     forcing function.
 *   - `lineage_branches` — many rows per artifact, one per
 *     `branch_lineage[].branch`. Backs the strict-membership filter
 *     for `list` / `status` / `show` ("artifact belongs to branch X
 *     iff any lineage entry has branch == X").
 *
 * Behavior:
 *   - Truncates both tables first (idempotent rebuild).
 *   - Walks every dir under `<repoRoot>/<artifacts.path>/<id>/`.
 *   - Reads `artifact.json` (only — projections aren't needed),
 *     upserts the tail into `lineage_by_latest_sha`, and one row
 *     per lineage entry into `lineage_branches`.
 *   - Skips directories without a parseable artifact.json
 *     (transitional in-flight state, rare).
 *   - Returns counts for diagnostics.
 */

export interface RebuildLineageIndexResult {
  artifactsScanned: number;
  /** Rows written into `lineage_by_latest_sha` (one per indexed artifact). */
  rowsIndexed: number;
  /** Rows written into `lineage_branches` (one per (artifact, branch) pair). */
  branchRowsIndexed: number;
  /** Artifact IDs whose artifact.json was missing or unreadable. */
  skipped: string[];
}

export interface RebuildLineageIndexOptions {
  repoRoot: string;
  config: Config;
  store: Store;
}

export async function rebuildLineageIndex(
  opts: RebuildLineageIndexOptions
): Promise<RebuildLineageIndexResult> {
  const { repoRoot, config, store } = opts;

  store.truncateLineageByLatestSha();
  store.truncateLineageBranches();

  const result: RebuildLineageIndexResult = {
    artifactsScanned: 0,
    rowsIndexed: 0,
    branchRowsIndexed: 0,
    skipped: [],
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

  for (const artifactId of artifactIds) {
    result.artifactsScanned += 1;
    try {
      assertSafePathSegment(artifactId, 'artifact id');
    } catch {
      result.skipped.push(artifactId);
      continue;
    }
    const artifactJsonPath = artifactPathsFor(repoRoot, config, artifactId).artifactJson;
    let raw: string;
    try {
      raw = await readFile(artifactJsonPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        result.skipped.push(artifactId);
        continue;
      }
      throw err;
    }
    let json;
    try {
      json = ArtifactJsonSchema.parse(JSON.parse(raw));
    } catch {
      result.skipped.push(artifactId);
      continue;
    }
    const tail = json.branch_lineage[json.branch_lineage.length - 1];
    if (!tail) {
      result.skipped.push(artifactId);
      continue;
    }
    store.upsertLineageByLatestSha({
      artifact_id: json.id,
      latest_lineage_sha: tail.head_sha,
      branch_name: tail.branch,
    });
    result.rowsIndexed += 1;
    for (const entry of json.branch_lineage) {
      store.upsertLineageBranch({
        artifact_id: json.id,
        branch_name: entry.branch,
      });
      result.branchRowsIndexed += 1;
    }
  }

  return result;
}
