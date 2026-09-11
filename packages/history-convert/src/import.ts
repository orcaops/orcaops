import { createHash } from 'node:crypto';

import {
  derivedImportOperationId,
  type LegacyImportAttempt,
  type LegacyImportCaptureSource,
  type LegacyImportCloudFact,
  type LegacyImportLifecycle,
  type LegacyImportPlanIdempotency,
  type LegacyImportSessionBranch,
  type LegacyImportSourcePlanRecord,
  type LegacyImportSqliteImage,
  prepareImportedProjectSeedState,
  type ProjectHistoryImportSource,
} from '@orcaops/storage/history/database';

import { HistoryConversionError } from './errors.js';
import { canonicalJson } from './legacy/storage/events/canonical-json.js';
import {
  reconcileCloudFacts,
  reconcileLifecycles,
  reconcilePlanIdempotency,
} from './operational-state.js';
import {
  assertPreparedLegacySources,
  type PreparedLegacySources,
  readPreparedLegacyArtifact,
  readPreparedLegacyDecisions,
  readPreparedLegacyRemote,
  readPreparedLegacySeedState,
  readPreparedLegacySqlite,
  readPreparedLegacyUsage,
} from './prepared-sources.js';
import { LEGACY_PROFILE_ID, LEGACY_SOURCE_REVISION } from './profile.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const EMPTY_ORDERED_HASH = hash(Buffer.from('orcaops-events-v1\n'));

// Recomputed here rather than imported from the writer: a comparison that reuses the importer's
// own hash function proves only that the function is deterministic.
function orderedHash(records: readonly unknown[]): string {
  let value = EMPTY_ORDERED_HASH;
  for (const record of records)
    value = createHash('sha256')
      .update(Buffer.from(value, 'hex'))
      .update(Buffer.from([0x0a]))
      .update(canonicalJson(record))
      .digest('hex');
  return value;
}

function integrity(message: string, resource?: string): never {
  throw new HistoryConversionError('SOURCE_INTEGRITY', message, resource);
}

export interface LegacyImportExpectedEvent {
  readonly eventId: string;
  readonly ordinal: number;
  readonly type: string;
  readonly recordedAt: string;
  readonly checksum: string;
  readonly recordHash: string;
  readonly sidecarHash: string | null;
}
export interface LegacyImportExpectedArtifact {
  readonly artifactId: string;
  readonly sourceLocation: string;
  readonly eventBytesSha256: string;
  readonly byteLength: number;
  readonly orderedHash: string;
  readonly tailEventId: string;
  readonly events: readonly LegacyImportExpectedEvent[];
  readonly branches: readonly string[];
  readonly originKind: string;
  readonly completedAt: string | null;
}
export interface LegacyImportExpectation {
  readonly profile: typeof LEGACY_PROFILE_ID;
  readonly sourceRevision: typeof LEGACY_SOURCE_REVISION;
  readonly sourceManifestHash: string;
  readonly conversionOperationId: string;
  readonly artifacts: readonly LegacyImportExpectedArtifact[];
  readonly usage: {
    readonly eventIds: readonly string[];
    readonly eventBytesSha256: string;
    readonly byteLength: number;
    readonly orderedHash: string;
    readonly counts: {
      readonly originalOccurrences: number;
      readonly selectedSnapshots: number;
      readonly selectedLinks: number;
      readonly retainedEvidenceOccurrences: number;
    };
  } | null;
  readonly seed: readonly { readonly kind: string; readonly sha256: string }[];
  readonly planIdempotency: readonly { readonly key: string; readonly artifactId: string }[];
  readonly lifecycles: readonly {
    readonly artifactId: string;
    readonly firesAt: string;
    readonly cpN: number;
  }[];
  readonly attempts: readonly {
    readonly artifactId: string;
    readonly idempotencyKey: string;
    readonly eventType: string;
    readonly outcome: string;
  }[];
  readonly sessionBranches: readonly LegacyImportSessionBranch[];
  readonly cloudFacts: readonly LegacyImportCloudFact[];
  readonly sourcePlanRecords: readonly (Omit<
    LegacyImportSourcePlanRecord,
    'bodyBytes' | 'recordBytes'
  > & {
    readonly bodySha256: string | null;
    readonly recordSha256: string;
  })[];
  readonly sqliteImages: readonly {
    readonly sourceLocation: string;
    readonly part: string;
    readonly sha256: string;
    readonly byteLength: number;
    readonly baselineVersion: number;
    readonly walFrames: number;
    readonly committedFrames: number;
    readonly tableCounts: Readonly<Record<string, number>>;
  }[];
  readonly gitResources: readonly { readonly ref: string; readonly oid: string }[];
  readonly omissions: PreparedLegacySources['manifest']['omitted'];
}

