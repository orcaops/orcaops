import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';

import { ingestArtifactThread } from './ingest.js';
import type { ArchiveMirror } from './mirror.js';
import { archiveArtifactPaths, archiveReviewPaths } from './paths.js';
import {
  type ArchivedArtifactThread,
  loadArtifactThreadFromArchive,
  loadArtifactThreadFromPaths,
} from './read.js';
import { artifactPathsFor } from '../artifacts/paths.js';
import type { ArtifactStore } from '../artifacts/store.js';
import { type EventRecord, readEventLog } from '../events/event-log.js';
import { appendDurable, fsyncDir, mkdirDurable, writeDurable } from '../fs/durable.js';
import { assertResolvedWithin, assertSafePathSegment } from '../paths/containment.js';
import type { Config } from '../schema/config.js';
import { withNonDerivableWriteLease } from '../store/write-lease.js';

/**
 * The reverse mirror: materialize an ARCHIVED artifact into
 * a worktree's hot store — the handoff mechanic behind
 * `resume --artifact` on a machine/worktree that never captured it.
 *
 * Rules:
 * - **Ordered append-only top-up.** Only an empty hot log or an exact ordered
 *   prefix of the archive can append the remaining suffix. A non-prefix
 *   subset refuses and points to explicit source selection; appending by set
 *   difference would scramble lifecycle order.
 * - Sidecars copy temp → rename BEFORE their referencing lines.
 * - Projection files are not written here: reads derive them from the event
 *   log in memory, while SQLite rows are upserted through the same ingest the
 *   global index uses.
 */
export class ArchiveRestoreDivergenceError extends Error {
  readonly code = 'ARCHIVE_RESTORE_DIVERGENCE';
  constructor(artifactId: string, localOnlyIds: string[]) {
    super(
      `Hot store already holds ${localOnlyIds.length} event(s) for artifact ${artifactId} ` +
        `that the archive does not (${localOnlyIds.slice(0, 3).join(', ')}${localOnlyIds.length > 3 ? ', …' : ''}). ` +
        `Refusing to restore over diverged local work — run \`orcaops archive repair\` to mirror it first.`
    );
    this.name = 'ArchiveRestoreDivergenceError';
  }
}

export class ArchiveRestoreNonPrefixError extends Error {
  readonly code = 'ARCHIVE_RESTORE_NON_PREFIX';
  constructor(artifactId: string) {
    super(
      `Hot artifact ${artifactId} is a non-prefix subset of its archive. ` +
        'Nothing was written because appending the missing events would scramble lifecycle order. ' +
        `Run \`orcaops archive resolve --artifact ${artifactId} --source archive --apply\` ` +
        'to replace the hot copy explicitly.'
    );
    this.name = 'ArchiveRestoreNonPrefixError';
  }
}

export class ArchiveRestoreSourceInvalidError extends Error {
  readonly code = 'ARCHIVE_RESTORE_SOURCE_INVALID';
  constructor(artifactId: string, message: string) {
    super(`Archived artifact ${artifactId} is not a valid restore source: ${message}`);
    this.name = 'ArchiveRestoreSourceInvalidError';
  }
}

export class ArchiveRestoreNotInFlightError extends Error {
  readonly code = 'ARCHIVE_RESTORE_NOT_IN_FLIGHT';
  constructor(artifactId: string) {
    super(`Archived artifact ${artifactId} is no longer in flight.`);
    this.name = 'ArchiveRestoreNotInFlightError';
  }
}

export class ArchiveRestoreConcurrentChangeError extends Error {
  readonly code = 'ARCHIVE_RESTORE_CONCURRENT_CHANGE';
  constructor(artifactId: string, side: 'hot' | 'archive') {
    super(
      `${side === 'hot' ? 'Hot' : 'Archive'} artifact ${artifactId} changed while replacement ` +
        'was preparing; nothing was replaced. Re-run the command from a fresh status.'
    );
    this.name = 'ArchiveRestoreConcurrentChangeError';
  }
}

