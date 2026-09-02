import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  appendFile,
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';

import {
  archiveArtifactPaths,
  archiveReviewPaths,
  archiveUsageLedgerPaths,
  ensureDir0700,
} from './paths.js';
import { loadArtifactThreadFromPaths } from './read.js';
import { atomicWriteFile } from '../artifacts/atomic-write.js';
import { appendEvent, type EventRecord, readEventLog } from '../events/event-log.js';
import { fsyncDirStrict, mkdirDurable, writeDurable } from '../fs/durable.js';
import { ArtifactLock } from '../locks.js';
import { assertResolvedWithin, assertSafePathSegment } from '../paths/containment.js';
import { MAX_USAGE_SIDECAR_BYTES, type UsageLedgerRecord } from '../schema/usage-ledger.js';
import { redactSecretsInObject } from '../secrets.js';
import {
  appendUsageLedgerRecord,
  readUsageLedger,
  usageRecordContentIdentity,
} from '../usage/ledger-log.js';
import {
  deriveUsageLedgerRecord,
  loadUsageRecordPayload,
  readExactBytes,
} from '../usage/record.js';

/**
 * Write-through mirror of the hot store into the home-dir archive.
 *
 * Invariants:
 * - **Hot first, mirror second, fail-open.** The mirror is invoked with the
 *   hot record already durably appended; every failure here is reported via
 *   `onWarn` and NEVER thrown — archive failure must not block capture.
 *   `archive repair` appends a missing tail or explicitly rebuilds a
 *   non-tail gap with the previous copy retained.
 * - **Idempotent by canonical identity.** Artifact events use `event_id`.
 *   Usage events use their stable envelope plus canonical payload content.
 *   Either the raw or policy-redacted payload may satisfy a hot record, while
 *   malformed or valid-but-divergent same-id content cannot suppress repair.
 * - **Conflicting usage sidecars are retained.** A same-id repair may need to
 *   replace the canonical sidecar filename. Different prior bytes are copied
 *   to a content-addressed `sidecar-conflicts` path before replacement.
 * - **Sidecar before line.** Same crash ordering as the hot log: the archive
 *   never holds an event line referencing a missing sidecar.
 * - **Fidelity by default.** With `redactSecrets` off the mirrored line is
 *   byte-identical to the hot line (raw copy, no recompute). With it on, the
 *   payload is redacted and the record is re-derived through the SAME append
 *   primitive the hot store uses — checksum and sidecar hash recomputed, the
 *   inline-vs-sidecar spill re-decided, and event identity (event_id / ts /
 *   type / idempotency_key) preserved.
 *
 * Concurrency: each mirror call takes an archive-side mkdir-lockdir (the
 * same `ArtifactLock` primitive as the hot store, with the lock dir under
 * the DISPOSABLE index root). Lock ordering is always hot-lock → archive-lock
 * (callers hold the hot lock already), so no cycle exists. The usage ledger
 * is the guaranteed-concurrent case: every worktree of a project mirrors to
 * one file.
 */

/** Archive-side lock id for the per-project usage-ledger mirror. */
export const USAGE_MIRROR_LOCK_ID = '__usage_ledger__';

/**
 * Archive-side lock id for a review append log. Scoped per `(slug, kind)` so a
 * `journal` append never blocks a `comments` append on the same branch, and no
 * two slugs contend. Underscores + the (already fs-safe) slug only — the id
 * becomes a `<id>.lock` dir name.
 */
export function reviewMirrorLockId(slug: string, kind: 'journal' | 'comments'): string {
  return `__review_${kind}__${slug}`;
}

/**
 * Stable per-line identity for a raw review-log line. Review lines have NO
 * usable per-line id: journal events are id-less, and a comment's `comment_id`
 * repeats across its `add`/`reply`/`status` lines (and across multiple replies),
 * so it cannot key a line. The deterministic, collision-free choice is the
 * sha256 of the verbatim line — identical for BOTH kinds. This makes replay
 * exact: re-mirroring the same hot line is a no-op; any genuinely new event
 * (fresh `ts`, or a comment's fresh UUID) always differs. The one accepted
 * trade-off — two byte-identical hot lines would collapse to one archived line
 * — never occurs in practice, since every event carries a millisecond `ts`.
 */
