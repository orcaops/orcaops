import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { ArtifactThread } from '../../events/artifact-thread.js';
import { initializeUnboundExecution } from '../execution.js';
import type { ArtifactSidecarPayload } from './artifact-events.js';
import {
  composeArtifactAppend,
  type ProjectArtifactSnapshot,
  restoreArtifactAppendRequest,
} from './artifacts.js';
import {
  prepareArtifactAttemptSettlement,
  settleProjectArtifactAttemptChanges,
} from './capture-attempts.js';
import {
  prepareLifecycleCompletionSettlement,
  preparePlanIdempotencySettlement,
  settleProjectLifecycleCompletion,
  settleProjectPlanIdempotency,
} from './capture-lifecycles.js';
import {
  artifactAttemptPreparation,
  type CaptureHistoricalOptions,
  type CaptureOperationSelection,
  lifecycleCompletionPreparation,
  planIdempotencyPreparation,
  prepareHistoricalArtifactAttempt,
  prepareHistoricalLifecycleCompletion,
  prepareHistoricalPlanIdempotency,
} from './capture-operation-input.js';
import { captureOperation } from './capture-records.js';
import {
  createReadView,
  openProjectDatabase,
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
  projectDatabasePath,
  readProjectInitializationCandidate,
  validateProjectDatabaseLocation,
} from './connection.js';
import { isDatabaseContention, ProjectDatabaseError } from './errors.js';
import { restoreExecutionRecords, settleExecutionRecords } from './execution-records.js';
import {
  prepareArtifactQueryMetadata,
  replaceArtifactQueryMetadata,
} from './query-metadata-records.js';
import { copyRepositoryCreation, type RepositoryCreation } from './repository-creation.js';
import { validateProjectSchema } from './schema-validation.js';
import { PROJECT_DATABASE_SCHEMA, PROJECT_DATABASE_SCHEMA_VERSION } from './schema.js';
import type { PreparedImportedProjectSeedState } from './seed-state-input.js';
import { prepareSeedStateSettlement } from './seed-state.js';
import type { ProjectOperation, ProjectSettlement } from './transactions.js';
import type { UsageSidecarPayload } from './usage-events.js';
import { prepareUsageAppend } from './usage.js';
import { type DatabaseJson, serializeDatabaseValue } from './values.js';
import { isUuidV7, uuidv7 } from '../../ids/uuidv7.js';

export const LEGACY_IMPORT_PROFILE = 'orcaops-0.2.0-rc.2';
const historicalOptions: CaptureHistoricalOptions = { sourceProfile: '0.2.0-rc.2' };

export interface LegacyImportArtifact {
  readonly artifactId: string;
  readonly eventBytes: Uint8Array;
  readonly sidecarPayloads: readonly ArtifactSidecarPayload[];
}
export interface LegacyImportUsage {
  readonly eventBytes: Uint8Array;
  readonly sidecarPayloads: readonly UsageSidecarPayload[];
}
export interface LegacyImportCaptureSource {
  readonly identity: string;
  readonly locator: string;
  readonly revisionId: string | null;
  readonly eventId: string | null;
  readonly operationId: string | null;
  readonly sha256: string | null;
}
export interface LegacyImportPlanIdempotency {
  readonly artifactId: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly source: LegacyImportCaptureSource;
}
export interface LegacyImportLifecycle {
  readonly artifactId: string;
  readonly bytes: Uint8Array;
  readonly source: LegacyImportCaptureSource;
}
export interface LegacyImportAttempt {
  readonly artifactId: string;
  readonly bytes: Uint8Array;
  readonly source: LegacyImportCaptureSource;
}
export interface LegacyImportSessionBranch {
  readonly repoUrl: string;
  readonly workingDir: string;
  readonly currentBranch: string;
  readonly branchHistory: readonly string[];
  readonly baseCommitSha: string | null;
  readonly ackedAt: string | null;
  readonly sourceLocation: string;
}
export interface LegacyImportCloudFact {
  readonly artifactId: string;
  readonly syncedAt: string | null;
  readonly syncHash: string | null;
  readonly externalId: string | null;
  readonly orgId: string | null;
  readonly lastPushAttemptAt: string | null;
  readonly lastPushErrorKind: string | null;
  readonly lastPushErrorMessage: string | null;
  readonly consecutiveFailures: number | null;
  readonly sourceLocation: string;
}
export interface LegacyImportSourcePlanRecord {
  readonly sourceLocation: string;
  readonly kind: 'approved' | 'review' | 'locator';
  readonly namespaceBaseUrl: string;
  readonly namespaceOrgId: string;
  readonly externalId: string;
  readonly slug: string | null;
  readonly versionNumber: number | null;
  readonly versionId: string | null;
  readonly target: string | null;
  readonly title: string | null;
  readonly contentHash: string | null;
  readonly bodyBytes: Uint8Array | null;
  readonly realPath: string | null;
  readonly pulledAt: string | null;
  readonly recordBytes: Uint8Array;
}
export interface LegacyImportSqliteImage {
  readonly sourceLocation: string;
  readonly baselineVersion: 20 | 22 | 23 | 24 | 25;
  readonly walFrames: number;
  readonly committedFrames: number;
  readonly tableCounts: Readonly<Record<string, number>>;
  readonly parts: readonly {
    readonly part: 'main' | 'wal' | 'shm';
    readonly sha256: string;
    readonly byteLength: number;
  }[];
}