export interface RestoreResult {
  /** Events appended to the hot log (0 = already fully present). */
  events_copied: number;
  /** True when the SQLite cache was refreshed from the restored thread. */
  indexed: boolean;
}

export interface RestoreOptions {
  repoRoot: string;
  config: Config;
  /** The worktree's hot store (cache upserts go through it). */
  store: ArtifactStore;
  /** `<dataRoot>/projects/<project-id>` for this repo's identity. */
  projectDir: string;
  artifactId: string;
  /** Refuse before writing unless the validated archive thread is still resumable. */
  requireInFlight?: boolean;
  /** Archive-side coordination used when the caller requires a current state decision. */
  archiveLock?: Pick<ArchiveMirror, 'withArtifactLock'>;
}

export interface ArtifactSourceState {
  valid: boolean;
  event_ids: string[];
  corrupt_lines: number;
  error: string | null;
}

export interface ArtifactSourceInspection {
  hot: ArtifactSourceState;
  archive: ArtifactSourceState;
}

export type ArchivedArtifactAvailability =
  | { kind: 'missing' }
  | { kind: 'in_flight'; state: 'planned' | 'active' | 'blocked' }
  | { kind: 'summarized' }
  | { kind: 'uncertain'; reason: string };

/** Read-only archive classification shared by GC and pin-based resume. */
export async function inspectArchivedArtifactAvailability(
  projectDir: string,
  artifactId: string
): Promise<ArchivedArtifactAvailability> {
  try {
    const thread = await loadArtifactThreadFromArchive(projectDir, artifactId);
    if (thread.corruptLines > 0) {
      return {
        kind: 'uncertain',
        reason: `${thread.corruptLines} corrupt archive line(s)`,
      };
    }
    if (thread.events.length === 0) return { kind: 'missing' };
    if (thread.plan === null || thread.artifactJson === null) {
      return {
        kind: 'uncertain',
        reason: 'archive events do not reconstruct complete artifact state',
      };
    }
    return thread.artifactJson.state === 'summarized'
      ? { kind: 'summarized' }
      : { kind: 'in_flight', state: thread.artifactJson.state };
  } catch (error) {
    return { kind: 'uncertain', reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function inspectArtifactSources(
  opts: Pick<RestoreOptions, 'repoRoot' | 'config' | 'projectDir' | 'artifactId'>
): Promise<ArtifactSourceInspection> {
  const hotPaths = artifactPathsFor(opts.repoRoot, opts.config, opts.artifactId);
  const archivePaths = archiveArtifactPaths(opts.projectDir, opts.artifactId);
  return {
    hot: await inspectArtifactSource(
      opts.artifactId,
      hotPaths.eventsNdjson,
      hotPaths.sidecarsDir,
      opts.repoRoot
    ),
    archive: await inspectArtifactSource(
      opts.artifactId,
      archivePaths.eventsNdjson,
      archivePaths.sidecarsDir
    ),
  };
}

export async function restoreArtifactFromArchive(opts: RestoreOptions): Promise<RestoreResult> {
  const archivePaths = archiveArtifactPaths(opts.projectDir, opts.artifactId);
  const hotPaths = artifactPathsFor(opts.repoRoot, opts.config, opts.artifactId);
  return opts.store.withArtifactLock(opts.artifactId, async () => {
    const restoreLocked = async (): Promise<RestoreResult> => {
      const archivedThread = await loadStrictArchiveThread(opts.projectDir, opts.artifactId);
      if (opts.requireInFlight === true && archivedThread.artifactJson === null) {
        throw new ArchiveRestoreSourceInvalidError(
          opts.artifactId,
          'the event stream does not reconstruct artifact state'
        );
      }
      if (opts.requireInFlight === true && archivedThread.artifactJson?.state === 'summarized') {
        throw new ArchiveRestoreNotInFlightError(opts.artifactId);
      }
      const archivedRecords = archivedThread.events.map((event) => event.record);
      if (archivedRecords.length === 0) {
        throw new Error(
          `Artifact ${opts.artifactId} is not in the archive (no valid events at ${archivePaths.eventsNdjson}).`
        );
      }

      const hot = await readEventLog({
        eventLogPath: hotPaths.eventsNdjson,
        sidecarsDir: hotPaths.sidecarsDir,
        containmentRoot: opts.repoRoot,
      });
      if (hot.corrupt.length > 0) {
        throw new ArchiveRestoreNonPrefixError(opts.artifactId);
      }
      const archivedIds = new Set(archivedRecords.map((event) => event.event_id));
      const localOnly = hot.events.map((e) => e.event_id).filter((id) => !archivedIds.has(id));
      if (localOnly.length > 0) {
        throw new ArchiveRestoreDivergenceError(opts.artifactId, localOnly);
      }
      const hotIds = hot.events.map((event) => event.event_id);
      const archiveIds = archivedRecords.map((event) => event.event_id);
      if (!isOrderedPrefix(hotIds, archiveIds)) {
        throw new ArchiveRestoreNonPrefixError(opts.artifactId);
      }
      const missingRecords = archivedRecords.slice(hotIds.length);
      await withNonDerivableWriteLease(opts.repoRoot, () => {
        if (opts.store.store.projectionHealth === 'healthy') {
          opts.store.store.setProjectionHealth('rebuild_pending');
        }
        if (missingRecords.length > 0) {
          opts.store.store.rotateCloudSyncTokens([opts.artifactId]);
        }
      });
      let copied = 0;
      for (const record of missingRecords) {
        if ('sidecar_sha256' in record) {
          assertSafePathSegment(record.event_id, 'event id');
          const src = path.join(archivePaths.sidecarsDir, `${record.event_id}.json`);
          const dest = path.join(hotPaths.sidecarsDir, `${record.event_id}.json`);
          await installManagedFile(await readFile(src), dest, opts.repoRoot);
        }
        await mkdirDurable(path.dirname(hotPaths.eventsNdjson), 0o700, undefined, opts.repoRoot);
        await appendDurable(hotPaths.eventsNdjson, JSON.stringify(record) + '\n', opts.repoRoot);
        copied += 1;
      }

      // Targeted ingest serves this invocation, but only a full durable-source
      // replay may certify the entire projection after new hot bytes appear.
      const { indexed } = await withNonDerivableWriteLease(opts.repoRoot, () =>
        ingestArtifactThread(opts.store.store, archivedThread)
      );
      return { events_copied: copied, indexed };
    };

    if (opts.archiveLock) {
      return opts.archiveLock.withArtifactLock(opts.artifactId, restoreLocked);
    }
    if (opts.requireInFlight === true) {
      throw new ArchiveRestoreSourceInvalidError(
        opts.artifactId,
        'its in-flight archive state cannot be proven without archive coordination'
      );
    }
    return restoreLocked();
  });
}

export interface CanonicalArchiveToHotOptions extends RestoreOptions {
  /** Optimistic token observed before the replacement request. */
  expectedHotEventIds: readonly string[];
  /** Corrupt-line count observed with the hot sequence token. */
  expectedHotCorruptLines: number;
  /** Optimistic token observed before the replacement request. */
  expectedArchiveEventIds: readonly string[];
}

export interface CanonicalArchiveToHotResult {
  events_installed: number;
  backup_path: string;
  indexed: boolean;
}

/**
 * Explicit archive-authoritative recovery. The archive is strictly rebuilt,
 * copied into staging, rechecked for concurrent change, and only then
 * installed over hot under the artifact lock. The prior hot event source is
 * retained indefinitely; derived projections and SQLite rows are refreshed
 * from the installed thread before the lock is released.
 */
export async function replaceHotArtifactFromArchive(
  opts: CanonicalArchiveToHotOptions
): Promise<CanonicalArchiveToHotResult> {
  const initialArchive = await loadStrictArchiveThread(opts.projectDir, opts.artifactId);
  const initialArchiveRecords = initialArchive.events.map((event) => event.record);
  if (initialArchiveRecords.length === 0) {
    throw new ArchiveRestoreSourceInvalidError(opts.artifactId, 'the archive has no events');
  }
  if (!sameEventIds(initialArchiveRecords, opts.expectedArchiveEventIds)) {
    throw new ArchiveRestoreConcurrentChangeError(opts.artifactId, 'archive');
  }

  const archivePaths = archiveArtifactPaths(opts.projectDir, opts.artifactId);
  const hotPaths = artifactPathsFor(opts.repoRoot, opts.config, opts.artifactId);
  return opts.store.withArtifactLock(opts.artifactId, async () => {
    const currentHot = await readEventLog({
      eventLogPath: hotPaths.eventsNdjson,
      sidecarsDir: hotPaths.sidecarsDir,
      containmentRoot: opts.repoRoot,
    });
    if (
      currentHot.corrupt.length !== opts.expectedHotCorruptLines ||
      !sameEventIds(currentHot.events, opts.expectedHotEventIds)
    ) {
      throw new ArchiveRestoreConcurrentChangeError(opts.artifactId, 'hot');
    }

    const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const stagingDir = path.join(hotPaths.dir, `.archive-restore-staging-${nonce}`);
    const stagingLog = path.join(stagingDir, 'events.ndjson');
    const stagingSidecars = path.join(stagingDir, 'sidecars');
    let result: CanonicalArchiveToHotResult | undefined;
    let replacementError: { value: unknown } | undefined;
    let cleanupError: { value: unknown } | undefined;
    try {
      await mkdirDurable(stagingDir, 0o700, undefined, opts.repoRoot);
      await installManagedFile(
        await readFile(archivePaths.eventsNdjson),
        stagingLog,
        opts.repoRoot
      );
      for (const record of initialArchiveRecords) {
        if (!('sidecar_sha256' in record)) continue;
        await installManagedFile(
          await readFile(path.join(archivePaths.sidecarsDir, `${record.event_id}.json`)),
          path.join(stagingSidecars, `${record.event_id}.json`),
          opts.repoRoot
        );
      }

      const staged = await loadArtifactThreadFromPaths(
        opts.artifactId,
        stagingLog,
        stagingSidecars,
        opts.repoRoot
      );
      if (
        staged.corruptLines > 0 ||
        !sameEventIds(
          staged.events.map((event) => event.record),
          opts.expectedArchiveEventIds
        )
      ) {
        throw new ArchiveRestoreSourceInvalidError(
          opts.artifactId,
          'the staged event sequence did not match the validated archive'
        );
      }

      const finalArchive = await loadStrictArchiveThread(opts.projectDir, opts.artifactId);
      if (
        !sameEventRecords(
          initialArchiveRecords,
          finalArchive.events.map((event) => event.record)
        )
      ) {
        throw new ArchiveRestoreConcurrentChangeError(opts.artifactId, 'archive');
      }

      const backupPath = path.join(hotPaths.dir, 'restore-backups', nonce);
      await mkdirDurable(backupPath, 0o700, undefined, opts.repoRoot);
      await copyManagedFileIfPresent(
        hotPaths.eventsNdjson,
        path.join(backupPath, 'events.ndjson'),
        opts.repoRoot
      );
      await copyManagedDirectoryIfPresent(
        hotPaths.sidecarsDir,
        path.join(backupPath, 'sidecars'),
        opts.repoRoot
      );

      for (const record of initialArchiveRecords) {
        if (!('sidecar_sha256' in record)) continue;
        assertSafePathSegment(record.event_id, 'event id');
        await installManagedFile(
          await readFile(
            assertResolvedWithin(
              path.join(stagingSidecars, `${record.event_id}.json`),
              opts.repoRoot,
              'staged event sidecar',
              { rejectSymlinks: true }
            )
          ),
          path.join(hotPaths.sidecarsDir, `${record.event_id}.json`),
          opts.repoRoot
        );
      }
      await installManagedFile(
        await readFile(
          assertResolvedWithin(stagingLog, opts.repoRoot, 'staged event log', {
            rejectSymlinks: true,
          })
        ),
        hotPaths.eventsNdjson,
        opts.repoRoot
      );
      await removeHotProjectionFiles(hotPaths.dir, opts.repoRoot);

      const installed = await loadArtifactThreadFromPaths(
        opts.artifactId,
        hotPaths.eventsNdjson,
        hotPaths.sidecarsDir,
        opts.repoRoot
      );
      if (
        installed.corruptLines > 0 ||
        !sameEventIds(
          installed.events.map((event) => event.record),
          opts.expectedArchiveEventIds
        )
      ) {
        throw new ArchiveRestoreSourceInvalidError(
          opts.artifactId,
          `post-install validation failed; the prior hot source is retained at ${backupPath}`
        );
      }

      await withNonDerivableWriteLease(opts.repoRoot, () =>
        opts.store.store.deleteArtifact(opts.artifactId)
      );
      const { indexed } = ingestArtifactThread(opts.store.store, installed);
      result = {
        events_installed: installed.events.length,
        backup_path: backupPath,
        indexed,
      };
    } catch (error) {
      replacementError = { value: error };
    } finally {
      try {
        const safeStagingDir = assertResolvedWithin(
          stagingDir,
          opts.repoRoot,
          'archive restore staging directory',
          { rejectSymlinks: true }
        );
        await rm(safeStagingDir, { recursive: true, force: true });
      } catch (error) {
        cleanupError = { value: error };
      }
    }
    if (replacementError !== undefined) throw replacementError.value;
    if (cleanupError !== undefined) throw cleanupError.value;
    if (result === undefined) {
      throw new Error('archive replacement finished without a result');
    }
    return result;
  });
}

async function loadStrictArchiveThread(
  projectDir: string,
  artifactId: string
): Promise<ArchivedArtifactThread> {
  try {
    const thread = await loadArtifactThreadFromArchive(projectDir, artifactId);
    if (thread.corruptLines > 0) {
      throw new ArchiveRestoreSourceInvalidError(
        artifactId,
        `${thread.corruptLines} corrupt archive line(s) were detected`
      );
    }
    if (thread.events.length > 0 && thread.plan === null) {
      throw new ArchiveRestoreSourceInvalidError(
        artifactId,
        'the event stream has no reconstructable plan'
      );
    }
    return thread;
  } catch (error) {
    if (error instanceof ArchiveRestoreSourceInvalidError || isInfrastructureError(error)) {
      throw error;
    }
    throw new ArchiveRestoreSourceInvalidError(
      artifactId,
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function inspectArtifactSource(
  artifactId: string,
  eventsNdjson: string,
  sidecarsDir: string,
  containmentRoot?: string
): Promise<ArtifactSourceState> {
  const read = await readEventLog({ eventLogPath: eventsNdjson, sidecarsDir, containmentRoot });
  const eventIds = read.events.map((event) => event.event_id);
  if (read.corrupt.length > 0) {
    return {
      valid: false,
      event_ids: eventIds,
      corrupt_lines: read.corrupt.length,
      error: `${read.corrupt.length} corrupt line(s)`,
    };
  }
  if (read.events.length === 0) {
    return {
      valid: false,
      event_ids: [],
      corrupt_lines: 0,
      error: 'no events',
    };
  }
  try {
    const thread = await loadArtifactThreadFromPaths(
      artifactId,
      eventsNdjson,
      sidecarsDir,
      containmentRoot
    );
    if (thread.plan === null) {
      return {
        valid: false,
        event_ids: eventIds,
        corrupt_lines: 0,
        error: 'no reconstructable plan',
      };
    }
    return {
      valid: true,
      event_ids: eventIds,
      corrupt_lines: 0,
      error: null,
    };
  } catch (error) {
    if (isInfrastructureError(error)) throw error;
    return {
      valid: false,
      event_ids: eventIds,
      corrupt_lines: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isOrderedPrefix(prefix: readonly string[], complete: readonly string[]): boolean {
  return (
    prefix.length <= complete.length &&
    prefix.every((eventId, index) => eventId === complete[index])
  );
}

function sameEventIds(records: readonly EventRecord[], expectedIds: readonly string[]): boolean {
  return (
    records.length === expectedIds.length &&
    records.every((record, index) => record.event_id === expectedIds[index])
  );
}

function sameEventRecords(left: readonly EventRecord[], right: readonly EventRecord[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (record, index) =>
        record.event_id === right[index]?.event_id && record.checksum === right[index]?.checksum
    )
  );
}

function isInfrastructureError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

async function installManagedFile(
  content: Buffer,
  destination: string,
  containmentRoot: string
): Promise<void> {
  await mkdirDurable(path.dirname(destination), 0o700, undefined, containmentRoot);
  const resolveTarget = (target: string, label: string): string =>
    assertResolvedWithin(target, containmentRoot, label, { rejectSymlinks: true });
  let finalPath = resolveTarget(destination, 'managed file destination');
  let tempPath = resolveTarget(
    `${finalPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    'managed file temporary path'
  );
  try {
    await writeDurable(tempPath, content, 0o600, containmentRoot);
    tempPath = resolveTarget(tempPath, 'managed file temporary path');
    finalPath = resolveTarget(destination, 'managed file destination');
    await rename(tempPath, finalPath);
    await fsyncDir(path.dirname(finalPath), containmentRoot);
  } catch (error) {
    try {
      await unlink(resolveTarget(tempPath, 'managed file temporary cleanup')).catch(() => {});
    } catch {
      // Preserve the operation's original failure if an unsafe cleanup is refused.
    }
    throw error;
  }
}

async function copyManagedFileIfPresent(
  source: string,
  destination: string,
  containmentRoot: string
): Promise<void> {
  const safeSource = assertResolvedWithin(source, containmentRoot, 'managed backup source', {
    rejectSymlinks: true,
  });
  try {
    await installManagedFile(await readFile(safeSource), destination, containmentRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function copyManagedDirectoryIfPresent(
  source: string,
  destination: string,
  containmentRoot: string
): Promise<void> {
  const safeSource = assertResolvedWithin(source, containmentRoot, 'managed backup directory', {
    rejectSymlinks: true,
  });
  let entries: Dirent[];
  try {
    entries = await readdir(safeSource, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const entrySource = assertResolvedWithin(
      path.join(safeSource, entry.name),
      containmentRoot,
      'managed backup entry',
      { rejectSymlinks: true }
    );
    if (!entry.isFile()) {
      throw new Error(`refusing unexpected non-file in managed sidecar directory: ${entrySource}`);
    }
    await installManagedFile(
      await readFile(entrySource),
      path.join(destination, entry.name),
      containmentRoot
    );
  }
}

const HOT_PROJECTION_FILES = new Set([
  'artifact.json',
  'digest.md',
  'digest.meta.json',
  'evaluators.json',
  'plan.json',
  'plan.md',
  'resume.md',
  'summary.json',
  'summary.md',
]);

async function removeHotProjectionFiles(
  artifactDir: string,
  containmentRoot: string
): Promise<void> {
  const safeArtifactDir = assertResolvedWithin(
    artifactDir,
    containmentRoot,
    'hot artifact directory',
    { rejectSymlinks: true }
  );
  const entries = await readdir(safeArtifactDir, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      (!HOT_PROJECTION_FILES.has(entry.name) && !/^checkpoint-\d+\.(?:json|md)$/.test(entry.name))
    ) {
      continue;
    }
    const target = assertResolvedWithin(
      path.join(safeArtifactDir, entry.name),
      containmentRoot,
      'hot projection file',
      { rejectSymlinks: true }
    );
    await rm(target, { force: true });
  }
}

export interface ReviewLogRestoreResult {
  /** Per-slug lines appended to the hot journal/comments logs. */
  slugs: { slug: string; journal_lines: number; comments_lines: number }[];
  /** Total lines appended across every slug and both logs. */
  lines_copied: number;
}

class ArchiveReviewRestoreDivergenceError extends Error {
  readonly code = 'ARCHIVE_REVIEW_RESTORE_DIVERGENCE';
  constructor(slug: string, kind: 'journal' | 'comments') {
    super(
      `Hot review ${kind} log for ${slug} cannot be topped up from the archive: ` +
        `the hot log is not an exact prefix. ` +
        'Nothing was written for this review.'
    );
    this.name = 'ArchiveReviewRestoreDivergenceError';
  }
}

export interface ReviewLogRestoreOptions {
  repoRoot: string;
  projectDir: string;
  reviewStateVersion: number;
  archiveLock: Pick<ArchiveMirror, 'withReviewLocks'>;
  withHotReviewLocks<T>(slug: string, fn: () => Promise<T>): Promise<T>;
  validateReviewLogs(journalFile: string, commentsFile: string): Promise<void>;
}

/**
 * Rehydrate the archived review append logs back into a worktree's hot
 * `.orcaops/reviews/<slug>/` tree — the review-log companion to the artifact
 * reverse mirror (rides the same cold-start restore path).
 *
 * Every archived review slug is replayed (the archive dir name IS the hot slug,
 * verbatim — no `slugifyBranch` needed). Both logs are preflighted together:
 * each hot log must be an exact prefix of its archive, after which only the
 * missing suffix is appended. The caller supplies the existing hot review
 * locks, while the mirror supplies its existing archive locks.
 */
export async function restoreReviewLogsFromArchive(
  opts: ReviewLogRestoreOptions
): Promise<ReviewLogRestoreResult> {
  const reviewsRootCandidate = path.join(opts.projectDir, 'reviews', `v${opts.reviewStateVersion}`);
  try {
    await lstat(opts.projectDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { slugs: [], lines_copied: 0 };
    throw error;
  }
  const reviewsRoot = assertResolvedWithin(
    reviewsRootCandidate,
    opts.projectDir,
    'archived review root',
    { rejectSymlinks: true }
  );
  try {
    await lstat(reviewsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { slugs: [], lines_copied: 0 };
    throw error;
  }
  const entries = await readdir(reviewsRoot, { withFileTypes: true });

  const slugs: ReviewLogRestoreResult['slugs'] = [];
  let linesCopied = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Archived review slug path ${entry.name} must not be a symlink.`);
    }
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    assertSafePathSegment(slug, 'review slug');
    const archive = archiveReviewPaths(opts.projectDir, opts.reviewStateVersion, slug);
    const result = await opts.withHotReviewLocks(slug, () =>
      opts.archiveLock.withReviewLocks(slug, async () => {
        const hotDir = resolveHotReviewDirectory(opts.repoRoot, slug);
        const hotMarkerPath = resolveReviewFile(
          path.join(hotDir, 'review-state.json'),
          opts.repoRoot,
          'hot review state marker'
        );
        const hotJournalPath = resolveReviewFile(
          path.join(hotDir, 'journal.ndjson'),
          opts.repoRoot,
          'hot review journal'
        );
        const hotCommentsPath = resolveReviewFile(
          path.join(hotDir, 'comments.ndjson'),
          opts.repoRoot,
          'hot review comments'
        );
        const archiveJournalPath = resolveReviewFile(
          archive.journalNdjson,
          opts.projectDir,
          'archived review journal'
        );
        const archiveCommentsPath = resolveReviewFile(
          archive.commentsNdjson,
          opts.projectDir,
          'archived review comments'
        );
        const directoryState = await inspectHotReviewDirectory(
          hotDir,
          hotMarkerPath,
          opts.reviewStateVersion
        );
        const archiveJournal = await readNdjsonLines(archiveJournalPath);
        const archiveComments = await readNdjsonLines(archiveCommentsPath);
        const hotJournal = await readNdjsonLines(hotJournalPath);
        const hotComments = await readNdjsonLines(hotCommentsPath);
        await opts.validateReviewLogs(archiveJournalPath, archiveCommentsPath);
        await opts.validateReviewLogs(hotJournalPath, hotCommentsPath);
        const journalLines = missingReviewSuffix(slug, 'journal', hotJournal, archiveJournal);
        const commentsLines = missingReviewSuffix(slug, 'comments', hotComments, archiveComments);

        if (journalLines.length === 0 && commentsLines.length === 0) {
          return { journalLines: 0, commentsLines: 0 };
        }
        await prepareHotReviewDirectory(
          resolveHotReviewDirectory(opts.repoRoot, slug),
          opts.reviewStateVersion,
          directoryState,
          opts.repoRoot,
          hotMarkerPath
        );
        if (journalLines.length > 0) {
          await appendDurable(
            hotJournalPath,
            journalLines.map((line) => `${line}\n`).join(''),
            opts.repoRoot
          );
        }
        if (commentsLines.length > 0) {
          await appendDurable(
            hotCommentsPath,
            commentsLines.map((line) => `${line}\n`).join(''),
            opts.repoRoot
          );
        }
        return { journalLines: journalLines.length, commentsLines: commentsLines.length };
      })
    );
    const { journalLines, commentsLines } = result;
    if (journalLines > 0 || commentsLines > 0) {
      slugs.push({ slug, journal_lines: journalLines, comments_lines: commentsLines });
      linesCopied += journalLines + commentsLines;
    }
  }
  return { slugs, lines_copied: linesCopied };
}

/**
 * Restore only into an empty/current-version hot directory. A mismatched or
 * unversioned directory belongs to another schema and must be repaired by the
 * review-state owner before any archived event can enter it.
 */
type HotReviewDirectoryState = 'missing-or-empty' | 'current';

function resolveHotReviewDirectory(repoRoot: string, slug: string): string {
  return assertResolvedWithin(
    path.join(repoRoot, '.orcaops', 'reviews', slug),
    repoRoot,
    'hot review directory',
    { rejectSymlinks: true }
  );
}

function resolveReviewFile(file: string, root: string, label: string): string {
  return assertResolvedWithin(file, root, label, { rejectSymlinks: true });
}

async function inspectHotReviewDirectory(
  dir: string,
  markerFile: string,
  version: number
): Promise<HotReviewDirectoryState> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    entries = [];
  }
  if (entries.length === 0) return 'missing-or-empty';
  try {
    const marker = JSON.parse(await readFile(markerFile, 'utf8')) as {
      review_state_version?: unknown;
    };
    if (marker.review_state_version === version) return 'current';
  } catch {
    // The review owner must repair unversioned or corrupt state.
  }
  throw new Error(
    `Hot review state at ${dir} is not current schema ${version}; ` +
      'run `orcaops review state repair --branch <branch>` before restoring archived review logs.'
  );
}

async function prepareHotReviewDirectory(
  dir: string,
  version: number,
  state: HotReviewDirectoryState,
  repoRoot: string,
  markerFile: string
): Promise<void> {
  if (state === 'current') return;
  await mkdirDurable(dir, 0o700, undefined, repoRoot);
  await writeDurable(
    markerFile,
    `${JSON.stringify({ review_state_version: version })}\n`,
    0o600,
    repoRoot
  );
  await fsyncDir(dir, repoRoot);
}

function missingReviewSuffix(
  slug: string,
  kind: 'journal' | 'comments',
  hotLines: readonly string[],
  archiveLines: readonly string[]
): readonly string[] {
  if (!isOrderedPrefix(hotLines, archiveLines)) {
    throw new ArchiveReviewRestoreDivergenceError(slug, kind);
  }
  return archiveLines.slice(hotLines.length);
}

/** Read an ndjson file into its non-empty physical lines (ENOENT → []). */
async function readNdjsonLines(file: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  if (raw.length > 0 && !raw.endsWith('\n')) {
    throw new Error(`Review append log ${file} has an unterminated final line.`);
  }
  return raw.split('\n').filter((l) => l.length > 0);
}