export function reviewEventIdentity(rawLine: string): string {
  return createHash('sha256').update(rawLine, 'utf8').digest('hex');
}

export interface ArchiveMirrorOptions {
  /** `<dataRoot>/projects/<project-id>` — the project's archive dir. */
  projectDir: string;
  /** Archive-side lock dir (under the disposable index root, per project). */
  locksDir: string;
  /** Redact payloads at mirror time (archive copy only; hot store untouched). */
  redactSecrets: boolean;
  /** Fail-open sink; every mirror failure lands here as one line. */
  onWarn?: (message: string) => void;
}

/** Structural shape shared by artifact events and usage-ledger records. */
type MirrorableRecord = EventRecord | UsageLedgerRecord;

export interface CanonicalArtifactRebuildResult {
  /** Directory containing the pre-repair archive log and sidecars. */
  backupPath: string;
}

export class ArchiveMirror {
  readonly projectDir: string;
  private readonly lock: ArtifactLock;
  private readonly usageContentCacheDir: string;
  private readonly redactSecrets: boolean;
  private readonly onWarn: (message: string) => void;

  constructor(opts: ArchiveMirrorOptions) {
    this.projectDir = opts.projectDir;
    this.lock = new ArtifactLock({ locksDir: opts.locksDir, heartbeatIntervalMs: 30_000 });
    this.usageContentCacheDir = path.join(opts.locksDir, 'usage-content-cache');
    this.redactSecrets = opts.redactSecrets;
    this.onWarn = opts.onWarn ?? (() => {});
  }

  /** Coordinate a strict archive read with mirror and repair writers. */
  withArtifactLock<T>(artifactId: string, fn: () => Promise<T>): Promise<T> {
    return this.lock.withLock(artifactId, fn);
  }

