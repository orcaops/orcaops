import { readFile, rm, stat } from 'node:fs/promises';

import { ingestArtifactThread } from './ingest.js';
import { USAGE_MIRROR_LOCK_ID } from './mirror.js';
import {
  archiveArtifactPaths,
  archiveLocksDir,
  archiveUsageLedgerPaths,
  projectIndexDbPath,
  projectIndexMetaPath,
  writeCachedirTag,
} from './paths.js';
import {
  listArchivedArtifactIds,
  loadArtifactThreadFromArchive,
  readArchivedUsageEvents,
} from './read.js';
import { atomicWriteFile } from '../artifacts/atomic-write.js';
import { ArtifactLock, ArtifactLockTimeoutError } from '../locks.js';
import { Store, UnsupportedSchemaVersionError } from '../store/sqlite.js';
import { replayUsageEventsIntoStore } from '../usage/ledger.js';

/**
 * Per-project disposable index. One UNMODIFIED `Store` per
 * project under the CACHEDIR.TAG'd cache root — no schema fork, no
 * project_id column; `--all-projects` fans out over these and merges.
 *
 * Degrade tiers for hostile filesystems (Dropbox/iCloud/NFS):
 *   1. WAL requested but not granted (pragma returns non-'wal') →
 *      DELETE journal.
 *   2. Open/migrate throws → in-memory Store rebuilt per invocation
 *      (correctness preserved at a speed cost; doctor surfaces it).
 *
 * An index left behind at an OLDER schema is not a hostile-filesystem
 * degrade — it is the ordinary cost of upgrading orcaops, and it is
 * self-healing precisely because this index is disposable. It gets dropped
 * and rebuilt rather than falling to tier 2, where the whole archive would
 * be re-ingested on every invocation forever with nothing persisted.
 *
 * The index is NEVER authoritative: delete the DB (or the meta high-water
 * file) and everything rebuilds identically from the archive NDJSON.
 */

export type IndexJournalMode = 'wal' | 'delete' | 'memory';

interface HighWater {
  size: number;
  mtime_ms: number;
}

export interface ArchiveArtifactIssue {
  kind: 'artifact_unavailable';
  artifact_id: string;
  message: string;
}

export interface ProjectIndex {
  store: Store;
  /** Null in the in-memory degrade tier. */
  dbPath: string | null;
  journalMode: IndexJournalMode;
  /** Last generation returned by a successful refresh in this process. */
  meta: ProjectIndexMeta;
  close(): void;
}

/** Pure tier-1 rule: requested WAL, use what was actually granted. */
export function resolveJournalFallback(actualMode: string): 'wal' | 'delete' {
  return actualMode.toLowerCase() === 'wal' ? 'wal' : 'delete';
}

export async function openProjectIndex(
  indexRootDir: string,
  projectId: string
): Promise<ProjectIndex> {
  await writeCachedirTag(indexRootDir);
  const dbPath = projectIndexDbPath(indexRootDir, projectId);
  try {
    return await openPersistentProjectIndex(indexRootDir, projectId, dbPath);
  } catch (error) {
    // A schema BELOW this build's is the one failure worth healing: the index
    // is disposable by contract, so drop it and rebuild from the archive.
    // A schema ABOVE it (SchemaAheadError — a sibling type, never caught here)
    // belongs to a newer orcaops: deleting it would make two installed builds
    // destroy and rebuild each other's cache in a loop. Every other failure is
    // the hostile-filesystem case the memory tier exists for, and a cache that
    // is merely locked or transiently unreadable must never be deleted.
    if (error instanceof UnsupportedSchemaVersionError) {
      try {
        await dropProjectIndex(indexRootDir, projectId);
        return await openPersistentProjectIndex(indexRootDir, projectId, dbPath);
      } catch {
        // The rebuilt index is no more openable than the stale one was; the
        // memory tier still keeps this project's rows correct.
      }
    }
    const memoryStore = new Store(':memory:');
    return {
      store: memoryStore,
      dbPath: null,
      journalMode: 'memory',
      meta: EMPTY_META,
      close: () => memoryStore.close(),
    };
  }
}

