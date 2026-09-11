import { isDeepStrictEqual } from 'node:util';

import { isUuidV7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import {
  type ArtifactSourceTimeMember,
  ArtifactSourceTimeMemberSchema,
  resolveSourceEvidenceTime,
  SourceTimeEvidenceSchema,
} from '../source-time.js';
import type { CaptureOperationSelection } from './capture-operation-input.js';
import {
  captureArtifactId,
  captureArtifactRevision,
  captureIntegrity,
  captureReadColumns,
  captureReadJoins,
  type CaptureRecordRow,
  decodeCaptureProvenance,
  decodeCaptureRecord,
  validateCaptureSelection,
} from './capture-records.js';
import {
  assertProjectDatabasePath,
  type ProjectDatabase,
  type ProjectReadView,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';

interface SourceTimeHeader {
  revisionId: string;
  version: number;
  recordId: string | null;
  operationId: string | null;
  artifactGeneration: number | null;
  retainedGeneration: number | null;
  sourceCount: number | null;
}
export interface SourceTimeRecordRow extends CaptureRecordRow {
  revisionId: string;
  sourceCount: number;
}
export interface ProjectSourceTimeMaterialized {
  selection: CaptureOperationSelection | null;
  record: SourceTimeRecordRow | null;
}
function selectedSourceTime(view: ProjectReadView, artifactId: string): SourceTimeHeader | null {
  const selected = view.get<SourceTimeHeader>(
    `SELECT c.revision_id AS revisionId,c.version,r.revision_id AS recordId,
    r.artifact_generation AS artifactGeneration,a.generation AS retainedGeneration,
    o.operation_id AS operationId,r.source_count AS sourceCount
    FROM source_time_current c
    LEFT JOIN source_time_revisions r ON r.artifact_id=c.artifact_id AND r.revision_id=c.revision_id
    ${captureReadJoins} WHERE c.artifact_id=?`,
    artifactId
  );
  if (!selected) {
    if (
      view.get(
        'SELECT revision_id FROM source_time_revisions WHERE artifact_id=? LIMIT 1',
        artifactId
      )
    )
      captureIntegrity('Source chronology selection is missing while retained facts remain');
    return null;
  }
  validateCaptureSelection(selected);
  if (
    selected.recordId !== selected.revisionId ||
    typeof selected.operationId !== 'string' ||
    !isUuidV7(selected.operationId) ||
    selected.artifactGeneration !== selected.retainedGeneration ||
    !Number.isSafeInteger(selected.artifactGeneration) ||
    selected.artifactGeneration! < 1 ||
    !Number.isSafeInteger(selected.sourceCount) ||
    selected.sourceCount! < 0
  )
    captureIntegrity(
      'Selected source chronology or original publication is missing or inconsistent'
    );
  return selected;
}
function retainedSourceTime(
  view: ProjectReadView,
  artifactId: string,
  revisionId: string
): SourceTimeRecordRow | null {
  return (
    view.get<SourceTimeRecordRow>(
      `SELECT ${captureReadColumns},r.revision_id AS revisionId,r.source_count AS sourceCount
    FROM source_time_revisions r ${captureReadJoins} WHERE r.artifact_id=? AND r.revision_id=?`,
      artifactId,
      revisionId
    ) ?? null
  );
}
export function snapshotProjectSourceTime(
  view: ProjectReadView,
  artifactId: string
): ProjectSourceTimeMaterialized {
  const selected = selectedSourceTime(view, artifactId);
  if (!selected) return { selection: null, record: null };
  const record = retainedSourceTime(view, artifactId, selected.revisionId);
  if (!record) captureIntegrity('The selected source chronology record disappeared');
  return {
    selection: Object.freeze({ revisionId: selected.revisionId, version: selected.version }),
    record,
  };
}
export function hydrateProjectSourceTime(
  snapshot: ProjectSourceTimeMaterialized,
  artifactId: string
): ArtifactSourceTimeMember | null {
  if (snapshot.record === null) {
    if (snapshot.selection !== null)
      captureIntegrity('Selected source chronology bytes are missing');
    return null;
  }
  const { record } = snapshot;
  const decoded = decodeCaptureRecord(record, ArtifactSourceTimeMemberSchema);
  if (
    decoded.record.artifact_id !== artifactId ||
    record.artifactId !== artifactId ||
    record.sourceCount !== decoded.record.sources.length ||
    !isUuidV7(record.revisionId) ||
    (snapshot.selection !== null && snapshot.selection.revisionId !== record.revisionId)
  )
    captureIntegrity(
      'Source chronology membership or exact artifact identity differs from retained bytes'
    );
  return decoded.record;
}
class SourceTimeSnapshotChanged extends ProjectDatabaseError {
  constructor() {
    super(
      'STALE_CONTEXT',
      'The retained source chronology selection changed; refresh only this derived-input snapshot without retargeting authored content'
    );
  }
}
export function isSourceTimeSnapshotChanged(error: unknown): boolean {
  return error instanceof SourceTimeSnapshotChanged;
}
export function assertProjectSourceTimeSelection(
  view: ProjectReadView,
  artifactId: string,
  expected: CaptureOperationSelection | null
): void {
  const current = selectedSourceTime(view, artifactId);
  const actual =
    current === null ? null : { revisionId: current.revisionId, version: current.version };
  if (!isDeepStrictEqual(actual, expected)) throw new SourceTimeSnapshotChanged();
}
export function readProjectSourceTime(
  handle: ProjectDatabase,
  artifactId: string,
  revisionId?: string
) {
  const id = captureArtifactId(artifactId);
  const revision = revisionId === undefined ? undefined : captureArtifactId(revisionId);
  assertProjectDatabasePath(handle);
  const snapshot = handle.read((view) => {
    captureArtifactRevision(view, id);
    if (revision === undefined) return snapshotProjectSourceTime(view, id);
    const record = retainedSourceTime(view, id, revision);
    if (!record)
      throw new ProjectDatabaseError(
        'HISTORY_MISSING',
        'The requested original source chronology revision is missing; preserve history for explicit repair'
      );
    return { selection: null, record };
  });
  const member = hydrateProjectSourceTime(snapshot.value, id);
  if (member === null) return null;
  const retained = snapshot.value.record!;
  return {
    selection: snapshot.value.selection,
    revisionId: retained.revisionId,
    artifactGeneration: retained.artifactGeneration,
    operationId: retained.operationId,
    sourceKind: retained.sourceKind,
    sourceProfile: retained.sourceProfile,
    source: decodeCaptureProvenance(retained),
    bytes: Buffer.from(retained.bytesHex!, 'hex'),
    member,
    counters: snapshot.counters,
  };
}
interface SourceRow {
  sourceId: string;
  sourceJson: string;
  sourceHash: string;
  evidenceTime: string | null;
  evidenceTimeBasis: 'commit' | 'commit_set_latest' | 'unknown';
  unknownReason: string | null;
}
export function readProjectSourceTimeSource(
  handle: ProjectDatabase,
  artifactId: string,
  sourceId: string
) {
  const id = captureArtifactId(artifactId);
  const source = sourceId;
  if (typeof source !== 'string' || source.length === 0)
    throw new ProjectDatabaseError('INVALID_INPUT', 'Select the exact original source ID');
  assertProjectDatabasePath(handle);
  const snapshot = handle.read((view) => {
    captureArtifactRevision(view, id);
    const selected = selectedSourceTime(view, id);
    if (!selected) return null;
    const count = view.get<{ count: number }>(
      'SELECT count(*) AS count FROM source_time_sources WHERE revision_id=?',
      selected.revisionId
    )!;
    if (count.count !== selected.sourceCount)
      captureIntegrity(
        'Source chronology lookup membership is incomplete; explicitly rebuild from retained source bytes'
      );
    const row = view.get<SourceRow>(
      `SELECT source_id AS sourceId,source_json AS sourceJson,source_hash AS sourceHash,evidence_time AS evidenceTime,evidence_time_basis AS evidenceTimeBasis,unknown_reason AS unknownReason FROM source_time_sources WHERE revision_id=? AND source_id=?`,
      selected.revisionId,
      source
    );
    return {
      selection: { revisionId: selected.revisionId, version: selected.version },
      row: row ?? null,
    };
  });
  if (!snapshot.value?.row) return null;
  const row = snapshot.value.row;
  try {
    if (digest(Buffer.from(row.sourceJson)) !== row.sourceHash)
      captureIntegrity(
        'Source chronology lookup checksum differs; explicitly rebuild from retained source bytes'
      );
    const evidence = SourceTimeEvidenceSchema.parse(JSON.parse(row.sourceJson));
    const time = resolveSourceEvidenceTime({ artifactId: id, sourceId: source, evidence });
    if (
      evidence.artifact_id !== id ||
      evidence.source_id !== source ||
      row.sourceId !== source ||
      row.evidenceTime !== time.evidence_time ||
      row.evidenceTimeBasis !== time.evidence_time_basis ||
      row.unknownReason !== (time.evidence_time_basis === 'unknown' ? time.reason : null)
    )
      captureIntegrity(
        'Source chronology lookup differs from its original source identity or time'
      );
    return { selection: snapshot.value.selection, evidence, time, counters: snapshot.counters };
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError) throw cause;
    captureIntegrity(
      'Source chronology lookup cannot be decoded; explicitly rebuild from retained source bytes',
      cause
    );
  }
}
