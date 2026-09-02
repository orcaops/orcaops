import type { Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  type ArtifactJson,
  artifactPathsFor,
  type ArtifactState,
  type ArtifactStore,
  assertResolvedWithin,
  inspectArchivedArtifactAvailability,
  listPinsForRepo,
  type Pin,
  pinFilePath,
  pinIdentity,
  unslugifyBranch,
} from '@orcaops/storage';

import type { Repo } from '../git/repo.js';

/**
 * Garbage-collection scanner. Pure read; produces a set of candidate
 * artifacts / pins per category. The CLI (`orcaops gc`) renders the
 * dry-run report from these and, on `--apply`, deletes them.
 *
 * Categories:
 *
 * - `stale_pins`: pin files whose target artifact is missing or
 *   summarized. The picker treats these as stale; gc removes the pin
 *   file outright.
 *
 * - `unreachable_nonterminal_artifacts`: planned, active, or blocked
 *   artifacts whose latest lineage SHA isn't reachable from any local
 *   branch tip. These are reported for diagnosis and are never deletion
 *   candidates.
 *
 * - `abandoned_summarized`: summarized artifacts whose lineage SHAs
 *   are all unreachable from local branches AND whose `summarized_at`
 *   is older than `retentionDays`. The category models artifacts whose
 *   branch lineage is fully merged, or whose lineage branches have all
 *   been deleted for longer than the retention window. Local-branch
 *   reachability proxies for both ("merged into
 *   the default branch" => the branch tip the artifact knows about
 *   is no longer the artifact's recorded SHA, but the SHA is
 *   reachable from a tip; "deleted" => the SHA is unreachable).
 *   Retention adds the safety window.
 *
 * - `stale_review_dirs`: `.orcaops/reviews/<branch-slug>/` dirs whose
 *   branch is gone (deleted locally) or merged into the default branch,
 *   AND whose most-recent mtime is older than `retentionDays`. The dir
 *   caches a derivable review floor; gc removes it plus its two pinned
 *   refs (`refs/orcaops/review/<slug>[-base]`), which exist solely to
 *   keep that dir's floor trees readable. The current branch's dir is
 *   never stale (you're standing on it).
 */
export interface PinCandidate {
  pin_file: string;
  artifact_id: string;
  shell_key: Pin['shell_key'];
  reason: 'artifact-missing' | 'artifact-summarized';
  /** Exact identity re-read under the pin lock before deletion. */
  pin_identity: string;
}

export interface GcStorageUncertainty {
  operation:
    | 'hot_artifact_presence'
    | 'archive_artifact_inspection'
    | 'artifact_state_inspection'
    | 'review_state_inspection';
  subject: string;
  reason: string;
}

export interface ArtifactCandidate {
  artifact_id: string;
  task: string;
  branch: string;
  state: ArtifactState;
  /** When non-null, the artifact's `summary.ts` (used for retention math). */
  summarized_at: string | null;
}

export interface ReviewDirCandidate {
  slug: string;
  branch: string;
  /** Absolute path to `.orcaops/reviews/<slug>/`. */
  dir: string;
  reason: 'branch_deleted' | 'branch_merged';
  /** Max mtime over the dir's files, ISO-8601 (used for retention math). */
  last_modified: string;
}

export type GcGitOperation =
  | 'branch_tip_enumeration'
  | 'artifact_lineage_resolution'
  | 'artifact_reachability'
  | 'current_branch'
  | 'default_branch_resolution'
  | 'review_branch_presence'
  | 'review_branch_tip'
  | 'review_branch_reachability'
  | 'snapshot_ref_enumeration'
  | 'baseline_ref_enumeration'
  | 'review_ref_enumeration';

export interface GcGitUncertainty {
  operation: GcGitOperation;
  /** Artifact id, ref, or branch whose Git state could not be proven. */
  subject: string;
}

export interface GcCandidates {
  stale_pins: PinCandidate[];
  /** Report-only. Ordinary gc never deletes nonterminal artifacts. */
  unreachable_nonterminal_artifacts: ArtifactCandidate[];
  abandoned_summarized: ArtifactCandidate[];
  stale_review_dirs: ReviewDirCandidate[];
  /** Any entry makes the complete candidate set unsafe to apply. */
  git_uncertainties: GcGitUncertainty[];
  /** Omitted when no durable-store uncertainty affected classification. */
  storage_uncertainties?: GcStorageUncertainty[];
}

