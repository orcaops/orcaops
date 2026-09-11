import {
  captureWorktreeTreeSha,
  diffSnapshotTrees,
  matchDiffAgainstManifests,
} from '@orcaops/core';
import { HistoryScopeError, validateHistorySelector } from '@orcaops/project-scope/history';
import {
  collectDatabaseHistory,
  resolveDatabaseHistoryOverview,
} from '@orcaops/project-scope/history/database';
import type { ArtifactThread, Config } from '@orcaops/storage';
import { resolveCaptureExcludes } from '@orcaops/storage';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import {
  collectBranchHistory,
  type HistoryHydrationFailure,
  historyRepository,
  type HydratedHistoryThread,
  hydrateHistoryThreads,
  inFlightEntries,
  liveEntries,
  requireRepositoryScope,
} from './database-branch-history.js';
import type { resolveDatabaseHistoryCommandContext } from './database-history-context.js';
import {
  type DatabaseManifestSourcingResult,
  loadDatabaseManifestSources,
  readDatabaseOverlapSupport,
} from './database-manifest-sources.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

export interface DatabaseDiffOptions {
  attribution?: boolean;
  reconcile?: boolean;
  base?: string;
  target?: string;
  artifact?: string;
  project?: string;
  unattributed?: boolean;
  json?: boolean;
}

const DIFF_KEYS = [
  'attribution',
  'reconcile',
  'base',
  'target',
  'artifact',
  'project',
  'unattributed',
  'json',
] as const;

export function validateDatabaseDiff(raw: DatabaseDiffOptions = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new HistoryScopeError('INVALID_INPUT', 'Provide diff options as an object');
  const options = { ...raw };
  for (const key of Object.keys(options))
    if (!(DIFF_KEYS as readonly string[]).includes(key))
      throw new OrcaopsError(ErrorCodes.INVALID_INPUT, `Unsupported diff option "${key}"`, key);
  if (options.artifact !== undefined && !/^[0-9a-f-]{1,36}$/iu.test(options.artifact))
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'Provide an artifact UUID or hexadecimal prefix',
      'artifact'
    );
  const selector = { projectId: options.project };
  validateHistorySelector({ profile: 'git-history', selector });
  return { options, selector } as const;
}

export type DiffContext = Awaited<ReturnType<typeof resolveDatabaseHistoryCommandContext>>;

/** The reads below need the opened scope and nothing else from the context. */
type ScopedDiffContext = Pick<DiffContext, 'scope'>;

/** One artifact the diff can anchor a base or a manifest pool on. */
export interface DiffArtifact {
  id: string;
  base_sha: string;
  thread: ArtifactThread;
}

function toDiffArtifact(entry: HydratedHistoryThread): DiffArtifact {
  return {
    id: entry.artifactId,
    base_sha: entry.thread.plan?.base_sha ?? '',
    thread: entry.thread,
  };
}

export function readDiffArtifact(context: ScopedDiffContext, requested: string): DiffArtifact {
  const target = resolveDatabaseHistoryOverview(context.scope, requested);
  return {
    id: target.artifactId,
    base_sha: target.artifact.thread.plan?.base_sha ?? '',
    thread: target.artifact.thread,
  };
}

/**
 * Every artifact recorded on the branch, hydrated one at a time so a single
 * unreadable artifact is disclosed by id instead of hiding the rest. Imported
 * artifacts participate: attribution is a provenance surface, and without their
 * manifests a seeded project answers `none` for history it holds.
 */
export function readBranchDiffArtifacts(
  context: ScopedDiffContext,
  branch: string
): { artifacts: DiffArtifact[]; skipped: HistoryHydrationFailure[] } {
  const entries = collectBranchHistory(context.scope, { branch, profile: 'versions' }).entries;
  const { threads, skipped } = hydrateHistoryThreads(context.scope, entries, 'skip');
  return { artifacts: threads.map(toDiffArtifact), skipped };
}

