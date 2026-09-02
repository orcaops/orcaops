import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import type { Repo, SeedFileOwnership } from '@orcaops/core';
import { ensureProjectId, readProjectId } from '@orcaops/project-scope';
import {
  archiveProjectDir,
  archiveRoot,
  atomicWriteFile,
  type Config,
  ensureDir0700,
  replaceDurable,
} from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../../io/errors.js';

/**
 * Seed state is split by data class, because losing the two halves costs
 * different things:
 *
 * - **Precious** (`<dataRoot>/projects/<projectId>/seed-state.json`): the
 *   install nonce every deterministic artifact id is salted with, PR-context
 *   consent, the pending-importance flag, and progressive-discovery memory.
 *   Losing it re-prompts the user and re-mints ids for history already
 *   imported, so it lives outside the repo, keyed by the project identity in
 *   the git common dir — which makes linked worktrees share one copy.
 * - **Scratch** (`.orcaops/cache/seed/journal.json`): the current run's
 *   options hash, the in-progress cluster map, and best-effort per-job run
 *   extras. Every field here is either re-derivable or purely informational,
 *   so a cache wipe is a no-op.
 */

const SeedJournalClusterSchema = z.object({
  artifact_id: z.string().min(1),
  status: z.enum(['pending', 'writing', 'complete', 'covered', 'failed']),
  error: z.string().optional(),
});

/**
 * Run extras that do not belong on an artifact: wall time, the budget the run
 * ran under, and which clusters it declined to write. The job ledger itself is
 * derived from `origin.job` in the store, so these render best-effort and
 * their loss costs nothing.
 */
const SeedJobRecordSchema = z.object({
  kind: z.enum(['initial', 'importance', 'commit', 'path', 'resume']),
  /**
   * The coding agent that RAN the import (resolved --invoked-by-agent
   * tiers). Distinct from the artifact-level agent, which stays 'other'
   * because imported history is not the invoking agent's work.
   */
  invoked_by: z.string().min(1).optional(),
  started_at: z.string().datetime(),
  finished_at: z.string().datetime().optional(),
  wall_time_ms: z.number().int().nonnegative().optional(),
  budget: z
    .object({
      max_commits: z.number().int().positive(),
      selected_commits: z.number().int().nonnegative(),
      commits_beyond: z.number().int().nonnegative().optional(),
      clusters_beyond: z.number().int().nonnegative().optional(),
    })
    .optional(),
  skipped_covered: z.number().int().nonnegative().optional(),
  skips: z
    .array(z.object({ cluster_key: z.string().min(1), reason: z.string().min(1) }))
    .optional(),
});

export type SeedJobRecord = z.infer<typeof SeedJobRecordSchema>;

const SeedJournalSchema = z.object({
  schema_version: z.literal(2),
  /** Mirror of the precious nonce, for offline debugging only — never the source. */
  install_nonce: z.string().regex(/^[0-9a-f]{32}$/u),
  options_hash: z.string(),
  updated_at: z.string().datetime(),
  clusters: z.record(z.string(), SeedJournalClusterSchema),
  jobs: z.record(z.string(), SeedJobRecordSchema),
});

export type SeedJournal = z.infer<typeof SeedJournalSchema>;

/** Pre-1.1 journals carried the precious fields; parsed only to migrate them. */
const SeedJournalV1Schema = z.object({
  schema_version: z.literal(1),
  install_nonce: z.string().regex(/^[0-9a-f]{32}$/u),
  options_hash: z.string(),
  pr_context: z.boolean(),
  pending_importance: z.boolean(),
  updated_at: z.string().datetime(),
  clusters: z.record(z.string(), SeedJournalClusterSchema),
  declined_discovery_areas: z.array(z.string()),
  commit_graph_hint_shown: z.boolean().optional(),
});

type SeedJournalV1 = z.infer<typeof SeedJournalV1Schema>;

