import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

import type { SeedCluster } from './cluster.js';
import type { DetailedCommit, Repo } from '../git/repo.js';

export const DEFAULT_BLAME_PROBE_FILES = 3;
export const DEFAULT_BLAME_PROBE_THRESHOLD_MS = 300;
export const DEFAULT_BLAME_CONCURRENCY = 8;
export const LARGE_HISTORY_COMMIT_COUNT = 150_000;

export interface SeedFileOwnership {
  path: string;
  lineCount: number;
  byCommit: Map<string, number>;
  complete: boolean;
}

export interface ImportanceRanking {
  status: 'complete' | 'deferred';
  reason: 'large-history' | 'slow-probe' | null;
  probeMedianMs: number | null;
  ownership: SeedFileOwnership[];
  lineMassByCommit: Map<string, number>;
}

export interface ImportanceSelection {
  clusters: SeedCluster[];
  selectedCommitCount: number;
  candidateCommitCount: number;
  candidateClusterCount: number;
  truncated: boolean;
}

interface GitOutput {
  code: number | null;
  stdout: string;
  killed: boolean;
}

function runGit(
  cwd: string,
  args: readonly string[],
  opts: { timeoutMs?: number } = {}
): Promise<GitOutput> {
  return new Promise((resolve) => {
    const proc = spawn('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    let killed = false;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    const timer =
      opts.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            killed = true;
            proc.kill('SIGTERM');
          }, opts.timeoutMs);
    proc.on('error', () => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, killed });
    });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, killed });
    });
  });
}

function isVendorPath(file: string): boolean {
  const normalized = file.replaceAll('\\', '/').toLowerCase();
  return (
    normalized.startsWith('vendor/') ||
    normalized.includes('/vendor/') ||
    normalized.startsWith('third_party/') ||
    normalized.includes('/third_party/') ||
    normalized.startsWith('node_modules/') ||
    normalized.includes('/node_modules/')
  );
}

async function listTrackedFiles(repo: Repo, ref: string, pathFilter?: string): Promise<string[]> {
  const normalized = pathFilter?.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
  const result = await runGit(repo.cwd, [
    '-c',
    'core.quotepath=false',
    'ls-tree',
    '-r',
    '--name-only',
    '-z',
    ref,
    ...(normalized ? ['--', normalized] : []),
  ]);
  if (result.code !== 0) return [];
  return result.stdout.split('\0').filter((file) => file.length > 0 && !isVendorPath(file));
}

function parseIncrementalBlame(file: string, output: GitOutput): SeedFileOwnership {
  const byCommit = new Map<string, number>();
  let lineCount = 0;
  for (const line of output.stdout.split('\n')) {
    const match = /^(?:\^)?([0-9a-f]{40}) \d+ \d+ (\d+)$/u.exec(line);
    if (!match) continue;
    const count = Number.parseInt(match[2]!, 10);
    byCommit.set(match[1]!, (byCommit.get(match[1]!) ?? 0) + count);
    lineCount += count;
  }
  return {
    path: file,
    lineCount,
    byCommit,
    complete: output.code === 0 && !output.killed,
  };
}