export interface LegacyImportPreparation {
  readonly source: ProjectHistoryImportSource;
  readonly expected: LegacyImportExpectation;
}

type Row = Record<string, string | number | null>;

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') integrity('Retained operational row has no text value', column);
  return value;
}
function optionalText(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string')
    integrity('Retained operational row has an unusable value', column);
  return value;
}
function optionalCount(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    integrity('Retained operational row has an inexact counter', column);
  return value;
}
function count(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    integrity('Retained operational row has no exact counter', column);
  return value;
}

// `sha256` is the checksum of the supplied record bytes, and these rows are projections of the
// operational image rather than files that were hashed, so the image digest goes in `identity`.
function captureSource(location: string, imageSha256: string): LegacyImportCaptureSource {
  return {
    identity: `legacy-operational-image:${imageSha256}`,
    locator: location,
    revisionId: null,
    eventId: null,
    operationId: null,
    sha256: null,
  };
}

export function prepareLegacyImport(
  prepared: PreparedLegacySources,
  options: { conversionOperationId: string }
): LegacyImportPreparation {
  assertPreparedLegacySources(prepared);
  const conversionOperationId = options.conversionOperationId;
  if (prepared.manifest.profile !== LEGACY_PROFILE_ID)
    throw new HistoryConversionError(
      'UNSUPPORTED_SOURCE_PROFILE',
      'Only the frozen source profile can be imported'
    );
  if (!prepared.manifest.project_id)
    throw new HistoryConversionError(
      'SOURCE_UNAVAILABLE',
      'The prepared sources establish no original project identity'
    );

  const artifacts: ProjectHistoryImportSource['artifacts'][number][] = [];
  const expectedArtifacts: LegacyImportExpectedArtifact[] = [];
  for (const artifactId of legacyArtifactIds(prepared)) {
    const { selection, bundle } = readPreparedLegacyArtifact(prepared, artifactId);
    const log = bundle.artifact.log;
    const eventBytes = Buffer.from(log.bytesBase64, 'base64');
    const sidecarPayloads = log.sidecars.map((sidecar) => ({
      eventId: sidecar.eventId,
      bytes: Buffer.from(sidecar.bytesBase64, 'base64'),
    }));
    artifacts.push({ artifactId, eventBytes, sidecarPayloads });
    const lines = eventBytes.toString('utf8').split('\n').slice(0, -1);
    expectedArtifacts.push({
      artifactId,
      sourceLocation: selection.sourceId,
      eventBytesSha256: hash(eventBytes),
      byteLength: eventBytes.length,
      orderedHash: orderedHash(log.events.map((event) => event.record)),
      tailEventId: log.events.at(-1)!.record.event_id,
      events: log.events.map((event, index) => ({
        eventId: event.record.event_id,
        ordinal: index + 1,
        type: event.record.type,
        recordedAt: event.record.ts,
        checksum: event.record.checksum,
        recordHash: hash(Buffer.from(lines[index]! + '\n')),
        sidecarHash:
          log.sidecars.find((sidecar) => sidecar.eventId === event.record.event_id)?.sha256 ?? null,
      })),
      branches: [
        ...new Set(bundle.artifact.artifact.branch_lineage.map((entry) => entry.branch)),
      ].sort(),
      originKind: bundle.artifact.plan.origin?.kind ?? 'captured',
      completedAt: bundle.artifact.summary?.ts ?? null,
    });
  }

  const usageSelection = readPreparedLegacyUsage(prepared);
  const usageBytes = usageSelection
    ? Buffer.from(usageSelection.eventBytesBase64, 'base64')
    : Buffer.alloc(0);
  const usage = usageSelection
    ? {
        eventBytes: usageBytes,
        sidecarPayloads: usageSelection.sidecars.map((sidecar) => ({
          eventId: sidecar.eventId,
          bytes: Buffer.from(sidecar.bytesBase64, 'base64'),
        })),
      }
    : null;
  const usageRecords = usageSelection
    ? usageBytes
        .toString('utf8')
        .split('\n')
        .slice(0, -1)
        .map((line) => JSON.parse(line) as { event_id: string })
    : [];

  const seedSources = readPreparedLegacySeedState(prepared);
  const seed = seedSources.length
    ? prepareImportedProjectSeedState({
        operationId: derivedImportOperationId(conversionOperationId, 'seed'),
        revisionId: derivedImportOperationId(conversionOperationId, 'seed-revision'),
        expectedRevision: null,
        sourceManifestIdentity: prepared.manifestSha256,
        sources: seedSources.map((entry) => ({
          kind: entry.key,
          sourceId: derivedImportOperationId(conversionOperationId, `seed-source:${entry.key}`),
          sourceIdentity: entry.file.sha256,
          sourceLocation: entry.originalPath,
          sourceSha256: entry.file.sha256,
          bytes: Buffer.from(entry.file.bytesBase64, 'base64'),
        })),
      })
    : null;

  const images = readPreparedLegacySqlite(prepared);
  const planIdempotencyRows: LegacyImportPlanIdempotency[] = [];
  const lifecycleRows: LegacyImportLifecycle[] = [];
  const attempts: LegacyImportAttempt[] = [];
  const sessionBranches: LegacyImportSessionBranch[] = [];
  const cloudFactRows: LegacyImportCloudFact[] = [];
  const sqliteImages: LegacyImportSqliteImage[] = [];
  const known = new Set(expectedArtifacts.map((entry) => entry.artifactId));
  for (const { source, sqlite } of images) {
    const main = sqlite.sources.find((part) => part.kind === 'main')!;
    const provenance = captureSource(source, main.sha256);
    sqliteImages.push({
      sourceLocation: source,
      baselineVersion: sqlite.baselineVersion,
      walFrames: sqlite.wal.frames,
      committedFrames: sqlite.wal.committedFrames,
      tableCounts: { ...sqlite.tableCounts },
      parts: sqlite.sources.map((part) => ({
        part: part.kind,
        sha256: part.sha256,
        byteLength: Buffer.from(part.bytesBase64, 'base64').length,
      })),
    });
    for (const row of sqlite.rows.plan_idempotency) {
      const artifactId = text(row, 'artifact_id');
      if (!known.has(artifactId)) continue;
      planIdempotencyRows.push({
        artifactId,
        idempotencyKey: text(row, 'idempotency_key'),
        createdAt: text(row, 'created_at'),
        source: provenance,
      });
    }
    for (const row of sqlite.rows.evaluator_lifecycles) {
      const artifactId = text(row, 'artifact_id');
      if (!known.has(artifactId)) continue;
      lifecycleRows.push({
        artifactId,
        bytes: Buffer.from(
          JSON.stringify({
            fires_at: text(row, 'fires_at'),
            cp_n: count(row, 'cp_n'),
            triggered_at: text(row, 'triggered_at'),
          })
        ),
        source: provenance,
      });
    }
    for (const row of sqlite.rows.idempotency_blocks) {
      const artifactId = text(row, 'artifact_id');
      if (!known.has(artifactId)) continue;
      attempts.push({
        artifactId,
        bytes: Buffer.from(
          JSON.stringify({
            artifact_id: artifactId,
            idempotency_key: text(row, 'idempotency_key'),
            event_type: text(row, 'event_type'),
            outcome: text(row, 'outcome'),
            payload_hash: text(row, 'payload_hash'),
            evaluator_fingerprint: optionalText(row, 'evaluator_fingerprint'),
            envelope: optionalText(row, 'envelope'),
            recorded_at: text(row, 'recorded_at'),
          })
        ),
        source: provenance,
      });
    }
    for (const row of sqlite.rows.cli_session_branch_state) {
      const history: unknown = JSON.parse(text(row, 'branch_history'));
      if (!Array.isArray(history) || history.some((entry) => typeof entry !== 'string'))
        integrity('Retained session branch history is not a list of branch names', source);
      sessionBranches.push({
        repoUrl: text(row, 'repo_url'),
        workingDir: text(row, 'working_dir'),
        currentBranch: text(row, 'current_branch'),
        branchHistory: history as string[],
        baseCommitSha: optionalText(row, 'base_commit_sha'),
        ackedAt: optionalText(row, 'last_acked_at'),
        sourceLocation: source,
      });
    }
    // The frozen writer keeps a successful sync and a later failed push on the same row, with a
    // running failure count. Every one of its eight cloud columns is carried across; none is
    // dropped because another is set.
    for (const row of sqlite.rows.artifacts) {
      const artifactId = text(row, 'id');
      const fact = {
        artifactId,
        syncedAt: optionalText(row, 'cloud_synced_at'),
        syncHash: optionalText(row, 'cloud_sync_hash'),
        externalId: optionalText(row, 'cloud_external_id'),
        orgId: optionalText(row, 'cloud_org_id'),
        lastPushAttemptAt: optionalText(row, 'cloud_last_push_attempt_at'),
        lastPushErrorKind: optionalText(row, 'cloud_last_push_error_kind'),
        lastPushErrorMessage: optionalText(row, 'cloud_last_push_error_message'),
        consecutiveFailures: optionalCount(row, 'cloud_consecutive_failures'),
        sourceLocation: source,
      };
      const recorded =
        fact.syncedAt !== null ||
        fact.lastPushErrorKind !== null ||
        fact.lastPushAttemptAt !== null ||
        (fact.consecutiveFailures !== null && fact.consecutiveFailures > 0);
      if (known.has(artifactId) && recorded) cloudFactRows.push(fact);
    }
  }

  const planIdempotency = reconcilePlanIdempotency(planIdempotencyRows);
  const lifecycles = reconcileLifecycles(lifecycleRows);
  const cloudFacts = reconcileCloudFacts(cloudFactRows);

  const sourcePlanRecords: LegacyImportSourcePlanRecord[] = [];
  for (const { source, graph } of readPreparedLegacyRemote(prepared)) {
    for (const member of graph.members) {
      if (!member.file) continue;
      const value = member.file.value as Record<string, unknown>;
      const kind =
        member.file.kind === 'source_plan_pull'
          ? 'approved'
          : member.file.kind === 'source_plan_review_pull'
            ? 'review'
            : 'locator';
      const bytes = Buffer.from(member.bytesBase64, 'base64');
      const body = typeof value.body === 'string' ? Buffer.from(value.body, 'utf8') : null;
      sourcePlanRecords.push({
        sourceLocation: `${source}/${member.relativePath}`,
        kind,
        namespaceBaseUrl: typeof value.base_url === 'string' ? value.base_url : 'unknown',
        namespaceOrgId: typeof value.org_id === 'string' ? value.org_id : 'unknown',
        externalId: typeof value.external_id === 'string' ? value.external_id : 'unknown',
        slug: typeof value.slug === 'string' ? value.slug : null,
        versionNumber: typeof value.version_number === 'number' ? value.version_number : null,
        versionId: typeof value.version_id === 'string' ? value.version_id : null,
        target: typeof value.target === 'string' ? value.target : null,
        title: typeof value.title === 'string' ? value.title : null,
        contentHash: typeof value.content_hash === 'string' ? value.content_hash : null,
        bodyBytes: body,
        realPath: null,
        pulledAt: typeof value.pulled_at === 'string' ? value.pulled_at : null,
        recordBytes: bytes,
      });
    }
  }

  const gitResources = prepared.manifest.git_resources.map((resource) => ({
    ref: resource.ref,
    oid: resource.oid,
    symbolicTarget: resource.symbolicTarget,
    ownership: 'unknown' as const,
  }));

  const source: ProjectHistoryImportSource = {
    sourceProfile: LEGACY_PROFILE_ID,
    sourceRevision: LEGACY_SOURCE_REVISION,
    sourceManifestHash: prepared.manifestSha256,
    artifacts,
    usage,
    seed,
    planIdempotency,
    lifecycles,
    attempts,
    sessionBranches,
    cloudFacts,
    sourcePlanRecords,
    sqliteImages,
    gitResources,
    omissions: prepared.manifest.omitted.map((entry) => ({ ...entry })),
  };

  const expected: LegacyImportExpectation = {
    profile: LEGACY_PROFILE_ID,
    sourceRevision: LEGACY_SOURCE_REVISION,
    sourceManifestHash: prepared.manifestSha256,
    conversionOperationId,
    artifacts: expectedArtifacts,
    usage: usageSelection
      ? {
          eventIds: usageRecords.map((entry) => entry.event_id),
          eventBytesSha256: hash(usageBytes),
          byteLength: usageBytes.length,
          orderedHash: orderedHash(
            usageBytes
              .toString('utf8')
              .split('\n')
              .slice(0, -1)
              .map((line) => JSON.parse(line))
          ),
          counts: usageSelection.counts,
        }
      : null,
    seed: seedSources.map((entry) => ({ kind: entry.key, sha256: entry.file.sha256 })),
    planIdempotency: planIdempotency.map((entry) => ({
      key: entry.idempotencyKey,
      artifactId: entry.artifactId,
    })),
    lifecycles: lifecycles.map((entry) => {
      const row = JSON.parse(Buffer.from(entry.bytes).toString('utf8')) as {
        fires_at: string;
        cp_n: number;
      };
      return { artifactId: entry.artifactId, firesAt: row.fires_at, cpN: row.cp_n };
    }),
    attempts: attempts.map((entry) => {
      const row = JSON.parse(Buffer.from(entry.bytes).toString('utf8')) as {
        idempotency_key: string;
        event_type: string;
        outcome: string;
      };
      return {
        artifactId: entry.artifactId,
        idempotencyKey: row.idempotency_key,
        eventType: row.event_type,
        outcome: row.outcome,
      };
    }),
    sessionBranches,
    cloudFacts,
    sourcePlanRecords: sourcePlanRecords.map(({ bodyBytes, recordBytes, ...entry }) => ({
      ...entry,
      bodySha256: bodyBytes === null ? null : hash(Buffer.from(bodyBytes)),
      recordSha256: hash(Buffer.from(recordBytes)),
    })),
    sqliteImages: sqliteImages.flatMap((image) =>
      image.parts.map((part) => ({
        sourceLocation: image.sourceLocation,
        part: part.part,
        sha256: part.sha256,
        byteLength: part.byteLength,
        baselineVersion: image.baselineVersion,
        walFrames: image.walFrames,
        committedFrames: image.committedFrames,
        tableCounts: image.tableCounts,
      }))
    ),
    gitResources: gitResources.map((entry) => ({ ref: entry.ref, oid: entry.oid })),
    omissions: prepared.manifest.omitted,
  };
  return Object.freeze({ source, expected });
}

