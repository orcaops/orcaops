import { readdir, readFile } from 'node:fs/promises';

import type { ArchiveMirror } from './mirror.js';
import { archiveArtifactPaths, archiveUsageLedgerPaths } from './paths.js';
import { loadArtifactThreadFromArchive, loadArtifactThreadFromPaths } from './read.js';
import {
  artifactPathsFor,
  artifactsRoot,
  usageLedgerPath,
  usageSidecarsDir,
} from '../artifacts/paths.js';
import { readEventLog } from '../events/event-log.js';
import { assertResolvedWithin } from '../paths/containment.js';
import type { Config } from '../schema/config.js';
import { type UsageLedgerRecord, UsageLedgerRecordSchema } from '../schema/usage-ledger.js';
import { redactSecretsInObject } from '../secrets.js';
import {
  readUsageLedger,
  usageRecordContentIdentity,
  verifyUsageRecordChecksum,
} from '../usage/ledger-log.js';
import { deriveUsageLedgerRecord, loadUsageRecordPayload } from '../usage/record.js';

/**
 * Mirror lag + repair. There is deliberately NO queue and NO
 * cursor: the hot event log is the durable source, so lag is a per-artifact
 * ordered event comparison computed on demand. A true missing tail stays
 * append-only; a prefix/interior/order gap is rebuilt from the authoritative
 * hot log only after strict staged reconstruction, with the damaged copy
 * retained as a backup. Unrelated corrupt archive lines are still reported
 * and left untouched.
 */

export type ArtifactRepairMode = 'complete' | 'tail_replay' | 'canonical_rebuild' | 'blocked';

export type ArtifactRepairBlockReason =
  | 'hot_log_corrupt'
  | 'archive_ahead'
  | 'hot_unreconstructable';

export type ArchiveRepairIssueKind = ArtifactRepairBlockReason | 'archive_unreconstructable';

export interface ArchiveRepairIssue {
  artifact_id: string;
  kind: ArchiveRepairIssueKind;
  message: string;
  missing_events: number;
}

export interface ArtifactMirrorLag {
  artifact_id: string;
  hot_events: number;
  archived_events: number;
  /** Hot event ids absent from the archive, in hot-log order. */
  missing_event_ids: string[];
  /** Archive event ids absent from hot. Any such event blocks automatic repair. */
  archive_only_event_ids: string[];
  /** Whether repair is complete, append-safe, requires overwrite, or needs a decision. */
  repair_mode: ArtifactRepairMode;
  /** Why automatic repair is blocked, if `repair_mode` is `blocked`. */
  block_reason: ArtifactRepairBlockReason | null;
  /** Human-readable detail for a blocked artifact. */
  block_message: string | null;
  /** Corrupt lines in the authoritative HOT copy. */
  hot_corrupt_lines: number;
  /** Corrupt lines in the ARCHIVE copy (surfaced, never touched). */
  archive_corrupt_lines: number;
}

export interface UsageMirrorLag {
  hot_events: number;
  archived_events: number;
  missing_event_ids: string[];
}

export interface MirrorLagReport {
  artifacts: ArtifactMirrorLag[];
  usage: UsageMirrorLag;
  /** All hot events absent from archive, including blocked artifacts. */
  total_missing: number;
  /** Missing events that an automatic repair can still attempt. */
  repairable_missing: number;
  /** Missing events automatic repair refuses to copy. */
  blocked_missing: number;
  /** Payload-invalid usage records quarantined outside the readable archive. */
  usage_blocked_missing: number;
  /** Artifacts held behind an explicit content-resolution decision. */
  blocked_artifacts: number;
  artifacts_requiring_rebuild: number;
}

export interface MirrorLagOptions {
  repoRoot: string;
  config: Pick<Config, 'artifacts'>;
  /** `<dataRoot>/projects/<project-id>` for this repo's identity. */
  projectDir: string;
}

