import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  clusterSeedHistory,
  DEFAULT_ARTIFACT_CEILING,
  DEFAULT_MAX_COMMITS,
  DEFAULT_RECENCY_COMMIT_CAP,
  loadSeedHistory,
  MAX_SEED_COMMITS,
  rankSeedImportance,
  type Repo,
  resolveSeedSince,
  type SeedCluster,
  type SeedFileOwnership,
  selectImportanceClusters,
} from '@orcaops/core';
import {
  type ArtifactOrigin,
  type ArtifactOriginJob,
  type Checkpoint,
  listArchivedArtifactIds,
  loadArtifactThreadFromArchive,
  restoreArtifactFromArchive,
  type Summary,
  uuidv7,
} from '@orcaops/storage';

import {
  readSeedEnrichmentManifest,
  resolveSeedEnrichment,
  type SeedEnrichmentReport,
  type SeedSelectionRecord,
  writeSeedEnrichmentBundles,
} from './enrichment.js';
import {
  buildSeedCoverageReport,
  clearSeedArea,
  declinedSeedAreas,
  loadSeedStateForWrite,
  normalizeSeedArea,
  offeredSeedAreas,
  readSeedCoverage,
  readSeedState,
  recordSeedAreaOffered,
  recordSeedJob,
  rememberDeclinedSeedArea,
  type SeedJobRecord,
  withSeedRunLock,
  writeSeedCoverage,
  writeSeedJournal,
  writeSeedPreciousState,
} from './journal.js';
import { type SeedClusterSynthesis, synthesizeSeedCluster } from './synthesize.js';
import { prepareSeedSnapshots, writeSeedCluster } from './write.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../../io/output.js';
import { CLI_VERSION } from '../../lib/cli-version.js';
import { buildContext, type CliContext } from '../../lib/context.js';
import { getInvocationEnv } from '../../lib/invocation-context.js';

export interface SeedOptions {
  since?: string;
  maxCommits?: number;
  branch?: string;
  author?: string;
  dryRun?: boolean;
  yes?: boolean;
  enrichmentDir?: string;
  includeBots?: boolean;
  prContext?: boolean;
  importance?: boolean;
  path?: string;
  commit?: string;
  json?: boolean;
}

export interface SeedPreflight {
  partialClone: boolean;
  shallowClone: boolean;
  historyCommitCount: number;
  backfillAvailable: boolean;
  suggestCommitGraph: boolean;
  warnings: string[];
}

interface SeedOpenCheckpoint {
  artifact_id: string;
  artifact_label: string;
  checkpoint_n: number;
  /** True when the artifact is a `git-import` row — an interrupted seed run. */
  seed_owned: boolean;
}

interface SeedOpenCheckpointGuard {
  blocked: boolean;
  open_checkpoints: SeedOpenCheckpoint[];
  /** Seed-owned strays: an interrupted run to recover, never a reason to refuse. */
  stranded: SeedOpenCheckpoint[];
  message: string | null;
  /** What the apply will do about `stranded`; null when there is nothing to recover. */
  recovery_message: string | null;
}

function runGit(
  repo: Repo,
  args: readonly string[]
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const proc = spawn('git', [...args], { cwd: repo.cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    proc.on('error', () => resolve({ code: null, stdout }));
    proc.on('close', (code) => resolve({ code, stdout }));
  });
}

export async function inspectSeedClone(repo: Repo): Promise<SeedPreflight> {
  const [partialFilter, promisor, count, commands, shallowPath] = await Promise.all([
    runGit(repo, ['config', '--get', 'remote.origin.partialclonefilter']),
    runGit(repo, ['config', '--get-regexp', String.raw`^remote\..*\.promisor$`]),
    runGit(repo, ['rev-list', '--count', '--all']),
    runGit(repo, ['help', '-a']),
    repo.getGitPathAbsolute('shallow'),
  ]);
  const historyCommitCount = Number.parseInt(count.stdout.trim(), 10) || 0;
  const backfillAvailable = commands.code === 0 && hasGitBackfillCommand(commands.stdout);
  const partialClone =
    (partialFilter.code === 0 && partialFilter.stdout.trim().length > 0) ||
    (promisor.code === 0 && promisor.stdout.trim().length > 0);
  let shallowClone = false;
  try {
    await access(shallowPath);
    shallowClone = true;
  } catch {
    shallowClone = false;
  }
  const warnings: string[] = [];
  if (partialClone) {
    warnings.push(partialCloneWarning(backfillAvailable));
  }
  if (shallowClone) warnings.push('Shallow clone detected: available history may be truncated.');
  return {
    partialClone,
    shallowClone,
    historyCommitCount,
    backfillAvailable,
    suggestCommitGraph: historyCommitCount >= 5_000,
    warnings,
  };
}

export const COMMIT_GRAPH_WARNING =
  'Large history detected: consider `git commit-graph write --reachable` before seeding.';

export function partialCloneWarning(backfillAvailable: boolean): string {
  const prefetch = backfillAvailable
    ? '`git backfill` is available to download missing objects (introduced in Git 2.49).'
    : '`git backfill` is unavailable; use a plain full fetch to download missing objects.';
  return `Partial clone detected: seed will skip blob fingerprints. ${prefetch}`;
}

export function hasGitBackfillCommand(commandList: string): boolean {
  return /^\s+backfill(?:\s|$)/mu.test(commandList);
}

export function collectArtifactCoverage(
  checkpoints: readonly Checkpoint[],
  summary: Summary | null,
  covered: Set<string>,
  ranges?: Map<string, { base: string; head: string }>
): void {
  for (const checkpoint of checkpoints) {
    if (checkpoint.status !== 'closed') continue;
    covered.add(checkpoint.head_sha);
    const base = checkpoint.open_head_sha;
    if (base) ranges?.set(`${base}\0${checkpoint.head_sha}`, { base, head: checkpoint.head_sha });
  }
  if (summary?.head_sha) covered.add(summary.head_sha);
}

/**
 * `localCovered` is the subset explained by this checkout's store alone.
 * The apply/dry-run surface uses the gap to say when a covered count is
 * carried by the shared project archive, which a fresh linked worktree's
 * `Imported artifacts: 0` would otherwise appear to contradict.
 */
async function collectCoveredShas(ctx: CliContext): Promise<{
  covered: Set<string>;
  localCovered: Set<string>;
  lossyArchivedThreads: number;
  /**
   * Imported artifacts the shared project archive holds but this checkout's
   * store does not — a linked worktree's whole imported corpus on first seed.
   * Their coverage suppresses the import, so leaving them unmaterialized is
   * what produced "covered 235" beside an empty `list --imported`.
   */
  restorableImports: string[];
}> {
  const localCovered = new Set<string>();
  const localRanges = new Map<string, { base: string; head: string }>();
  for (const row of ctx.store.store.listArtifacts()) {
    collectArtifactCoverage(
      await ctx.store.readCheckpoints(row.id),
      await ctx.store.readSummary(row.id),
      localCovered,
      localRanges
    );
  }
  await expandCoveredRanges(ctx.repo, [...localRanges.values()], localCovered);
  const covered = new Set(localCovered);
  let lossyArchivedThreads = 0;
  const restorableImports: string[] = [];
  if (ctx.archive) {
    const archiveRanges = new Map<string, { base: string; head: string }>();
    for (const artifactId of await listArchivedArtifactIds(ctx.archive.projectDir)) {
      const thread = await loadArtifactThreadFromArchive(ctx.archive.projectDir, artifactId);
      // Only imported threads: a live capture belongs to whoever is running
      // it, and restoring an in-flight one would plant a foreign open
      // checkpoint that then refuses the very run doing the restoring.
      if (
        thread.plan?.origin?.kind === 'git-import' &&
        ctx.store.store.getArtifact(artifactId) === null
      ) {
        restorableImports.push(artifactId);
      }
      if (thread.lossyLines === 0) {
        collectArtifactCoverage(thread.checkpoints, thread.summary, covered, archiveRanges);
      } else {
        // A lossy archived thread still testifies to the head shas its
        // readable prefix closed — skipping it whole would re-import that
        // history as duplicates. Only range expansion is withheld: an
        // open-to-close range rebuilt over missing events cannot be
        // trusted to bound the same commits, and a malformed range must
        // never widen coverage.
        lossyArchivedThreads += 1;
        collectArtifactCoverage(thread.checkpoints, thread.summary, covered);
      }
    }
    await expandCoveredRanges(ctx.repo, [...archiveRanges.values()], covered);
  }
  return { covered, localCovered, lossyArchivedThreads, restorableImports };
}

/**
 * Materialize archive-held imports into this checkout. The alternative —
 * disclosing a restore command — leaves the tool asserting coverage the
 * checkout cannot show, and the design authority already requires a fresh
 * worktree to "restore or skip, never re-write". Failures are per-artifact
 * and non-fatal: a thread that will not restore simply stays covered-only.
 */
async function restoreArchivedImports(
  ctx: CliContext,
  artifactIds: readonly string[]
): Promise<{ restored: number; failed: number }> {
  if (!ctx.archive) return { restored: 0, failed: 0 };
  let restored = 0;
  let failed = 0;
  for (const artifactId of artifactIds) {
    try {
      await restoreArtifactFromArchive({
        repoRoot: ctx.repoRoot,
        config: ctx.config,
        store: ctx.store,
        projectDir: ctx.archive.projectDir,
        artifactId,
        archiveLock: ctx.archive,
      });
      restored += 1;
    } catch {
      failed += 1;
    }
  }
  return { restored, failed };
}