async function blameFile(
  repo: Repo,
  ref: string,
  file: string,
  ignoreRevsFile: string | null,
  timeoutMs: number
): Promise<{ ownership: SeedFileOwnership; durationMs: number }> {
  const started = performance.now();
  const output = await runGit(
    repo.cwd,
    [
      'blame',
      '--incremental',
      '-w',
      ...(ignoreRevsFile ? ['--ignore-revs-file', ignoreRevsFile] : []),
      ref,
      '--',
      file,
    ],
    { timeoutMs }
  );
  return {
    ownership: parseIncrementalBlame(file, output),
    durationMs: performance.now() - started,
  };
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await fn(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function sumOwnership(ownership: readonly SeedFileOwnership[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const file of ownership) {
    for (const [sha, count] of file.byCommit) {
      result.set(sha, (result.get(sha) ?? 0) + count);
    }
  }
  return result;
}

export async function rankSeedImportance(
  repo: Repo,
  input: {
    branchSha: string;
    commits: readonly DetailedCommit[];
    historyCommitCount: number;
    path?: string;
    force?: boolean;
    probeFiles?: number;
    probeThresholdMs?: number;
    concurrency?: number;
    timeoutMs?: number;
  }
): Promise<ImportanceRanking> {
  const files = await listTrackedFiles(repo, input.branchSha, input.path);
  const touches = new Map<string, number>();
  for (const commit of input.commits) {
    for (const file of commit.files) touches.set(file, (touches.get(file) ?? 0) + 1);
  }
  files.sort(
    (left, right) =>
      (touches.get(right) ?? 0) - (touches.get(left) ?? 0) ||
      (left < right ? -1 : left > right ? 1 : 0)
  );
  if (!input.force && input.historyCommitCount > LARGE_HISTORY_COMMIT_COUNT) {
    return {
      status: 'deferred',
      reason: 'large-history',
      probeMedianMs: null,
      ownership: [],
      lineMassByCommit: new Map(),
    };
  }

  const ignoreCandidate = path.join(repo.cwd, '.git-blame-ignore-revs');
  const ignoreRevsFile = await access(ignoreCandidate).then(
    () => ignoreCandidate,
    () => null
  );
  const probeCount = Math.min(input.probeFiles ?? DEFAULT_BLAME_PROBE_FILES, files.length);
  const timeoutMs = input.timeoutMs ?? 30_000;
  const probe = await mapConcurrent(files.slice(0, probeCount), probeCount || 1, (file) =>
    blameFile(repo, input.branchSha, file, ignoreRevsFile, timeoutMs)
  );
  const probeMedianMs = median(probe.map((item) => item.durationMs));
  const ownership = probe.map((item) => item.ownership);
  if (
    !input.force &&
    probeMedianMs !== null &&
    probeMedianMs > (input.probeThresholdMs ?? DEFAULT_BLAME_PROBE_THRESHOLD_MS)
  ) {
    return {
      status: 'deferred',
      reason: 'slow-probe',
      probeMedianMs,
      ownership,
      lineMassByCommit: sumOwnership(ownership),
    };
  }

  const rest = await mapConcurrent(
    files.slice(probeCount),
    input.concurrency ?? DEFAULT_BLAME_CONCURRENCY,
    async (file) =>
      (await blameFile(repo, input.branchSha, file, ignoreRevsFile, timeoutMs)).ownership
  );
  ownership.push(...rest);
  return {
    status: 'complete',
    reason: null,
    probeMedianMs,
    ownership,
    lineMassByCommit: sumOwnership(ownership),
  };
}

export function selectImportanceClusters(
  canonicalClusters: readonly SeedCluster[],
  lineMassByCommit: ReadonlyMap<string, number>,
  opts: {
    maxCommits: number;
    maxClusters?: number;
    excludedClusterKeys?: ReadonlySet<string>;
  }
): ImportanceSelection {
  if (!Number.isSafeInteger(opts.maxCommits) || opts.maxCommits < 0) {
    throw new RangeError('maxCommits must be a non-negative safe integer');
  }
  const maxClusters = opts.maxClusters ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxClusters) || maxClusters < 0) {
    throw new RangeError('maxClusters must be a non-negative safe integer');
  }
  const excluded = opts.excludedClusterKeys ?? new Set<string>();
  const ranked = canonicalClusters
    .filter((cluster) => !excluded.has(cluster.key))
    .map((cluster) => ({
      cluster,
      mass: [...new Set([cluster.headSha, ...cluster.commits.map((commit) => commit.sha)])].reduce(
        (total, sha) => total + (lineMassByCommit.get(sha) ?? 0),
        0
      ),
    }))
    .filter((candidate) => candidate.mass > 0)
    .sort(
      (left, right) =>
        right.mass - left.mass ||
        right.cluster.firstParentPosition - left.cluster.firstParentPosition ||
        (left.cluster.key < right.cluster.key ? -1 : 1)
    );
  const clusters: SeedCluster[] = [];
  let selectedCommitCount = 0;
  for (const candidate of ranked) {
    if (clusters.length >= maxClusters) break;
    if (selectedCommitCount + candidate.cluster.commits.length > opts.maxCommits) continue;
    clusters.push(candidate.cluster);
    selectedCommitCount += candidate.cluster.commits.length;
  }
  clusters.sort(
    (left, right) =>
      left.firstParentPosition - right.firstParentPosition || (left.key < right.key ? -1 : 1)
  );
  const candidateCommitCount = ranked.reduce(
    (total, candidate) => total + candidate.cluster.commits.length,
    0
  );
  return {
    clusters,
    selectedCommitCount,
    candidateCommitCount,
    candidateClusterCount: ranked.length,
    truncated: selectedCommitCount < candidateCommitCount,
  };
}