export async function computeMirrorLag(opts: MirrorLagOptions): Promise<MirrorLagReport> {
  const artifacts: ArtifactMirrorLag[] = [];
  for (const artifactId of await listHotArtifactIds(opts.repoRoot, opts.config)) {
    const hotPaths = artifactPathsFor(opts.repoRoot, opts.config, artifactId);
    const archivePaths = archiveArtifactPaths(opts.projectDir, artifactId);
    const hot = await readEventLog({
      eventLogPath: hotPaths.eventsNdjson,
      sidecarsDir: hotPaths.sidecarsDir,
      containmentRoot: opts.repoRoot,
    });
    const archived = await readEventLog({
      eventLogPath: archivePaths.eventsNdjson,
      sidecarsDir: archivePaths.sidecarsDir,
    });
    const archivedIds = new Set(archived.events.map((e) => e.event_id));
    const hotIds = new Set(hot.events.map((e) => e.event_id));
    const hotEventIds = hot.events.map((event) => event.event_id);
    const archivedEventIds = archived.events.map((event) => event.event_id);
    const missingEventIds = hotEventIds.filter((id) => !archivedIds.has(id));
    const archiveOnlyEventIds = archivedEventIds.filter((id) => !hotIds.has(id));
    const classification = await classifyArtifactRepair({
      artifactId,
      hotEventIds,
      archivedEventIds,
      hotCorruptLines: hot.corrupt.length,
      archiveOnlyEventIds,
      hotEventsNdjson: hotPaths.eventsNdjson,
      hotSidecarsDir: hotPaths.sidecarsDir,
      hotContainmentRoot: opts.repoRoot,
    });
    artifacts.push({
      artifact_id: artifactId,
      hot_events: hot.events.length,
      archived_events: archived.events.length,
      missing_event_ids: missingEventIds,
      archive_only_event_ids: archiveOnlyEventIds,
      repair_mode: classification.mode,
      block_reason: classification.blockReason,
      block_message: classification.blockMessage,
      hot_corrupt_lines: hot.corrupt.length,
      archive_corrupt_lines: archived.corrupt.length,
    });
  }

  const usageAnalysis = await analyzeUsageLag(opts);
  const usage = usageAnalysis.lag;

  const total_missing =
    artifacts.reduce((n, a) => n + a.missing_event_ids.length, 0) + usage.missing_event_ids.length;
  const blockedArtifacts = artifacts.filter((artifact) => artifact.repair_mode === 'blocked');
  const blocked_missing = blockedArtifacts.reduce(
    (count, artifact) => count + artifact.missing_event_ids.length,
    0
  );
  const usage_blocked_missing = usageAnalysis.blockedMissing;
  const repairable_missing = total_missing - blocked_missing - usage_blocked_missing;
  const blocked_artifacts = blockedArtifacts.length;
  const artifacts_requiring_rebuild = artifacts.filter(
    (artifact) => artifact.repair_mode === 'canonical_rebuild'
  ).length;
  return {
    artifacts,
    usage,
    total_missing,
    repairable_missing,
    blocked_missing,
    usage_blocked_missing,
    blocked_artifacts,
    artifacts_requiring_rebuild,
  };
}

export interface RebuiltArtifact {
  artifact_id: string;
  backup_path: string;
}

export interface ReplayResult {
  /** Records replayed through the mirror (attempted; the mirror is fail-open). */
  replayed_events: number;
  /** Repairable missing count remaining after replay. Blocked work is separate. */
  remaining_missing: number;
  /** Missing events automatic repair refuses to copy. */
  blocked_missing: number;
  /** Payload-invalid usage records retained only in the authoritative hot ledger. */
  usage_blocked_missing: number;
  /** Artifacts unavailable to automatic repair. */
  blocked_artifacts: number;
  /**
   * False when repairable work or artifact content resolution remains.
   * Quarantined invalid usage records remain reported separately without
   * making archive activation permanently impossible.
   */
  complete: boolean;
  /** Artifact-local content failures; infrastructure failures still throw. */
  artifact_issues: ArchiveRepairIssue[];
  /** Non-tail artifacts replaced from the canonical hot log. */
  rebuilt_artifacts: RebuiltArtifact[];
  /** Artifacts still requiring a canonical rebuild after repair. */
  remaining_rebuilds: number;
}

/**
 * Repair every artifact in canonical hot-log order (also the first-enable
 * backfill path). True tails replay through the mirror; non-tail gaps use a
 * staged rebuild. Returns a fresh post-repair survey so silent mirror
 * failures cannot masquerade as repaired.
 */