  /** Coordinate a review-wide read with both per-kind mirror writers. */
  withReviewLocks<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    assertSafePathSegment(slug, 'review slug');
    return this.lock.withLock(reviewMirrorLockId(slug, 'journal'), () =>
      this.lock.withLock(reviewMirrorLockId(slug, 'comments'), fn)
    );
  }

  /** Mirror one artifact event record. Never throws (fail-open). */
  async mirrorEventRecord(
    artifactId: string,
    record: EventRecord,
    hotSidecarsDir: string,
    hotContainmentRoot: string
  ): Promise<void> {
    try {
      await this.lock.withLock(artifactId, async () => {
        const paths = archiveArtifactPaths(this.projectDir, artifactId);
        const log = await archiveLogAppendState(paths.eventsNdjson, paths.sidecarsDir);
        if (log.unterminatedTail) {
          throw new Error(
            `archive copy for artifact ${artifactId} ends in an unterminated line ` +
              '(crash residue; appending would merge into or seal it)'
          );
        }
        if (log.seen.has(record.event_id)) return;
        // Mirroring that begins partway through a live artifact leaves a
        // headless archive log the reader cannot project, and nothing else
        // announces it: `archive status`, `doctor`, and `archive repair` all
        // see it, but only when someone thinks to look. Repair replays from the
        // hot store, so the remedy expires silently the day that worktree is
        // deleted — say so now, while it still works, and keep mirroring the
        // tail (refusing would discard the only copy that outlives the repo).
        if (log.seen.size === 0 && record.type !== 'plan_captured') {
          this.onWarn(
            `orcaops archive: mirroring for artifact ${artifactId} started mid-artifact ` +
              `(first archived event is ${record.type}, not the plan). Run ` +
              '`orcaops archive repair` now — once this worktree is gone the archived ' +
              'copy can never be completed.'
          );
        }
        await ensureDir0700(this.projectDir);
        await ensureDir0700(paths.dir);
        if (this.redactSecrets) {
          const payload = await loadRecordPayload(record, hotSidecarsDir, hotContainmentRoot);
          await appendEvent(
            {
              type: record.type,
              ts: record.ts,
              idempotency_key: record.idempotency_key,
              payload: redactSecretsInObject(payload),
              event_id: record.event_id,
            },
            { eventLogPath: paths.eventsNdjson, sidecarsDir: paths.sidecarsDir }
          );
        } else {
          await mirrorVerbatim(
            record,
            hotSidecarsDir,
            hotContainmentRoot,
            paths.eventsNdjson,
            paths.sidecarsDir
          );
        }
      });
    } catch (err) {
      this.onWarn(
        `orcaops archive: failed to mirror event ${record.event_id} (artifact ${artifactId}); ` +
          `capture continues, run \`orcaops archive repair\` to backfill. ` +
          `Cause: ${(err as Error).message}`
      );
    }
  }

  /** Mirror one usage-ledger record. Never throws (fail-open). */
  async mirrorUsageRecord(
    record: UsageLedgerRecord,
    hotSidecarsDir: string,
    hotContainmentRoot: string
  ): Promise<void> {
    try {
      await this.lock.withLock(USAGE_MIRROR_LOCK_ID, async () => {
        const paths = archiveUsageLedgerPaths(this.projectDir);
        const loaded = await loadUsageRecordPayload(record, hotSidecarsDir, hotContainmentRoot);
        if (!loaded.ok) {
          throw new Error(`Hot usage event ${record.event_id} has no valid bounded payload.`);
        }
        const payload = loaded.payload;
        const redactedPayload = redactSecretsInObject(payload);
        const acceptableContentIdentities = new Set([
          usageRecordContentIdentity(record, payload),
          usageRecordContentIdentity(record, redactedPayload),
        ]);
        const cached = await openUsageContentCache(
          this.usageContentCacheDir,
          paths.ledgerNdjson,
          paths.sidecarsDir
        ).catch(() => null);
        if (cached) {
          if (await cached.has(record.event_id, acceptableContentIdentities)) return;
        } else if (
          await ledgerHasUsageContent(
            paths.ledgerNdjson,
            paths.sidecarsDir,
            record.event_id,
            acceptableContentIdentities
          )
        ) {
          return;
        }
        await ensureDir0700(this.projectDir);
        await ensureDir0700(path.dirname(paths.ledgerNdjson));
        if (this.redactSecrets) {
          const redactedRecord = deriveUsageLedgerRecord({
            type: record.type,
            ts: record.ts,
            idempotency_key: record.idempotency_key,
            payload: redactedPayload,
            event_id: record.event_id,
          }).record;
          if ('sidecar_sha256' in redactedRecord) {
            await preserveDisplacedUsageSidecar(
              paths.sidecarsDir,
              record.event_id,
              redactedRecord.sidecar_sha256
            );
          }
          await appendUsageLedgerRecord(
            {
              type: record.type,
              ts: record.ts,
              idempotency_key: record.idempotency_key,
              payload: redactedPayload,
              event_id: record.event_id,
            },
            { ledgerPath: paths.ledgerNdjson, sidecarsDir: paths.sidecarsDir }
          );
          await cached
            ?.record(
              record.event_id,
              usageRecordContentIdentity(record, redactedPayload),
              redactedRecord
            )
            .catch(() => {});
        } else {
          if ('sidecar_sha256' in record) {
            await preserveDisplacedUsageSidecar(
              paths.sidecarsDir,
              record.event_id,
              record.sidecar_sha256
            );
          }
          await mirrorVerbatim(
            record,
            hotSidecarsDir,
            hotContainmentRoot,
            paths.ledgerNdjson,
            paths.sidecarsDir
          );
          await cached
            ?.record(record.event_id, usageRecordContentIdentity(record, payload), record)
            .catch(() => {});
        }
      });
    } catch (err) {
      this.onWarn(
        `orcaops archive: failed to mirror usage event ${record.event_id}; ` +
          `capture continues, run \`orcaops archive repair\` to backfill. ` +
          `Cause: ${(err as Error).message}`
      );
    }
  }

  /**
   * Explicit repair for a non-tail artifact gap.
   *
   * Unlike capture-time mirroring, this operation is strict: it stages and
   * reconstructs the complete hot thread, retains the damaged archive copy,
   * then atomically replaces only events.ndjson. Candidate sidecars land
   * before the log, preserving the normal crash-ordering invariant.
   */
  async rebuildArtifactFromHot(
    artifactId: string,
    hotRecords: readonly EventRecord[],
    hotSidecarsDir: string,
    hotContainmentRoot: string,
    expectedArchivedEventIds: readonly string[],
    expectedArchivedCorruptLines: number
  ): Promise<CanonicalArtifactRebuildResult> {
    return this.lock.withLock(artifactId, async () => {
      const paths = archiveArtifactPaths(this.projectDir, artifactId);
      const current = await readEventLog({
        eventLogPath: paths.eventsNdjson,
        sidecarsDir: paths.sidecarsDir,
      });
      const currentIds = current.events.map((event) => event.event_id);
      if (
        current.corrupt.length !== expectedArchivedCorruptLines ||
        !sameStrings(currentIds, expectedArchivedEventIds)
      ) {
        throw new Error(
          `Archive artifact ${artifactId} changed while repair was preparing it; ` +
            'nothing was replaced. Re-run `orcaops archive repair`.'
        );
      }

      await ensureDir0700(this.projectDir);
      await ensureDir0700(paths.dir);
      const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
      const stagingDir = path.join(paths.dir, `.repair-staging-${nonce}`);
      const stagingLog = path.join(stagingDir, 'events.ndjson');
      const stagingSidecars = path.join(stagingDir, 'sidecars');

      try {
        await ensureDir0700(stagingDir);
        await atomicWriteFile(stagingLog, '');
        for (const record of hotRecords) {
          if (this.redactSecrets) {
            const payload = await loadRecordPayload(record, hotSidecarsDir, hotContainmentRoot);
            await appendEvent(
              {
                type: record.type,
                ts: record.ts,
                idempotency_key: record.idempotency_key,
                payload: redactSecretsInObject(payload),
                event_id: record.event_id,
              },
              { eventLogPath: stagingLog, sidecarsDir: stagingSidecars }
            );
          } else {
            await mirrorVerbatim(
              record,
              hotSidecarsDir,
              hotContainmentRoot,
              stagingLog,
              stagingSidecars
            );
          }
        }

        const staged = await loadArtifactThreadFromPaths(artifactId, stagingLog, stagingSidecars);
        const stagedIds = staged.events.map((event) => event.record.event_id);
        const hotIds = hotRecords.map((event) => event.event_id);
        if (staged.corruptLines !== 0 || !sameStrings(stagedIds, hotIds)) {
          throw new Error(
            `Refusing to install staged archive repair for ${artifactId}: ` +
              'the staged thread did not validate against the hot event sequence.'
          );
        }

        const backupPath = path.join(paths.dir, 'repair-backups', nonce);
        await ensureDir0700(backupPath);
        await copyFileDurablyIfPresent(
          paths.eventsNdjson,
          path.join(backupPath, 'events.ndjson'),
          this.projectDir
        );
        await copyDirectoryDurablyIfPresent(
          paths.sidecarsDir,
          path.join(backupPath, 'sidecars'),
          this.projectDir
        );

        for (const { record } of staged.events) {
          if (!('sidecar_sha256' in record)) continue;
          await writeFileDurablyAtomic(
            path.join(paths.sidecarsDir, `${record.event_id}.json`),
            await readFile(path.join(stagingSidecars, `${record.event_id}.json`)),
            this.projectDir
          );
        }
        await writeFileDurablyAtomic(
          paths.eventsNdjson,
          await readFile(stagingLog),
          this.projectDir
        );

        // Validate the installed copy too. Staging validation protects the
        // old archive; this verifies the actual install before success.
        const installed = await loadArtifactThreadFromPaths(
          artifactId,
          paths.eventsNdjson,
          paths.sidecarsDir
        );
        const installedIds = installed.events.map((event) => event.record.event_id);
        if (installed.corruptLines !== 0 || !sameStrings(installedIds, hotIds)) {
          throw new Error(
            `Archive repair installed ${artifactId}, but post-install validation failed. ` +
              `The previous copy is retained at ${backupPath}.`
          );
        }
        return { backupPath };
      } finally {
        await rm(stagingDir, { recursive: true, force: true });
      }
    });
  }

  /**
   * Remove a detectable unterminated final line from an artifact's archive
   * log — never-acknowledged crash residue per the event-log tail doctrine.
   * Reachable ONLY from the explicit repair verb (`replayMissingEvents`); no
   * capture-time write or read path removes bytes. The damaged copy is
   * retained first (repair-backups/<nonce>, same pattern as the canonical
   * rebuild). Returns null when the log is absent or newline-terminated.
   */
  async clearUnterminatedArchiveTail(artifactId: string): Promise<{ backupPath: string } | null> {
    return this.lock.withLock(artifactId, async () => {
      const paths = archiveArtifactPaths(this.projectDir, artifactId);
      let raw: Buffer;
      try {
        raw = await readFile(paths.eventsNdjson);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
      if (raw.length === 0 || raw[raw.length - 1] === 0x0a) return null;
      const terminated = raw.subarray(0, raw.lastIndexOf(0x0a) + 1);
      const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
      const backupPath = path.join(paths.dir, 'repair-backups', nonce);
      await ensureDir0700(backupPath);
      // The backup is written from the buffer just read, never re-copied from
      // the source: a racing source change could otherwise leave an empty
      // backup while the stale buffer overwrites it. Backup failure throws.
      await writeFileDurablyAtomic(path.join(backupPath, 'events.ndjson'), raw, this.projectDir);
      await writeFileDurablyAtomic(paths.eventsNdjson, terminated, this.projectDir);
      this.onWarn(
        `orcaops archive: cleared unterminated crash residue from artifact ${artifactId}'s ` +
          `archive copy; the damaged copy is retained at ${backupPath}`
      );
      return { backupPath };
    });
  }

  /**
   * Mirror one raw review-log line (`journal.ndjson` / `comments.ndjson`) into
   * the archive. Never throws (fail-open), verbatim byte-copy, idempotent by
   * `identity` (see `reviewEventIdentity`). `rawLine` is the single serialized
   * JSON event WITHOUT its trailing newline — exactly `JSON.stringify(event)`,
   * the same bytes the hot append writes — so the archived line is byte-identical.
   */
  async mirrorReviewEvent(
    reviewStateVersion: number,
    slug: string,
    kind: 'journal' | 'comments',
    rawLine: string,
    identity: string
  ): Promise<void> {
    try {
      await this.lock.withLock(reviewMirrorLockId(slug, kind), async () => {
        const paths = archiveReviewPaths(this.projectDir, reviewStateVersion, slug);
        const logPath = kind === 'journal' ? paths.journalNdjson : paths.commentsNdjson;
        const seen = await seenReviewIdentities(logPath);
        if (seen.has(identity)) return;
        await ensureDir0700(this.projectDir);
        await ensureDir0700(paths.dir);
        await mkdir(path.dirname(logPath), { recursive: true });
        await appendFile(logPath, `${rawLine}\n`, 'utf8');
      });
    } catch (err) {
      this.onWarn(
        `orcaops archive: failed to mirror review ${kind} line (slug ${slug}); ` +
          `the review continues and the hot log is intact. ` +
          `Cause: ${(err as Error).message}`
      );
    }
  }
}