// The prepared decisions are the reviewed preview verbatim; its representation list names
// exactly the artifacts whose original bytes were selected for conversion.
function legacyArtifactIds(prepared: PreparedLegacySources): string[] {
  const decisions = JSON.parse(readPreparedLegacyDecisions(prepared).toString('utf8')) as {
    representations: readonly { artifactId: string }[];
  };
  return decisions.representations.map((entry) => entry.artifactId);
}

export interface LegacyImportComparisonFamily {
  readonly family: string;
  readonly expected: number;
  readonly observed: number;
  readonly matched: boolean;
  readonly differences: readonly string[];
}
export interface LegacyImportComparison {
  readonly ok: boolean;
  readonly sourceManifestHash: string;
  readonly conversionOperationId: string;
  readonly families: readonly LegacyImportComparisonFamily[];
  readonly differences: readonly string[];
}

export interface LegacyTargetReadView {
  all<T>(sql: string, ...parameters: unknown[]): T[];
  get<T>(sql: string, ...parameters: unknown[]): T | null;
}

/**
 * Names the exact field that differs rather than reporting that a family differs. Both sides
 * are already in the same order, so the report can be read without hunting.
 */
function difference(
  family: string,
  observed: readonly Record<string, unknown>[],
  wanted: readonly Record<string, unknown>[]
): string[] {
  const differences: string[] = [];
  for (let index = 0; index < Math.max(observed.length, wanted.length); index++) {
    const left = observed[index];
    const right = wanted[index];
    if (!left || !right) {
      differences.push(`${family}: row ${index + 1} is ${left ? 'unexpected' : 'missing'}`);
      continue;
    }
    for (const field of new Set([...Object.keys(right), ...Object.keys(left)]))
      if (canonicalJson(left[field] ?? null) !== canonicalJson(right[field] ?? null))
        differences.push(`${family}: row ${index + 1} field ${field} differs`);
  }
  return differences;
}