export interface ProjectHistoryImportSource {
  readonly sourceProfile: typeof LEGACY_IMPORT_PROFILE;
  readonly sourceRevision: string;
  readonly sourceManifestHash: string;
  readonly artifacts: readonly LegacyImportArtifact[];
  readonly usage: LegacyImportUsage | null;
  readonly seed: PreparedImportedProjectSeedState | null;
  readonly planIdempotency: readonly LegacyImportPlanIdempotency[];
  readonly lifecycles: readonly LegacyImportLifecycle[];
  readonly attempts: readonly LegacyImportAttempt[];
  readonly sessionBranches: readonly LegacyImportSessionBranch[];
  readonly cloudFacts: readonly LegacyImportCloudFact[];
  readonly sourcePlanRecords: readonly LegacyImportSourcePlanRecord[];
  readonly sqliteImages: readonly LegacyImportSqliteImage[];
  readonly gitResources: readonly {
    readonly ref: string;
    readonly oid: string;
    readonly symbolicTarget: string | null;
    readonly ownership: 'unknown';
  }[];
  readonly omissions: DatabaseJson;
}

export interface ProjectHistoryImportReceipt {
  readonly operationId: string;
  readonly sourceProfile: string;
  readonly sourceRevision: string;
  readonly sourceManifestHash: string;
  readonly importedAt: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly omissions: DatabaseJson;
  readonly gitResources: DatabaseJson;
}

export interface ProjectHistoryImportResult {
  readonly receipt: ProjectHistoryImportReceipt;
  readonly replayed: boolean;
}

function invalid(message: string): never {
  throw new ProjectDatabaseError('INVALID_INPUT', message);
}

// Every family needs its own operation receipt, and a retry by the original conversion ID has
// to reproduce them byte for byte, so they are derived from that ID instead of minted fresh.
export function derivedImportOperationId(conversionOperationId: string, scope: string): string {
  if (!isUuidV7(conversionOperationId))
    invalid('Provide the original conversion operation UUID before deriving family receipts');
  const timestamp = Number(BigInt('0x' + conversionOperationId.replaceAll('-', '').slice(0, 12)));
  const seed = createHash('sha256')
    .update(conversionOperationId)
    .update('\0')
    .update(scope)
    .digest();
  return uuidv7({ now: timestamp, random: () => seed.subarray(0, 10) });
}

interface PendingOperation {
  readonly operation: ProjectOperation;
  readonly settle: (transaction: ProjectSettlement) => unknown;
}

function copySource(source: LegacyImportCaptureSource) {
  return {
    identity: source.identity,
    locator: source.locator,
    revisionId: source.revisionId,
    eventId: source.eventId,
    operationId: source.operationId,
    sha256: source.sha256,
  };
}