/** Tier-1 open: the persistent store plus its journal-mode degrade. Throws to
 *  the caller, which owns the drop-and-retry and memory-tier decisions. */
async function openPersistentProjectIndex(
  indexRootDir: string,
  projectId: string,
  dbPath: string
): Promise<ProjectIndex> {
  const store = new Store(dbPath);
  try {
    store.db.pragma('busy_timeout = 5000');
    const actual = store.db.pragma('journal_mode', { simple: true }) as string;
    const journalMode = resolveJournalFallback(actual);
    if (journalMode === 'delete') store.db.pragma('journal_mode = DELETE');
    const meta = await readAlignedMeta(store, projectIndexMetaPath(indexRootDir, projectId));
    return { store, dbPath, journalMode, meta, close: () => store.close() };
  } catch (error) {
    try {
      store.close();
    } catch {
      // Already unusable — the caller's fallback is what keeps this project readable.
    }
    throw error;
  }
}

interface IndexMeta {
  schema_version: 1;
  /** Monotonic publication generation stored authoritatively in SQLite. */
  generation: number;
  /** Successfully ingested artifact high-waters only. */
  artifacts: Record<string, HighWater>;
  /**
   * Failed artifact high-waters are separate from successful ingestion state:
   * unchanged failures stay cheap, but can never masquerade as indexed.
   */
  artifact_issues: Record<string, HighWater & { message: string }>;
  usage: HighWater | null;
  /** Invalid-record disclosure retained while the usage high-water is unchanged. */
  usage_issue?: { invalid_records: number };
}

const EMPTY_META: IndexMeta = {
  schema_version: 1,
  generation: 0,
  artifacts: {},
  artifact_issues: {},
  usage: null,
};

/**
 * Public alias of the per-project index high-water meta (the incremental
 * refresh sidecar). Exposed for read-only consumers (e.g. the cross-project
 * `watch` dashboard) that need each artifact's last-write `mtime_ms` without
 * re-statting the archive log. The additive generation field lets retained
 * consumers reject a slower concurrent refresh result.
 */
export type ProjectIndexMeta = IndexMeta;

/**
 * Read a project's index high-water meta, or an empty meta when it is
 * absent/corrupt. Additive public reader over the private {@link readMeta}:
 * the `artifacts[id].mtime_ms` values are the same last-write high-waters the
 * incremental refresh writes, so a read-only consumer can order artifacts by
 * recency (and route last-write lookups for archive-served rows) without
 * opening any archive log. Never throws.
 */
export async function readProjectIndexMeta(
  indexRootDir: string,
  projectId: string
): Promise<ProjectIndexMeta> {
  return readMeta(projectIndexMetaPath(indexRootDir, projectId));
}

export interface RefreshResult {
  ingested_artifacts: number;
  skipped_artifacts: number;
  usage_replayed: boolean;
  artifact_issues: ArchiveArtifactIssue[];
  /** High-waters aligned with the projection produced by this refresh. */
  meta: ProjectIndexMeta;
  /** Non-fatal degradation that left a prior projection in service. */
  index_issues: ArchiveIndexIssue[];
}

export interface ArchiveIndexIssue {
  kind: 'index_degraded';
  message: string;
}

const ARCHIVE_READ_HEARTBEAT_MS = 30_000;
const MAX_CONCURRENT_REFRESH_RETRIES = 3;
const REFRESH_GENERATION_KEY = 'archive_refresh_generation';
const INDEX_PUBLICATION_LOCK_ID = 'archive-index-publication';

class ConcurrentRefreshError extends Error {
  constructor() {
    super(
      'Archive index changed repeatedly while this refresh was preparing; retry the operation.'
    );
    this.name = 'ConcurrentRefreshError';
  }
}