export function compareLegacyImport(
  expected: LegacyImportExpectation,
  view: LegacyTargetReadView
): LegacyImportComparison {
  const families: LegacyImportComparisonFamily[] = [];
  const record = (
    family: string,
    expectedCount: number,
    observedCount: number,
    differences: string[]
  ) =>
    families.push({
      family,
      expected: expectedCount,
      observed: observedCount,
      matched: differences.length === 0 && expectedCount === observedCount,
      differences,
    });

  const receipt = view.get<Row>('SELECT * FROM legacy_import WHERE singleton = 1');
  const receiptDifferences: string[] = [];
  if (!receipt) receiptDifferences.push('the converted database records no conversion receipt');
  else {
    if (text(receipt, 'operation_id') !== expected.conversionOperationId)
      receiptDifferences.push('conversion operation ID differs');
    if (text(receipt, 'source_manifest_hash') !== expected.sourceManifestHash)
      receiptDifferences.push('source manifest hash differs');
    if (text(receipt, 'source_profile') !== expected.profile)
      receiptDifferences.push('source profile differs');
    if (text(receipt, 'source_revision') !== expected.sourceRevision)
      receiptDifferences.push('source revision differs');
    if (
      canonicalJson(JSON.parse(text(receipt, 'omissions_json'))) !==
      canonicalJson(expected.omissions)
    )
      receiptDifferences.push('disclosed omissions differ');
    const observedRefs = (
      JSON.parse(text(receipt, 'git_resources_json')) as { ref: string; oid: string }[]
    ).map((entry) => ({ ref: entry.ref, oid: entry.oid }));
    if (canonicalJson(observedRefs) !== canonicalJson(expected.gitResources))
      receiptDifferences.push('recorded Git resources differ');
  }
  record('receipt', 1, receipt ? 1 : 0, receiptDifferences);

  const artifactDifferences: string[] = [];
  const observedArtifacts = view.all<Row>('SELECT artifact_id FROM artifacts');
  for (const artifact of expected.artifacts) {
    const events = view.all<Row>(
      `SELECT event_id, ordinal, checksum, record_hash, event_type, recorded_at,
         hex(record_bytes) AS record_bytes,
         CASE WHEN sidecar_payload_bytes IS NULL THEN NULL ELSE hex(sidecar_payload_bytes) END AS sidecar
       FROM artifact_events WHERE artifact_id = ? ORDER BY ordinal`,
      artifact.artifactId
    );
    if (events.length !== artifact.events.length) {
      artifactDifferences.push(`${artifact.artifactId}: event count differs`);
      continue;
    }
    const bytes = Buffer.concat(events.map((row) => Buffer.from(text(row, 'record_bytes'), 'hex')));
    if (hash(bytes) !== artifact.eventBytesSha256)
      artifactDifferences.push(`${artifact.artifactId}: converted event bytes differ`);
    if (bytes.length !== artifact.byteLength)
      artifactDifferences.push(`${artifact.artifactId}: converted byte length differs`);
    artifact.events.forEach((event, index) => {
      const row = events[index]!;
      if (
        text(row, 'event_id') !== event.eventId ||
        count(row, 'ordinal') !== event.ordinal ||
        text(row, 'checksum') !== event.checksum ||
        text(row, 'record_hash') !== event.recordHash ||
        text(row, 'event_type') !== event.type ||
        text(row, 'recorded_at') !== event.recordedAt
      )
        artifactDifferences.push(`${artifact.artifactId}: event ${event.eventId} differs`);
      const sidecar = optionalText(row, 'sidecar');
      const sidecarHash = sidecar === null ? null : hash(Buffer.from(sidecar, 'hex'));
      if (sidecarHash !== event.sidecarHash)
        artifactDifferences.push(`${artifact.artifactId}: sidecar for ${event.eventId} differs`);
    });
    const revision = view.get<Row>(
      `SELECT generation, ordered_hash, event_count, byte_length, tail_event_id
       FROM artifact_revisions WHERE artifact_id = ? AND generation = 1`,
      artifact.artifactId
    );
    if (!revision) artifactDifferences.push(`${artifact.artifactId}: no publication revision`);
    else if (
      text(revision, 'ordered_hash') !== artifact.orderedHash ||
      count(revision, 'event_count') !== artifact.events.length ||
      count(revision, 'byte_length') !== artifact.byteLength ||
      text(revision, 'tail_event_id') !== artifact.tailEventId
    )
      artifactDifferences.push(`${artifact.artifactId}: publication revision differs`);
    const metadata = view.get<Row>(
      'SELECT origin_kind, completed_at FROM artifact_metadata WHERE artifact_id = ?',
      artifact.artifactId
    );
    if (!metadata) artifactDifferences.push(`${artifact.artifactId}: no listing metadata`);
    else if (
      text(metadata, 'origin_kind') !== artifact.originKind ||
      optionalText(metadata, 'completed_at') !== artifact.completedAt
    )
      artifactDifferences.push(`${artifact.artifactId}: listing provenance differs`);
    const branches = view
      .all<Row>(
        'SELECT branch FROM artifact_branches WHERE artifact_id = ? ORDER BY branch',
        artifact.artifactId
      )
      .map((row) => text(row, 'branch'));
    if (canonicalJson(branches) !== canonicalJson(artifact.branches))
      artifactDifferences.push(`${artifact.artifactId}: branch lineage differs`);
  }
  record('artifacts', expected.artifacts.length, observedArtifacts.length, artifactDifferences);

  const usageRows = view.all<Row>('SELECT event_id, ordinal FROM usage_events ORDER BY ordinal');
  const usageDifferences: string[] = [];
  if (expected.usage) {
    if (
      canonicalJson(usageRows.map((row) => text(row, 'event_id'))) !==
      canonicalJson(expected.usage.eventIds)
    )
      usageDifferences.push('selected usage identities differ');
    const revision = view.get<Row>(
      `SELECT ordered_hash, event_count, byte_length, tail_event_id FROM usage_revisions
       WHERE generation = (SELECT current_generation FROM usage_selection WHERE singleton = 1)`
    );
    if (!revision) usageDifferences.push('no usage publication revision');
    else if (
      text(revision, 'ordered_hash') !== expected.usage.orderedHash ||
      count(revision, 'event_count') !== expected.usage.eventIds.length ||
      count(revision, 'byte_length') !== expected.usage.byteLength
    )
      usageDifferences.push('usage publication revision differs');
  }
  record('usage', expected.usage?.eventIds.length ?? 0, usageRows.length, usageDifferences);

  const seedRows = view.all<Row>(
    'SELECT kind, source_sha256 FROM seed_state_sources ORDER BY kind'
  );
  const seedDifferences: string[] = [];
  if (
    canonicalJson(
      seedRows.map((row) => ({
        kind: text(row, 'kind'),
        sha256: optionalText(row, 'source_sha256'),
      }))
    ) !== canonicalJson([...expected.seed].sort((a, b) => a.kind.localeCompare(b.kind)))
  )
    seedDifferences.push('seed source identities or hashes differ');
  record('seed', expected.seed.length, seedRows.length, seedDifferences);

  const planRows = view.all<Row>(
    'SELECT idempotency_key, artifact_id FROM plan_idempotency_records ORDER BY idempotency_key'
  );
  record(
    'planIdempotency',
    expected.planIdempotency.length,
    planRows.length,
    canonicalJson(
      planRows.map((row) => ({
        key: text(row, 'idempotency_key'),
        artifactId: text(row, 'artifact_id'),
      }))
    ) === canonicalJson([...expected.planIdempotency].sort((a, b) => a.key.localeCompare(b.key)))
      ? []
      : ['retained plan keys differ']
  );

  const lifecycleOrder = (
    a: { artifactId: string; firesAt: string; cpN: number },
    b: { artifactId: string; firesAt: string; cpN: number }
  ) =>
    a.artifactId.localeCompare(b.artifactId) || a.firesAt.localeCompare(b.firesAt) || a.cpN - b.cpN;
  const lifecycleRows = view
    .all<Row>('SELECT artifact_id, fires_at, cp_n FROM artifact_lifecycle_revisions')
    .map((row) => ({
      artifactId: text(row, 'artifact_id'),
      firesAt: text(row, 'fires_at'),
      cpN: count(row, 'cp_n'),
    }))
    .sort(lifecycleOrder);
  record(
    'lifecycles',
    expected.lifecycles.length,
    lifecycleRows.length,
    canonicalJson(lifecycleRows) === canonicalJson([...expected.lifecycles].sort(lifecycleOrder))
      ? []
      : ['retained evaluator lifecycles differ']
  );

  const attemptRows = view.all<Row>(
    'SELECT artifact_id, idempotency_key, event_type, outcome FROM artifact_attempt_revisions ORDER BY idempotency_key'
  );
  record(
    'attempts',
    expected.attempts.length,
    attemptRows.length,
    canonicalJson(
      attemptRows.map((row) => ({
        artifactId: text(row, 'artifact_id'),
        idempotencyKey: text(row, 'idempotency_key'),
        eventType: text(row, 'event_type'),
        outcome: text(row, 'outcome'),
      }))
    ) ===
      canonicalJson(
        [...expected.attempts].sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey))
      )
      ? []
      : ['retained refused attempts differ']
  );

  const sessionRows = view.all<Row>(
    `SELECT ordinal, repo_url, working_dir, current_branch, branch_history_json, base_commit_sha,
       acked_at, updated_at, source_location, account_provenance
     FROM legacy_session_branch_state ORDER BY ordinal`
  );
  record(
    'sessionBranches',
    expected.sessionBranches.length,
    sessionRows.length,
    difference(
      'retained session branch state',
      sessionRows.map((row, index) => ({
        ordinal: count(row, 'ordinal'),
        expectedOrdinal: index + 1,
        repoUrl: text(row, 'repo_url'),
        workingDir: text(row, 'working_dir'),
        currentBranch: text(row, 'current_branch'),
        branchHistory: JSON.parse(text(row, 'branch_history_json')) as string[],
        baseCommitSha: optionalText(row, 'base_commit_sha'),
        ackedAt: optionalText(row, 'acked_at'),
        // The frozen profile records no session update time; a value here would be invented.
        updatedAt: optionalText(row, 'updated_at'),
        sourceLocation: text(row, 'source_location'),
        accountProvenance: text(row, 'account_provenance'),
      })),
      expected.sessionBranches.map((entry, index) => ({
        ordinal: index + 1,
        expectedOrdinal: index + 1,
        repoUrl: entry.repoUrl,
        workingDir: entry.workingDir,
        currentBranch: entry.currentBranch,
        branchHistory: [...entry.branchHistory],
        baseCommitSha: entry.baseCommitSha,
        ackedAt: entry.ackedAt,
        updatedAt: null,
        sourceLocation: entry.sourceLocation,
        accountProvenance: 'unknown',
      }))
    )
  );

  const cloudRows = view.all<Row>(
    `SELECT artifact_id, synced_at, sync_hash, external_id, org_id, last_push_attempt_at,
       last_push_error_kind, last_push_error_message, consecutive_failures, source_location,
       account_provenance
     FROM legacy_artifact_cloud_facts ORDER BY artifact_id`
  );
  record(
    'cloudFacts',
    expected.cloudFacts.length,
    cloudRows.length,
    difference(
      'retained cloud facts',
      cloudRows.map((row) => ({
        artifactId: text(row, 'artifact_id'),
        syncedAt: optionalText(row, 'synced_at'),
        syncHash: optionalText(row, 'sync_hash'),
        externalId: optionalText(row, 'external_id'),
        orgId: optionalText(row, 'org_id'),
        lastPushAttemptAt: optionalText(row, 'last_push_attempt_at'),
        lastPushErrorKind: optionalText(row, 'last_push_error_kind'),
        lastPushErrorMessage: optionalText(row, 'last_push_error_message'),
        consecutiveFailures: optionalCount(row, 'consecutive_failures'),
        sourceLocation: text(row, 'source_location'),
        accountProvenance: text(row, 'account_provenance'),
      })),
      [...expected.cloudFacts]
        .sort((a, b) => a.artifactId.localeCompare(b.artifactId))
        .map((entry) => ({ ...entry, accountProvenance: 'unknown' }))
    )
  );

  const remoteRows = view.all<Row>(
    `SELECT source_location, kind, namespace_base_url, namespace_org_id, external_id, slug,
       version_number, version_id, target, title, content_hash, real_path, pulled_at,
       record_sha256, account_provenance, hex(record_bytes) AS record_bytes,
       CASE WHEN body_bytes IS NULL THEN NULL ELSE hex(body_bytes) END AS body_bytes
     FROM legacy_source_plan_records ORDER BY source_location`
  );
  record(
    'sourcePlanRecords',
    expected.sourcePlanRecords.length,
    remoteRows.length,
    difference(
      'retained Source Plan records',
      remoteRows.map((row) => {
        const body = optionalText(row, 'body_bytes');
        // The stored digest column is checked against the bytes rather than trusted as the
        // record's identity: a rewritten row could carry a digest of its own new content.
        const recordSha256 = hash(Buffer.from(text(row, 'record_bytes'), 'hex'));
        return {
          sourceLocation: text(row, 'source_location'),
          kind: text(row, 'kind'),
          namespaceBaseUrl: text(row, 'namespace_base_url'),
          namespaceOrgId: text(row, 'namespace_org_id'),
          externalId: text(row, 'external_id'),
          slug: optionalText(row, 'slug'),
          versionNumber: optionalCount(row, 'version_number'),
          versionId: optionalText(row, 'version_id'),
          target: optionalText(row, 'target'),
          title: optionalText(row, 'title'),
          contentHash: optionalText(row, 'content_hash'),
          realPath: optionalText(row, 'real_path'),
          pulledAt: optionalText(row, 'pulled_at'),
          bodySha256: body === null ? null : hash(Buffer.from(body, 'hex')),
          recordSha256,
          storedRecordSha256: text(row, 'record_sha256'),
          accountProvenance: text(row, 'account_provenance'),
        };
      }),
      [...expected.sourcePlanRecords]
        .sort((a, b) => a.sourceLocation.localeCompare(b.sourceLocation))
        .map((entry) => ({
          ...entry,
          storedRecordSha256: entry.recordSha256,
          accountProvenance: 'unknown',
        }))
    )
  );

  const imageRows = view.all<Row>(
    `SELECT source_location, part, sha256, byte_length, baseline_version, wal_frames,
       committed_frames, table_counts_json
     FROM legacy_sqlite_images ORDER BY source_location, part`
  );
  record(
    'sqliteImages',
    expected.sqliteImages.length,
    imageRows.length,
    difference(
      'retained SQLite image evidence',
      imageRows.map((row) => ({
        sourceLocation: text(row, 'source_location'),
        part: text(row, 'part'),
        sha256: text(row, 'sha256'),
        byteLength: count(row, 'byte_length'),
        baselineVersion: count(row, 'baseline_version'),
        walFrames: count(row, 'wal_frames'),
        committedFrames: count(row, 'committed_frames'),
        tableCounts: JSON.parse(text(row, 'table_counts_json')) as Record<string, number>,
      })),
      [...expected.sqliteImages].sort((a, b) =>
        `${a.sourceLocation}${a.part}`.localeCompare(`${b.sourceLocation}${b.part}`)
      )
    )
  );

  const differences = families.flatMap((family) =>
    family.matched
      ? []
      : [
          ...family.differences,
          ...(family.expected === family.observed
            ? []
            : [`${family.family}: expected ${family.expected} rows, converted ${family.observed}`]),
        ]
  );
  return Object.freeze({
    ok: differences.length === 0,
    sourceManifestHash: expected.sourceManifestHash,
    conversionOperationId: expected.conversionOperationId,
    families: Object.freeze(families),
    differences: Object.freeze(differences),
  });
}