export async function replayMissingEvents(
  opts: MirrorLagOptions & { mirror: ArchiveMirror }
): Promise<ReplayResult> {
  const before = await computeMirrorLag(opts);
  let replayed = 0;
  const rebuilt: RebuiltArtifact[] = [];
  const touchedArtifactIds = new Set<string>();
  const encounteredIssues: ArchiveRepairIssue[] = [];

  for (const lag of before.artifacts) {
    if (lag.repair_mode === 'blocked') {
      encounteredIssues.push(issueFromBlockedLag(lag));
      continue;
    }
    if (lag.repair_mode === 'complete') continue;

    const hotPaths = artifactPathsFor(opts.repoRoot, opts.config, lag.artifact_id);
    const hot = await readEventLog({
      eventLogPath: hotPaths.eventsNdjson,
      sidecarsDir: hotPaths.sidecarsDir,
      containmentRoot: opts.repoRoot,
    });
    if (hot.corrupt.length > 0) {
      encounteredIssues.push(
        makeIssue(
          lag.artifact_id,
          'hot_log_corrupt',
          lag.missing_event_ids.length,
          `The authoritative hot log has ${hot.corrupt.length} corrupt line(s).`
        )
      );
      continue;
    }
    if (lag.repair_mode === 'canonical_rebuild') {
      const archivePaths = archiveArtifactPaths(opts.projectDir, lag.artifact_id);
      const archived = await readEventLog({
        eventLogPath: archivePaths.eventsNdjson,
        sidecarsDir: archivePaths.sidecarsDir,
      });
      const currentHotIds = new Set(hot.events.map((event) => event.event_id));
      const archiveOnly = archived.events.filter((event) => !currentHotIds.has(event.event_id));
      if (archiveOnly.length > 0) {
        encounteredIssues.push(
          makeIssue(
            lag.artifact_id,
            'archive_ahead',
            lag.missing_event_ids.length,
            `The archive has ${archiveOnly.length} event(s) absent from the hot log.`
          )
        );
        continue;
      }
      const hotValidation = await validateHotCanonicalSource(
        lag.artifact_id,
        hotPaths.eventsNdjson,
        hotPaths.sidecarsDir,
        opts.repoRoot
      );
      if (hotValidation !== null) {
        encounteredIssues.push(hotValidation);
        continue;
      }
      const result = await opts.mirror.rebuildArtifactFromHot(
        lag.artifact_id,
        hot.events,
        hotPaths.sidecarsDir,
        opts.repoRoot,
        archived.events.map((event) => event.event_id),
        archived.corrupt.length
      );
      rebuilt.push({ artifact_id: lag.artifact_id, backup_path: result.backupPath });
      touchedArtifactIds.add(lag.artifact_id);
      continue;
    }
    // Tail-shape residue (torn line OR complete-but-unterminated record) is
    // cleared under the explicit repair verb before replaying, damaged copy
    // retained; interior corrupt lines are untouched.
    await opts.mirror.clearUnterminatedArchiveTail(lag.artifact_id);
    const missing = new Set(lag.missing_event_ids);
    for (const record of hot.events) {
      if (!missing.has(record.event_id)) continue;
      await opts.mirror.mirrorEventRecord(
        lag.artifact_id,
        record,
        hotPaths.sidecarsDir,
        opts.repoRoot
      );
      replayed += 1;
    }
    touchedArtifactIds.add(lag.artifact_id);
  }

  if (before.usage.missing_event_ids.length > 0) {
    const hotSidecars = usageSidecarsDir(opts.repoRoot);
    const usageAnalysis = await analyzeUsageLag(opts);
    for (const record of usageAnalysis.repairableRecords) {
      await opts.mirror.mirrorUsageRecord(record, hotSidecars, opts.repoRoot);
      replayed += 1;
    }
  }

  const after = await computeMirrorLag(opts);
  for (const artifact of after.artifacts) {
    if (!touchedArtifactIds.has(artifact.artifact_id) || artifact.repair_mode !== 'complete') {
      continue;
    }
    try {
      const thread = await loadArtifactThreadFromArchive(opts.projectDir, artifact.artifact_id);
      if (thread.corruptLines > 0) {
        encounteredIssues.push(
          makeIssue(
            artifact.artifact_id,
            'archive_unreconstructable',
            artifact.missing_event_ids.length,
            `The repaired archive still has ${thread.corruptLines} corrupt line(s).`
          )
        );
      }
    } catch (error) {
      if (isInfrastructureError(error)) throw error;
      encounteredIssues.push(
        makeIssue(
          artifact.artifact_id,
          'archive_unreconstructable',
          artifact.missing_event_ids.length,
          `The repaired archive cannot be reconstructed: ${errorMessage(error)}`
        )
      );
    }
  }
  const artifactIssues = dedupeIssues([
    ...encounteredIssues,
    ...after.artifacts
      .filter((artifact) => artifact.repair_mode === 'blocked')
      .map(issueFromBlockedLag),
  ]);
  const blockedArtifactIds = new Set(artifactIssues.map((issue) => issue.artifact_id));
  const complete =
    after.repairable_missing === 0 &&
    after.artifacts_requiring_rebuild === 0 &&
    artifactIssues.length === 0;
  return {
    replayed_events: replayed,
    remaining_missing: after.repairable_missing,
    blocked_missing: after.blocked_missing,
    usage_blocked_missing: after.usage_blocked_missing,
    blocked_artifacts: blockedArtifactIds.size,
    complete,
    artifact_issues: artifactIssues,
    rebuilt_artifacts: rebuilt,
    remaining_rebuilds: after.artifacts_requiring_rebuild,
  };
}