/**
 * Append-time view of an archive event log. Read fresh per append (the check
 * runs under the archive lock, and cross-process writers exist — a cached set
 * could lie). Ids are claimed by every NEWLINE-TERMINATED line that names one
 * — surviving events AND corrupt lines — so replaying over a damaged line can
 * never mint a duplicate id. The unterminated final line claims nothing: it
 * is never-acknowledged crash residue (event-log tail doctrine) and must not
 * suppress its own replay.
 */
async function archiveLogAppendState(
  logPath: string,
  sidecarsDir: string
): Promise<{ seen: Set<string>; unterminatedTail: boolean }> {
  const read = await readEventLog({ eventLogPath: logPath, sidecarsDir });
  const seen = new Set(read.events.map((event) => event.event_id));
  for (const entry of read.corrupt) {
    if (entry.event_id !== undefined) seen.add(entry.event_id);
  }
  return {
    seen,
    unterminatedTail: read.corrupt.some((entry) => entry.kind === 'truncated_tail'),
  };
}

interface UsageCacheHighWater {
  size: number;
  mtime_ms: number;
}

interface UsageContentCacheMeta {
  schema_version: 1;
  ledger: UsageCacheHighWater | null;
}

interface UsageContentMarker {
  identity: string;
  sidecar_sha256: string | null;
  sidecar_size: number | null;
}