/**
 * Ancestry-guarded open-to-close range expansion. When the open head is
 * NOT an ancestor of the close head (rebase or branch switch mid-
 * checkpoint) rev-listing the range would mark unrelated history covered
 * and silently suppress its import; a missing open-head object would
 * abort the run. Both fall back to the close head alone, which the
 * caller already covered — a malformed range must never widen coverage.
 */
export async function expandCoveredRanges(
  repo: Pick<Repo, 'isAncestor' | 'getCommitsBetweenStrict'>,
  ranges: ReadonlyArray<{ base: string; head: string }>,
  covered: Set<string>
): Promise<void> {
  for (let index = 0; index < ranges.length; index += 8) {
    const commitsByRange = await Promise.all(
      ranges
        .slice(index, index + 8)
        .map(async ({ base, head }) =>
          (await repo.isAncestor(base, head)) ? repo.getCommitsBetweenStrict(base, head) : []
        )
    );
    for (const commits of commitsByRange) {
      for (const commit of commits) covered.add(commit.sha);
    }
  }
}

async function collectImportedShas(ctx: CliContext): Promise<Set<string>> {
  const imported = new Set<string>();
  for (const row of ctx.store.store.listArtifacts()) {
    if (row.origin_kind !== 'git-import') continue;
    collectArtifactCoverage(
      await ctx.store.readCheckpoints(row.id),
      await ctx.store.readSummary(row.id),
      imported
    );
  }
  return imported;
}

function authorMatches(cluster: SeedCluster, pattern: string | undefined): boolean {
  if (!pattern) return true;
  const needle = pattern.toLowerCase();
  return cluster.authors.some((author) => author.toLowerCase().includes(needle));
}

function clusterTouchesPath(cluster: SeedCluster, pathFilter: string): boolean {
  const normalized = normalizeSeedArea(pathFilter);
  return cluster.files.some((file) => file === normalized || file.startsWith(`${normalized}/`));
}

/**
 * Whether an import supersedes an area's suppression: a leftover decline
 * would keep suppressing offers for history the user chose to import, and a
 * leftover offer row would keep it out of the offer rotation for the rest of
 * its cooldown. "Chose" means targeted — a cluster selected by
 * `--path` still carries commits that stray outside it, so files written
 * incidentally elsewhere are no choice to import those areas, and one
 * `--commit` cluster is never a choice to import an area's history.
 */
/**
 * The coverage table's `(root)` row: files with no directory component, which
 * `buildSeedCoverageReport` keys as `.`. No prefix test can match it, so it
 * needs its own membership rule.
 */
const ROOT_AREA = '.';

function areaContainsFile(area: string, file: string): boolean {
  if (area === ROOT_AREA) return !file.includes('/');
  return file === area || file.startsWith(`${area}/`);
}

export function importSupersedesArea(
  area: string,
  writtenFiles: readonly string[],
  opts: Pick<SeedOptions, 'commit' | 'path'>
): boolean {
  // Truthiness, not `!== undefined`: every lane-selection site in this file
  // classifies the same way, so an empty flag value (an unset shell variable
  // reaching `--path "$DIR"`) runs the untargeted import and must take the
  // untargeted clear with it.
  if (opts.commit) return false;
  const normalized = normalizeSeedArea(area);
  if (!writtenFiles.some((file) => areaContainsFile(normalized, file))) return false;
  const target = opts.path ? normalizeSeedArea(opts.path) : '';
  // `listTrackedFiles` hands the normalized path to git as a pathspec, and
  // `-- .` is the whole repo: a root-normalized target selects every cluster
  // exactly as an untargeted run does, so it must clear like one.
  if (!target || target === ROOT_AREA) return true;
  return (
    normalized === target ||
    normalized.startsWith(`${target}/`) ||
    target.startsWith(`${normalized}/`)
  );
}

async function cacheCoverage(
  ctx: CliContext,
  branchSha: string,
  ownership: readonly SeedFileOwnership[],
  complete: boolean,
  scoped: boolean
): Promise<void> {
  if (ownership.length === 0) return;
  const report = buildSeedCoverageReport(
    branchSha,
    ownership,
    await collectImportedShas(ctx),
    complete
  );
  if (scoped) {
    // A path-scoped job ranks only its own subtree; replacing the report
    // would drop every previously reported directory row. Merge the fresh
    // rows over the prior ones and keep the whole-tree completeness
    // verdict — a scoped refresh can neither prove nor revoke it.
    const prior = await readSeedCoverage(ctx.repoRoot, ctx.config);
    if (prior) {
      report.directories = { ...prior.directories, ...report.directories };
      report.complete = prior.complete;
    }
  }
  await writeSeedCoverage(ctx.repoRoot, ctx.config, report);
}

function clusterIsCovered(cluster: SeedCluster, covered: ReadonlySet<string>): boolean {
  return covered.has(cluster.headSha) || cluster.commits.some((commit) => covered.has(commit.sha));
}

function optionsHash(selection: SeedSelectionRecord, branchSha: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        sinceIso: selection.since,
        branchSha,
        maxCommits: selection.max_commits,
        author: selection.author,
        includeBots: selection.include_bots,
        path: selection.path,
        commit: selection.commit,
        importance: selection.importance,
      })
    )
    .digest('hex');
}

/**
 * Resume semantics: the pending manifest is the contract the enrichment
 * bundles were written against, so a flag-less apply adopts its recorded
 * clock-derived `since`. Any explicitly conflicting flag forfeits the
 * adoption — the apply then resolves its own selection and a differing
 * hash still rejects the bundles loudly.
 */
function selectionFlagsMatch(
  opts: SeedOptions,
  maxCommits: number,
  selection: SeedSelectionRecord
): boolean {
  return (
    maxCommits === selection.max_commits &&
    (opts.author ?? null) === selection.author &&
    (opts.includeBots ?? false) === selection.include_bots &&
    (opts.path ?? null) === selection.path &&
    (opts.commit ?? null) === selection.commit &&
    (opts.importance ?? false) === selection.importance
  );
}

/**
 * The commit-graph prep suggestion belongs to full onboarding runs — a
 * 3-second --commit/--path gap-fill never benefits from it — and one
 * journal only needs to hear it once.
 */
export function shouldShowCommitGraphHint(
  preflight: Pick<SeedPreflight, 'suggestCommitGraph'>,
  opts: Pick<SeedOptions, 'commit' | 'path'>,
  journal: { commit_graph_hint_shown?: boolean | undefined }
): boolean {
  return (
    preflight.suggestCommitGraph &&
    opts.commit === undefined &&
    opts.path === undefined &&
    journal.commit_graph_hint_shown !== true
  );
}

/**
 * Which lane produced an apply run. The flag-scoped lanes name themselves;
 * a plain apply is a `resume` once the journal carries evidence of an earlier
 * apply, so `initial` stays reserved for the first onboarding import. Statuses
 * a dry run can leave behind (`pending`, `covered`) are not evidence.
 */
export function seedJobKind(
  opts: Pick<SeedOptions, 'commit' | 'path' | 'importance'>,
  journal: {
    clusters: Record<string, { status: string }>;
    jobs?: Record<string, unknown> | undefined;
  }
): ArtifactOriginJob['kind'] {
  if (opts.commit) return 'commit';
  if (opts.path) return 'path';
  if (opts.importance) return 'importance';
  const priorApply =
    Object.keys(journal.jobs ?? {}).length > 0 ||
    Object.values(journal.clusters).some((cluster) =>
      ['complete', 'writing', 'failed'].includes(cluster.status)
    );
  return priorApply ? 'resume' : 'initial';
}

function invalidInput(message: string): OrcaopsError {
  return new OrcaopsError(ErrorCodes.INVALID_INPUT, message);
}

function validateSeedOptions(opts: SeedOptions): number {
  const maxCommits = opts.maxCommits ?? DEFAULT_MAX_COMMITS;
  if (!Number.isSafeInteger(maxCommits) || maxCommits <= 0 || maxCommits > MAX_SEED_COMMITS) {
    throw invalidInput(`--max-commits must be an integer from 1 to ${MAX_SEED_COMMITS}`);
  }
  if (opts.dryRun && opts.yes) throw invalidInput('--dry-run and --yes cannot be used together.');
  if (opts.path && opts.commit) throw invalidInput('--path and --commit cannot be used together.');
  if (opts.importance && (opts.path || opts.commit)) {
    throw invalidInput('--importance cannot be combined with --path or --commit.');
  }
  if (opts.enrichmentDir && opts.yes !== true) {
    throw invalidInput('--enrichment-dir requires --yes after reviewing the dry-run preview.');
  }
  return maxCommits;
}

function describeOpenCheckpoint(checkpoint: SeedOpenCheckpoint): string {
  return `"${checkpoint.artifact_label}" (${checkpoint.artifact_id}), checkpoint #${checkpoint.checkpoint_n}`;
}

/**
 * The guard exists to protect a LIVE capture from being seeded beside: the
 * coverage pre-filter reads closed claims only, so an in-flight session's
 * eventual head shas are unknowable and seeding around it risks
 * double-narrating it. A seed-owned open checkpoint testifies to nothing of
 * the sort — it is this command's own crash residue — and refusing over it
 * wedges `seed --yes` permanently with no in-tool way out. Ownership is read
 * off `origin_kind`, the storage-class choke point.
 */