async function composePendingOperations(
  authority: ProjectDatabaseAuthority,
  operationId: string,
  source: ProjectHistoryImportSource,
  signal?: AbortSignal
): Promise<{ pending: PendingOperation[]; counts: Record<string, number> }> {
  const pending: PendingOperation[] = [];
  const counts: Record<string, number> = {
    artifacts: 0,
    artifactEvents: 0,
    usageEvents: 0,
    seedSources: 0,
    planIdempotency: source.planIdempotency.length,
    lifecycles: source.lifecycles.length,
    attempts: source.attempts.length,
    sessionBranches: source.sessionBranches.length,
    cloudFacts: source.cloudFacts.length,
    sourcePlanRecords: source.sourcePlanRecords.length,
    sqliteImages: source.sqliteImages.length,
    gitResources: source.gitResources.length,
  };
  const threads = new Map<string, ArtifactThread>();
  const revisions = new Map<
    string,
    Awaited<ReturnType<typeof composeArtifactAppend>>['revision']
  >();
  for (const artifact of source.artifacts) {
    cancelled(signal);
    const appendOperationId = derivedImportOperationId(
      operationId,
      `artifact:${artifact.artifactId}`
    );
    const request = restoreArtifactAppendRequest({
      operationId: appendOperationId,
      artifactId: artifact.artifactId,
      expectedRevision: null,
      eventBytes: artifact.eventBytes,
      sidecarPayloads: artifact.sidecarPayloads,
      secretAllow: [],
    });
    const composed = await composeArtifactAppend({
      projectId: authority.projectId,
      request,
      prior: null as ProjectArtifactSnapshot | null,
      sourceSnapshot: { selection: null, record: null },
    });
    if (!composed.thread.plan)
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'A retained artifact has no captured plan to date its imported execution from; preserve it for explicit repair',
        { cause: new Error(artifact.artifactId) }
      );
    threads.set(artifact.artifactId, composed.thread);
    revisions.set(artifact.artifactId, composed.revision);
    counts.artifacts += 1;
    counts.artifactEvents += composed.revision.eventCount;
    const query = await prepareArtifactQueryMetadata(composed.thread, composed.revision.generation);
    const execution = restoreExecutionRecords({
      state: initializeUnboundExecution({
        artifactId: artifact.artifactId,
        operationId: appendOperationId,
        reason: composed.thread.summary ? 'completed' : 'legacy_unknown',
        ts: composed.thread.plan.started_at,
        origin: composed.thread.plan?.origin?.kind === 'git-import' ? 'git-import' : 'captured',
      }),
      artifactRevision: composed.revision,
      previous: null,
      operationId: appendOperationId,
      secretAllow: [],
    });
    pending.push({
      operation: { ...request.operation, kind: 'capture.append' },
      settle: (transaction) => {
        const result = composed.settle(transaction);
        replaceArtifactQueryMetadata(transaction, query);
        settleExecutionRecords(transaction, execution);
        return result;
      },
    });
  }
  if (source.usage) {
    const usage = prepareUsageAppend(
      authority.projectId,
      {
        operationId: derivedImportOperationId(operationId, 'usage'),
        expectedRevision: null,
        eventBytes: source.usage.eventBytes,
        sidecarPayloads: source.usage.sidecarPayloads,
        secretAllow: [],
      },
      false
    );
    counts.usageEvents = (usage.operation.payload as unknown[]).length;
    pending.push(usage);
  }
  if (source.seed) {
    const seed = prepareSeedStateSettlement(authority.projectId, source.seed, 'historical');
    pending.push(seed);
    counts.seedSources = 1;
  }
  for (const record of source.planIdempotency) {
    const revision = revisions.get(record.artifactId);
    if (!revision) invalid('A retained plan key names an artifact outside the converted history');
    const prepared = prepareHistoricalPlanIdempotency(
      {
        operationId: derivedImportOperationId(operationId, `plan-key:${record.idempotencyKey}`),
        artifactId: record.artifactId,
        artifactRevision: revision,
        source: copySource(record.source),
        bytes: Buffer.from(
          JSON.stringify({
            idempotency_key: record.idempotencyKey,
            artifact_id: record.artifactId,
            created_at: record.createdAt,
          })
        ),
      },
      historicalOptions
    );
    const settlement = preparePlanIdempotencySettlement(prepared);
    const written = planIdempotencyPreparation(prepared);
    pending.push({
      operation: captureOperation(written, 'plan-key.publish', {
        artifactRevision: { ...written.artifactRevision },
      }),
      settle: (transaction) =>
        settleProjectPlanIdempotency(transaction, settlement, written.operationId),
    });
  }
  const lifecycleSelections = new Map<string, CaptureOperationSelection>();
  for (const [index, record] of source.lifecycles.entries()) {
    const revision = revisions.get(record.artifactId);
    if (!revision) invalid('A retained lifecycle names an artifact outside the converted history');
    const receipt = derivedImportOperationId(operationId, `lifecycle:${index}`);
    const revisionId = derivedImportOperationId(operationId, `lifecycle-revision:${index}`);
    const input = {
      operationId: receipt,
      revisionId,
      artifactId: record.artifactId,
      artifactRevision: revision,
      expectedSelection: null,
      source: copySource(record.source),
      bytes: record.bytes,
    };
    const initial = prepareHistoricalLifecycleCompletion(input, historicalOptions);
    const initialRecord = lifecycleCompletionPreparation(initial);
    const slot = `${record.artifactId}\0${initialRecord.key}`;
    const expectedSelection = lifecycleSelections.get(slot) ?? null;
    const prepared =
      expectedSelection === null
        ? initial
        : prepareHistoricalLifecycleCompletion(
            {
              ...input,
              expectedSelection,
            },
            historicalOptions
          );
    const settlement = prepareLifecycleCompletionSettlement(prepared);
    const written = lifecycleCompletionPreparation(prepared);
    lifecycleSelections.set(slot, {
      revisionId,
      version: (expectedSelection?.version ?? 0) + 1,
    });
    pending.push({
      operation: captureOperation(written, 'lifecycle.publish', {
        artifactRevision: { ...written.artifactRevision },
        selection: written.expectedSelection === null ? null : { ...written.expectedSelection },
      }),
      settle: (transaction) =>
        settleProjectLifecycleCompletion(transaction, settlement, written.operationId),
    });
  }
  for (const [index, record] of source.attempts.entries()) {
    const revision = revisions.get(record.artifactId);
    if (!revision) invalid('A retained attempt names an artifact outside the converted history');
    const receipt = derivedImportOperationId(operationId, `attempt:${index}`);
    const prepared = prepareHistoricalArtifactAttempt(
      {
        operationId: receipt,
        revisionId: derivedImportOperationId(operationId, `attempt-revision:${index}`),
        artifactId: record.artifactId,
        artifactRevision: revision,
        expectedSelection: null,
        source: copySource(record.source),
        bytes: record.bytes,
        action: 'set',
      },
      historicalOptions
    );
    const settlement = prepareArtifactAttemptSettlement(prepared);
    const written = artifactAttemptPreparation(prepared);
    pending.push({
      operation: captureOperation(written, 'attempt.publish', {
        artifactRevision: { ...written.artifactRevision },
        selection: written.expectedSelection === null ? null : { ...written.expectedSelection },
      }),
      settle: (transaction) =>
        settleProjectArtifactAttemptChanges(transaction, settlement, written.operationId),
    });
  }
  return { pending, counts };
}