/**
 * Disposable acceleration only. The ledger high-water invalidates this cache;
 * a missing/corrupt cache rebuilds from fully validated archive records.
 */
class UsageContentCache {
  constructor(
    private readonly cacheDir: string,
    private readonly ledgerPath: string,
    private readonly sidecarsDir: string
  ) {}

  async has(eventId: string, acceptable: ReadonlySet<string>): Promise<boolean> {
    const stored = await readUsageContentMarker(this.cacheDir, eventId);
    for (const marker of stored) {
      if (!acceptable.has(marker.identity)) continue;
      if (marker.sidecar_sha256 === null) return true;
      if (await usageSidecarMatches(this.sidecarsDir, eventId, marker)) return true;
    }
    return false;
  }

  async record(eventId: string, identity: string, record: UsageLedgerRecord): Promise<void> {
    const markers = new Map(
      (await readUsageContentMarker(this.cacheDir, eventId)).map((marker) => [
        marker.identity,
        marker,
      ])
    );
    markers.set(identity, markerForRecord(identity, record));
    await writeUsageContentMarker(this.cacheDir, eventId, markers.values());
    await writeUsageContentCacheMeta(this.cacheDir, await usageCacheHighWater(this.ledgerPath));
  }
}

async function openUsageContentCache(
  cacheDir: string,
  ledgerPath: string,
  sidecarsDir: string
): Promise<UsageContentCache> {
  const ledger = await usageCacheHighWater(ledgerPath);
  const meta = await readUsageContentCacheMeta(cacheDir);
  if (meta === null || !sameUsageCacheHighWater(meta.ledger, ledger)) {
    await rebuildUsageContentCache(cacheDir, ledgerPath, sidecarsDir);
  }
  return new UsageContentCache(cacheDir, ledgerPath, sidecarsDir);
}