/**
 * Every artifact recorded in the project, hydrated one at a time. A commit can carry
 * work from any branch's artifacts, so an attribution pool over one commit must not be
 * branch-scoped.
 */
export function readProjectDiffArtifacts(context: ScopedDiffContext): {
  artifacts: DiffArtifact[];
  skipped: HistoryHydrationFailure[];
} {
  const entries = collectDatabaseHistory(
    context.scope,
    { limit: undefined, offset: 0 },
    'versions'
  ).entries;
  const { threads, skipped } = hydrateHistoryThreads(context.scope, entries, 'skip');
  return { artifacts: threads.map(toDiffArtifact), skipped };
}

/**
 * The implicit base owner: the newest in-flight artifact on the branch, else the
 * newest artifact captured live. An imported artifact is always summarized and
 * backdated, so it can never become the implicit base for live work.
 */
export function readDefaultDiffArtifact(
  context: ScopedDiffContext,
  branch: string
): { artifact: DiffArtifact; source: 'active_artifact' | 'recent_artifact' } | null {
  const entries = collectBranchHistory(context.scope, { branch, profile: 'versions' }).entries;
  const inFlight = inFlightEntries(entries);
  const pool = inFlight.length > 0 ? inFlight : liveEntries(entries);
  if (pool.length === 0) return null;
  const { threads } = hydrateHistoryThreads(context.scope, [pool[0]]);
  return {
    artifact: toDiffArtifact(threads[0]),
    source: inFlight.length > 0 ? 'active_artifact' : 'recent_artifact',
  };
}

export interface DiffManifestPool extends DatabaseManifestSourcingResult {
  skippedUnreadableArtifacts: string[];
}

export async function loadDiffManifests(
  context: ScopedDiffContext,
  artifacts: readonly DiffArtifact[],
  skipped: readonly HistoryHydrationFailure[]
): Promise<DiffManifestPool> {
  const { database } = requireRepositoryScope(context.scope);
  const threads = artifacts.map((artifact) => artifact.thread);
  const support = readDatabaseOverlapSupport(database, threads);
  return {
    ...(await loadDatabaseManifestSources(threads, support)),
    skippedUnreadableArtifacts: [...new Set(skipped.map((entry) => entry.artifact_id))].sort(),
  };
}

export function requireDiffBase(artifact: DiffArtifact): string {
  if (artifact.base_sha.length === 0)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      `Artifact ${artifact.id} has no recorded base_sha`
    );
  return artifact.base_sha;
}

/**
 * Why the attributed-change hint could not be measured. Every arm is a state the
 * legacy command answered with a bare `null`; naming it keeps a null value from
 * reading as "nothing of this branch is attributed".
 */
export type DiffAttributionUnavailable =
  | 'NOT_MEASURED'
  | 'REPOSITORY_UNAVAILABLE'
  | 'ARTIFACT_BASE_UNAVAILABLE'
  | 'WORKTREE_TREE_UNAVAILABLE'
  | 'UNMERGED_INDEX'
  | 'DIFF_UNAVAILABLE'
  | 'MANIFEST_POOL_INCOMPLETE'
  | 'NO_MANIFEST_SOURCES'
  | 'MEASUREMENT_FAILED';

export type DiffAttributionOutcome =
  | { state: 'measured'; attributed_pct: number | null }
  | { state: 'unavailable'; reason: DiffAttributionUnavailable; message: string };

/** What a caller that did not measure reports: honest about the absence, never a number. */
export const DIFF_ATTRIBUTION_NOT_MEASURED: DiffAttributionOutcome = {
  state: 'unavailable',
  reason: 'NOT_MEASURED',
  message: 'This read did not measure diff attribution',
};

export interface DiffAttributionContext extends ScopedDiffContext {
  config: Pick<Config, 'capture' | 'diff_fingerprint'>;
}