/**
 * Incremental refresh: re-ingest only artifacts whose archive
 * `events.ndjson` changed (size + mtime high-water in a sibling meta
 * file). A changed artifact replaces its prior disposable projection in the
 * publication transaction, so explicit archive repair cannot leave stale rows.
 * Guards:
 *   - in-memory tier → always full ingest (nothing persists);
 *   - meta present but DB empty (someone deleted the .db) → full ingest.
 */
export async function refreshProjectIndex(
  projectDir: string,
  index: ProjectIndex,
  indexRootDir: string,
  projectId: string
): Promise<RefreshResult> {
  for (let attempt = 0; attempt < MAX_CONCURRENT_REFRESH_RETRIES; attempt += 1) {
    const expectedGeneration = readRefreshGeneration(index.store);
    try {
      const result = await refreshProjectIndexAtGeneration(
        projectDir,
        index,
        indexRootDir,
        projectId,
        expectedGeneration
      );
      if (result.meta.generation >= index.meta.generation) index.meta = result.meta;
      return result;
    } catch (error) {
      if (error instanceof ConcurrentRefreshError && attempt + 1 < MAX_CONCURRENT_REFRESH_RETRIES) {
        continue;
      }
      if (index.journalMode !== 'memory') {
        try {
          const reloaded = await readAlignedMeta(
            index.store,
            projectIndexMetaPath(indexRootDir, projectId)
          );
          if (reloaded.generation >= index.meta.generation) index.meta = reloaded;
        } catch {
          // Preserve the original refresh failure when the disposable store is also unreadable.
        }
      }
      throw error;
    }
  }
  throw new ConcurrentRefreshError();
}