async function rebuildUsageContentCache(
  cacheDir: string,
  ledgerPath: string,
  sidecarsDir: string
): Promise<void> {
  await rm(cacheDir, { recursive: true, force: true });
  await ensureDir0700(cacheDir);
  const byEvent = new Map<string, Map<string, UsageContentMarker>>();
  await readUsageLedger({
    ledgerPath,
    sidecarsDir,
    onValidRecord: (record, payload) => {
      const markers = byEvent.get(record.event_id) ?? new Map<string, UsageContentMarker>();
      const identity = usageRecordContentIdentity(record, payload);
      markers.set(identity, markerForRecord(identity, record));
      byEvent.set(record.event_id, markers);
    },
  });
  for (const [eventId, markers] of byEvent) {
    await writeUsageContentMarker(cacheDir, eventId, markers.values());
  }
  await writeUsageContentCacheMeta(cacheDir, await usageCacheHighWater(ledgerPath));
}

async function readUsageContentMarker(
  cacheDir: string,
  eventId: string
): Promise<UsageContentMarker[]> {
  assertSafePathSegment(eventId, 'usage event id');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(cacheDir, `${eventId}.json`), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isUsageContentMarker);
}

async function writeUsageContentMarker(
  cacheDir: string,
  eventId: string,
  markers: Iterable<UsageContentMarker>
): Promise<void> {
  assertSafePathSegment(eventId, 'usage event id');
  await ensureDir0700(cacheDir);
  await atomicWriteFile(
    path.join(cacheDir, `${eventId}.json`),
    `${JSON.stringify([...markers].sort((left, right) => left.identity.localeCompare(right.identity)))}\n`
  );
}

function markerForRecord(identity: string, record: UsageLedgerRecord): UsageContentMarker {
  return 'sidecar_sha256' in record
    ? {
        identity,
        sidecar_sha256: record.sidecar_sha256,
        sidecar_size: record.sidecar_size,
      }
    : { identity, sidecar_sha256: null, sidecar_size: null };
}

function isUsageContentMarker(value: unknown): value is UsageContentMarker {
  if (typeof value !== 'object' || value === null) return false;
  const marker = value as Partial<UsageContentMarker>;
  if (typeof marker.identity !== 'string' || !/^[0-9a-f]{64}$/.test(marker.identity)) {
    return false;
  }
  if (marker.sidecar_sha256 === null && marker.sidecar_size === null) return true;
  return (
    typeof marker.sidecar_sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(marker.sidecar_sha256) &&
    typeof marker.sidecar_size === 'number' &&
    Number.isSafeInteger(marker.sidecar_size) &&
    marker.sidecar_size >= 0 &&
    marker.sidecar_size <= MAX_USAGE_SIDECAR_BYTES
  );
}