function settleLegacyRows(
  transaction: ProjectSettlement,
  source: ProjectHistoryImportSource
): void {
  source.sessionBranches.forEach((row, index) =>
    transaction.run(
      'INSERT INTO legacy_session_branch_state VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
      index + 1,
      row.repoUrl,
      row.workingDir,
      row.currentBranch,
      serializeDatabaseValue([...row.branchHistory]),
      row.baseCommitSha,
      row.ackedAt,
      row.sourceLocation,
      'unknown'
    )
  );
  for (const row of source.cloudFacts)
    transaction.run(
      'INSERT INTO legacy_artifact_cloud_facts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      row.artifactId,
      row.syncedAt,
      row.syncHash,
      row.externalId,
      row.orgId,
      row.lastPushAttemptAt,
      row.lastPushErrorKind,
      row.lastPushErrorMessage,
      row.consecutiveFailures,
      row.sourceLocation,
      'unknown'
    );
  for (const row of source.sourcePlanRecords) {
    const bytes = Buffer.from(row.recordBytes);
    transaction.run(
      'INSERT INTO legacy_source_plan_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      row.sourceLocation,
      row.kind,
      row.namespaceBaseUrl,
      row.namespaceOrgId,
      row.externalId,
      row.slug,
      row.versionNumber,
      row.versionId,
      row.target,
      row.title,
      row.contentHash,
      row.bodyBytes === null ? null : Buffer.from(row.bodyBytes),
      row.realPath,
      row.pulledAt,
      bytes,
      createHash('sha256').update(bytes).digest('hex'),
      'unknown'
    );
  }
  for (const image of source.sqliteImages)
    for (const part of image.parts)
      transaction.run(
        'INSERT INTO legacy_sqlite_images VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        image.sourceLocation,
        part.part,
        part.sha256,
        part.byteLength,
        image.baselineVersion,
        image.walFrames,
        image.committedFrames,
        serializeDatabaseValue({ ...image.tableCounts })
      );
}