function unmeasured(reason: DiffAttributionUnavailable, cause: unknown): DiffAttributionOutcome {
  return {
    state: 'unavailable',
    reason,
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

/**
 * The attributed-change hint: how much of the current branch's latest artifact
 * window (its `base_sha` against the live worktree, untracked files included) an
 * unambiguous hunk match accounts for.
 *
 * It runs the same pipeline as live `orcaops diff --attribution` — the shared
 * `captureWorktreeTreeSha` (temp index, untracked included, tree-only), the same
 * byte-capped tree diff and the same exact matcher over the branch's manifest
 * pool — so the two surfaces can never disagree about what is attributed. The
 * capture writes unreferenced Git tree objects and leaves the real index and
 * every ref untouched.
 *
 * It differs from the command in its failure policy only: this is a HYGIENE
 * HINT, so every failure answers a reason rather than refusing, and a
 * cancellation still propagates.
 */
export async function measureDiffAttribution(
  context: DiffAttributionContext
): Promise<DiffAttributionOutcome> {
  let worktreeRoot: string;
  try {
    worktreeRoot = requireRepositoryScope(context.scope).git.worktreeRoot;
  } catch (cause) {
    return unmeasured('REPOSITORY_UNAVAILABLE', cause);
  }
  try {
    const repo = historyRepository(worktreeRoot);
    const branch = await repo.getCurrentBranch();
    const owner = readDefaultDiffArtifact(context, branch);
    if (owner === null || owner.artifact.base_sha.length === 0)
      return {
        state: 'unavailable',
        reason: 'ARTIFACT_BASE_UNAVAILABLE',
        message: `No artifact on branch "${branch}" records a base_sha to measure against`,
      };
    const live = await captureWorktreeTreeSha(repo, {
      excludePatterns: resolveCaptureExcludes(context.config.capture).patterns,
    });
    if (!live.ok)
      return {
        state: 'unavailable',
        reason: 'WORKTREE_TREE_UNAVAILABLE',
        message: `Could not capture the live worktree tree (reason: ${live.error_reason})`,
      };
    // A conflicted worktree stays unmeasured: marker hunks would silently dip a
    // scalar hint that has nowhere to disclose why they are there.
    if (live.unmerged_paths.length > 0)
      return {
        state: 'unavailable',
        reason: 'UNMERGED_INDEX',
        message: `${live.unmerged_paths.length} unmerged path(s) in the index`,
      };
    const maxDiffBytes = context.config.diff_fingerprint.max_diff_bytes;
    const diff = await diffSnapshotTrees({
      repo,
      openTreeSha: owner.artifact.base_sha,
      closeTreeSha: live.tree_sha,
      maxDiffBytes,
    });
    if (!diff.ok)
      return {
        state: 'unavailable',
        reason: 'DIFF_UNAVAILABLE',
        message: `Could not diff ${owner.artifact.base_sha.slice(0, 12)} against the live worktree`,
      };
    const pool = readBranchDiffArtifacts(context, branch);
    const { sources, skippedUnreadableArtifacts } = await loadDiffManifests(
      context,
      pool.artifacts,
      pool.skipped
    );
    // FAIL CLOSED, exactly as the command does: a skip-reduced pool would
    // attribute a hunk two artifacts both claimed confidently to the one that
    // still reads, so a smaller pool can only answer "unmeasured".
    if (skippedUnreadableArtifacts.length > 0)
      return {
        state: 'unavailable',
        reason: 'MANIFEST_POOL_INCOMPLETE',
        message: `Artifact(s) ${skippedUnreadableArtifacts.join(', ')} could not be read, so the ambiguity pool is incomplete`,
      };
    if (sources.length === 0)
      return {
        state: 'unavailable',
        reason: 'NO_MANIFEST_SOURCES',
        message: 'No closed checkpoint on this branch carries a manifest to match against',
      };
    const matched = await matchDiffAgainstManifests({
      diffBytes: diff.diff,
      truncated: diff.truncated,
      maxDiffBytes,
      sources,
    });
    return { state: 'measured', attributed_pct: matched.coverage.attributed_pct };
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError && cause.code === 'CANCELLED') throw cause;
    return unmeasured('MEASUREMENT_FAILED', cause);
  }
}