/** Exact destructive candidate comparison, independent of scan ordering. */
export function gcCandidateSetsEqual(left: GcCandidates, right: GcCandidates): boolean {
  const canonicalize = <T>(items: T[]): string[] =>
    items.map((item) => JSON.stringify(item)).sort((a, b) => a.localeCompare(b));

  return (
    JSON.stringify(canonicalize(left.stale_pins)) ===
      JSON.stringify(canonicalize(right.stale_pins)) &&
    JSON.stringify(canonicalize(left.abandoned_summarized)) ===
      JSON.stringify(canonicalize(right.abandoned_summarized)) &&
    JSON.stringify(canonicalize(left.stale_review_dirs)) ===
      JSON.stringify(canonicalize(right.stale_review_dirs)) &&
    JSON.stringify(canonicalize(left.storage_uncertainties ?? [])) ===
      JSON.stringify(canonicalize(right.storage_uncertainties ?? []))
  );
}

export interface ScanGcOptions {
  store: ArtifactStore;
  repo: Repo;
  /**
   * Pin store identifier: the repo's minted project id, or null when the repo
   * has no identity yet — nothing can be pinned, so the pin sweep is skipped
   * rather than minting one from a read-only scan.
   */
  pinRepoId: string | null;
  /**
   * Days a candidate must sit before gc collects it. Applies to
   * `abandoned_summarized` (from `summarized_at`) and `stale_review_dirs`
   * (from the dir's most-recent mtime). Structural checks ignore it.
   */
  retentionDays: number;
  /** Override `Date.now()` for tests. */
  now?: () => number;
  /**
   * Env override for pin-storage XDG_STATE_HOME resolution. Defaults
   * to `process.env`. The CLI threads its invocation-context env here
   * so in-process tests see per-call pin paths.
   */
  env?: NodeJS.ProcessEnv;
  /** Whether archive-resident artifacts are part of the current pin contract. */
  archiveEnabled?: boolean;
  /** Resolved project archive directory; null when enabled setup was unavailable. */
  archiveProjectDir?: string | null;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export async function scanGcCandidates(opts: ScanGcOptions): Promise<GcCandidates> {
  const now = opts.now ? opts.now() : Date.now();
  const cutoffMs = now - opts.retentionDays * ONE_DAY_MS;
  const gitUncertainties: GcGitUncertainty[] = [];

  // Pre-compute branch tip set once — every artifact reachability
  // check uses it.
  const tipState = await opts.repo.listLocalBranchTipsState();
  const tips = tipState.status === 'known' ? tipState.tips : null;
  if (tipState.status === 'unknown') {
    gitUncertainties.push({ operation: 'branch_tip_enumeration', subject: 'refs/heads' });
  }

  const { candidates: stalePins, uncertainties: storageUncertainties } = await scanStalePins(opts);
  const { nonterminal, abandoned } =
    tips === null
      ? { nonterminal: [], abandoned: [] }
      : await scanArtifacts(opts, tips, cutoffMs, gitUncertainties, storageUncertainties);
  const staleReviews = await scanStaleReviewDirs(opts, cutoffMs, gitUncertainties);
  storageUncertainties.push(...staleReviews.uncertainties);
  const uniqueStorageUncertainties = [
    ...new Map(
      storageUncertainties.map((uncertainty) => [JSON.stringify(uncertainty), uncertainty])
    ).values(),
  ];

  return {
    stale_pins: stalePins,
    unreachable_nonterminal_artifacts: nonterminal,
    abandoned_summarized: abandoned,
    stale_review_dirs: staleReviews.candidates,
    git_uncertainties: gitUncertainties,
    ...(uniqueStorageUncertainties.length > 0
      ? { storage_uncertainties: uniqueStorageUncertainties }
      : {}),
  };
}

async function scanStalePins(opts: ScanGcOptions): Promise<{
  candidates: PinCandidate[];
  uncertainties: GcStorageUncertainty[];
}> {
  const repoId = opts.pinRepoId;
  if (repoId === null) return { candidates: [], uncertainties: [] };
  const pins = await listPinsForRepo({ repoId, env: opts.env });
  const candidates: PinCandidate[] = [];
  const uncertainties: GcStorageUncertainty[] = [];
  for (const pin of pins) {
    const result = await scanPinGcCandidate(pin, opts);
    if (result.candidate) candidates.push(result.candidate);
    uncertainties.push(...result.uncertainties);
  }
  return { candidates, uncertainties };
}

/** Revalidate one already-read pin while its caller holds the shared pin lock. */
export async function scanPinGcCandidate(
  pin: Pin,
  opts: ScanGcOptions
): Promise<{ candidate: PinCandidate | null; uncertainties: GcStorageUncertainty[] }> {
  // A repo with no minted identity has no pin store, so a pin cannot exist to
  // collect; the null-identity case is a no-candidate, never a throw.
  const repoId = opts.pinRepoId;
  if (repoId === null) return { candidate: null, uncertainties: [] };
  const uncertainties: GcStorageUncertainty[] = [];
  const reason = await classifyPinTarget(pin, opts, uncertainties);
  return {
    candidate:
      reason === null
        ? null
        : {
            pin_file: pinFilePath(repoId, pin.shell_key, opts.env),
            artifact_id: pin.artifact_id,
            shell_key: pin.shell_key,
            reason,
            pin_identity: pinIdentity(pin),
          },
    uncertainties,
  };
}

async function classifyPinTarget(
  pin: Pin,
  opts: ScanGcOptions,
  uncertainties: GcStorageUncertainty[]
): Promise<PinCandidate['reason'] | null> {
  const row = opts.store.store.getArtifact(pin.artifact_id);
  if (!row) {
    let hotPath: string;
    try {
      hotPath = artifactPathsFor(opts.store.repoRoot, opts.store.config, pin.artifact_id).dir;
      await lstat(hotPath);
      uncertainties.push({
        operation: 'hot_artifact_presence',
        subject: pin.artifact_id,
        reason: 'durable hot-store bytes exist without a certified SQLite row',
      });
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        uncertainties.push({
          operation: 'hot_artifact_presence',
          subject: pin.artifact_id,
          reason: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }

    if (opts.archiveEnabled === true) {
      if (!opts.archiveProjectDir) {
        uncertainties.push({
          operation: 'archive_artifact_inspection',
          subject: pin.artifact_id,
          reason: 'archive is enabled but its project directory is unavailable',
        });
        return null;
      }
      const archived = await inspectArchivedArtifactAvailability(
        opts.archiveProjectDir,
        pin.artifact_id
      );
      if (archived.kind === 'in_flight') return null;
      if (archived.kind === 'summarized') return 'artifact-summarized';
      if (archived.kind === 'uncertain') {
        uncertainties.push({
          operation: 'archive_artifact_inspection',
          subject: pin.artifact_id,
          reason: archived.reason,
        });
        return null;
      }
    }
    return 'artifact-missing';
  }
  const artifact = await readConsistentDurableArtifact(
    opts,
    pin.artifact_id,
    row.status,
    uncertainties
  );
  return artifact?.state === 'summarized' ? 'artifact-summarized' : null;
}

async function readConsistentDurableArtifact(
  opts: ScanGcOptions,
  artifactId: string,
  sqliteStatus: string,
  uncertainties: GcStorageUncertainty[]
): Promise<ArtifactJson | null> {
  let artifact: ArtifactJson | null;
  try {
    artifact = await opts.store.readArtifact(artifactId);
  } catch (error) {
    uncertainties.push({
      operation: 'artifact_state_inspection',
      subject: artifactId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (artifact === null) {
    uncertainties.push({
      operation: 'artifact_state_inspection',
      subject: artifactId,
      reason: 'SQLite contains the artifact but its durable lifecycle state is missing',
    });
    return null;
  }
  if (artifact.id !== artifactId) {
    uncertainties.push({
      operation: 'artifact_state_inspection',
      subject: artifactId,
      reason: `durable lifecycle projection identifies artifact ${artifact.id}`,
    });
    return null;
  }
  if ((artifact.state === 'summarized') !== (sqliteStatus === 'complete')) {
    uncertainties.push({
      operation: 'artifact_state_inspection',
      subject: artifactId,
      reason: `durable lifecycle state ${artifact.state} contradicts SQLite status ${sqliteStatus}`,
    });
    return null;
  }
  return artifact;
}

async function scanArtifacts(
  opts: ScanGcOptions,
  tips: string[],
  cutoffMs: number,
  gitUncertainties: GcGitUncertainty[],
  storageUncertainties: GcStorageUncertainty[]
): Promise<{ nonterminal: ArtifactCandidate[]; abandoned: ArtifactCandidate[] }> {
  const nonterminal: ArtifactCandidate[] = [];
  const abandoned: ArtifactCandidate[] = [];

  // We rely on `lineage_by_latest_sha` as the working set — it has
  // every artifact that has a recorded lineage SHA. Artifacts without
  // any lineage entry yet aren't candidates (they're transitional /
  // mid-write).
  const rows = opts.store.store.db
    .prepare(
      `SELECT a.id, a.task, a.status,
              lbls.latest_lineage_sha, s.ts AS summarized_at
       FROM artifacts a
       LEFT JOIN lineage_by_latest_sha lbls ON lbls.artifact_id = a.id
       LEFT JOIN summaries s ON s.artifact_id = a.id`
    )
    .all() as Array<{
    id: string;
    task: string;
    status: string;
    latest_lineage_sha: string | null;
    summarized_at: string | null;
  }>;

  for (const r of rows) {
    if (!r.latest_lineage_sha) continue; // no lineage → not a candidate

    const artifact = await readConsistentDurableArtifact(
      opts,
      r.id,
      r.status,
      storageUncertainties
    );
    if (artifact === null) continue;
    const latestLineage = artifact.branch_lineage.at(-1);
    if (!latestLineage || latestLineage.head_sha !== r.latest_lineage_sha) {
      storageUncertainties.push({
        operation: 'artifact_state_inspection',
        subject: r.id,
        reason: 'durable lineage contradicts the SQLite lineage projection',
      });
      continue;
    }
    const terminal = artifact.state === 'summarized';
    let summarizedAt: string | null = null;
    if (terminal) {
      try {
        const summary = await opts.store.readSummary(r.id);
        if (summary === null || summary.artifact_id !== r.id || summary.ts !== r.summarized_at) {
          storageUncertainties.push({
            operation: 'artifact_state_inspection',
            subject: r.id,
            reason: 'durable summary timestamp contradicts the SQLite summary projection',
          });
          continue;
        }
        summarizedAt = summary.ts;
      } catch (error) {
        storageUncertainties.push({
          operation: 'artifact_state_inspection',
          subject: r.id,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    } else if (r.summarized_at !== null) {
      storageUncertainties.push({
        operation: 'artifact_state_inspection',
        subject: r.id,
        reason: `nonterminal durable lifecycle state ${artifact.state} has a SQLite summary`,
      });
      continue;
    }

    const lineage = await opts.repo.resolveCommitState(r.latest_lineage_sha);
    if (lineage.status !== 'resolved') {
      gitUncertainties.push({
        operation: 'artifact_lineage_resolution',
        subject: `${r.id}:${r.latest_lineage_sha}`,
      });
      continue;
    }

    let reachability: 'reachable' | 'unreachable' | 'unknown' = 'unreachable';
    for (const tip of tips) {
      const result = await opts.repo.checkReachability(lineage.sha, tip);
      if (result === 'unknown') {
        reachability = 'unknown';
        gitUncertainties.push({
          operation: 'artifact_reachability',
          subject: `${r.id}:${r.latest_lineage_sha}:${tip}`,
        });
        break;
      }
      if (result === 'reachable') {
        reachability = 'reachable';
        break;
      }
    }
    if (reachability === 'unknown') continue;

    if (reachability === 'unreachable' && !terminal) {
      nonterminal.push({
        artifact_id: r.id,
        task: r.task,
        branch: latestLineage.branch,
        state: artifact.state,
        summarized_at: null,
      });
    }

    if (terminal && summarizedAt && reachability === 'unreachable') {
      const summarizedMs = Date.parse(summarizedAt);
      const retentionMs =
        artifact.origin?.kind === 'git-import'
          ? Math.max(summarizedMs, Date.parse(artifact.origin.imported_at))
          : summarizedMs;
      if (!Number.isNaN(retentionMs) && retentionMs < cutoffMs) {
        abandoned.push({
          artifact_id: r.id,
          task: r.task,
          branch: latestLineage.branch,
          state: artifact.state,
          summarized_at: summarizedAt,
        });
      } else if (Number.isNaN(retentionMs)) {
        storageUncertainties.push({
          operation: 'artifact_state_inspection',
          subject: r.id,
          reason: `durable summary timestamp is invalid: ${summarizedAt}`,
        });
      }
    }
  }

  return { nonterminal, abandoned };
}

/**
 * Default-branch tip sha for the destructive merged-review-dir check.
 * origin/HEAD is authoritative when it resolves. Without it, exactly one of
 * main/master must resolve; both is ambiguous and neither is unknown, so both
 * cases return null and skip the merged check for an existing branch.
 *
 * This is intentionally stricter than review-engine's ordered scope fallback:
 * a wrong scope is visible and recoverable, while a wrong GC choice deletes.
 * Watch's main/master set is display classification, not branch resolution.
 */
async function resolveDefaultBranchTip(
  repo: Repo
): Promise<{ tip: string | null; uncertain: boolean }> {
  const remoteHead = await repo.resolveCommitState('refs/remotes/origin/HEAD');
  if (remoteHead.status === 'unknown') return { tip: null, uncertain: true };
  if (remoteHead.status === 'resolved') return { tip: remoteHead.sha, uncertain: false };

  const [mainTip, masterTip] = await Promise.all([
    repo.resolveCommitState('refs/heads/main'),
    repo.resolveCommitState('refs/heads/master'),
  ]);
  if (mainTip.status === 'unknown' || masterTip.status === 'unknown') {
    return { tip: null, uncertain: true };
  }
  const mainSha = mainTip.status === 'resolved' ? mainTip.sha : null;
  const masterSha = masterTip.status === 'resolved' ? masterTip.sha : null;
  if ((mainSha === null) === (masterSha === null)) return { tip: null, uncertain: false };
  return { tip: mainSha ?? masterSha, uncertain: false };
}

async function currentBranchOrNull(
  repo: Repo
): Promise<{ branch: string | null; uncertain: boolean }> {
  try {
    const b = await repo.getCurrentBranch();
    return { branch: b.length > 0 ? b : null, uncertain: false };
  } catch {
    return { branch: null, uncertain: true };
  }
}

/**
 * Staleness verdict for a review dir's branch, or null to keep it. Deleted
 * locally → `branch_deleted`; exists but its tip is an ancestor of the default
 * branch's tip → `branch_merged`. An unresolvable branch tip or a missing
 * default branch keeps the dir (can't prove staleness).
 *
 * A branch whose tip EQUALS the default tip is the default branch itself (or a
 * branch parked at the same commit); it is trivially its own ancestor but is
 * not "merged" in the sense that would make its review dir disposable — keep it.
 */
async function classifyReviewBranch(
  repo: Repo,
  branch: string,
  defaultTip: string | null
): Promise<{
  reason: ReviewDirCandidate['reason'] | null;
  uncertainty: GcGitUncertainty | null;
}> {
  const presence = await repo.branchPresence(branch);
  if (presence === 'unknown') {
    return {
      reason: null,
      uncertainty: { operation: 'review_branch_presence', subject: branch },
    };
  }
  if (presence === 'absent') return { reason: 'branch_deleted', uncertainty: null };
  if (defaultTip === null) return { reason: null, uncertainty: null };
  const branchTip = await repo.resolveCommitState(`refs/heads/${branch}`);
  if (branchTip.status !== 'resolved') {
    return {
      reason: null,
      uncertainty: { operation: 'review_branch_tip', subject: branch },
    };
  }
  if (branchTip.sha === defaultTip) return { reason: null, uncertainty: null };
  const reachability = await repo.checkReachability(branchTip.sha, defaultTip);
  if (reachability === 'unknown') {
    return {
      reason: null,
      uncertainty: { operation: 'review_branch_reachability', subject: branch },
    };
  }
  return {
    reason: reachability === 'reachable' ? 'branch_merged' : null,
    uncertainty: null,
  };
}

/** Max mtime (ms) over a review tree, rejecting symlinks instead of following them. */
async function reviewDirLastModifiedMs(dir: string): Promise<number> {
  let maxMs = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const currentStat = await lstat(current);
    if (currentStat.mtimeMs > maxMs) maxMs = currentStat.mtimeMs;
    if (currentStat.isSymbolicLink()) {
      throw new Error(`review state contains a symbolic link: ${current}`);
    }
    if (!currentStat.isDirectory()) continue;
    for (const name of await readdir(current)) pending.push(path.join(current, name));
  }
  return maxMs;
}

/**
 * `.orcaops/reviews/<slug>/` dirs whose branch is deleted or merged AND whose
 * most-recent mtime predates the retention cutoff. The current branch's dir is
 * never a candidate (you're standing on it). Missing reviews root → [].
 */
async function scanStaleReviewDirs(
  opts: ScanGcOptions,
  cutoffMs: number,
  gitUncertainties: GcGitUncertainty[]
): Promise<{ candidates: ReviewDirCandidate[]; uncertainties: GcStorageUncertainty[] }> {
  const requestedReviewsRoot = path.join(opts.repo.cwd, '.orcaops', 'reviews');
  let reviewsRoot: string;
  try {
    reviewsRoot = assertResolvedWithin(requestedReviewsRoot, opts.repo.cwd, 'review state root', {
      rejectSymlinks: true,
    });
  } catch (error) {
    return {
      candidates: [],
      uncertainties: [
        {
          operation: 'review_state_inspection',
          subject: requestedReviewsRoot,
          reason: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  let entries: Dirent[];
  try {
    entries = await readdir(reviewsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { candidates: [], uncertainties: [] };
    }
    return {
      candidates: [],
      uncertainties: [
        {
          operation: 'review_state_inspection',
          subject: reviewsRoot,
          reason: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const currentBranch = await currentBranchOrNull(opts.repo);
  if (currentBranch.uncertain) {
    gitUncertainties.push({ operation: 'current_branch', subject: 'HEAD' });
  }
  const defaultTip = await resolveDefaultBranchTip(opts.repo);
  if (defaultTip.uncertain) {
    gitUncertainties.push({
      operation: 'default_branch_resolution',
      subject: 'refs/remotes/origin/HEAD|refs/heads/main|refs/heads/master',
    });
  }

  const out: ReviewDirCandidate[] = [];
  const uncertainties: GcStorageUncertainty[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      uncertainties.push({
        operation: 'review_state_inspection',
        subject: entry.name,
        reason: 'review state entry is a symbolic link',
      });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    let branch: string;
    try {
      branch = unslugifyBranch(slug);
    } catch (error) {
      uncertainties.push({
        operation: 'review_state_inspection',
        subject: slug,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (branch === currentBranch.branch) continue; // standing on it → never stale

    const classification = await classifyReviewBranch(opts.repo, branch, defaultTip.tip);
    if (classification.uncertainty !== null) {
      gitUncertainties.push(classification.uncertainty);
      continue;
    }
    if (classification.reason === null) continue;

    const dir = path.join(reviewsRoot, slug);
    let lastModifiedMs: number;
    try {
      lastModifiedMs = await reviewDirLastModifiedMs(dir);
    } catch (error) {
      uncertainties.push({
        operation: 'review_state_inspection',
        subject: slug,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (lastModifiedMs >= cutoffMs) continue; // still inside the retention window

    out.push({
      slug,
      branch,
      dir,
      reason: classification.reason,
      last_modified: new Date(lastModifiedMs).toISOString(),
    });
  }

  if (out.length > 0) {
    const reviewTrashRoot = path.join(opts.repo.cwd, '.orcaops', 'tmp', 'trash');
    try {
      assertResolvedWithin(reviewTrashRoot, opts.repo.cwd, 'review deletion trash root', {
        rejectSymlinks: true,
      });
    } catch (error) {
      uncertainties.push({
        operation: 'review_state_inspection',
        subject: reviewTrashRoot,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { candidates: out, uncertainties };
}