function inspectOpenCheckpointGuard(ctx: CliContext): SeedOpenCheckpointGuard {
  const openCheckpoints = ctx.store.store
    .listArtifacts()
    .flatMap((artifact) =>
      ctx.store.store.getOpenCheckpoints(artifact.id).map((checkpoint) => ({
        artifact_id: artifact.id,
        artifact_label: artifact.label,
        checkpoint_n: checkpoint.n,
        seed_owned: artifact.origin_kind === 'git-import',
      }))
    )
    .sort(
      (left, right) =>
        left.artifact_id.localeCompare(right.artifact_id) || left.checkpoint_n - right.checkpoint_n
    );
  const foreign = openCheckpoints.filter((checkpoint) => !checkpoint.seed_owned);
  const stranded = openCheckpoints.filter((checkpoint) => checkpoint.seed_owned);
  return {
    blocked: foreign.length > 0,
    open_checkpoints: openCheckpoints,
    stranded,
    message:
      foreign.length > 0
        ? `Seed cannot write while a checkpoint is open: ${foreign
            .map(describeOpenCheckpoint)
            .join('; ')}. Close or abandon it first.`
        : null,
    recovery_message:
      stranded.length > 0
        ? `recovering an interrupted seed run: ${stranded.map(describeOpenCheckpoint).join('; ')}`
        : null,
  };
}