function receiptFrom(row: Record<string, unknown>): ProjectHistoryImportReceipt {
  return Object.freeze({
    operationId: row.operation_id as string,
    sourceProfile: row.source_profile as string,
    sourceRevision: row.source_revision as string,
    sourceManifestHash: row.source_manifest_hash as string,
    importedAt: row.imported_at as string,
    counts: Object.freeze(JSON.parse(row.counts_json as string) as Record<string, number>),
    omissions: JSON.parse(row.omissions_json as string) as DatabaseJson,
    gitResources: JSON.parse(row.git_resources_json as string) as DatabaseJson,
  });
}

export function readProjectHistoryImport(
  handle: ProjectDatabase
): ProjectHistoryImportReceipt | null {
  const row = handle.read((view) =>
    view.get<Record<string, unknown>>('SELECT * FROM legacy_import WHERE singleton = 1')
  ).value;
  return row === null ? null : receiptFrom(row);
}

export interface ImportProjectHistoryInput {
  readonly authority: ProjectDatabaseAuthority;
  readonly operationId: string;
  readonly importedAt: string;
  readonly repositoryCreation: RepositoryCreation;
  readonly source: ProjectHistoryImportSource;
  readonly authorize: () => void;
  readonly signal?: AbortSignal;
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ProjectDatabaseError(
      'CANCELLED',
      'Conversion cancelled before commit; retry the original conversion operation ID if still wanted'
    );
}

