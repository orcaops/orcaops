import { spawn } from 'node:child_process';

import { clusterSeedHistory, type SeedCluster } from './cluster.js';
import { type DetailedCommit, Repo } from '../git/repo.js';

export const DEFAULT_RECENCY_MONTHS = 6;
export const DEFAULT_RECENCY_COMMIT_CAP = 600;
export const DEFAULT_MAX_COMMITS = 1_000;
export const MAX_SEED_COMMITS = 5_000;
export const DEFAULT_ARTIFACT_CEILING = 400;

export type SeedBranchResolutionSource = 'explicit' | 'origin-head' | 'main' | 'master' | 'current';

export interface ResolvedSeedBranch {
  ref: string;
  sha: string;
  source: SeedBranchResolutionSource;
}

export interface SelectSeedClustersOptions {
  now?: Date;
  sinceIso?: string;
  /**
   * Targeted lanes (--commit/--path) ignore the recency window by design —
   * the why-miss hint emits `seed --commit` for old commits. Only a since the
   * user explicitly passed re-enables the window filter for them.
   */
  sinceExplicit?: boolean;
  recencyCommitCap?: number;
  artifactCeiling?: number;
  commit?: string;
  path?: string;
  author?: string;
}

export interface SeedClusterSelection {
  clusters: SeedCluster[];
  selectedCommitCount: number;
  eligibleClusterCount: number;
  eligibleCommitCount: number;
  windowExcludedClusterCount: number;
  truncatedByCommitCap: boolean;
  truncatedByArtifactCeiling: boolean;
  /** Eligible clusters/commits the budget left behind — 0 when nothing was truncated. */
  truncatedClusterCount: number;
  truncatedCommitCount: number;
  sinceIso: string;
}

export interface LoadedSeedHistory extends SeedClusterSelection {
  branch: ResolvedSeedBranch;
  firstParentCommits: DetailedCommit[];
  graphCommits: DetailedCommit[];
}

function runGit(
  cwd: string,
  args: readonly string[]
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    proc.on('error', () => resolve({ code: null, stdout }));
    proc.on('close', (code) => resolve({ code, stdout }));
  });
}

async function resolvedRef(repo: Repo, ref: string): Promise<ResolvedSeedBranch | null> {
  const sha = await repo.resolveCommit(ref);
  return sha ? { ref, sha, source: 'explicit' } : null;
}

export async function resolveSeedBranch(
  repo: Repo,
  explicitRef?: string
): Promise<ResolvedSeedBranch> {
  if (explicitRef) {
    const resolved = await resolvedRef(repo, explicitRef);
    if (!resolved) throw new Error(`Seed branch does not resolve to a commit: ${explicitRef}`);
    return resolved;
  }

  const remoteHead = await runGit(repo.cwd, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (remoteHead.code === 0) {
    const ref = remoteHead.stdout.trim();
    const sha = ref ? await repo.resolveCommit(ref) : null;
    if (sha) return { ref, sha, source: 'origin-head' };
  }

  for (const ref of ['main', 'master']) {
    const sha = await repo.resolveCommit(ref);
    if (sha) return { ref, sha, source: ref as 'main' | 'master' };
  }

  if (!(await repo.resolveCommit('HEAD'))) {
    throw new Error('Repository has no commits yet — nothing to seed');
  }
  const current = await repo.getCurrentBranch();
  if (current === 'HEAD') {
    throw new Error('Cannot infer a seed branch from detached HEAD; pass --branch <ref>');
  }
  const sha = await repo.resolveCommit(current);
  if (!sha) throw new Error(`Current branch does not resolve to a commit: ${current}`);
  return { ref: current, sha, source: 'current' };
}

export async function resolveSeedSince(repo: Repo, value: string): Promise<string> {
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  const result = await runGit(repo.cwd, ['show', '-s', '--format=%cI', `${value}^{commit}`]);
  const timestamp = result.stdout.trim();
  if (result.code !== 0 || !timestamp || Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`--since must be an ISO date or a ref resolving to a commit: ${value}`);
  }
  return new Date(timestamp).toISOString();
}

export function defaultSeedSince(now = new Date()): string {
  if (Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  const cutoff = new Date(now);
  const day = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - DEFAULT_RECENCY_MONTHS);
  const lastDay = new Date(
    Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)
  ).getUTCDate();
  cutoff.setUTCDate(Math.min(day, lastDay));
  // Snapped to the UTC day boundary: the value feeds the enrichment
  // options hash, so sub-day precision would make every default
  // dry-run/apply pair disagree and reject the bundles it just wrote.
  cutoff.setUTCHours(0, 0, 0, 0);
  return cutoff.toISOString();
}