async function runSeed(ctx: CliContext, opts: SeedOptions): Promise<Record<string, unknown>> {
  const maxCommits = validateSeedOptions(opts);
  const openCheckpointGuard = inspectOpenCheckpointGuard(ctx);
  if (opts.yes === true && openCheckpointGuard.message) {
    throw new OrcaopsError(ErrorCodes.SEED_OPEN_CHECKPOINT, openCheckpointGuard.message);
  }
  const preflight = await inspectSeedClone(ctx.repo);
  let sinceIso = opts.since ? await resolveSeedSince(ctx.repo, opts.since) : undefined;
  let sinceExplicit = opts.since !== undefined;
  if (sinceIso === undefined && opts.yes === true) {
    const pendingManifest = await readSeedEnrichmentManifest(ctx.repoRoot, ctx.config);
    if (
      pendingManifest?.selection &&
      selectionFlagsMatch(opts, maxCommits, pendingManifest.selection)
    ) {
      sinceIso = pendingManifest.selection.since;
      sinceExplicit = pendingManifest.selection.since_explicit === true;
    }
  }
  const commitSha = opts.commit ? await ctx.repo.resolveCommit(opts.commit) : null;
  if (opts.commit && !commitSha)
    throw invalidInput(`--commit does not resolve to a commit: ${opts.commit}`);
  const history = await loadSeedHistory(ctx.repo, {
    ...(sinceIso ? { sinceIso } : {}),
    ...(opts.branch ? { branch: opts.branch } : {}),
    ...(opts.author ? { author: opts.author } : {}),
    ...(commitSha ? { commit: commitSha } : {}),
    ...(opts.path ? { path: opts.path } : {}),
    sinceExplicit,
    includeBots: opts.includeBots,
    recencyCommitCap: Math.min(DEFAULT_RECENCY_COMMIT_CAP, maxCommits),
  });
  const rootSha = history.firstParentCommits.at(-1)?.sha;
  if (!rootSha) throw invalidInput('Repository has no commits yet — nothing to seed');
  const canonicalClusters = clusterSeedHistory(history.firstParentCommits, history.graphCommits, {
    includeBots: opts.includeBots,
  }).filter((cluster) => authorMatches(cluster, opts.author));
  const sinceMs = Date.parse(history.sinceIso);
  const withinWindow = (cluster: SeedCluster): boolean =>
    Date.parse(cluster.latestCommitDateIso) >= sinceMs;
  // Targeted lanes ignore the window unless --since was explicit; explicit
  // since selects whole clusters in or out, it never reshapes them.
  const targetedCandidates =
    sinceExplicit && (opts.path || opts.commit)
      ? canonicalClusters.filter(withinWindow)
      : canonicalClusters;
  let selectedClusters = history.clusters;
  let ownership: SeedFileOwnership[] = [];
  let coverageComplete = false;
  let importanceTruncated = false;
  let importanceDeferred = false;
  // When the importance lane runs, every unselected mass-bearing cluster is
  // its candidate — including recency-cap leftovers — so its counts alone
  // are the beyond-budget tally; adding the recency counts would double it.
  let importanceLaneRan = false;
  let importanceCommitsBeyond = 0;
  let importanceClustersBeyond = 0;
  let probeMedianMs: number | null = null;
  if (opts.path && preflight.partialClone) {
    const touched = targetedCandidates.filter((cluster) => clusterTouchesPath(cluster, opts.path!));
    const touchMass = new Map(
      touched.flatMap((cluster) =>
        [cluster.headSha, ...cluster.commits.map((commit) => commit.sha)].map(
          (sha) => [sha, 1] as const
        )
      )
    );
    const selection = selectImportanceClusters(targetedCandidates, touchMass, {
      maxCommits,
      maxClusters: DEFAULT_ARTIFACT_CEILING,
    });
    selectedClusters = selection.clusters;
    importanceTruncated = selection.truncated;
    importanceLaneRan = true;
    importanceCommitsBeyond = selection.candidateCommitCount - selection.selectedCommitCount;
    importanceClustersBeyond = selection.candidateClusterCount - selection.clusters.length;
  } else if (opts.path || (!opts.commit && !preflight.partialClone)) {
    const ranking = await rankSeedImportance(ctx.repo, {
      branchSha: history.branch.sha,
      commits: history.graphCommits,
      historyCommitCount: preflight.historyCommitCount,
      ...(opts.path ? { path: opts.path } : {}),
      force: opts.importance === true || opts.path !== undefined,
    });
    ownership = ranking.ownership;
    coverageComplete =
      ranking.status === 'complete' &&
      opts.path === undefined &&
      ranking.ownership.every((file) => file.complete);
    probeMedianMs = ranking.probeMedianMs;
    if (ranking.status === 'deferred') {
      importanceDeferred = true;
    } else {
      const recencyKeys = new Set(history.clusters.map((cluster) => cluster.key));
      const recencyCommitCount = history.clusters.reduce(
        (total, cluster) => total + cluster.commits.length,
        0
      );
      const importance = selectImportanceClusters(
        opts.path ? targetedCandidates : canonicalClusters,
        ranking.lineMassByCommit,
        {
          maxCommits: opts.path ? maxCommits : Math.max(0, maxCommits - recencyCommitCount),
          maxClusters: opts.path
            ? DEFAULT_ARTIFACT_CEILING
            : Math.max(0, DEFAULT_ARTIFACT_CEILING - history.clusters.length),
          ...(opts.path ? {} : { excludedClusterKeys: recencyKeys }),
        }
      );
      importanceTruncated = importance.truncated;
      importanceLaneRan = true;
      importanceCommitsBeyond = importance.candidateCommitCount - importance.selectedCommitCount;
      importanceClustersBeyond = importance.candidateClusterCount - importance.clusters.length;
      selectedClusters = opts.path
        ? importance.clusters
        : [...history.clusters, ...importance.clusters];
    }
  } else if (preflight.partialClone && !opts.commit) {
    importanceDeferred = true;
  }
  selectedClusters.sort(
    (left, right) =>
      left.firstParentPosition - right.firstParentPosition || (left.key < right.key ? -1 : 1)
  );
  const selectedCommitCount = selectedClusters.reduce(
    (total, cluster) => total + cluster.commits.length,
    0
  );
  const commitsBeyondBudget = importanceLaneRan
    ? importanceCommitsBeyond
    : history.truncatedCommitCount;
  const clustersBeyondBudget = importanceLaneRan
    ? importanceClustersBeyond
    : history.truncatedClusterCount;
  const truncationCounts = importanceLaneRan
    ? {
        mass_bearing_commits_beyond: commitsBeyondBudget,
        mass_bearing_clusters_beyond: clustersBeyondBudget,
      }
    : {
        commits_beyond: commitsBeyondBudget,
        clusters_beyond: clustersBeyondBudget,
      };
  if (opts.commit && selectedCommitCount > maxCommits) {
    throw invalidInput(
      `The canonical cluster for ${opts.commit} expands to ${selectedCommitCount} commits, exceeding --max-commits ${maxCommits}.`
    );
  }
  const dryRun = opts.dryRun === true || opts.yes !== true;
  let coverageScan = await collectCoveredShas(ctx);
  const notes: string[] = [];
  // Materialize before the pre-filter reads coverage: the restored artifacts
  // become locally covered, so the same run that reports them also makes
  // `list --imported`, `search` and `stats` show them in this checkout.
  const restoration = dryRun
    ? { restored: 0, failed: 0 }
    : await restoreArchivedImports(ctx, coverageScan.restorableImports);
  if (restoration.restored > 0) {
    coverageScan = await collectCoveredShas(ctx);
    notes.push(
      `Restored ${restoration.restored} artifact${restoration.restored === 1 ? '' : 's'} ` +
        'from the shared project archive into this checkout.'
    );
  }
  if (restoration.failed > 0) {
    notes.push(
      `${restoration.failed} archived artifact${restoration.failed === 1 ? '' : 's'} could not be ` +
        'restored into this checkout; they stay covered but unreadable here.'
    );
  }
  if (dryRun && coverageScan.restorableImports.length > 0) {
    notes.push(
      `${coverageScan.restorableImports.length} imported artifact` +
        `${coverageScan.restorableImports.length === 1 ? '' : 's'} live in the shared project ` +
        'archive but not in this checkout; the apply restores them here.'
    );
  }
  const { covered, localCovered, lossyArchivedThreads } = coverageScan;
  if (lossyArchivedThreads > 0) {
    notes.push(
      `${lossyArchivedThreads} archived thread${lossyArchivedThreads === 1 ? '' : 's'} with ` +
        'corrupt event lines contributed head-sha coverage from the readable prefix only; ' +
        'commit-range expansion was skipped for them.'
    );
  }
  if (sinceExplicit && (opts.commit || opts.path)) {
    notes.push(
      `Honoring explicit --since ${history.sinceIso}; targeted runs ignore the selection window by default.`
    );
  }
  if (selectedClusters.length === 0) {
    if (commitSha) {
      const sha7 = commitSha.slice(0, 7);
      const containing = canonicalClusters.filter((cluster) =>
        cluster.commits.some((member) => member.sha === commitSha)
      );
      if (containing.length === 0 && covered.has(commitSha)) {
        notes.push(
          `commit ${sha7} is already covered by an imported or captured artifact; ` +
            'use `orcaops seed enrich --artifact <id> --dry-run` when the covering ' +
            'artifact is an imported Git thread.'
        );
      } else if (containing.length > 0 && sinceExplicit && !containing.some(withinWindow)) {
        notes.push(
          `commit ${sha7} falls outside the selection window (--since ${history.sinceIso}); ` +
            'targeted runs ignore the window by default — drop --since to import its cluster.'
        );
      } else if (containing.length > 0) {
        notes.push(`commit ${sha7} matched a cluster, but the current filters excluded it.`);
      } else {
        notes.push(`commit ${sha7} is not part of any seedable cluster on ${history.branch.ref}.`);
      }
    } else if (opts.path) {
      const touching = canonicalClusters.filter((cluster) =>
        clusterTouchesPath(cluster, opts.path!)
      );
      if (touching.length === 0) {
        notes.push(`No seedable cluster touches ${opts.path} on ${history.branch.ref}.`);
      } else if (sinceExplicit && !touching.some(withinWindow)) {
        notes.push(
          `All ${touching.length} cluster(s) touching ${opts.path} fall outside the selection ` +
            `window (--since ${history.sinceIso}); targeted runs ignore the window by default — ` +
            'drop --since to import them.'
        );
      } else {
        notes.push(
          `Clusters touching ${opts.path} own no lines in the current tree, so none were selected.`
        );
      }
    } else if (history.windowExcludedClusterCount > 0) {
      notes.push(
        `No clusters selected: ${history.windowExcludedClusterCount} candidate cluster(s) fall ` +
          `outside the selection window (--since ${history.sinceIso}).`
      );
    } else {
      notes.push('No clusters matched the current selection filters.');
    }
  }
  const selection: SeedSelectionRecord = {
    since: history.sinceIso,
    since_explicit: sinceExplicit,
    max_commits: maxCommits,
    author: opts.author ?? null,
    include_bots: opts.includeBots ?? false,
    path: opts.path ?? null,
    commit: opts.commit ?? null,
    importance: opts.importance ?? false,
  };
  const {
    precious,
    journal,
    location: stateLocation,
  } = await loadSeedStateForWrite(ctx.repo, getInvocationEnv(), ctx.repoRoot, ctx.config);
  journal.options_hash = optionsHash(selection, history.branch.sha);
  precious.pr_context = precious.pr_context || opts.prContext === true;
  if (shouldShowCommitGraphHint(preflight, opts, precious)) {
    preflight.warnings.push(COMMIT_GRAPH_WARNING);
    precious.commit_graph_hint_shown = true;
  }
  // The ledger accounts for runs that produced artifacts, so only an apply
  // mints a job id — stamping a dry run would name a run that wrote nothing.
  const job: ArtifactOriginJob | undefined = dryRun
    ? undefined
    : { job_id: uuidv7(), kind: seedJobKind(opts, journal) };
  const importedAt = new Date().toISOString();
  const syntheses = selectedClusters.map((cluster) =>
    synthesizeSeedCluster({
      cluster,
      branch: history.branch.ref,
      rootSha,
      installNonce: precious.install_nonce,
      importedAt,
      toolVersion: CLI_VERSION,
      ...(job ? { job } : {}),
    })
  );
  let pending: SeedClusterSynthesis[] = [];
  let coveredClusters = 0;
  let coveredViaArchive = 0;
  const skips: Array<{ cluster_key: string; reason: string }> = [];
  for (const synthesis of syntheses) {
    const existing = ctx.store.store.getArtifact(synthesis.artifactId);
    // Deliberately the CACHE, not the event log. A row missing for a thread
    // the log proves complete is exactly what must route the cluster into the
    // resume lane, where the write path repairs it. Reading the log here would
    // classify it already-imported and leave the cache wrong forever.
    const existingSummary = ctx.store.store.getSummary(synthesis.artifactId);
    if (existing && !existingSummary) {
      pending.push(synthesis);
      continue;
    }
    if (existingSummary || clusterIsCovered(synthesis.cluster, covered)) {
      coveredClusters += 1;
      if (!existingSummary && !clusterIsCovered(synthesis.cluster, localCovered)) {
        coveredViaArchive += 1;
      }
      // A preview never persists cluster entries: journal.clusters records
      // apply outcomes only, so `seed status` cannot flip to partial off a
      // dry run and `writing` stays a trustworthy crash-resume signal.
      if (!dryRun) {
        journal.clusters[synthesis.cluster.key] = {
          artifact_id: synthesis.artifactId,
          status: existingSummary ? 'complete' : 'covered',
        };
      }
      skips.push({
        cluster_key: synthesis.cluster.key,
        reason: existingSummary ? 'already-imported' : 'covered-by-captured-work',
      });
      continue;
    }
    pending.push(synthesis);
    if (!dryRun) {
      journal.clusters[synthesis.cluster.key] = {
        artifact_id: synthesis.artifactId,
        status: 'pending',
      };
    }
  }
  pending.sort((left, right) => {
    const leftIncomplete = ctx.store.store.getArtifact(left.artifactId) !== null ? 1 : 0;
    const rightIncomplete = ctx.store.store.getArtifact(right.artifactId) !== null ? 1 : 0;
    return rightIncomplete - leftIncomplete;
  });
  const coveredClusterReasons = new Map(
    skips
      .filter(
        (
          skip
        ): skip is {
          cluster_key: string;
          reason: 'already-imported' | 'covered-by-captured-work';
        } => skip.reason === 'already-imported' || skip.reason === 'covered-by-captured-work'
      )
      .map((skip) => [skip.cluster_key, skip.reason] as const)
  );
  const enrichment = await resolveSeedEnrichment(ctx.repoRoot, ctx.config, pending, {
    ...(opts.enrichmentDir ? { enrichmentDir: opts.enrichmentDir } : {}),
    optionsHash: journal.options_hash,
    prContextConsented: precious.pr_context,
    coveredClusters: coveredClusterReasons,
  });
  if (enrichment.report.invalid.length > 0) {
    const details = enrichment.report.invalid
      .map((entry) => `${entry.file}: ${entry.reason}`)
      .join('; ');
    throw invalidInput(
      `${enrichment.report.invalid.length} enrichment file(s) were rejected; ` +
        `no pending clusters were imported. Correct or remove them and retry. ${details}`
    );
  }
  pending = enrichment.syntheses;
  // Crash residue from an earlier seed run. An artifact this run will write
  // resumes for free — the deterministic open key replays onto the stranded
  // checkpoint and the close completes it — but one outside the pending set
  // has nothing left to close it, and a backdated dangling open matches every
  // future live close's wall-clock overlap scan. Abandon those.
  const recovery = { resumed: 0, abandoned: 0 };
  if (!dryRun && openCheckpointGuard.stranded.length > 0) {
    const pendingIds = new Set(pending.map((synthesis) => synthesis.artifactId));
    for (const stranded of openCheckpointGuard.stranded) {
      if (pendingIds.has(stranded.artifact_id)) {
        recovery.resumed += 1;
        continue;
      }
      await ctx.store.writeCheckpointAbandoned(
        {
          artifact_id: stranded.artifact_id,
          n: stranded.checkpoint_n,
          reason: 'Interrupted seed run; this cluster is outside the current selection.',
        },
        {
          idempotencyKey: `orcaops-seed:recover-abandon:${stranded.artifact_id}:${stranded.checkpoint_n}`,
          invokedByAgent: 'other',
        }
      );
      recovery.abandoned += 1;
    }
    notes.push(
      `${openCheckpointGuard.recovery_message} — ` +
        `resumed ${recovery.resumed}, abandoned ${recovery.abandoned}.`
    );
  }
  // Targeted lanes never ran the whole-history importance pass, so they
  // preserve the stored flag instead of clearing it; previews report the
  // would-be value without persisting it.
  const pendingImportance =
    opts.commit || opts.path ? precious.pending_importance : importanceDeferred;
  if (!dryRun) precious.pending_importance = pendingImportance;
  if (job) {
    recordSeedJob(journal.jobs, job.job_id, {
      kind: job.kind,
      // Job-ledger attribution only: the artifact-level agent stays
      // 'other' because imported history is not the invoking agent's work.
      invoked_by: ctx.invokingAgent.agent,
      started_at: new Date().toISOString(),
      budget: {
        max_commits: maxCommits,
        selected_commits: selectedCommitCount,
        ...(commitsBeyondBudget > 0 ? { commits_beyond: commitsBeyondBudget } : {}),
        ...(clustersBeyondBudget > 0 ? { clusters_beyond: clustersBeyondBudget } : {}),
      },
      skipped_covered: coveredClusters,
      ...(skips.length > 0 ? { skips } : {}),
    });
  }
  // The precious write still runs on previews: it records --pr-context
  // consent and the show-once commit-graph hint, neither of which `seed
  // status` reports. The scratch journal and the coverage report are both
  // status-visible, so only applies write them.
  await writeSeedPreciousState(stateLocation, precious);
  if (!dryRun) await writeSeedJournal(ctx.repoRoot, ctx.config, journal);

  const preview = pending.map((synthesis) => ({
    artifact_id: synthesis.artifactId,
    cluster_key: synthesis.cluster.key,
    kind: synthesis.cluster.kind,
    label: synthesis.plan.label,
    commits: synthesis.cluster.commits.length,
    checkpoints: synthesis.checkpoints.length,
    date: synthesis.cluster.displayDateIso,
    warnings: synthesis.cluster.warnings,
  }));
  if (dryRun) {
    const bundles = await writeSeedEnrichmentBundles(ctx.repoRoot, ctx.config, pending, {
      optionsHash: journal.options_hash,
      prContextConsented: precious.pr_context,
      selection,
    });
    return {
      mode: 'dry-run',
      confirmation_required: opts.yes !== true,
      open_checkpoint_guard: openCheckpointGuard,
      branch: history.branch,
      checked_out: {
        branch: history.checkedOut.branch,
        head_sha: history.checkedOut.headSha,
        excluded_from_selected_commit_count: history.checkedOut.excludedCommitCount,
        fully_represented: history.checkedOut.fullyRepresented,
      },
      since: history.sinceIso,
      notes,
      preflight,
      clusters: preview,
      totals: {
        selected: syntheses.length,
        pending: pending.length,
        covered: coveredClusters,
        covered_via_archive: coveredViaArchive,
        commits: pending.reduce((total, item) => total + item.cluster.commits.length, 0),
      },
      truncation: {
        recency_commit_cap: history.truncatedByCommitCap,
        recency_artifact_ceiling: history.truncatedByArtifactCeiling,
        importance: importanceTruncated,
        ...truncationCounts,
      },
      pending_importance: pendingImportance,
      importance: {
        deferred: importanceDeferred,
        probe_median_ms: probeMedianMs,
      },
      enrichment: {
        bundle_directory: bundles.directory,
        bundle_count: bundles.count,
        cue_bearing_bundle_count: bundles.cueBearingCount,
        cue_free_bundle_count: bundles.cueFreeCount,
        candidate_cue_count: bundles.candidateCueCount,
        estimated_reading_tasks: bundles.estimatedReadingTasks,
        pr_context_consented: precious.pr_context,
      },
    };
  }

  const prepared = await prepareSeedSnapshots(ctx.repo, pending, {
    fingerprints: ctx.config.diff_fingerprint.enabled && !preflight.partialClone,
    maxDiffBytes: ctx.config.diff_fingerprint.max_diff_bytes,
  });
  const results = [];
  // "Enriched N" must count artifacts actually written enriched, not
  // enrichment files that merely matched — a write failure after a match
  // must not inflate the count.
  let enrichedWritten = 0;
  let skeletonWritten = 0;
  for (const synthesis of pending) {
    journal.clusters[synthesis.cluster.key] = {
      artifact_id: synthesis.artifactId,
      status: 'writing',
    };
    await writeSeedJournal(ctx.repoRoot, ctx.config, journal);
    try {
      const result = await writeSeedCluster(ctx, synthesis, { prepared });
      results.push(result);
      if (result.outcome !== 'complete') {
        if (synthesis.plan.origin?.enriched_at) enrichedWritten += 1;
        else skeletonWritten += 1;
      }
      journal.clusters[synthesis.cluster.key] = {
        artifact_id: synthesis.artifactId,
        status: 'complete',
      };
    } catch (error) {
      journal.clusters[synthesis.cluster.key] = {
        artifact_id: synthesis.artifactId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await writeSeedJournal(ctx.repoRoot, ctx.config, journal);
  }
  // Cached AFTER the writes, never before: the report counts lines owned by
  // imported artifacts, so caching it up front publishes a 0%-covered report
  // that an interrupted run then leaves behind as the last word.
  await cacheCoverage(
    ctx,
    history.branch.sha,
    ownership,
    coverageComplete,
    opts.path !== undefined
  );
  const writtenIds = new Set(
    results.filter((result) => result.outcome !== 'complete').map((result) => result.artifactId)
  );
  const writtenFiles = pending
    .filter((synthesis) => writtenIds.has(synthesis.artifactId))
    .flatMap((synthesis) => synthesis.cluster.files);
  const clearedAreas: Array<{ area: string; declined: boolean; offered: boolean }> = [];
  for (const [area, entry] of Object.entries(precious.discovery_areas)) {
    if (importSupersedesArea(area, writtenFiles, opts)) {
      clearSeedArea(precious, area);
      clearedAreas.push({
        area,
        declined: entry.declined_at !== undefined,
        offered: entry.offered_at !== undefined,
      });
    }
  }
  if (clearedAreas.length > 0) {
    await writeSeedPreciousState(stateLocation, precious);
    for (const cleared of clearedAreas) {
      if (cleared.declined) notes.push(`cleared decline for ${cleared.area}`);
      if (cleared.offered) notes.push(`cleared offer cooldown for ${cleared.area}`);
    }
  }
  const jobRecord = job ? journal.jobs[job.job_id] : undefined;
  if (jobRecord) {
    const finishedAt = new Date();
    jobRecord.finished_at = finishedAt.toISOString();
    jobRecord.wall_time_ms = Math.max(0, finishedAt.getTime() - Date.parse(jobRecord.started_at));
    await writeSeedJournal(ctx.repoRoot, ctx.config, journal);
  }
  await cacheCoverage(
    ctx,
    history.branch.sha,
    ownership,
    coverageComplete,
    opts.path !== undefined
  );
  return {
    mode: 'applied',
    branch: history.branch,
    since: history.sinceIso,
    notes,
    preflight,
    recovery,
    restored_from_archive: restoration.restored,
    seeded: results,
    totals: {
      selected: syntheses.length,
      created: results.filter((result) => result.outcome === 'created').length,
      resumed: results.filter((result) => result.outcome === 'resumed').length,
      already_complete: results.filter((result) => result.outcome === 'complete').length,
      covered: coveredClusters,
      covered_via_archive: coveredViaArchive,
      failed: Object.values(journal.clusters).filter((entry) => entry.status === 'failed').length,
    },
    truncation: {
      recency_commit_cap: history.truncatedByCommitCap,
      recency_artifact_ceiling: history.truncatedByArtifactCeiling,
      importance: importanceTruncated,
      ...truncationCounts,
    },
    pending_importance: pendingImportance,
    importance: {
      deferred: importanceDeferred,
      probe_median_ms: probeMedianMs,
    },
    enrichment: {
      ...enrichment.report,
      applied: enrichedWritten,
      skeleton: skeletonWritten,
    } satisfies SeedEnrichmentReport,
  };
}

export async function repairSeed(repoRoot: string): Promise<Record<string, unknown>> {
  const ctx = await buildContext({ root: repoRoot });
  try {
    return await withSeedRunLock(ctx.repo, getInvocationEnv(), () => runSeed(ctx, { yes: true }));
  } finally {
    ctx.store.close();
  }
}

export interface SeedJobSummary {
  job_id: string;
  kind: string | null;
  artifacts: number;
  enriched: number;
  first_imported_at: string | null;
  last_imported_at: string | null;
  invoked_by?: string;
  wall_time_ms?: number;
  budget?: {
    max_commits: number;
    selected_commits: number;
    commits_beyond?: number;
    clusters_beyond?: number;
  };
  skipped_covered?: number;
  skips?: Array<{ cluster_key: string; reason: string }>;
}

/**
 * The ledger IS the store: imported artifacts carry the job that produced
 * them, so grouping survives rebuilds, archive restores, and worktree moves.
 * Imports written before the ledger existed have no job and collect under one
 * honest bucket rather than being attributed to a run nobody recorded.
 */
export const PRE_LEDGER_JOB_ID = 'pre-1.1';

export interface SeedJobLedgerSource {
  listArtifacts(): ReadonlyArray<{ id: string; origin_kind?: string | null }>;
  readPlan(artifactId: string): Promise<{ origin?: ArtifactOrigin | undefined } | null>;
}

export async function buildSeedJobLedger(
  source: SeedJobLedgerSource,
  jobs: Record<string, SeedJobRecord>
): Promise<SeedJobSummary[]> {
  const grouped = new Map<string, SeedJobSummary>();
  for (const row of source.listArtifacts()) {
    if (row.origin_kind !== 'git-import') continue;
    const plan = await source.readPlan(row.id);
    const origin = plan?.origin;
    if (!origin) continue;
    const jobId = origin.job?.job_id ?? PRE_LEDGER_JOB_ID;
    const summary = grouped.get(jobId) ?? {
      job_id: jobId,
      kind: origin.job?.kind ?? null,
      artifacts: 0,
      enriched: 0,
      first_imported_at: null,
      last_imported_at: null,
    };
    summary.artifacts += 1;
    if (origin.enriched_at !== null) summary.enriched += 1;
    if (summary.first_imported_at === null || origin.imported_at < summary.first_imported_at) {
      summary.first_imported_at = origin.imported_at;
    }
    if (summary.last_imported_at === null || origin.imported_at > summary.last_imported_at) {
      summary.last_imported_at = origin.imported_at;
    }
    grouped.set(jobId, summary);
  }
  for (const [jobId, summary] of grouped) {
    // Run extras live in the disposable journal, so they render when the
    // cache still has them and are simply absent otherwise.
    const extras = jobs[jobId];
    if (!extras) continue;
    if (extras.invoked_by !== undefined) summary.invoked_by = extras.invoked_by;
    if (extras.wall_time_ms !== undefined) summary.wall_time_ms = extras.wall_time_ms;
    if (extras.budget !== undefined) summary.budget = extras.budget;
    if (extras.skipped_covered !== undefined) summary.skipped_covered = extras.skipped_covered;
    if (extras.skips !== undefined) summary.skips = extras.skips;
  }
  return [...grouped.values()].sort((left, right) =>
    (left.first_imported_at ?? '') < (right.first_imported_at ?? '')
      ? -1
      : (left.first_imported_at ?? '') > (right.first_imported_at ?? '')
        ? 1
        : left.job_id < right.job_id
          ? -1
          : 1
  );
}

function formatBeyondBudget(counts: { commits_beyond: number; clusters_beyond: number }): string {
  const commits = counts.commits_beyond;
  const clusters = counts.clusters_beyond;
  return (
    `${commits} commit${commits === 1 ? '' : 's'}/` +
    `${clusters} cluster${clusters === 1 ? '' : 's'} beyond the budget`
  );
}

/**
 * Budget completeness is defined by the newest whole-history job (initial /
 * importance / resume): targeted --commit/--path jobs never widen the budget,
 * so they must not mask an earlier truncated full run.
 */
function latestBudgetTruncation(
  jobs: Record<string, SeedJobRecord>
): { commits_beyond: number; clusters_beyond: number } | null {
  const latest = Object.values(jobs)
    .filter((job) => job.kind === 'initial' || job.kind === 'importance' || job.kind === 'resume')
    .sort((left, right) => (left.started_at < right.started_at ? 1 : -1))[0];
  const budget = latest?.budget;
  if (!budget) return null;
  const commits = budget.commits_beyond ?? 0;
  const clusters = budget.clusters_beyond ?? 0;
  return commits > 0 || clusters > 0
    ? { commits_beyond: commits, clusters_beyond: clusters }
    : null;
}

/**
 * Coverage rows are keyed by top-level directory, so a decline or offer
 * recorded against anything else would suppress nothing forever (offers
 * share the declines' key space in `discovery_areas`). Multi-segment
 * areas normalize to their top-level directory; names that are not
 * top-level entries are rejected, with the containing top-level directory
 * suggested when one exists one level down.
 */
async function validateSeedArea(
  repoRoot: string,
  rawArea: string
): Promise<
  | { ok: true; area: string; normalizedFrom: string | null }
  | { ok: false; area: string; suggestion: string | null }
> {
  const normalized = normalizeSeedArea(rawArea);
  const top = normalized.split('/')[0]!;
  const entries = await readdir(repoRoot, { withFileTypes: true });
  const topLevel = new Set(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== '.git')
      .map((entry) => entry.name)
  );
  if (top === '.' || topLevel.has(top)) {
    return { ok: true, area: top, normalizedFrom: top === normalized ? null : normalized };
  }
  let suggestion: string | null = null;
  for (const dir of [...topLevel].sort()) {
    try {
      if ((await stat(path.join(repoRoot, dir, normalized))).isDirectory()) {
        suggestion = dir;
        break;
      }
    } catch {
      // not under this top-level directory; keep looking
    }
  }
  return { ok: false, area: normalized, suggestion };
}

export async function seedStatusAction(
  opts: {
    decline?: string;
    offered?: string;
    offerAgain?: string;
    jobs?: boolean;
    json?: boolean;
  } = {}
): Promise<void> {
  try {
    const ctx = await buildContext();
    try {
      // A blank selector is not an area; recording it would suppress nothing
      // forever, so say it was ignored instead of exiting 0 silently.
      const declineIgnored = opts.decline !== undefined && normalizeSeedArea(opts.decline) === '';
      const declineValidation =
        opts.decline !== undefined && !declineIgnored
          ? await validateSeedArea(ctx.repoRoot, opts.decline)
          : null;
      const declineArea = declineValidation?.ok === true ? declineValidation.area : null;
      // Offers share the declines' area key space, so they take the same
      // validation and top-level widening — a verbatim nested key would
      // orphan a cooldown row no import or offer-again could ever address.
      const offeredIgnored = opts.offered !== undefined && normalizeSeedArea(opts.offered) === '';
      const offeredValidation =
        opts.offered !== undefined && !offeredIgnored
          ? await validateSeedArea(ctx.repoRoot, opts.offered)
          : null;
      const offeredArea = offeredValidation?.ok === true ? offeredValidation.area : null;
      // A blank --offer-again is ignored-with-a-line exactly like the other
      // area selectors; clearing by '' could never match a remembered area.
      const offerAgainIgnored =
        opts.offerAgain !== undefined && normalizeSeedArea(opts.offerAgain) === '';
      const offerAgainArea =
        opts.offerAgain !== undefined && !offerAgainIgnored
          ? normalizeSeedArea(opts.offerAgain)
          : null;
      let offerAgainCleared = false;
      // What the cleared row actually held — the confirmation line must not
      // claim a decline was cleared when only an offer cooldown was.
      let offerAgainClearedDecline = false;
      let offerAgainClearedOffer = false;
      // Every precious-state write goes through the CLI, so the discovery
      // workflow reads one source of suppression truth and owns no file format.
      if (declineArea || offeredArea || offerAgainArea) {
        await withSeedRunLock(ctx.repo, getInvocationEnv(), async () => {
          const { precious, location } = await loadSeedStateForWrite(
            ctx.repo,
            getInvocationEnv(),
            ctx.repoRoot,
            ctx.config
          );
          if (declineArea) {
            rememberDeclinedSeedArea(
              precious,
              declineArea,
              declineValidation?.ok === true ? declineValidation.normalizedFrom : null
            );
          }
          if (offeredArea) recordSeedAreaOffered(precious, offeredArea);
          if (offerAgainArea) {
            const prior = precious.discovery_areas[offerAgainArea];
            offerAgainCleared = clearSeedArea(precious, offerAgainArea);
            offerAgainClearedDecline = offerAgainCleared && prior?.declined_at !== undefined;
            offerAgainClearedOffer = offerAgainCleared && prior?.offered_at !== undefined;
          }
          await writeSeedPreciousState(location, precious);
        });
      }
      const [{ precious, journal }, coverage, currentHeadSha] = await Promise.all([
        readSeedState(ctx.repo, getInvocationEnv(), ctx.repoRoot, ctx.config),
        readSeedCoverage(ctx.repoRoot, ctx.config),
        ctx.repo.getHeadSha(),
      ]);
      const importedRows = ctx.store.store
        .listArtifacts()
        .filter((artifact) => artifact.origin_kind === 'git-import');
      const importedArtifacts = importedRows.length;
      // Commit-lane applies never blame files, because a blame bounded to
      // the cluster's touched files would understate the per-directory
      // denominators the coverage rows aggregate (and blaming whole
      // directories is unbounded latency). The report therefore cannot see
      // those imports; count the ones it predates and disclose them rather
      // than silently understating coverage.
      let commitImportsExcludedFromCoverage = 0;
      for (const row of importedRows) {
        const origin = (await ctx.store.readPlan(row.id))?.origin;
        if (origin?.job?.kind !== 'commit') continue;
        if (coverage === null || origin.imported_at > coverage.generated_at) {
          commitImportsExcludedFromCoverage += 1;
        }
      }
      const clusterCounts = journal
        ? Object.values(journal.clusters).reduce<Record<string, number>>((counts, cluster) => {
            counts[cluster.status] = (counts[cluster.status] ?? 0) + 1;
            return counts;
          }, {})
        : {};
      const pendingImportance = precious?.pending_importance === true;
      const budgetTruncation = journal ? latestBudgetTruncation(journal.jobs) : null;
      const partial =
        pendingImportance ||
        budgetTruncation !== null ||
        (journal !== null &&
          Object.keys(journal.clusters).some((key) => {
            const status = journal.clusters[key]!.status;
            return status === 'pending' || status === 'writing' || status === 'failed';
          }));
      // A cluster stuck at `writing` is the fingerprint of an apply that died
      // mid-write — no other path leaves that status behind. The store is a
      // torn prefix of the run, so no coverage verdict computed over it may
      // present itself as complete or fresh.
      const interrupted =
        journal !== null &&
        Object.values(journal.clusters).some((cluster) => cluster.status === 'writing');
      const failures = journal
        ? Object.entries(journal.clusters)
            .filter(([, cluster]) => cluster.status === 'failed')
            .map(([clusterKey, cluster]) => ({
              cluster_key: clusterKey,
              artifact_id: cluster.artifact_id,
              error: cluster.error ?? 'unknown',
            }))
        : [];
      // Run state lives in the disposable journal, but imported artifacts in
      // the store are proof seed ran — a wiped cache must not claim never-run
      // beside a non-zero import count.
      const journalLost = journal === null && !pendingImportance && importedArtifacts > 0;
      // "complete" means the whole first-parent history was processed; a
      // store built only from --path/--commit jobs never was, so it must
      // not pair an unqualified "complete" with a partial coverage table.
      const jobRecords = journal ? Object.values(journal.jobs) : [];
      const targetedJobs = jobRecords.filter(
        (job) => job.kind === 'commit' || job.kind === 'path'
      ).length;
      const targetedOnly =
        journal !== null &&
        targetedJobs > 0 &&
        !jobRecords.some((job) => job.kind !== 'commit' && job.kind !== 'path');
      const result = {
        state:
          journal === null && !pendingImportance
            ? journalLost
              ? 'complete'
              : 'never-run'
            : partial
              ? 'partial'
              : targetedOnly
                ? 'targeted-only'
                : 'complete',
        ...(targetedOnly ? { targeted_jobs: targetedJobs, full_history_run: false } : {}),
        state_inferred_from_store: journalLost,
        budget_truncation: budgetTruncation,
        ...(declineIgnored || offeredIgnored || offerAgainIgnored
          ? { ignored_empty_area: true }
          : {}),
        ...(declineValidation?.ok === false
          ? {
              rejected_area: {
                area: declineValidation.area,
                suggestion: declineValidation.suggestion,
              },
            }
          : {}),
        ...(declineValidation?.ok === true && declineValidation.normalizedFrom !== null
          ? {
              normalized_area: {
                from: declineValidation.normalizedFrom,
                to: declineValidation.area,
              },
            }
          : {}),
        ...(declineValidation?.ok === true && declineValidation.normalizedFrom === null
          ? { declined_area: declineValidation.area }
          : {}),
        ...(offeredValidation?.ok === false
          ? {
              rejected_offered_area: {
                area: offeredValidation.area,
                suggestion: offeredValidation.suggestion,
              },
            }
          : {}),
        ...(offeredValidation?.ok === true && offeredValidation.normalizedFrom !== null
          ? {
              normalized_offered_area: {
                from: offeredValidation.normalizedFrom,
                to: offeredValidation.area,
              },
            }
          : {}),
        ...(offeredValidation?.ok === true && offeredValidation.normalizedFrom === null
          ? { offered_area: offeredValidation.area }
          : {}),
        ...(offerAgainArea !== null
          ? {
              offer_again: {
                area: offerAgainArea,
                cleared: offerAgainCleared,
                cleared_decline: offerAgainClearedDecline,
                cleared_offer: offerAgainClearedOffer,
              },
            }
          : {}),
        imported_artifacts: importedArtifacts,
        pending_importance: pendingImportance,
        clusters: clusterCounts,
        failures,
        // Kept as the flat list the discovery workflow already reads; the
        // `discovery` object carries the full three-state suppression view.
        declined_discovery_areas: declinedSeedAreas(precious),
        discovery: {
          declined: declinedSeedAreas(precious),
          offered: offeredSeedAreas(precious),
        },
        coverage,
        coverage_stale:
          coverage !== null && (interrupted || coverage.branch_sha !== currentHeadSha),
        coverage_interrupted: interrupted,
        coverage_excluded_commit_imports: commitImportsExcludedFromCoverage,
        ...(opts.jobs
          ? {
              jobs: await buildSeedJobLedger(
                {
                  listArtifacts: () => ctx.store.store.listArtifacts(),
                  readPlan: (artifactId) => ctx.store.readPlan(artifactId),
                },
                journal?.jobs ?? {}
              ),
            }
          : {}),
      };
      if (opts.json) {
        emitOk(result);
      } else {
        const lines = [
          ...(declineIgnored || offeredIgnored || offerAgainIgnored ? ['Ignored empty area.'] : []),
          ...(declineValidation?.ok === false
            ? [
                `Rejected --decline ${declineValidation.area}: areas are top-level ` +
                  'directories (the coverage-table rows)' +
                  (declineValidation.suggestion
                    ? ` — did you mean \`${declineValidation.suggestion}\`?`
                    : '.'),
              ]
            : []),
          ...(declineValidation?.ok === true && declineValidation.normalizedFrom !== null
            ? [
                `Declined ${declineValidation.area} ` +
                  `(normalized from ${declineValidation.normalizedFrom}; ` +
                  'areas are top-level directories — suppressing offers for ' +
                  `all of ${declineValidation.area}).`,
              ]
            : []),
          ...(declineValidation?.ok === true && declineValidation.normalizedFrom === null
            ? [
                `Declined ${declineValidation.area} — suppressing offers for ` +
                  `all of ${declineValidation.area}.`,
              ]
            : []),
          ...(offeredValidation?.ok === false
            ? [
                `Rejected --offered ${offeredValidation.area}: areas are top-level ` +
                  'directories (the coverage-table rows)' +
                  (offeredValidation.suggestion
                    ? ` — did you mean \`${offeredValidation.suggestion}\`?`
                    : '.'),
              ]
            : []),
          ...(offeredValidation?.ok === true && offeredValidation.normalizedFrom !== null
            ? [
                `Recorded offer for ${offeredValidation.area} ` +
                  `(normalized from ${offeredValidation.normalizedFrom}; ` +
                  'areas are top-level directories).',
              ]
            : []),
          ...(offeredValidation?.ok === true && offeredValidation.normalizedFrom === null
            ? [`Recorded offer for ${offeredValidation.area}.`]
            : []),
          ...(offerAgainArea !== null
            ? [
                !offerAgainCleared
                  ? `No decline or offer recorded for ${offerAgainArea}.`
                  : offerAgainClearedDecline && offerAgainClearedOffer
                    ? `Cleared decline and offer cooldown for ${offerAgainArea}.`
                    : offerAgainClearedOffer
                      ? `Cleared offer cooldown for ${offerAgainArea}.`
                      : `Cleared decline for ${offerAgainArea}.`,
              ]
            : []),
          `Seed state: ${result.state}` +
            (result.state === 'targeted-only'
              ? ` (${targetedJobs} path/commit job${targetedJobs === 1 ? '' : 's'}; ` +
                'no full-history run)'
              : '') +
            (budgetTruncation
              ? ` (budget-truncated — ${formatBeyondBudget(budgetTruncation)}; ` +
                'widen with --max-commits/--since)'
              : '') +
            (result.state_inferred_from_store
              ? ' (inferred from imported artifacts; the run journal cache was cleared)'
              : ''),
          `Imported artifacts: ${result.imported_artifacts}`,
        ];
        if (result.pending_importance) {
          lines.push('Importance lane pending — run `orcaops seed --importance`.');
        }
        for (const failure of result.failures) {
          lines.push(`Failed ${failure.cluster_key}: ${failure.error}`);
        }
        if (result.discovery.declined.length > 0) {
          lines.push(
            `Declined areas: ${result.discovery.declined.join(', ')} ` +
              '(clear one with `orcaops seed status --offer-again <area>`)'
          );
        }
        for (const offer of result.discovery.offered) {
          lines.push(
            `Offered ${offer.area} at ${offer.offered_at}` +
              `${offer.cooldown_active ? ' (cooldown active)' : ''}`
          );
        }
        const ledger = (result as { jobs?: SeedJobSummary[] }).jobs;
        if (ledger) {
          lines.push(`Generation jobs: ${ledger.length}`);
          for (const job of ledger) {
            const extras = [
              job.invoked_by === undefined ? null : `invoked by ${job.invoked_by}`,
              job.wall_time_ms === undefined ? null : `${job.wall_time_ms}ms`,
              job.budget === undefined
                ? null
                : `budget ${job.budget.selected_commits}/${job.budget.max_commits} commits`,
              job.skipped_covered === undefined ? null : `skipped ${job.skipped_covered}`,
            ].filter((part): part is string => part !== null);
            lines.push(
              `  ${job.job_id}  ${job.kind ?? 'unrecorded'}  ` +
                `${job.artifacts} artifact(s), ${job.enriched} enriched  ` +
                `${job.first_imported_at ?? 'unknown'}..${job.last_imported_at ?? 'unknown'}` +
                `${extras.length > 0 ? `  [${extras.join('; ')}]` : ''}`
            );
          }
        }
        if (coverage) {
          // An interrupted apply outranks the stored verdict: the report
          // describes a run that never finished, so it may claim neither
          // completeness nor freshness.
          lines.push(
            result.coverage_interrupted
              ? 'Coverage (interrupted run — rerun `orcaops seed --yes` to finish):'
              : `Coverage (${coverage.complete ? 'complete' : 'partial'}${result.coverage_stale ? ', stale' : ''}):`
          );
          for (const [directory, value] of Object.entries(coverage.directories)) {
            lines.push(
              // The report keys root-level files as '.'; label them
              // legibly without changing the stored key.
              `  ${directory === '.' ? '(root)' : directory}: ` +
                `${value.percent.toFixed(2)}% (${value.covered_lines}/${value.total_lines} lines)`
            );
          }
        } else {
          lines.push('Coverage: not calculated yet.');
        }
        if (commitImportsExcludedFromCoverage > 0) {
          lines.push(
            `Coverage excludes ${commitImportsExcludedFromCoverage} commit-lane ` +
              `import${commitImportsExcludedFromCoverage === 1 ? '' : 's'} — ` +
              'rerun a full or --path seed to refresh.'
          );
        }
        writeTerminalSafeStdout(`${lines.join('\n')}\n`);
      }
    } finally {
      ctx.store.close();
    }
  } catch (error) {
    if (opts.json) emitError(error);
    writeErrorLine(error);
    throw new CliExit(1);
  }
}

export function renderSeedResult(result: Record<string, unknown>): string {
  if (result.mode === 'push') {
    const totals = result.totals as Record<string, number>;
    return `Seed cloud push complete — pushed ${totals.pushed}; up to date ${totals.up_to_date}.\n`;
  }
  const branch = result.branch as { ref: string; source: string };
  const totals = result.totals as Record<string, number>;
  // "finished", not "completed": the latter contains "Seed complete" as a
  // substring, so a wrapper grepping for the clean headline would still match.
  const failedClusters = result.mode === 'dry-run' ? 0 : (totals.failed ?? 0);
  const headline =
    result.mode === 'dry-run'
      ? 'preview'
      : failedClusters > 0
        ? `finished with ${failedClusters} failure${failedClusters === 1 ? '' : 's'}`
        : 'complete';
  const lines = [`Seed ${headline} — ${branch.ref} (${branch.source})`];
  const preflight = result.preflight as SeedPreflight;
  for (const warning of preflight.warnings) lines.push(`warning: ${warning}`);
  if (result.mode === 'dry-run') {
    const openCheckpointGuard = result.open_checkpoint_guard as SeedOpenCheckpointGuard;
    if (openCheckpointGuard.message) lines.push(`blocked: ${openCheckpointGuard.message}`);
    if (openCheckpointGuard.recovery_message) {
      lines.push(`${openCheckpointGuard.recovery_message} — the next apply resolves it.`);
    }
    const checkedOut = result.checked_out as {
      branch: string | null;
      head_sha: string | null;
      excluded_from_selected_commit_count: number;
      fully_represented: boolean;
    };
    if (!checkedOut.fully_represented) {
      const checkoutRef = checkedOut.branch ?? checkedOut.head_sha ?? 'HEAD';
      lines.push(
        `warning: checked-out ${checkoutRef} has ` +
          `${checkedOut.excluded_from_selected_commit_count} commit(s) not reachable from ` +
          `${branch.ref}; preview it with \`orcaops seed --branch ${checkoutRef} --dry-run\`.`
      );
    }
    for (const cluster of result.clusters as Array<Record<string, unknown>>) {
      lines.push(
        `  ${cluster.date}  ${cluster.kind}  ${cluster.label}  ` +
          `(${cluster.commits} commit${cluster.commits === 1 ? '' : 's'})`
      );
    }
    lines.push(`Pending ${totals.pending}; covered ${totals.covered}; commits ${totals.commits}`);
    if (totals.covered_via_archive > 0) {
      lines.push(`${totals.covered_via_archive} covered via the shared project archive.`);
    }
    for (const note of (result.notes as string[] | undefined) ?? []) lines.push(note);
    const enrichment = result.enrichment as {
      bundle_directory: string;
      bundle_count: number;
      cue_bearing_bundle_count: number;
      cue_free_bundle_count: number;
      candidate_cue_count: number;
      estimated_reading_tasks: number;
    };
    lines.push(`Enrichment bundles: ${enrichment.bundle_count} in ${enrichment.bundle_directory}`);
    lines.push(
      `Candidate cues: ${enrichment.candidate_cue_count} across ` +
        `${enrichment.cue_bearing_bundle_count} bundle(s); ` +
        `${enrichment.cue_free_bundle_count} bundle(s) have none. ` +
        `Estimated reading: ${enrichment.estimated_reading_tasks} distinct task(s).`
    );
    if (result.confirmation_required && !openCheckpointGuard.blocked) {
      lines.push(
        (totals.pending ?? 0) > 0
          ? 'Run `orcaops seed --yes` to write these artifacts.'
          : 'Nothing pending to write — no apply needed.'
      );
    }
  } else {
    for (const seeded of result.seeded as Array<{ artifactId: string; outcome: string }>) {
      lines.push(`  ${seeded.outcome}  ${seeded.artifactId}`);
    }
    lines.push(
      `Created ${totals.created}; resumed ${totals.resumed}; covered ${totals.covered}; failed ${totals.failed}`
    );
    if (failedClusters > 0) {
      lines.push(
        'Run `orcaops seed status --json` for the per-cluster errors. A failure that ' +
          'names a cache disagreement is repaired by `orcaops rebuild`, which re-derives ' +
          'the cache from the durable event logs — then re-run `orcaops seed --yes`.'
      );
    }
    if (totals.covered_via_archive > 0) {
      lines.push(`${totals.covered_via_archive} covered via the shared project archive.`);
    }
    for (const note of (result.notes as string[] | undefined) ?? []) lines.push(note);
    const enrichment = result.enrichment as SeedEnrichmentReport;
    lines.push(`Enriched ${enrichment.applied}; skeleton ${enrichment.skeleton}.`);
    const dispositions = enrichment.nomination_dispositions;
    if (dispositions) {
      lines.push(
        `${dispositions.nominations} nomination${dispositions.nominations === 1 ? '' : 's'}: ` +
          `${dispositions.minted} minted, ${dispositions.skipped} skipped with reasons.`
      );
    }
    if (enrichment.invalid.length > 0) {
      lines.push(`${enrichment.invalid.length} invalid enrichment files fell back to skeleton:`);
      for (const entry of enrichment.invalid) {
        lines.push(`  rejected ${entry.file}: ${entry.reason}`);
      }
    }
    for (const entry of enrichment.warnings ?? []) {
      lines.push(`  warning ${entry.file}: ${entry.warning}`);
    }
    const coveredTargets = enrichment.unmatched.filter(
      (entry) => entry.reason !== 'no-matching-cluster'
    );
    const staleTargets = enrichment.unmatched.filter(
      (entry) => entry.reason === 'no-matching-cluster'
    );
    if (coveredTargets.length > 0) {
      lines.push(
        `${coveredTargets.length} enrichment file(s) target clusters that are already ` +
          'imported or covered by captured work. For an imported artifact, generate a fresh ' +
          'amendment bundle with `orcaops seed enrich --artifact <id> --dry-run`:'
      );
      for (const entry of coveredTargets) {
        lines.push(`  ${entry.reason} ${entry.file}: cluster_key ${entry.cluster_key}`);
      }
    }
    if (staleTargets.length > 0) {
      lines.push(
        `${staleTargets.length} enrichment file(s) matched no current cluster ` +
          '(stale or unknown cluster_key):'
      );
      for (const entry of staleTargets) {
        lines.push(`  unmatched ${entry.file}: cluster_key ${entry.cluster_key}`);
      }
    }
  }
  const truncation = result.truncation as {
    recency_commit_cap: boolean;
    recency_artifact_ceiling: boolean;
    importance: boolean;
    commits_beyond?: number;
    clusters_beyond?: number;
    mass_bearing_commits_beyond?: number;
    mass_bearing_clusters_beyond?: number;
  };
  const massBearing = truncation.mass_bearing_commits_beyond !== undefined;
  const beyond = {
    commits_beyond: massBearing
      ? truncation.mass_bearing_commits_beyond!
      : (truncation.commits_beyond ?? 0),
    clusters_beyond: massBearing
      ? (truncation.mass_bearing_clusters_beyond ?? 0)
      : (truncation.clusters_beyond ?? 0),
  };
  if (beyond.commits_beyond > 0 || beyond.clusters_beyond > 0) {
    lines.push(
      `${massBearing ? 'Mass-bearing history' : 'History'} selection was budget-truncated — ` +
        `${formatBeyondBudget(beyond)}; ` +
        'widen with --max-commits/--since.'
    );
  }
  if (result.pending_importance) {
    lines.push('Recency history seeded; run `orcaops seed --importance` to finish.');
  }
  return `${lines.join('\n')}\n`;
}

export async function seedAction(opts: SeedOptions = {}): Promise<void> {
  // `ok` keeps meaning "the command ran", so the report still emits in full and
  // only the exit status carries the failure. Raised after the emit so it never
  // routes through the error envelope below and double-reports.
  let failedClusters = 0;
  try {
    const ctx = await buildContext();
    try {
      const result = await withSeedRunLock(ctx.repo, getInvocationEnv(), () => runSeed(ctx, opts));
      if (opts.json) emitOk(result);
      else writeTerminalSafeStdout(renderSeedResult(result));
      if (result.mode !== 'dry-run') {
        const applyTotals = result.totals as Record<string, number> | undefined;
        failedClusters = applyTotals?.failed ?? 0;
      }
    } finally {
      ctx.store.close();
    }
  } catch (error) {
    if (opts.json) emitError(error);
    writeErrorLine(error);
    throw new CliExit(1);
  }
  if (failedClusters > 0) throw new CliExit(1);
}