async function usageSidecarMatches(
  sidecarsDir: string,
  eventId: string,
  marker: UsageContentMarker
): Promise<boolean> {
  if (marker.sidecar_sha256 === null || marker.sidecar_size === null) return false;
  let handle;
  try {
    handle = await open(
      path.join(sidecarsDir, `${eventId}.json`),
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK
    );
  } catch {
    return false;
  }
  let bytes: Buffer | null;
  try {
    bytes = await readExactBytes(handle, marker.sidecar_size);
  } catch {
    bytes = null;
  }
  await handle.close().catch(() => {});
  return (
    bytes !== null && createHash('sha256').update(bytes).digest('hex') === marker.sidecar_sha256
  );
}

async function ledgerHasUsageContent(
  ledgerPath: string,
  sidecarsDir: string,
  eventId: string,
  acceptable: ReadonlySet<string>
): Promise<boolean> {
  let found = false;
  await readUsageLedger({
    ledgerPath,
    sidecarsDir,
    onValidRecord: (record, payload) => {
      if (
        record.event_id === eventId &&
        acceptable.has(usageRecordContentIdentity(record, payload))
      ) {
        found = true;
      }
    },
  });
  return found;
}

async function readUsageContentCacheMeta(cacheDir: string): Promise<UsageContentCacheMeta | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(cacheDir, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!isUsageContentCacheMeta(parsed)) return null;
  return parsed;
}

async function writeUsageContentCacheMeta(
  cacheDir: string,
  ledger: UsageCacheHighWater | null
): Promise<void> {
  await ensureDir0700(cacheDir);
  await atomicWriteFile(
    path.join(cacheDir, 'meta.json'),
    `${JSON.stringify({ schema_version: 1, ledger })}\n`
  );
}

