import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  assertResolvedWithin,
  assertSafePathSegment,
  assertSafeRelativePath,
  PathContainmentError,
} from '../paths/containment.js';
import type { Config } from '../schema/config.js';

export interface ArtifactPaths {
  /** Directory for this artifact's files. */
  dir: string;
  /** Artifact-level metadata projection (state, lineage, counters, source_event_id). */
  artifactJson: string;
  /** Append-only event log (one record per line, per-line SHA-256 checksum). */
  eventsNdjson: string;
  /** Directory holding oversized event payloads. */
  sidecarsDir: string;
  /** Plan files. */
  planMd: string;
  planJson: string;
  /** Per-checkpoint files (use checkpointMd(n) / checkpointJson(n)). */
  checkpointMd: (n: number) => string;
  checkpointJson: (n: number) => string;
  /** Evaluator log (single file, append-only). */
  evaluatorsJson: string;
  /** Summary files. */
  summaryMd: string;
  summaryJson: string;
  /** Cached digest (regenerable). */
  digestMd: string;
  /** Cached resume handoff (regenerable). */
  resumeMd: string;
  /**
   * Digest staleness sidecar: records the artifact `source_event_id` the
   * cached digest was built from. Compared against the live
   * `source_event_id` to tell whether the digest is current (no mtimes).
   */
  digestMeta: string;
  /** The artifact id these paths were resolved for (archive-mirror hooks key on it). */
  artifactId: string;
}

/**
 * Resolve filesystem paths for an artifact.
 *
 * **Flat layout:** `<repoRoot>/.orcaops/artifacts/<artifactId>/`.
 * Branch is metadata in `artifact.json.branch_lineage`, not part of the
 * filesystem path. UUIDv7's lexicographic order = chronological order,
 * so a flat directory still sorts naturally.
 */
export function artifactPathsFor(
  repoRoot: string,
  config: Pick<Config, 'artifacts'>,
  artifactId: string
): ArtifactPaths {
  // The shared sink for every artifact-id → path construction (CLI input,
  // event records, SQLite rows, directory scans all pass through here);
  // segment safety here is what keeps a poisoned stored id from directing
  // reads, writes, or deleteArtifact's recursive rm outside the tree.
  assertSafePathSegment(artifactId, 'artifact id');
  const root = artifactsRoot(repoRoot, config);
  const dir = assertResolvedWithin(
    path.join(root, artifactId),
    repoRoot,
    `artifact path for ${artifactId}`,
    { rejectSymlinks: true }
  );
  const contained = (target: string, label: string): string =>
    assertResolvedWithin(target, repoRoot, label, { rejectSymlinks: true });
  return {
    dir,
    get artifactJson() {
      return contained(path.join(dir, 'artifact.json'), 'artifact.json path');
    },
    get eventsNdjson() {
      return contained(path.join(dir, 'events.ndjson'), 'events.ndjson path');
    },
    get sidecarsDir() {
      return contained(path.join(dir, 'sidecars'), 'event sidecars path');
    },
    get planMd() {
      return contained(path.join(dir, 'plan.md'), 'plan.md path');
    },
    get planJson() {
      return contained(path.join(dir, 'plan.json'), 'plan.json path');
    },
    checkpointMd: (n: number) =>
      contained(path.join(dir, `checkpoint-${n}.md`), `checkpoint-${n}.md path`),
    checkpointJson: (n: number) =>
      contained(path.join(dir, `checkpoint-${n}.json`), `checkpoint-${n}.json path`),
    get evaluatorsJson() {
      return contained(path.join(dir, 'evaluators.json'), 'evaluators.json path');
    },
    get summaryMd() {
      return contained(path.join(dir, 'summary.md'), 'summary.md path');
    },
    get summaryJson() {
      return contained(path.join(dir, 'summary.json'), 'summary.json path');
    },
    get digestMd() {
      return contained(path.join(dir, 'digest.md'), 'digest.md path');
    },
    get resumeMd() {
      return contained(path.join(dir, 'resume.md'), 'resume.md path');
    },
    get digestMeta() {
      return contained(path.join(dir, 'digest.meta.json'), 'digest metadata path');
    },
    artifactId,
  };
}

export function artifactsRoot(repoRoot: string, config: Pick<Config, 'artifacts'>): string {
  assertSafeRelativePath(config.artifacts.path, 'config artifacts.path');
  return assertResolvedWithin(
    path.join(repoRoot, config.artifacts.path),
    repoRoot,
    'config artifacts.path',
    { allowRoot: true, rejectSymlinks: true }
  );
}