interface ArtifactRepairClassificationInput {
  artifactId: string;
  hotEventIds: readonly string[];
  archivedEventIds: readonly string[];
  hotCorruptLines: number;
  archiveOnlyEventIds: readonly string[];
  hotEventsNdjson: string;
  hotSidecarsDir: string;
  hotContainmentRoot: string;
}

interface ArtifactRepairClassification {
  mode: ArtifactRepairMode;
  blockReason: ArtifactRepairBlockReason | null;
  blockMessage: string | null;
}

async function classifyArtifactRepair(
  input: ArtifactRepairClassificationInput
): Promise<ArtifactRepairClassification> {
  if (input.hotCorruptLines > 0) {
    return blockedClassification(
      'hot_log_corrupt',
      `The authoritative hot log has ${input.hotCorruptLines} corrupt line(s).`
    );
  }
  if (input.archiveOnlyEventIds.length > 0) {
    return blockedClassification(
      'archive_ahead',
      `The archive has ${input.archiveOnlyEventIds.length} event(s) absent from the hot log.`
    );
  }
  if (sameSequence(input.hotEventIds, input.archivedEventIds)) {
    return repairClassification('complete');
  }
  if (
    input.archivedEventIds.length < input.hotEventIds.length &&
    input.archivedEventIds.every((eventId, index) => eventId === input.hotEventIds[index])
  ) {
    return repairClassification('tail_replay');
  }
  const hotValidation = await validateHotCanonicalSource(
    input.artifactId,
    input.hotEventsNdjson,
    input.hotSidecarsDir,
    input.hotContainmentRoot
  );
  if (hotValidation !== null) {
    return blockedClassification(hotValidation.kind, hotValidation.message);
  }
  return repairClassification('canonical_rebuild');
}

function repairClassification(
  mode: Exclude<ArtifactRepairMode, 'blocked'>
): ArtifactRepairClassification {
  return { mode, blockReason: null, blockMessage: null };
}

function blockedClassification(
  reason: ArtifactRepairBlockReason,
  message: string
): ArtifactRepairClassification {
  return { mode: 'blocked', blockReason: reason, blockMessage: message };
}

