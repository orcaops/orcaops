import { isDeepStrictEqual } from 'node:util';

import { canonicalJson } from '../../events/canonical-json.js';
import { digest } from '../event-integrity.js';
import { type ArtifactSourceTimeMember, resolveSourceEvidenceTime } from '../source-time.js';
import { readProjectArtifact } from './artifacts.js';
import {
  type AuthoredSourceTimeInput,
  type CaptureAuthoredOptions,
  copyAuthoredSourceTimeInput,
  type PreparedSourceTime,
  prepareSourceTimeWithRetainedFacts,
  sourceTimePreparation,
  sourceTimeRecordForReplay,
} from './capture-operation-input.js';
import {
  assertCaptureArtifactRevision,
  assertCaptureOperation,
  captureIntegrity,
  captureOperation,
  captureProvenanceColumns,
  captureRecordParameters,
} from './capture-records.js';
import {
  assertProjectDatabasePath,
  type ProjectDatabase,
  type ProjectReadView,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { prepareArtifactSearchRows, replaceArtifactSearchRows } from './search-records.js';
import { sourceMembership } from './source-time-membership.js';
import {
  assertProjectSourceTimeSelection,
  hydrateProjectSourceTime,
  snapshotProjectSourceTime,
} from './source-time-records.js';
import {
  type ProjectOperationOptions,
  type ProjectSettlement,
  runProjectOperation,
} from './transactions.js';

function invalid(message: string): never {
  throw new ProjectDatabaseError('INVALID_INPUT', message);
}
function preserveMember(
  previous: ArtifactSourceTimeMember | null,
  next: ArtifactSourceTimeMember
): void {
  if (previous === null) return;
  if (!isDeepStrictEqual(previous.member_commits, next.member_commits))
    invalid('A source chronology update cannot replace original commit membership');
  const current = new Map(next.sources.map((source) => [source.source_id, source]));
  for (const source of previous.sources) {
    const retained = current.get(source.source_id);
    if (!retained || !isDeepStrictEqual(retained.attributed_commits, source.attributed_commits))
      invalid('Retain every original source attribution when adding chronology evidence');
    const facts = new Map(retained.facts.map((fact) => [fact.commit_oid, fact]));
    for (const fact of source.facts)
      if (!isDeepStrictEqual(facts.get(fact.commit_oid), fact))
        invalid('Previously retained Git facts cannot be removed or replaced');
  }
}
function originalRevision(view: ProjectReadView, revisionId: string): void {
  if (view.get('SELECT revision_id FROM source_time_revisions WHERE revision_id=?', revisionId))
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The source chronology revision ID already belongs to retained history'
    );
}
export interface PreparedSourceTimeSettlement {
  readonly kind: 'prepared-source-time-settlement';
}
const settlements = new WeakMap<
  PreparedSourceTimeSettlement,
  {
    record: ReturnType<typeof sourceTimePreparation>;
    parameters: unknown[];
    search: ReturnType<typeof prepareArtifactSearchRows>;
    sources: Array<{
      id: string;
      json: string;
      hash: string;
      time: string | null;
      basis: string;
      reason: string | null;
    }>;
  }