async function refreshProjectIndexAtGeneration(
  projectDir: string,
  index: ProjectIndex,
  indexRootDir: string,
  projectId: string,
  expectedGeneration: number
): Promise<RefreshResult> {
  const archiveLock = new ArtifactLock({
    locksDir: archiveLocksDir(indexRootDir, projectId),
    heartbeatIntervalMs: ARCHIVE_READ_HEARTBEAT_MS,
  });
  const indexIssues: ArchiveIndexIssue[] = [];
  if (index.journalMode === 'memory') {
    const artifactIssues: ArchiveArtifactIssue[] = [];
    const artifacts: Record<string, HighWater> = {};
    const artifactIssueMeta: IndexMeta['artifact_issues'] = {};
    const artifactIds = await listArchivedArtifactIds(projectDir);
    const archivedIds = new Set(artifactIds);
    const ingestions: Array<{
      artifactId: string;
      thread: Awaited<ReturnType<typeof loadArtifactThreadFromArchive>>;
    }> = [];
    const deletions = new Set(
      index.store
        .listArtifacts()
        .map((artifact) => artifact.id)
        .filter((artifactId) => !archivedIds.has(artifactId))
    );
    for (const artifactId of artifactIds) {
      try {
        await archiveLock.withLock(artifactId, async () => {
          const logPath = archiveArtifactPaths(projectDir, artifactId).eventsNdjson;
          let hw: HighWater | null;
          try {
            hw = await highWater(logPath);
          } catch (error) {
            deletions.add(artifactId);
            artifactIssues.push(toArtifactIssue(artifactId, error));
            return;
          }
          if (hw === null) {
            deletions.add(artifactId);
            return;
          }
          try {
            const thread = await loadArtifactThreadFromArchive(projectDir, artifactId);
            assertIndexableThread(artifactId, thread);
            deletions.add(artifactId);
            ingestions.push({ artifactId, thread });
            artifacts[artifactId] = hw;
          } catch (error) {
            deletions.add(artifactId);
            const issue = toArtifactIssue(artifactId, error);
            artifactIssues.push(issue);
            artifactIssueMeta[artifactId] = { ...hw, message: issue.message };
          }
        });
      } catch (error) {
        if (!(error instanceof ArtifactLockTimeoutError)) throw error;
        indexIssues.push(lockTimeoutIssue(artifactId, error));
        const prior = index.meta.artifacts[artifactId];
        const priorIssue = index.meta.artifact_issues[artifactId];
        if (prior !== undefined) artifacts[artifactId] = prior;
        if (priorIssue !== undefined) {
          artifactIssueMeta[artifactId] = priorIssue;
          artifactIssues.push({
            kind: 'artifact_unavailable',
            artifact_id: artifactId,
            message: priorIssue.message,
          });
        }
      }
    }
    let usage:
      | {
          events: Awaited<ReturnType<typeof readArchivedUsageEvents>>;
          highWater: HighWater | null;
          invalidRecords: number;
        }
      | undefined;
    try {
      usage = await archiveLock.withLock(USAGE_MIRROR_LOCK_ID, async () => {
        let invalidRecords = 0;
        const events = await readArchivedUsageEvents(projectDir, () => {
          invalidRecords += 1;
        });
        if (invalidRecords > 0) indexIssues.push(invalidUsageIssue(invalidRecords));
        return {
          events,
          highWater: await highWater(archiveUsageLedgerPaths(projectDir).ledgerNdjson),
          invalidRecords,
        };
      });
    } catch (error) {
      if (!(error instanceof ArtifactLockTimeoutError)) throw error;
      indexIssues.push(lockTimeoutIssue('usage ledger', error));
    }
    const generation = applyAtGeneration(index.store, expectedGeneration, () => {
      for (const artifactId of deletions) index.store.deleteArtifact(artifactId);
      for (const { thread } of ingestions) ingestArtifactThread(index.store, thread);
      if (usage !== undefined) {
        index.store.clearUsageProjection();
        replayUsageEventsIntoStore(index.store, usage.events);
      }
    });
    const meta: ProjectIndexMeta = {
      schema_version: 1,
      generation,
      artifacts,
      artifact_issues: artifactIssueMeta,
      usage: usage?.highWater ?? index.meta.usage,
      ...(usage !== undefined && usage.invalidRecords > 0
        ? { usage_issue: { invalid_records: usage.invalidRecords } }
        : {}),
    };
    return {
      ingested_artifacts: ingestions.length,
      skipped_artifacts: 0,
      usage_replayed: usage !== undefined,
      artifact_issues: artifactIssues,
      meta,
      index_issues: indexIssues,
    };
  }

  const metaPath = projectIndexMetaPath(indexRootDir, projectId);
  let meta = index.meta;
  if (!isMetaAlignedWithStore(index.store, meta)) {
    meta = await readAlignedMeta(index.store, metaPath);
  }

  const nextMeta: IndexMeta = {
    schema_version: 1,
    generation: 0,
    artifacts: {},
    artifact_issues: {},
    usage: null,
  };
  let ingested = 0;
  let skipped = 0;
  const artifactIssues: ArchiveArtifactIssue[] = [];
  const ingestions: Array<Awaited<ReturnType<typeof loadArtifactThreadFromArchive>>> = [];
  const deletions = new Set<string>();

  const artifactIds = await listArchivedArtifactIds(projectDir);
  const archivedIds = new Set(artifactIds);
  const projectedArtifactIds = new Set(index.store.listArtifacts().map((artifact) => artifact.id));
  for (const artifactId of projectedArtifactIds) {
    if (!archivedIds.has(artifactId)) deletions.add(artifactId);
  }
  for (const artifactId of artifactIds) {
    const logPath = archiveArtifactPaths(projectDir, artifactId).eventsNdjson;
    let hw: HighWater | null;
    try {
      hw = await highWater(logPath);
    } catch (error) {
      if (projectedArtifactIds.has(artifactId)) deletions.add(artifactId);
      artifactIssues.push(toArtifactIssue(artifactId, error));
      skipped += 1;
      continue;
    }
    if (hw === null) {
      if (projectedArtifactIds.has(artifactId)) deletions.add(artifactId);
      continue;
    }
    const prior = meta.artifacts[artifactId];
    if (prior && prior.size === hw.size && prior.mtime_ms === hw.mtime_ms) {
      nextMeta.artifacts[artifactId] = prior;
      skipped += 1;
      continue;
    }
    try {
      await archiveLock.withLock(artifactId, async () => {
        let current: HighWater | null;
        try {
          current = await highWater(logPath);
        } catch (error) {
          if (projectedArtifactIds.has(artifactId)) deletions.add(artifactId);
          artifactIssues.push(toArtifactIssue(artifactId, error));
          return;
        }
        if (current === null) {
          if (projectedArtifactIds.has(artifactId)) deletions.add(artifactId);
          return;
        }
        const lockedPrior = meta.artifacts[artifactId];
        if (
          lockedPrior &&
          lockedPrior.size === current.size &&
          lockedPrior.mtime_ms === current.mtime_ms
        ) {
          nextMeta.artifacts[artifactId] = lockedPrior;
          skipped += 1;
          return;
        }
        const priorIssue = meta.artifact_issues[artifactId];
        if (
          priorIssue &&
          priorIssue.size === current.size &&
          priorIssue.mtime_ms === current.mtime_ms
        ) {
          nextMeta.artifact_issues[artifactId] = priorIssue;
          if (projectedArtifactIds.has(artifactId)) deletions.add(artifactId);
          artifactIssues.push({
            kind: 'artifact_unavailable',
            artifact_id: artifactId,
            message: priorIssue.message,
          });
          skipped += 1;
          return;
        }
        try {
          const thread = await loadArtifactThreadFromArchive(projectDir, artifactId);
          assertIndexableThread(artifactId, thread);
          deletions.add(artifactId);
          ingestions.push(thread);
          nextMeta.artifacts[artifactId] = current;
          ingested += 1;
        } catch (error) {
          const issue = toArtifactIssue(artifactId, error);
          if (projectedArtifactIds.has(artifactId)) deletions.add(artifactId);
          nextMeta.artifact_issues[artifactId] = { ...current, message: issue.message };
          artifactIssues.push(issue);
        }
      });
    } catch (error) {
      if (!(error instanceof ArtifactLockTimeoutError)) throw error;
      const prior = meta.artifacts[artifactId];
      const priorIssue = meta.artifact_issues[artifactId];
      if (prior !== undefined) nextMeta.artifacts[artifactId] = prior;
      if (priorIssue !== undefined) {
        nextMeta.artifact_issues[artifactId] = priorIssue;
        if (projectedArtifactIds.has(artifactId)) deletions.add(artifactId);
        artifactIssues.push({
          kind: 'artifact_unavailable',
          artifact_id: artifactId,
          message: priorIssue.message,
        });
      }
      skipped += 1;
      indexIssues.push(lockTimeoutIssue(artifactId, error));
    }
  }

  let usageUpdate:
    | {
        events: Awaited<ReturnType<typeof readArchivedUsageEvents>>;
        highWater: HighWater | null;
        invalidRecords: number;
      }
    | undefined;
  const usagePath = archiveUsageLedgerPaths(projectDir).ledgerNdjson;
  const usageHw = await highWater(usagePath);
  nextMeta.usage = usageHw;
  if (usageHw === null) {
    if (meta.usage !== null || hasUsageProjection(index.store)) {
      usageUpdate = { events: [], highWater: null, invalidRecords: 0 };
    }
  } else if (
    meta.usage === null ||
    meta.usage.size !== usageHw.size ||
    meta.usage.mtime_ms !== usageHw.mtime_ms
  ) {
    try {
      const update = await archiveLock.withLock(USAGE_MIRROR_LOCK_ID, async () => {
        const current = await highWater(usagePath);
        if (current === null) return { events: [], highWater: null, invalidRecords: 0 };
        if (
          meta.usage !== null &&
          meta.usage.size === current.size &&
          meta.usage.mtime_ms === current.mtime_ms
        ) {
          return undefined;
        }
        let invalidRecords = 0;
        const events = await readArchivedUsageEvents(projectDir, () => {
          invalidRecords += 1;
        });
        return { events, highWater: current, invalidRecords };
      });
      if (update !== undefined) {
        usageUpdate = update;
        nextMeta.usage = update.highWater;
        if (update.invalidRecords > 0) {
          nextMeta.usage_issue = { invalid_records: update.invalidRecords };
          indexIssues.push(invalidUsageIssue(update.invalidRecords));
        }
      } else {
        nextMeta.usage = meta.usage;
        if (meta.usage_issue !== undefined) {
          nextMeta.usage_issue = meta.usage_issue;
          indexIssues.push(invalidUsageIssue(meta.usage_issue.invalid_records));
        }
      }
    } catch (error) {
      if (!(error instanceof ArtifactLockTimeoutError)) throw error;
      nextMeta.usage = meta.usage;
      if (meta.usage_issue !== undefined) {
        nextMeta.usage_issue = meta.usage_issue;
        indexIssues.push(invalidUsageIssue(meta.usage_issue.invalid_records));
      }
      indexIssues.push(lockTimeoutIssue('usage ledger', error));
    }
  } else if (meta.usage_issue !== undefined) {
    nextMeta.usage_issue = meta.usage_issue;
    indexIssues.push(invalidUsageIssue(meta.usage_issue.invalid_records));
  }

  await archiveLock.withLock(INDEX_PUBLICATION_LOCK_ID, async () => {
    const projectionChanged =
      deletions.size > 0 || ingestions.length > 0 || usageUpdate !== undefined;
    const metadataChanged = !sameIndexMetadata(meta, nextMeta);
    const generation =
      projectionChanged || metadataChanged
        ? applyAtGeneration(index.store, expectedGeneration, () => {
            for (const artifactId of deletions) index.store.deleteArtifact(artifactId);
            for (const thread of ingestions) ingestArtifactThread(index.store, thread);
            if (usageUpdate !== undefined) {
              index.store.clearUsageProjection();
              replayUsageEventsIntoStore(index.store, usageUpdate.events);
            }
          })
        : confirmGeneration(index.store, expectedGeneration);
    nextMeta.generation = generation;

    const publishedMeta = await readMeta(metaPath);
    if (!sameIndexMeta(publishedMeta, nextMeta)) {
      try {
        await atomicWriteFile(metaPath, JSON.stringify(nextMeta) + '\n');
      } catch (error) {
        const metaWriteIssue: ArchiveIndexIssue = {
          kind: 'index_degraded',
          message: `Could not update the disposable archive index metadata: ${errorMessage(error)}`,
        };
        indexIssues.push(metaWriteIssue);
      }
    }
    if (readRefreshGeneration(index.store) !== generation) throw new ConcurrentRefreshError();
  });
  return {
    ingested_artifacts: ingested,
    skipped_artifacts: skipped,
    usage_replayed: usageUpdate !== undefined,
    artifact_issues: artifactIssues,
    meta: nextMeta,
    index_issues: indexIssues,
  };
}