async function validateHotCanonicalSource(
  artifactId: string,
  eventsNdjson: string,
  sidecarsDir: string,
  containmentRoot: string
): Promise<(ArchiveRepairIssue & { kind: ArtifactRepairBlockReason }) | null> {
  try {
    const thread = await loadArtifactThreadFromPaths(
      artifactId,
      eventsNdjson,
      sidecarsDir,
      containmentRoot
    );
    if (thread.corruptLines > 0) {
      return makeIssue(
        artifactId,
        'hot_log_corrupt',
        0,
        `The authoritative hot log has ${thread.corruptLines} corrupt line(s).`
      );
    }
    return null;
  } catch (error) {
    if (isInfrastructureError(error)) throw error;
    return makeIssue(
      artifactId,
      'hot_unreconstructable',
      0,
      `The authoritative hot thread cannot be reconstructed: ${errorMessage(error)}`
    );
  }
}

function issueFromBlockedLag(lag: ArtifactMirrorLag): ArchiveRepairIssue {
  if (lag.block_reason === null) {
    throw new Error(`Blocked archive artifact ${lag.artifact_id} has no block reason.`);
  }
  return makeIssue(
    lag.artifact_id,
    lag.block_reason,
    lag.missing_event_ids.length,
    lag.block_message ?? 'Automatic archive repair is blocked.'
  );
}

function makeIssue<Kind extends ArchiveRepairIssueKind>(
  artifactId: string,
  kind: Kind,
  missingEvents: number,
  message: string
): ArchiveRepairIssue & { kind: Kind } {
  return {
    artifact_id: artifactId,
    kind,
    message,
    missing_events: missingEvents,
  };
}