const SeedDiscoveryAreaSchema = z.object({
  declined_at: z.string().datetime().optional(),
  offered_at: z.string().datetime().optional(),
  /**
   * The paths the user actually asked to decline before they were widened
   * to this top-level area. Suppression stays area-wide today; recording
   * the original request preserves the data a future finer-grained
   * suppression needs.
   */
  declined_paths: z.array(z.string()).optional(),
});

export type SeedDiscoveryArea = z.infer<typeof SeedDiscoveryAreaSchema>;

const SeedPreciousStateSchema = z.object({
  schema_version: z.literal(1),
  install_nonce: z.string().regex(/^[0-9a-f]{32}$/u),
  pr_context: z.boolean(),
  pending_importance: z.boolean(),
  commit_graph_hint_shown: z.boolean(),
  discovery_areas: z.record(z.string(), SeedDiscoveryAreaSchema),
  updated_at: z.string().datetime(),
});

export type SeedPreciousState = z.infer<typeof SeedPreciousStateSchema>;

/** Where the precious file lives for one project identity. */
export interface SeedStateLocation {
  dataRoot: string;
  projectId: string;
}

export function seedPreciousStatePath(dataRoot: string, projectId: string): string {
  return path.join(archiveProjectDir(dataRoot, projectId), 'seed-state.json');
}

/**
 * One canonical spelling per area, so a decline recorded as `./src/server/`
 * suppresses `src/server`. Trimmed first: a blank selector is not an area, and
 * remembering one would silently suppress nothing forever.
 */
export function normalizeSeedArea(area: string): string {
  return area.trim().replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
}

function emptyPreciousState(installNonce: string): SeedPreciousState {
  return {
    schema_version: 1,
    install_nonce: installNonce,
    pr_context: false,
    pending_importance: false,
    commit_graph_hint_shown: false,
    discovery_areas: {},
    updated_at: new Date().toISOString(),
  };
}

/**
 * Lift a pre-1.1 journal's precious half. Declines carried no timestamp, so
 * they are stamped at migration time — a decline is permanent until cleared,
 * so the exact instant is presentational.
 */
function liftLegacyPreciousState(legacy: SeedJournalV1): SeedPreciousState {
  const now = new Date().toISOString();
  const discovery_areas: Record<string, SeedDiscoveryArea> = {};
  for (const area of legacy.declined_discovery_areas) {
    const normalized = normalizeSeedArea(area);
    if (normalized) discovery_areas[normalized] = { declined_at: now };
  }
  return {
    schema_version: 1,
    install_nonce: legacy.install_nonce,
    pr_context: legacy.pr_context,
    pending_importance: legacy.pending_importance,
    commit_graph_hint_shown: legacy.commit_graph_hint_shown === true,
    discovery_areas,
    updated_at: now,
  };
}

function scratchFromLegacy(legacy: SeedJournalV1): SeedJournal {
  return {
    schema_version: 2,
    install_nonce: legacy.install_nonce,
    options_hash: legacy.options_hash,
    updated_at: legacy.updated_at,
    clusters: legacy.clusters,
    jobs: {},
  };
}