export async function importProjectHistory(
  input: ImportProjectHistoryInput
): Promise<ProjectHistoryImportResult> {
  const authority = Object.freeze({ ...input.authority });
  const operationId = input.operationId;
  const importedAt = input.importedAt;
  const source = input.source;
  const authorization: unknown = input.authorize();
  if (authorization !== undefined)
    invalid('Authorization and refusal checks must finish synchronously before a conversion');
  if (!isUuidV7(operationId) || !Number.isFinite(Date.parse(importedAt)))
    invalid('Provide the original conversion operation ID and timestamp before importing');
  if (source.sourceProfile !== LEGACY_IMPORT_PROFILE)
    throw new ProjectDatabaseError(
      'HISTORY_FORMAT_UNSUPPORTED',
      'Only the frozen 0.2.0-rc.2 source profile can be converted'
    );
  if (!/^[a-f0-9]{64}$/.test(source.sourceManifestHash))
    invalid('Provide the verified source manifest hash before importing');
  const repositoryCreation = copyRepositoryCreation(input.repositoryCreation);
  projectDatabasePath(authority);
  const file = await validateProjectDatabaseLocation(authority);

  // Preparation stays outside the transaction: decoding, hashing and query compilation must
  // not run while the exclusive write lock is held.
  cancelled(input.signal);
  const { pending, counts } = await composePendingOperations(
    authority,
    operationId,
    source,
    input.signal
  );
  const countsJson = serializeDatabaseValue({ ...counts, operations: pending.length + 1 });
  const omissionsJson = serializeDatabaseValue(source.omissions);
  const gitResourcesJson = serializeDatabaseValue(
    source.gitResources.map((entry) => ({ ...entry }))
  );

  let existed = false;
  try {
    closeSync(openSync(file, 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    existed = true;
  }
  const created = fileIdentity(file);
  const DatabaseConstructor = createRequire(import.meta.url)('better-sqlite3') as typeof Database;
  const database = new DatabaseConstructor(file, { fileMustExist: true, timeout: 100 });
  try {
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = FULL');
    database.pragma('foreign_keys = ON');
    database.pragma('temp_store = MEMORY');
    if (process.platform === 'darwin') database.pragma('fullfsync = ON');
    // When this call created the target exclusively, no other writer can hold its lock, so
    // BEGIN IMMEDIATE cannot contend. When the target already existed it is one of three things:
    // a leftover from an interrupted attempt (uncontended), a fully converted store to adopt
    // (uncontended), or a target a concurrent conversion is writing right now. The operation
    // runner is not usable here — it needs an initialized, activated database, which this
    // transaction is creating — so contention is disclosed as a typed retryable outcome instead
    // of blocking out the open-time busy timeout and surfacing a raw busy error. A zero busy
    // timeout makes the probe fail fast; an uncontended existing target acquires immediately.
    cancelled(input.signal);
    if (existed) {
      database.pragma('busy_timeout = 0');
      try {
        database.exec('BEGIN IMMEDIATE');
      } catch (error) {
        if (isDatabaseContention(error))
          throw new ProjectDatabaseError(
            'TRANSACTION_FAILED',
            'Another conversion is writing this target; retry the original conversion after it settles',
            { cause: error }
          );
        throw error;
      }
      database.pragma('busy_timeout = 100');
    } else {
      database.exec('BEGIN IMMEDIATE');
    }
    // A leftover from an interrupted attempt is re-entered only here, under the exclusive
    // lock, and only while it still holds no schema at all: anything else is someone's store.
    if (existed && database.prepare('SELECT 1 AS present FROM sqlite_schema LIMIT 1').get()) {
      database.exec('ROLLBACK');
      database.close();
      return { receipt: await adoptExistingTarget(authority, operationId, source), replayed: true };
    }
    database.exec(PROJECT_DATABASE_SCHEMA);
    database
      .prepare('INSERT INTO store_identity VALUES (1, ?, ?, ?, ?, ?, ?)')
      .run(
        authority.resolvedRoot,
        authority.rootKey,
        authority.projectId,
        authority.storeInstanceId,
        authority.repositoryInstanceId,
        operationId
      );
    database
      .prepare('INSERT INTO repository_creation VALUES (1, 1, ?, ?, ?, ?)')
      .run(
        repositoryCreation.commonDirectory,
        repositoryCreation.device,
        repositoryCreation.inode,
        repositoryCreation.birthtimeNs
      );
    database.prepare("INSERT INTO activation VALUES (1, 1, ?, 'active')").run(importedAt);
    database.prepare('INSERT INTO project_counters VALUES (1, 1, 0)').run();
    let writeSequence = 1;
    let intentCounter = 0;
    const transaction: ProjectSettlement = Object.freeze({
      ...createReadView(database, () => database.inTransaction),
      run(sql: string, ...parameters: unknown[]) {
        if (
          !/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql) ||
          /\b(store_identity|activation|repository_creation|project_counters|operations|legacy_import)\b/i.test(
            sql
          )
        )
          invalid(
            'Imported writes must target domain rows; identity, counters and receipts belong to the conversion'
          );
        return { changes: database.prepare(sql).run(...parameters).changes };
      },
    });
    const receiptStatement = database.prepare(
      'INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const commit = (operation: ProjectOperation, result: unknown) => {
      const targetJson = serializeDatabaseValue(operation.target);
      const payloadJson = serializeDatabaseValue(operation.payload);
      const expectedStateJson = serializeDatabaseValue(operation.expectedState);
      const resultJson = serializeDatabaseValue(result as DatabaseJson);
      writeSequence += 1;
      intentCounter += Number(operation.intentChange);
      receiptStatement.run(
        operation.operationId,
        operation.kind,
        Number(operation.intentChange),
        targetJson,
        payloadJson,
        createHash('sha256').update(payloadJson).digest('hex'),
        expectedStateJson,
        resultJson,
        writeSequence,
        intentCounter
      );
    };
    for (const entry of pending) {
      cancelled(input.signal);
      commit(entry.operation, entry.settle(transaction));
    }
    settleLegacyRows(transaction, source);
    commit(
      {
        operationId,
        kind: 'history.convert.import',
        target: { projectId: authority.projectId },
        payload: {
          sourceProfile: source.sourceProfile,
          sourceRevision: source.sourceRevision,
          sourceManifestHash: source.sourceManifestHash,
        },
        expectedState: null,
        intentChange: true,
      },
      { counts: JSON.parse(countsJson) as DatabaseJson }
    );
    database
      .prepare('INSERT INTO legacy_import VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        operationId,
        source.sourceProfile,
        source.sourceRevision,
        source.sourceManifestHash,
        importedAt,
        countsJson,
        omissionsJson,
        gitResourcesJson
      );
    database
      .prepare(
        'UPDATE project_counters SET write_sequence = ?, intent_change_counter = ? WHERE singleton = 1'
      )
      .run(writeSequence, intentCounter);
    validateProjectSchema(database, PROJECT_DATABASE_SCHEMA_VERSION);
    cancelled(input.signal);
    const after = fileIdentity(file);
    if (after.dev !== created.dev || after.ino !== created.ino)
      throw new ProjectDatabaseError(
        'HISTORY_MISSING',
        'The conversion target pathname identifies a different file; preserve it for explicit repair'
      );
    database.exec('COMMIT');
    const receipt = receiptFrom(
      database.prepare('SELECT * FROM legacy_import WHERE singleton = 1').get() as Record<
        string,
        unknown
      >
    );
    const directory = openSync(path.dirname(file), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    return { receipt, replayed: false };
  } finally {
    if (database.open) {
      if (database.inTransaction) database.exec('ROLLBACK');
      database.close();
    }
  }
}

function fileIdentity(file: string): { dev: bigint; ino: bigint } {
  const descriptor = openSync(file, 'r');
  try {
    const info = fstatSync(descriptor, { bigint: true });
    return { dev: info.dev, ino: info.ino };
  } finally {
    closeSync(descriptor);
  }
}

async function adoptExistingTarget(
  authority: ProjectDatabaseAuthority,
  operationId: string,
  source: ProjectHistoryImportSource
): Promise<ProjectHistoryImportReceipt> {
  const candidate = await readProjectInitializationCandidate({
    root: authority.resolvedRoot,
    projectId: authority.projectId,
  });
  if (candidate.initializationOperationId !== operationId)
    throw new ProjectDatabaseError(
      'IDENTITY_CONFLICT',
      'The target belongs to a different original operation; preserve it and select an unoccupied project'
    );
  const handle = await openProjectDatabase({ authority, mode: 'reader' });
  try {
    const receipt = readProjectHistoryImport(handle);
    if (!receipt)
      throw new ProjectDatabaseError(
        'IDENTITY_CONFLICT',
        'The target is an initialized store with no conversion receipt; never label an existing store converted'
      );
    if (
      receipt.operationId !== operationId ||
      receipt.sourceManifestHash !== source.sourceManifestHash ||
      receipt.sourceProfile !== source.sourceProfile
    )
      throw new ProjectDatabaseError(
        'IDEMPOTENCY_CONFLICT',
        'The target records a different original conversion; retry that operation or select an unoccupied project'
      );
    return receipt;
  } finally {
    handle.close();
  }
}