/** True when the hot artifact tree contains at least one durable event log. */
export function hasArtifactEventLogs(repoRoot: string, config: Pick<Config, 'artifacts'>): boolean {
  const root = artifactsRoot(repoRoot, config);
  try {
    return readdirSync(root, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && existsSync(path.join(root, entry.name, 'events.ndjson'))
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** True when the hot artifact tree contains any directory that rebuild must account for. */
export function hasArtifactDirectories(
  repoRoot: string,
  config: Pick<Config, 'artifacts'>
): boolean {
  const root = artifactsRoot(repoRoot, config);
  try {
    return readdirSync(root, { withFileTypes: true }).some((entry) => entry.isDirectory());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * What this worktree's hot store holds, read WITHOUT opening or creating
 * anything. An enabled worktree that has never captured is a valid empty
 * source: read paths must be able to say so before an `ArtifactStore` (whose
 * constructor creates the cache) or a direct `Store` ever exists.
 */
export interface HotStateProbe {
  artifacts: boolean;
  cache: boolean;
  usage: boolean;
  /** A protected artifact deletion is parked and awaits reconciliation. */
  staged: boolean;
  /** No artifact directories, no cache file, no usage ledger, nothing staged. */
  empty: boolean;
}

export function probeHotState(
  repoRoot: string,
  config: Pick<Config, 'artifacts' | 'cache'>
): HotStateProbe {
  // A data path that fails containment (a poisoned artifacts root, a
  // symlinked cache) is not "nothing here": report it as present so the
  // strict open runs and surfaces the refusal instead of serving an empty
  // projection over unsafe state.
  try {
    const artifacts = hasArtifactDirectories(repoRoot, config);
    const cache = existsSync(cacheDbPath(repoRoot, config));
    const usage = existsSync(usageLedgerPath(repoRoot));
    const staged = existsSync(artifactDeletionStagingRoot(repoRoot));
    return { artifacts, cache, usage, staged, empty: !artifacts && !cache && !usage && !staged };
  } catch (err) {
    if (err instanceof PathContainmentError) {
      return { artifacts: true, cache: true, usage: false, staged: false, empty: false };
    }
    throw err;
  }
}

/** `<repoRoot>/.orcaops/tmp/artifact-deletions` — where protected deletions are parked. */
export function artifactDeletionStagingRoot(repoRoot: string): string {
  return path.join(repoRoot, '.orcaops', 'tmp', 'artifact-deletions');
}

/** True when a fresh SQLite projection must inspect surviving durable state. */
export function hasDurableCacheSources(
  repoRoot: string,
  config: Pick<Config, 'artifacts'>
): boolean {
  try {
    if (hasArtifactDirectories(repoRoot, config)) return true;
  } catch (err) {
    if (!(err instanceof PathContainmentError)) throw err;
  }
  try {
    return existsSync(usageLedgerPath(repoRoot));
  } catch (err) {
    if (!(err instanceof PathContainmentError)) throw err;
    // Durable-source discovery is a non-authoritative construction probe.
    // Strict artifact and usage operations retain their own containment refusals.
    return false;
  }
}

export function cacheDbPath(repoRoot: string, config: Pick<Config, 'cache'>): string {
  assertSafeRelativePath(config.cache.path, 'config cache.path');
  return assertResolvedWithin(
    path.join(repoRoot, config.cache.path),
    repoRoot,
    'config cache.path',
    { rejectSymlinks: true }
  );
}

/** Per-artifact lockdir parent — `<repoRoot>/.orcaops/tmp/locks/`. */
export function locksDir(repoRoot: string): string {
  return assertResolvedWithin(
    path.join(repoRoot, '.orcaops', 'tmp', 'locks'),
    repoRoot,
    'artifact locks path',
    { rejectSymlinks: true }
  );
}

/**
 * Repo-level usage ledger ndjson — `<repoRoot>/.orcaops/usage/ledger.ndjson`.
 * Distinct from per-artifact `events.ndjson`: usage is session-derived state
 * that can predate any artifact, so it lives at the repo root, not under an
 * artifact dir.
 */
export function usageLedgerPath(repoRoot: string): string {
  return assertResolvedWithin(
    path.join(repoRoot, '.orcaops', 'usage', 'ledger.ndjson'),
    repoRoot,
    'usage ledger path',
    { rejectSymlinks: true }
  );
}

/** Usage ledger oversized-payload sidecars — `<repoRoot>/.orcaops/usage/sidecars/`. */
export function usageSidecarsDir(repoRoot: string): string {
  return assertResolvedWithin(
    path.join(repoRoot, '.orcaops', 'usage', 'sidecars'),
    repoRoot,
    'usage sidecars path',
    { rejectSymlinks: true }
  );
}