export async function readSeedPreciousState(
  location: SeedStateLocation
): Promise<SeedPreciousState | null> {
  try {
    return SeedPreciousStateSchema.parse(
      JSON.parse(
        await readFile(seedPreciousStatePath(location.dataRoot, location.projectId), 'utf8')
      )
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Write the precious file. A failure throws: the data root always resolves,
 * so an unwritable one is an operational fault, and silently degrading to the
 * disposable cache is exactly the durability loss this file exists to end.
 * Durable (fsynced tmp + rename + dir fsync), not merely atomic: nothing can
 * re-derive the install nonce or the decline memory after a power loss.
 */
export async function writeSeedPreciousState(
  location: SeedStateLocation,
  state: SeedPreciousState
): Promise<void> {
  const parsed = SeedPreciousStateSchema.parse({ ...state, updated_at: new Date().toISOString() });
  const filePath = seedPreciousStatePath(location.dataRoot, location.projectId);
  await ensureDir0700(path.dirname(filePath));
  await replaceDurable(filePath, `${JSON.stringify(parsed, null, 2)}\n`, 0o600, location.dataRoot);
  Object.assign(state, parsed);
}

export interface SeedStateBundle {
  precious: SeedPreciousState;
  journal: SeedJournal;
  location: SeedStateLocation;
}

async function readRawJournal(
  repoRoot: string,
  config: Pick<Config, 'cache'>
): Promise<{ current: SeedJournal | null; legacy: SeedJournalV1 | null }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(seedJournalPath(repoRoot, config), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { current: null, legacy: null };
    throw error;
  }
  const current = SeedJournalSchema.safeParse(raw);
  if (current.success) return { current: current.data, legacy: null };
  return { current: null, legacy: SeedJournalV1Schema.parse(raw) };
}

/**
 * READ path: no identity is minted and nothing is written. A pre-1.1 store
 * whose precious file does not exist yet still reports its remembered state,
 * lifted from the legacy journal in memory, so a read surface never regresses
 * while waiting for the next seed run to migrate on disk.
 */
export async function readSeedState(
  repo: Repo,
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  config: Pick<Config, 'cache'>
): Promise<{ precious: SeedPreciousState | null; journal: SeedJournal | null }> {
  const { current, legacy } = await readRawJournal(repoRoot, config);
  const journal = current ?? (legacy ? scratchFromLegacy(legacy) : null);
  const projectId = await readProjectId(repo);
  const stored = projectId
    ? await readSeedPreciousState({ dataRoot: archiveRoot(env), projectId })
    : null;
  return { precious: stored ?? (legacy ? liftLegacyPreciousState(legacy) : null), journal };
}

/**
 * Read-only peek at the remembered discovery areas: one precious-file read,
 * no journal, no identity minting — cheap enough for read-surface hints
 * like the `why` miss.
 */
export async function readSeedDiscoveryAreas(
  repo: Repo,
  env: NodeJS.ProcessEnv
): Promise<Record<string, SeedDiscoveryArea>> {
  const projectId = await readProjectId(repo);
  if (!projectId) return {};
  const stored = await readSeedPreciousState({ dataRoot: archiveRoot(env), projectId });
  return stored?.discovery_areas ?? {};
}

/**
 * WRITE path: resolves (minting when absent) the project identity, materializes
 * the precious state — migrating a pre-1.1 journal on first touch, with the
 * stored precious file winning every duplicated field — and returns both halves
 * for the caller to mutate and persist. The nonce is born precious; the journal
 * copy is only ever a mirror.
 */
export async function loadSeedStateForWrite(
  repo: Repo,
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  config: Pick<Config, 'cache'>
): Promise<SeedStateBundle> {
  const { current, legacy } = await readRawJournal(repoRoot, config);
  const { projectId } = await ensureProjectId(repo);
  const location = { dataRoot: archiveRoot(env), projectId };
  const stored = await readSeedPreciousState(location);
  const precious =
    stored ??
    (legacy
      ? liftLegacyPreciousState(legacy)
      : emptyPreciousState(randomBytes(16).toString('hex')));
  const journal = current ?? (legacy ? scratchFromLegacy(legacy) : null);
  return {
    precious,
    location,
    journal: journal
      ? { ...journal, install_nonce: precious.install_nonce }
      : {
          schema_version: 2,
          install_nonce: precious.install_nonce,
          options_hash: '',
          updated_at: new Date().toISOString(),
          clusters: {},
          jobs: {},
        },
  };
}

/**
 * Cap on retained run extras. The ledger itself is derived from the store, so
 * dropping the oldest extras loses no accounting — only the wall time and skip
 * detail of long-past runs.
 */
export const SEED_JOB_RECORD_LIMIT = 20;

export function recordSeedJob(
  jobs: Record<string, SeedJobRecord>,
  jobId: string,
  record: SeedJobRecord
): void {
  jobs[jobId] = record;
  const newestFirst = Object.entries(jobs).sort(([, left], [, right]) =>
    left.started_at < right.started_at ? 1 : left.started_at > right.started_at ? -1 : 0
  );
  for (const [key] of newestFirst.slice(SEED_JOB_RECORD_LIMIT)) delete jobs[key];
}

export function rememberDeclinedSeedArea(
  state: SeedPreciousState,
  area: string,
  requestedPath: string | null = null,
  now: Date = new Date()
): void {
  const normalized = normalizeSeedArea(area);
  if (!normalized) return;
  const prior = state.discovery_areas[normalized];
  const requested = requestedPath === null ? '' : normalizeSeedArea(requestedPath);
  const declinedPaths =
    requested !== '' && requested !== normalized
      ? [...new Set([...(prior?.declined_paths ?? []), requested])].sort()
      : prior?.declined_paths;
  state.discovery_areas[normalized] = {
    ...prior,
    declined_at: now.toISOString(),
    ...(declinedPaths !== undefined ? { declined_paths: declinedPaths } : {}),
  };
}

/**
 * How long an unanswered offer suppresses the same recommendation. A decline
 * is permanent until cleared; an offer the user simply never acted on is not,
 * so it expires rather than silently becoming one.
 */
export const SEED_OFFER_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export type SeedAreaSuppression = 'declined' | 'offer-cooldown' | null;

export function seedAreaSuppression(
  state: SeedPreciousState | null,
  area: string,
  now: Date = new Date()
): SeedAreaSuppression {
  const record = state?.discovery_areas[normalizeSeedArea(area)];
  if (!record) return null;
  if (record.declined_at !== undefined) return 'declined';
  if (record.offered_at === undefined) return null;
  const offeredAt = Date.parse(record.offered_at);
  if (!Number.isFinite(offeredAt)) return null;
  return now.getTime() - offeredAt < SEED_OFFER_COOLDOWN_MS ? 'offer-cooldown' : null;
}

export function recordSeedAreaOffered(
  state: SeedPreciousState,
  area: string,
  now: Date = new Date()
): void {
  const normalized = normalizeSeedArea(area);
  if (!normalized) return;
  state.discovery_areas[normalized] = {
    ...state.discovery_areas[normalized],
    offered_at: now.toISOString(),
  };
}

/** Forget one area entirely — the only way back from a permanent decline. */
export function clearSeedArea(state: SeedPreciousState, area: string): boolean {
  const normalized = normalizeSeedArea(area);
  if (!normalized || state.discovery_areas[normalized] === undefined) return false;
  delete state.discovery_areas[normalized];
  return true;
}

export interface SeedOfferedArea {
  area: string;
  offered_at: string;
  cooldown_active: boolean;
}

export function offeredSeedAreas(
  state: SeedPreciousState | null,
  now: Date = new Date()
): SeedOfferedArea[] {
  if (!state) return [];
  return Object.entries(state.discovery_areas)
    .filter(([, record]) => record.declined_at === undefined && record.offered_at !== undefined)
    .map(([area, record]) => ({
      area,
      offered_at: record.offered_at!,
      cooldown_active: seedAreaSuppression(state, area, now) === 'offer-cooldown',
    }))
    .sort((left, right) => (left.area < right.area ? -1 : left.area > right.area ? 1 : 0));
}

export function declinedSeedAreas(state: SeedPreciousState | null): string[] {
  if (!state) return [];
  return Object.entries(state.discovery_areas)
    .filter(([, record]) => record.declined_at !== undefined)
    .map(([area]) => area)
    .sort();
}

const SeedCoverageDirectorySchema = z.object({
  covered_lines: z.number().int().nonnegative(),
  total_lines: z.number().int().nonnegative(),
  percent: z.number().min(0).max(100),
});

const SeedCoverageReportSchema = z.object({
  schema_version: z.literal(1),
  branch_sha: z.string().regex(/^[0-9a-f]{40}$/u),
  generated_at: z.string().datetime(),
  complete: z.boolean(),
  directories: z.record(z.string(), SeedCoverageDirectorySchema),
});

export type SeedCoverageReport = z.infer<typeof SeedCoverageReportSchema>;

export function seedStateDir(repoRoot: string, config: Pick<Config, 'cache'>): string {
  return path.join(repoRoot, path.dirname(config.cache.path), 'seed');
}

export function seedJournalPath(repoRoot: string, config: Pick<Config, 'cache'>): string {
  return path.join(seedStateDir(repoRoot, config), 'journal.json');
}

export function seedCoveragePath(repoRoot: string, config: Pick<Config, 'cache'>): string {
  return path.join(seedStateDir(repoRoot, config), 'coverage.json');
}

export function buildSeedCoverageReport(
  branchSha: string,
  ownership: readonly SeedFileOwnership[],
  importedShas: ReadonlySet<string>,
  complete: boolean
): SeedCoverageReport {
  const totals = new Map<string, { covered: number; total: number }>();
  for (const file of ownership) {
    const directory = file.path.includes('/') ? file.path.slice(0, file.path.indexOf('/')) : '.';
    const current = totals.get(directory) ?? { covered: 0, total: 0 };
    current.total += file.lineCount;
    for (const [sha, count] of file.byCommit) {
      if (importedShas.has(sha)) current.covered += count;
    }
    totals.set(directory, current);
  }
  const directories = Object.fromEntries(
    [...totals]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([directory, value]) => [
        directory,
        {
          covered_lines: value.covered,
          total_lines: value.total,
          percent: value.total === 0 ? 0 : Math.round((value.covered / value.total) * 10_000) / 100,
        },
      ])
  );
  return SeedCoverageReportSchema.parse({
    schema_version: 1,
    branch_sha: branchSha,
    generated_at: new Date().toISOString(),
    complete,
    directories,
  });
}

export async function readSeedCoverage(
  repoRoot: string,
  config: Pick<Config, 'cache'>
): Promise<SeedCoverageReport | null> {
  try {
    return SeedCoverageReportSchema.parse(
      JSON.parse(await readFile(seedCoveragePath(repoRoot, config), 'utf8'))
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeSeedCoverage(
  repoRoot: string,
  config: Pick<Config, 'cache'>,
  report: SeedCoverageReport
): Promise<void> {
  const parsed = SeedCoverageReportSchema.parse(report);
  await atomicWriteFile(
    seedCoveragePath(repoRoot, config),
    `${JSON.stringify(parsed, null, 2)}\n`,
    repoRoot
  );
}

export async function writeSeedJournal(
  repoRoot: string,
  config: Pick<Config, 'cache'>,
  journal: SeedJournal
): Promise<void> {
  const parsed = SeedJournalSchema.parse({ ...journal, updated_at: new Date().toISOString() });
  await atomicWriteFile(
    seedJournalPath(repoRoot, config),
    `${JSON.stringify(parsed, null, 2)}\n`,
    repoRoot
  );
  Object.assign(journal, parsed);
}

/**
 * The seed run lock lives beside `seed-state.json` in the common-dir project
 * state dir — NOT in the worktree cache — because the state it guards
 * (precious file, deterministic ids, archive-backed coverage) is shared by
 * every linked worktree of the project. A worktree-local lock let two linked
 * checkouts seed the same project state concurrently.
 */
export function seedRunLockPath(dataRoot: string, projectId: string): string {
  return path.join(archiveProjectDir(dataRoot, projectId), 'seed-run.lock');
}

/**
 * How old an unreadable/unparseable lock must be before it is presumed
 * stale. A lock whose content never landed (crash between create and write
 * in an older layout, or a torn filesystem) would otherwise wedge every
 * later run forever — content is unparseable, so no pid can ever die.
 */
export const SEED_LOCK_UNREADABLE_STALE_MS = 30 * 60 * 1000;

function parseLockOwnerPid(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return Number.isSafeInteger(parsed.pid) && (parsed.pid as number) > 0
      ? (parsed.pid as number)
      : null;
  } catch {
    return null;
  }
}

async function readLockOwnerPid(lockPath: string): Promise<number | null> {
  try {
    return parseLockOwnerPid(await readFile(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

/** Raw lock bytes, or null when the lock does not exist. */
async function readLockRaw(lockPath: string): Promise<string | null> {
  try {
    return await readFile(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}

async function ownerIsAlive(lockPath: string, raw: string): Promise<boolean> {
  const pid = parseLockOwnerPid(raw);
  if (pid === null) {
    // No parseable owner. Fall back to mtime staleness rather than
    // presuming alive forever: fresh means an acquisition may be mid-flight
    // somewhere unexpected, old means crash residue.
    try {
      return Date.now() - (await stat(lockPath)).mtimeMs < SEED_LOCK_UNREADABLE_STALE_MS;
    } catch {
      return false; // Vanished — the contender may retry.
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function seedRunActiveError(lockPath: string, ownerPid: number | null): Error {
  const owner = ownerPid === null ? 'unknown owner' : `pid ${ownerPid}`;
  return new OrcaopsError(
    ErrorCodes.SEED_RUN_ACTIVE,
    `Another orcaops seed run is active for this project (${owner}, lock ${lockPath}). ` +
      'Wait for it to finish; if it crashed, remove the lock file and retry.'
  );
}

/** How long a crashed takeover critical section may wedge new takeovers. */
export const SEED_TAKEOVER_TTL_MS = 60 * 1000;

/**
 * Atomically create `target` bearing this process's owner record.
 * `link(2)` from a pre-written temp file fails EEXIST when the target
 * exists — the only atomic create-exclusive-with-content primitive (a
 * rename would silently replace a racer's live file). There is never an
 * empty-file window for `ownerIsAlive` to misread.
 */
async function createBornWithOwner(target: string): Promise<boolean> {
  const tmpPath = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(
    tmpPath,
    `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  try {
    await link(tmpPath, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return false;
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

/**
 * Discard a crashed takeover section file past its TTL. The claim happens
 * via rename, not stat-then-unlink: an unlink after a bare stat could land
 * on a FRESH claim created between the two calls and delete a live section
 * file. Rename moves whatever inode is there aside atomically; the age is
 * re-verified on the renamed file (rename preserves mtime), and a
 * displaced fresh claim is restored via link.
 */
async function expireCrashedTakeover(takeoverPath: string): Promise<void> {
  try {
    if (Date.now() - (await stat(takeoverPath)).mtimeMs <= SEED_TAKEOVER_TTL_MS) return;
  } catch {
    return; // Vanished — the holder finished; re-contend.
  }
  const expiredPath = `${takeoverPath}.expired.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    await rename(takeoverPath, expiredPath);
  } catch {
    return; // Lost the expiry race — someone else claimed or discarded it.
  }
  try {
    if (Date.now() - (await stat(expiredPath)).mtimeMs > SEED_TAKEOVER_TTL_MS) {
      await unlink(expiredPath).catch(() => {});
      return;
    }
    // Fresh claim displaced between the stat and the rename: put it back.
    // EEXIST means yet another claimant landed meanwhile; the in-section
    // link(2) creation still arbitrates the lock itself either way.
    await link(expiredPath, takeoverPath).catch(() => {});
  } finally {
    await unlink(expiredPath).catch(() => {});
  }
}

export type TakeoverResult = 'acquired' | 'busy' | 'lost';

/**
 * Replace a judged-dead lock inside the takeover critical section. BOTH
 * halves happen inside the held section, and the removal is conditional
 * on the exact bytes the caller judged dead:
 *
 * - The lock is re-read immediately before unlink and removed only when
 *   its content still byte-matches `judgedDeadRaw` (same pid +
 *   started_at, so the same dead owner — dead pids stay dead). A
 *   mismatch means someone else already replaced it: return 'lost'
 *   without touching the file. A removal-only section with an
 *   unconditional unlink double-acquired under four contenders: the
 *   winner re-created its lock AFTER releasing the section, and the next
 *   section holder's unlink deleted that fresh LIVE lock.
 * - The replacement lock is created via link(2) BEFORE the section is
 *   released, so the winner exits already holding it — there is no
 *   removal-to-recreation window outside the section at all.
 *
 * Section release is ownership-checked: after a >TTL pause the file on
 * disk can be a successor's claim, which this holder must not unlink.
 *
 * Exported only so the conditional-displacement interleaving is
 * deterministically testable; production callers go through
 * `withSeedRunLockAtPath`.
 */
export async function takeOverDeadLock(
  lockPath: string,
  judgedDeadRaw: string
): Promise<TakeoverResult> {
  const takeoverPath = `${lockPath}.takeover`;
  if (!(await createBornWithOwner(takeoverPath))) {
    // Busy — a live takeover resolves in microseconds; only a crash leaves
    // residue, bounded by the TTL so it cannot wedge takeovers forever.
    await expireCrashedTakeover(takeoverPath);
    return 'busy';
  }
  try {
    const current = await readLockRaw(lockPath);
    if (current !== null) {
      if (current !== judgedDeadRaw) return 'lost';
      await unlink(lockPath).catch(() => {});
    }
    return (await createBornWithOwner(lockPath)) ? 'acquired' : 'lost';
  } finally {
    if ((await readLockOwnerPid(takeoverPath)) === process.pid) {
      await unlink(takeoverPath).catch(() => {});
    }
  }
}

/**
 * Acquire the run lock at an explicit path. The lock is born with its owner
 * content (see `createBornWithOwner`); dead-owner takeover removes AND
 * re-creates the lock inside a takeover critical section, conditional on
 * the judged-dead bytes (see `takeOverDeadLock`); release is
 * ownership-checked. Plain link(2) on a missing lock stays safe outside
 * the section because no takeover can unlink content it did not judge.
 */
export async function withSeedRunLockAtPath<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 10 && !acquired; attempt++) {
    if (await createBornWithOwner(lockPath)) {
      acquired = true;
      break;
    }
    const judgedRaw = await readLockRaw(lockPath);
    if (judgedRaw === null) continue; // Vanished — retry the plain create.
    if (await ownerIsAlive(lockPath, judgedRaw)) {
      throw seedRunActiveError(lockPath, parseLockOwnerPid(judgedRaw));
    }
    const takeover = await takeOverDeadLock(lockPath, judgedRaw);
    if (takeover === 'acquired') {
      acquired = true;
      break;
    }
    if (takeover === 'busy') {
      // Another contender is mid-takeover; give it a beat before re-judging.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (!acquired) throw seedRunActiveError(lockPath, await readLockOwnerPid(lockPath));
  try {
    return await fn();
  } finally {
    // Ownership-checked release: only the recorded owner may unlink. After a
    // (mis)judged takeover the file on disk can belong to someone else, and
    // an unconditional unlink would free THEIR lock mid-run.
    if ((await readLockOwnerPid(lockPath)) === process.pid) {
      await unlink(lockPath).catch(() => {});
    }
  }
}

export async function withSeedRunLock<T>(
  repo: Repo,
  env: NodeJS.ProcessEnv,
  fn: () => Promise<T>
): Promise<T> {
  const { projectId } = await ensureProjectId(repo);
  return withSeedRunLockAtPath(seedRunLockPath(archiveRoot(env), projectId), fn);
}