>();
export function prepareSourceTimeSettlement(
  handle: ProjectDatabase,
  input: PreparedSourceTime
): PreparedSourceTimeSettlement {
  const record = sourceTimePreparation(input);
  assertProjectDatabasePath(handle);
  const artifact = readProjectArtifact(handle, record.artifactId, record.artifactRevision);
  if (artifact === null)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'The intended source chronology artifact revision is missing; preserve it for explicit repair'
    );
  const observed = handle.read((view) => snapshotProjectSourceTime(view, record.artifactId)).value;
  if (!isDeepStrictEqual(observed.selection, record.expectedSelection))
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'Source chronology selection advanced; prepare a new operation for the intended facts'
    );
  const previous = hydrateProjectSourceTime(observed, record.artifactId);
  sourceMembership(artifact.thread, record.member, record.sourceKind === 'historical');
  preserveMember(previous, record.member);
  const sources = record.member.sources.map((source) => {
    const json = canonicalJson(source);
    const time = resolveSourceEvidenceTime({
      artifactId: record.artifactId,
      sourceId: source.source_id,
      evidence: source,
    });
    return {
      id: source.source_id,
      json,
      hash: digest(Buffer.from(json)),
      time: time.evidence_time,
      basis: time.evidence_time_basis,
      reason: time.evidence_time_basis === 'unknown' ? time.reason : null,
    };
  });
  const value = Object.freeze({ kind: 'prepared-source-time-settlement' as const });
  settlements.set(value, {
    record,
    parameters: captureRecordParameters(record),
    sources,
    search: prepareArtifactSearchRows(
      handle.authority.projectId,
      artifact.thread,
      record.artifactRevision.generation,
      record.member
    ),
  });
  return value;
}
export function settleProjectSourceTime(
  transaction: ProjectSettlement,
  input: PreparedSourceTimeSettlement,
  operationId: string
) {
  const value = settlements.get(input);
  if (!value) invalid('Use genuine prepared source chronology settlement');
  const { record, parameters, sources, search } = value;
  assertCaptureOperation(record, operationId);
  assertCaptureArtifactRevision(transaction, record.artifactId, record.artifactRevision);
  assertProjectSourceTimeSelection(transaction, record.artifactId, record.expectedSelection);
  originalRevision(transaction, record.revisionId);
  const version = (record.expectedSelection?.version ?? 0) + 1;
  if (!Number.isSafeInteger(version))
    captureIntegrity('Source chronology selection version capacity is exhausted');
  transaction.run(
    `INSERT INTO source_time_revisions (revision_id,${captureProvenanceColumns},source_count) VALUES (${Array(15).fill('?').join(',')})`,
    record.revisionId,
    ...parameters,
    sources.length
  );
  for (const source of sources)
    transaction.run(
      'INSERT INTO source_time_sources VALUES (?,?,?,?,?,?,?)',
      record.revisionId,
      source.id,
      source.json,
      source.hash,
      source.time,
      source.basis,
      source.reason
    );
  if (record.expectedSelection)
    transaction.run(
      'UPDATE source_time_current SET revision_id=?,version=? WHERE artifact_id=? AND revision_id=? AND version=?',
      record.revisionId,
      version,
      record.artifactId,
      record.expectedSelection.revisionId,
      record.expectedSelection.version
    );
  else
    transaction.run(
      'INSERT INTO source_time_current VALUES (?,?,?)',
      record.artifactId,
      record.revisionId,
      version
    );
  replaceArtifactSearchRows(transaction, search);
  return { artifactId: record.artifactId, selection: { revisionId: record.revisionId, version } };
}
export async function publishProjectSourceTime(
  handle: ProjectDatabase,
  input: AuthoredSourceTimeInput,
  refusal: CaptureAuthoredOptions,
  options: ProjectOperationOptions = {}
) {
  const copied = copyAuthoredSourceTimeInput(input, refusal);
  const runtime = { signal: options.signal, onWait: options.onWait };
  assertProjectDatabasePath(handle);
  const operationRecord = sourceTimeRecordForReplay(copied.input, copied.options);
  const operation = captureOperation(operationRecord, 'source-time.publish', {
    artifactRevision: { ...operationRecord.artifactRevision },
    selection:
      operationRecord.expectedSelection === null ? null : { ...operationRecord.expectedSelection },
  });
  if (
    handle.read((view) =>
      view.get(
        'SELECT operation_id FROM operations WHERE operation_id=?',
        operationRecord.operationId
      )
    ).value
  )
    return runProjectOperation(
      handle,
      operation,
      () => {
        throw new ProjectDatabaseError(
          'HISTORY_INTEGRITY_REQUIRED',
          'The original source chronology operation disappeared; preserve history for explicit repair'
        );
      },
      runtime
    );
  const observed = handle.read((view) =>
    snapshotProjectSourceTime(view, operationRecord.artifactId)
  ).value;
  const prior = hydrateProjectSourceTime(observed, operationRecord.artifactId);
  const prepared = prepareSourceTimeWithRetainedFacts(copied.input, copied.options, prior);
  const settlement = prepareSourceTimeSettlement(handle, prepared);
  return runProjectOperation(
    handle,
    operation,
    (transaction) => settleProjectSourceTime(transaction, settlement, operationRecord.operationId),
    runtime
  );
}