function dedupeIssues(issues: readonly ArchiveRepairIssue[]): ArchiveRepairIssue[] {
  const byKey = new Map<string, ArchiveRepairIssue>();
  for (const issue of issues) {
    byKey.set(`${issue.artifact_id}\0${issue.kind}`, issue);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.artifact_id.localeCompare(right.artifact_id) || left.kind.localeCompare(right.kind)
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Hot artifact ids = subdirectories of the artifacts root (flat layout). */
async function listHotArtifactIds(
  repoRoot: string,
  config: Pick<Config, 'artifacts'>
): Promise<string[]> {
  try {
    const entries = await readdir(artifactsRoot(repoRoot, config), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Raw usage-ledger records (line shape, checksum intact) — the verbatim
 * mirror needs the on-disk record. Corrupt lines are skipped, while
 * checksummed payload-invalid lines remain visible as unrepaired lag.
 */
async function readRawUsageRecords(
  ledgerPath: string,
  containmentRoot?: string
): Promise<UsageLedgerRecord[]> {
  const target =
    containmentRoot === undefined
      ? ledgerPath
      : assertResolvedWithin(ledgerPath, containmentRoot, 'hot usage ledger read', {
          rejectSymlinks: true,
        });
  let raw: string;
  try {
    raw = await readFile(target, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: UsageLedgerRecord[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = UsageLedgerRecordSchema.safeParse(JSON.parse(line));
      // Envelope/checksum corruption is not a ledger event. Payload semantics
      // are filtered separately before copying so invalid payloads remain
      // visible as lag without entering the archive.
      if (parsed.success && verifyUsageRecordChecksum(parsed.data)) {
        out.push(parsed.data);
      }
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

interface UsageRecordSet {
  rawRecords: UsageLedgerRecord[];
  invalidRecordIdentityCounts: Map<string, number>;
  redactedRecordIdentities: Map<string, string>;
  validRecordIdentities: Set<string>;
  validContentIdentities: Set<string>;
  acceptableContentIdentities: Map<string, Set<string>>;
}

interface UsageLagAnalysis {
  lag: UsageMirrorLag;
  repairableRecords: UsageLedgerRecord[];
  blockedMissing: number;
}

async function analyzeUsageLag(opts: MirrorLagOptions): Promise<UsageLagAnalysis> {
  const hot = await readUsageRecordSet(
    usageLedgerPath(opts.repoRoot),
    usageSidecarsDir(opts.repoRoot),
    opts.repoRoot,
    true
  );
  const archivePaths = archiveUsageLedgerPaths(opts.projectDir);
  const archived = await readUsageRecordSet(archivePaths.ledgerNdjson, archivePaths.sidecarsDir);
  const missingEventIds: string[] = [];
  const repairableRecords: UsageLedgerRecord[] = [];
  const remainingInvalidArchiveRecords = new Map(archived.invalidRecordIdentityCounts);
  let blockedMissing = 0;

  for (const record of hot.rawRecords) {
    const recordIdentity = usageRecordIdentity(record);
    const isValid = hot.validRecordIdentities.has(recordIdentity);
    let isArchived: boolean;
    if (isValid) {
      const acceptable = hot.acceptableContentIdentities.get(recordIdentity) ?? new Set();
      isArchived = [...acceptable].some((identity) =>
        archived.validContentIdentities.has(identity)
      );
    } else {
      isArchived = consumeIdentity(remainingInvalidArchiveRecords, recordIdentity);
      const redactedIdentity = hot.redactedRecordIdentities.get(recordIdentity);
      if (!isArchived && redactedIdentity !== undefined && redactedIdentity !== recordIdentity) {
        isArchived = consumeIdentity(remainingInvalidArchiveRecords, redactedIdentity);
      }
    }
    if (isArchived) continue;

    missingEventIds.push(record.event_id);
    if (isValid) {
      repairableRecords.push(record);
    } else {
      blockedMissing += 1;
    }
  }

  return {
    lag: {
      hot_events: hot.rawRecords.length,
      archived_events: archived.rawRecords.length,
      missing_event_ids: missingEventIds,
    },
    repairableRecords,
    blockedMissing,
  };
}

async function readUsageRecordSet(
  ledgerPath: string,
  sidecarsDir: string,
  containmentRoot?: string,
  deriveRedactedIdentities = false
): Promise<UsageRecordSet> {
  const rawRecords = await readRawUsageRecords(ledgerPath, containmentRoot);
  const invalidRecordIdentityCounts = new Map<string, number>();
  const redactedRecordIdentities = new Map<string, string>();
  const validRecordIdentities = new Set<string>();
  const validContentIdentities = new Set<string>();
  const acceptableContentIdentities = new Map<string, Set<string>>();
  await readUsageLedger({
    ledgerPath,
    sidecarsDir,
    containmentRoot,
    onValidRecord: (record, payload) => {
      const recordIdentity = usageRecordIdentity(record);
      validRecordIdentities.add(recordIdentity);
      const contentIdentity = usageRecordContentIdentity(record, payload);
      validContentIdentities.add(contentIdentity);
      if (deriveRedactedIdentities) {
        acceptableContentIdentities.set(
          recordIdentity,
          new Set([
            contentIdentity,
            usageRecordContentIdentity(record, redactSecretsInObject(payload)),
          ])
        );
      }
    },
  });
  for (const record of rawRecords) {
    const recordIdentity = usageRecordIdentity(record);
    if (validRecordIdentities.has(recordIdentity)) continue;
    const loaded = await loadUsageRecordPayload(record, sidecarsDir, containmentRoot);
    if (!loaded.ok) continue;
    incrementIdentity(invalidRecordIdentityCounts, recordIdentity);
    if (deriveRedactedIdentities) {
      try {
        const redacted = deriveUsageLedgerRecord({
          type: record.type,
          ts: record.ts,
          idempotency_key: record.idempotency_key,
          payload: redactSecretsInObject(loaded.payload),
          event_id: record.event_id,
        }).record;
        redactedRecordIdentities.set(recordIdentity, usageRecordIdentity(redacted));
      } catch {
        // Leave pathological payloads unmapped so they remain quarantined.
      }
    }
  }
  return {
    rawRecords,
    invalidRecordIdentityCounts,
    redactedRecordIdentities,
    validRecordIdentities,
    validContentIdentities,
    acceptableContentIdentities,
  };
}

function incrementIdentity(counts: Map<string, number>, identity: string): void {
  counts.set(identity, (counts.get(identity) ?? 0) + 1);
}

function consumeIdentity(counts: Map<string, number>, identity: string): boolean {
  const count = counts.get(identity) ?? 0;
  if (count === 0) return false;
  if (count === 1) counts.delete(identity);
  else counts.set(identity, count - 1);
  return true;
}

export function usageBlockedMissing(report: MirrorLagReport): number {
  return report.usage_blocked_missing;
}

function usageRecordIdentity(record: UsageLedgerRecord): string {
  return `${record.event_id}:${record.checksum}`;
}