function readRefreshGeneration(store: Store): number {
  const row = store.db
    .prepare(`SELECT value FROM schema_meta WHERE key = ?`)
    .get(REFRESH_GENERATION_KEY) as { value: string } | undefined;
  if (row === undefined) return 0;
  const generation = Number(row.value);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
}

function applyAtGeneration(store: Store, expectedGeneration: number, apply: () => void): number {
  const transaction = store.db.transaction(() => {
    const current = readRefreshGeneration(store);
    if (current !== expectedGeneration) throw new ConcurrentRefreshError();
    apply();
    const next = current + 1;
    store.db
      .prepare(
        `INSERT INTO schema_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(REFRESH_GENERATION_KEY, String(next));
    return next;
  });
  return transaction.immediate();
}

function confirmGeneration(store: Store, expectedGeneration: number): number {
  const current = readRefreshGeneration(store);
  if (current !== expectedGeneration) throw new ConcurrentRefreshError();
  return current;
}

async function readAlignedMeta(store: Store, metaPath: string): Promise<IndexMeta> {
  const meta = await readMeta(metaPath);
  return isMetaAlignedWithStore(store, meta) ? meta : EMPTY_META;
}

function isMetaAlignedWithStore(store: Store, meta: IndexMeta): boolean {
  const readSnapshot = store.db.transaction(() => ({
    generation: readRefreshGeneration(store),
    projectedIds: store
      .listArtifacts()
      .map((artifact) => artifact.id)
      .sort(),
  }));
  const snapshot = readSnapshot();
  const cachedIds = Object.keys(meta.artifacts).sort();
  return (
    meta.generation === snapshot.generation &&
    snapshot.projectedIds.length === cachedIds.length &&
    snapshot.projectedIds.every((artifactId, index) => artifactId === cachedIds[index]) &&
    readRefreshGeneration(store) === snapshot.generation
  );
}

function sameIndexMeta(left: IndexMeta, right: IndexMeta): boolean {
  return left.generation === right.generation && sameIndexMetadata(left, right);
}

function sameIndexMetadata(left: IndexMeta, right: IndexMeta): boolean {
  return (
    sameHighWaterMap(left.artifacts, right.artifacts) &&
    sameArtifactIssueMap(left.artifact_issues, right.artifact_issues) &&
    sameHighWater(left.usage, right.usage) &&
    left.usage_issue?.invalid_records === right.usage_issue?.invalid_records
  );
}

function sameHighWaterMap(
  left: Record<string, HighWater>,
  right: Record<string, HighWater>
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => right[key] !== undefined && sameHighWater(left[key], right[key]))
  );
}

function sameArtifactIssueMap(
  left: IndexMeta['artifact_issues'],
  right: IndexMeta['artifact_issues']
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        right[key] !== undefined &&
        left[key].message === right[key].message &&
        sameHighWater(left[key], right[key])
    )
  );
}

function sameHighWater(left: HighWater | null, right: HighWater | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.size === right.size &&
      left.mtime_ms === right.mtime_ms)
  );
}

function hasUsageProjection(store: Store): boolean {
  const row = store.db
    .prepare(
      `SELECT
         EXISTS(SELECT 1 FROM usage_snapshots LIMIT 1)
         OR EXISTS(SELECT 1 FROM source_plan_links LIMIT 1) AS present`
    )
    .get() as { present: number };
  return row.present === 1;
}

function lockTimeoutIssue(target: string, error: ArtifactLockTimeoutError): ArchiveIndexIssue {
  return {
    kind: 'index_degraded',
    message:
      `Archive ${target} stayed locked for ${error.waitedMs}ms; ` +
      'the prior indexed generation remains in service and the next refresh will retry.',
  };
}

function invalidUsageIssue(count: number): ArchiveIndexIssue {
  return {
    kind: 'index_degraded',
    message:
      `Archive usage projection skipped ${count} invalid or unreadable ` +
      `${count === 1 ? 'record' : 'records'}; repair the archive before relying on usage totals.`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertIndexableThread(
  artifactId: string,
  thread: Awaited<ReturnType<typeof loadArtifactThreadFromArchive>>
): void {
  // A lossy archive thread rebuilt only the survivors: indexing it would
  // serve silently-incomplete state through every --all-projects surface.
  // Refuse — the ingest sites record the issue and skip the artifact.
  if (thread.lossyLines > 0) {
    throw new Error(
      `Archive artifact ${artifactId} has ${thread.lossyLines} corrupt event-log line(s) — ` +
        `a lossy thread must not be indexed; repair or restore the archive copy first.`
    );
  }
  if (thread.plan === null) {
    throw new Error(`Archive artifact ${artifactId} has no plan_captured event.`);
  }
}

/** Drop a project's index DB + meta (disposable by contract). */
export async function dropProjectIndex(indexRootDir: string, projectId: string): Promise<void> {
  const dbPath = projectIndexDbPath(indexRootDir, projectId);
  for (const p of [
    dbPath,
    `${dbPath}-wal`,
    `${dbPath}-shm`,
    projectIndexMetaPath(indexRootDir, projectId),
  ]) {
    await rm(p, { force: true });
  }
}

async function readMeta(metaPath: string): Promise<IndexMeta> {
  try {
    const parsed: unknown = JSON.parse(await readFile(metaPath, 'utf8'));
    if (!isRecord(parsed) || parsed.schema_version !== 1) return EMPTY_META;
    if (!Number.isSafeInteger(parsed.generation) || (parsed.generation as number) < 0) {
      return EMPTY_META;
    }
    const artifacts = parseHighWaterMap(parsed.artifacts);
    const artifactIssues = parseArtifactIssueMap(parsed.artifact_issues);
    const usage =
      parsed.usage === null || parsed.usage === undefined ? null : parseHighWater(parsed.usage);
    const usageIssue = parseUsageIssue(parsed.usage_issue);
    if (
      artifacts === null ||
      artifactIssues === null ||
      usage === undefined ||
      usageIssue === null ||
      (usage === null && usageIssue !== undefined)
    ) {
      return EMPTY_META;
    }
    return {
      schema_version: 1,
      generation: parsed.generation as number,
      artifacts,
      artifact_issues: artifactIssues,
      usage,
      ...(usageIssue === undefined ? {} : { usage_issue: usageIssue }),
    };
  } catch {
    return EMPTY_META;
  }
}

function parseUsageIssue(value: unknown): { invalid_records: number } | undefined | null {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.invalid_records) ||
    (value.invalid_records as number) < 1
  ) {
    return null;
  }
  return { invalid_records: value.invalid_records as number };
}

function parseHighWaterMap(value: unknown): Record<string, HighWater> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, HighWater> = {};
  for (const [key, candidate] of Object.entries(value)) {
    const highWater = parseHighWater(candidate);
    if (highWater === undefined || isUnsafeRecordKey(key)) return null;
    Object.defineProperty(result, key, { value: highWater, enumerable: true });
  }
  return result;
}

function parseArtifactIssueMap(value: unknown): IndexMeta['artifact_issues'] | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const result: IndexMeta['artifact_issues'] = {};
  for (const [key, candidate] of Object.entries(value)) {
    const highWater = parseHighWater(candidate);
    if (
      highWater === undefined ||
      !isRecord(candidate) ||
      typeof candidate.message !== 'string' ||
      isUnsafeRecordKey(key)
    ) {
      return null;
    }
    Object.defineProperty(result, key, {
      value: { ...highWater, message: candidate.message },
      enumerable: true,
    });
  }
  return result;
}

function parseHighWater(value: unknown): HighWater | undefined {
  if (!isRecord(value)) return undefined;
  const size = value.size;
  const mtimeMs = value.mtime_ms;
  if (
    typeof size !== 'number' ||
    !Number.isFinite(size) ||
    size < 0 ||
    typeof mtimeMs !== 'number' ||
    !Number.isFinite(mtimeMs) ||
    mtimeMs < 0
  ) {
    return undefined;
  }
  return { size, mtime_ms: mtimeMs };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUnsafeRecordKey(key: string): boolean {
  return key === '__proto__' || key === 'prototype' || key === 'constructor';
}

async function highWater(filePath: string): Promise<HighWater | null> {
  try {
    const s = await stat(filePath);
    return { size: s.size, mtime_ms: s.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function toArtifactIssue(artifactId: string, error: unknown): ArchiveArtifactIssue {
  return {
    kind: 'artifact_unavailable',
    artifact_id: artifactId,
    message: error instanceof Error ? error.message : String(error),
  };
}