async function usageCacheHighWater(filePath: string): Promise<UsageCacheHighWater | null> {
  try {
    const value = await stat(filePath);
    return { size: value.size, mtime_ms: value.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function sameUsageCacheHighWater(
  left: UsageCacheHighWater | null,
  right: UsageCacheHighWater | null
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.size === right.size &&
      left.mtime_ms === right.mtime_ms)
  );
}

function isUsageContentCacheMeta(value: unknown): value is UsageContentCacheMeta {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { schema_version?: unknown; ledger?: unknown };
  if (candidate.schema_version !== 1) return false;
  if (candidate.ledger === null) return true;
  if (typeof candidate.ledger !== 'object' || candidate.ledger === null) return false;
  const ledger = candidate.ledger as { size?: unknown; mtime_ms?: unknown };
  return (
    typeof ledger.size === 'number' &&
    Number.isFinite(ledger.size) &&
    ledger.size >= 0 &&
    typeof ledger.mtime_ms === 'number' &&
    Number.isFinite(ledger.mtime_ms) &&
    ledger.mtime_ms >= 0
  );
}

async function preserveDisplacedUsageSidecar(
  sidecarsDir: string,
  eventId: string,
  incomingSha256: string
): Promise<void> {
  assertSafePathSegment(eventId, 'event id');
  const currentPath = path.join(sidecarsDir, `${eventId}.json`);
  let current: Buffer;
  try {
    current = await readFile(currentPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const currentSha256 = createHash('sha256').update(current).digest('hex');
  if (currentSha256 === incomingSha256) return;

  const backupPath = path.join(
    path.dirname(sidecarsDir),
    'sidecar-conflicts',
    eventId,
    `${currentSha256}.json`
  );
  await writeFileDurablyAtomic(backupPath, current, path.dirname(sidecarsDir));
}

/**
 * Content-hash identities already present in an archive review log. Read fresh
 * per append under the review lock (same doctrine as `archiveLogAppendState`). Corrupt
 * lines simply don't contribute an identity; the verbatim append never rewrites
 * existing lines.
 */
async function seenReviewIdentities(logPath: string): Promise<Set<string>> {
  let raw: string;
  try {
    raw = await readFile(logPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw err;
  }
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    seen.add(reviewEventIdentity(line));
  }
  return seen;
}

/** Inline payload, or the hot sidecar's JSON for spilled records. */
async function loadRecordPayload(
  record: MirrorableRecord,
  hotSidecarsDir: string,
  hotContainmentRoot: string
): Promise<unknown> {
  if ('payload' in record) return record.payload;
  const sidecarPath = assertResolvedWithin(
    path.join(hotSidecarsDir, `${record.event_id}.json`),
    hotContainmentRoot,
    'hot archive-mirror sidecar read',
    { rejectSymlinks: true }
  );
  const raw = await readFile(sidecarPath, 'utf8');
  return JSON.parse(raw) as unknown;
}

/**
 * Byte-identical mirror: copy the hot sidecar (temp → rename, BEFORE the
 * referencing line) and append the hot line verbatim. No recompute — the
 * checksum, spill decision, and key order are exactly the hot store's.
 */
async function mirrorVerbatim(
  record: MirrorableRecord,
  hotSidecarsDir: string,
  hotContainmentRoot: string,
  destLogPath: string,
  destSidecarsDir: string
): Promise<void> {
  if ('sidecar_sha256' in record) {
    // Records reaching here are schema-validated (UUIDv7 event ids), but
    // the id becomes both a SOURCE and DESTINATION segment — keep the
    // segment guard at the join so no future ingress can route the copy
    // outside the sidecar dirs.
    assertSafePathSegment(record.event_id, 'event id');
    await mkdir(destSidecarsDir, { recursive: true });
    const src = assertResolvedWithin(
      path.join(hotSidecarsDir, `${record.event_id}.json`),
      hotContainmentRoot,
      'hot archive-mirror sidecar copy',
      { rejectSymlinks: true }
    );
    const dest = path.join(destSidecarsDir, `${record.event_id}.json`);
    const temp = `${dest}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    await copyFile(src, temp);
    await rename(temp, dest);
  }
  await mkdir(path.dirname(destLogPath), { recursive: true });
  await appendFile(destLogPath, JSON.stringify(record) + '\n', 'utf8');
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function writeFileDurablyAtomic(
  dest: string,
  data: Buffer,
  ownedRoot: string
): Promise<void> {
  const canonicalRoot = assertResolvedWithin(ownedRoot, ownedRoot, 'durable archive root', {
    allowRoot: true,
    rejectSymlinks: true,
  });
  const finalPath = assertResolvedWithin(dest, canonicalRoot, 'durable archive write', {
    rejectSymlinks: true,
  });
  const dir = path.dirname(finalPath);
  await mkdirDurable(dir, 0o700, canonicalRoot, canonicalRoot);
  await fsyncDirectoryChain(dir, canonicalRoot);
  const temp = assertResolvedWithin(
    `${finalPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    canonicalRoot,
    'durable archive temporary write',
    { rejectSymlinks: true }
  );
  try {
    await writeDurable(temp, data, 0o600, canonicalRoot);
    await rename(temp, finalPath);
    await fsyncDirStrict(dir, canonicalRoot);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

async function fsyncDirectoryChain(dir: string, ownedRoot: string): Promise<void> {
  let current = dir;
  for (;;) {
    await fsyncDirStrict(current, ownedRoot);
    if (current === ownedRoot) return;
    const parent = path.dirname(current);
    if (parent === current || !current.startsWith(`${ownedRoot}${path.sep}`)) {
      throw new Error(`durable archive directory escaped its owned root: ${dir}`);
    }
    current = parent;
  }
}

async function copyFileDurablyIfPresent(
  src: string,
  dest: string,
  ownedRoot: string
): Promise<void> {
  const safeSource = assertResolvedWithin(src, ownedRoot, 'archive repair backup source', {
    rejectSymlinks: true,
  });
  let data: Buffer;
  try {
    data = await readFile(safeSource);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  await writeFileDurablyAtomic(dest, data, ownedRoot);
}

async function copyDirectoryDurablyIfPresent(
  src: string,
  dest: string,
  ownedRoot: string
): Promise<void> {
  const safeSource = assertResolvedWithin(src, ownedRoot, 'archive repair backup directory', {
    rejectSymlinks: true,
  });
  let entries;
  try {
    entries = await readdir(safeSource, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isFile()) {
      throw new Error(
        `refusing unexpected non-file in archive repair sidecars: ${path.join(safeSource, entry.name)}`
      );
    }
    await copyFileDurablyIfPresent(
      path.join(safeSource, entry.name),
      path.join(dest, entry.name),
      ownedRoot
    );
  }
}