function positiveBound(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function authorMatches(cluster: SeedCluster, pattern: string | undefined): boolean {
  if (!pattern) return true;
  const needle = pattern.toLowerCase();
  return cluster.authors.some((author) => author.toLowerCase().includes(needle));
}

function pathMatches(cluster: SeedCluster, pathFilter: string | undefined): boolean {
  if (!pathFilter) return true;
  const normalized = pathFilter.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
  return cluster.files.some((file) => file === normalized || file.startsWith(`${normalized}/`));
}

export function selectSeedClusters(
  canonicalClusters: readonly SeedCluster[],
  opts: SelectSeedClustersOptions = {}
): SeedClusterSelection {
  const recencyCommitCap = opts.recencyCommitCap ?? DEFAULT_RECENCY_COMMIT_CAP;
  const artifactCeiling = opts.artifactCeiling ?? DEFAULT_ARTIFACT_CEILING;
  positiveBound(recencyCommitCap, 'recencyCommitCap');
  positiveBound(artifactCeiling, 'artifactCeiling');
  const sinceIso = opts.sinceIso ?? defaultSeedSince(opts.now);
  const sinceMs = Date.parse(sinceIso);
  if (Number.isNaN(sinceMs)) throw new TypeError('sinceIso must be an ISO timestamp');

  const targeted = opts.commit !== undefined || opts.path !== undefined;
  const enforceWindow = !targeted || opts.sinceExplicit === true;
  let windowExcludedClusterCount = 0;
  const eligible = canonicalClusters.filter((cluster) => {
    if (!authorMatches(cluster, opts.author) || !pathMatches(cluster, opts.path)) return false;
    if (opts.commit && !cluster.commits.some((commit) => commit.sha.startsWith(opts.commit!))) {
      return false;
    }
    if (enforceWindow && Date.parse(cluster.latestCommitDateIso) < sinceMs) {
      windowExcludedClusterCount += 1;
      return false;
    }
    return true;
  });
  const newestFirst = [...eligible].sort(
    (a, b) =>
      Date.parse(b.latestCommitDateIso) - Date.parse(a.latestCommitDateIso) ||
      b.firstParentPosition - a.firstParentPosition ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );

  const selected: SeedCluster[] = [];
  let selectedCommitCount = 0;
  let truncatedByCommitCap = false;
  let truncatedByArtifactCeiling = false;
  for (const cluster of newestFirst) {
    if (selected.length >= artifactCeiling) {
      truncatedByArtifactCeiling = true;
      break;
    }
    if (
      !targeted &&
      selected.length > 0 &&
      selectedCommitCount + cluster.commits.length > recencyCommitCap
    ) {
      truncatedByCommitCap = true;
      break;
    }
    selected.push(cluster);
    selectedCommitCount += cluster.commits.length;
  }
  if (
    !targeted &&
    selected.length < newestFirst.length &&
    selectedCommitCount >= recencyCommitCap
  ) {
    truncatedByCommitCap = true;
  }
  if (selected.length < newestFirst.length && selected.length >= artifactCeiling) {
    truncatedByArtifactCeiling = true;
  }

  selected.sort(
    (a, b) => a.firstParentPosition - b.firstParentPosition || (a.key < b.key ? -1 : 1)
  );
  const eligibleCommitCount = eligible.reduce(
    (total, cluster) => total + cluster.commits.length,
    0
  );
  const truncated = truncatedByCommitCap || truncatedByArtifactCeiling;
  return {
    clusters: selected,
    selectedCommitCount,
    eligibleClusterCount: eligible.length,
    eligibleCommitCount,
    windowExcludedClusterCount,
    truncatedByCommitCap,
    truncatedByArtifactCeiling,
    truncatedClusterCount: truncated ? newestFirst.length - selected.length : 0,
    truncatedCommitCount: truncated ? eligibleCommitCount - selectedCommitCount : 0,
    sinceIso: new Date(sinceMs).toISOString(),
  };
}

export async function loadSeedHistory(
  repo: Repo,
  opts: SelectSeedClustersOptions & { branch?: string; includeBots?: boolean } = {}
): Promise<LoadedSeedHistory> {
  const branch = await resolveSeedBranch(repo, opts.branch);
  const [firstParentCommits, graphCommits] = await Promise.all([
    repo.logFirstParentDetailed(branch.sha),
    repo.logDetailed(branch.sha),
  ]);
  const sinceIso = opts.sinceIso ?? defaultSeedSince(opts.now);
  // Targeted lanes select from canonical clusters over full history: the
  // window trim would silently drop the very merge members --commit names.
  const targeted = opts.commit !== undefined || opts.path !== undefined;
  const canonicalClusters = clusterSeedHistory(firstParentCommits, graphCommits, {
    includeBots: opts.includeBots,
    ...(targeted ? {} : { windowStartIso: sinceIso }),
  });
  return {
    branch,
    firstParentCommits,
    graphCommits,
    ...selectSeedClusters(canonicalClusters, { ...opts, sinceIso }),
  };
}
