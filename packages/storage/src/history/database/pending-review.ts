import {
  assertProjectDatabasePath,
  type ProjectCounters,
  type ProjectDatabase,
  type ProjectReadView,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  type GitRetentionRecords,
  insertRetentionRecords,
  readRetentionRecords,
  retentionId,
  retentionIntegrity,
} from './retention-records.js';
import { assertRetentionTarget } from './retention-targets.js';
import {
  type PreparedReviewRetention,
  restoreReviewRetentionPreparation,
  type ReviewRetentionPreparation,
  reviewRetentionPreparation,
} from './review-retention-input.js';
import type { ProjectSettlement } from './transactions.js';
import { serializeDatabaseValue } from './values.js';
import { canonicalJson } from '../../events/canonical-json.js';
import { digest } from '../event-integrity.js';

interface RetainedReviewReceipt {
  operationId: string;
  kind: string;
  intentChange: boolean;
  targetJson: string;
  payloadJson: string;
  payloadHash: string;
  expectedStateJson: string;
  resultJson: string;
  counters: ProjectCounters;
}
export interface PendingReviewRetention {
  prepared: PreparedReviewRetention;
  readonly original: ReturnType<typeof originalReviewInput>;
  retention: GitRetentionRecords;
  admission: RetainedReviewReceipt;
  terminal: RetainedReviewReceipt | null;
}
function originalReviewInput(input: ReviewRetentionPreparation) {
  return Object.freeze({
    kind: input.kind,
    selectedTransitionId: input.selectedTransitionId,
    base: input.base ? Object.freeze({ ...input.base }) : null,
    floor: input.floor
      ? Object.freeze({
          ...input.floor,
          basis: Object.freeze({
            ...input.floor.basis,
            reviewIncludedUntracked: Object.freeze([...input.floor.basis.reviewIncludedUntracked]),
          }),
          members: Object.freeze(input.floor.members.map((member) => Object.freeze({ ...member }))),
        })
      : null,
  });
}
interface RequestRow {
  kind: 'base' | 'floor';
  selectedTransitionId: string;
  baseRevisionId: string | null;
  floorPublicationId: string | null;
  baseRecordId: string | null;
  floorInputId: string | null;
}
interface BaseRow {
  bytesHex: string;
  sha256: string;
}
interface FloorRow {
  baseSha: string;
  pinnedTreeSha: string;
  worktreeHead: string | null;
  defaultBranch: string | null;
  fingerprintMaxDiffBytes: number;
  reviewMaxDiffBytes: number;
  observedWriteSequence: number;
  floorMemberName: string;
  diffMemberName: string;
}
type MemberRow = NonNullable<ReviewRetentionPreparation['floor']>['members'][number];
interface ReceiptRow extends Omit<RetainedReviewReceipt, 'intentChange' | 'counters'> {
  intentChange: number;
  writeSequence: number;
  intentChangeCounter: number;
}
function readReceipt(view: ProjectReadView, operationId: string) {
  return view.get<ReceiptRow>(
    'SELECT operation_id AS operationId, operation_kind AS kind, intent_change AS intentChange, target_json AS targetJson, payload_json AS payloadJson, payload_hash AS payloadHash, expected_state_json AS expectedStateJson, result_json AS resultJson, committed_write_sequence AS writeSequence, committed_intent_counter AS intentChangeCounter FROM operations WHERE operation_id = ?',
    operationId
  );
}
function readPendingReviewRows(view: ProjectReadView, operationId: string) {
  const request = view.get<RequestRow>(
    'SELECT kind, selected_transition_id AS selectedTransitionId, base_revision_id AS baseRevisionId, floor_publication_id AS floorPublicationId, base_record_id AS baseRecordId, floor_input_id AS floorInputId FROM pending_review_requests WHERE original_operation_id = ?',
    operationId
  );
  const base = view.get<BaseRow>(
    'SELECT lower(hex(record_bytes)) AS bytesHex, record_hash AS sha256 FROM pending_review_base_records WHERE original_operation_id = ?',
    operationId
  );
  const floor = view.get<FloorRow>(
    'SELECT base_sha AS baseSha, pinned_tree_sha AS pinnedTreeSha, worktree_head AS worktreeHead, default_branch AS defaultBranch, fingerprint_max_diff_bytes AS fingerprintMaxDiffBytes, review_max_diff_bytes AS reviewMaxDiffBytes, observed_write_sequence AS observedWriteSequence, floor_member_name AS floorMemberName, diff_member_name AS diffMemberName FROM pending_review_floor_inputs WHERE original_operation_id = ?',
    operationId
  );
  const paths = view.all<{ ordinal: number; path: string }>(
    'SELECT ordinal, path FROM pending_review_untracked_paths WHERE original_operation_id = ? ORDER BY ordinal',
    operationId
  );
  const members = view.all<MemberRow>(
    'SELECT name, kind, schema_version AS schemaVersion, relative_path AS relativePath, sha256, byte_length AS byteLength FROM pending_review_evidence_members WHERE original_operation_id = ? ORDER BY name',
    operationId
  );
  return { request, base, floor, paths, members };
}
export function readPendingReviewSnapshot(view: ProjectReadView, operationId: string) {
  const retention = readRetentionRecords(view, operationId);
  const { request, base, floor, paths, members } = readPendingReviewRows(view, operationId);
  if (!retention) {
    if (
      request ||
      base ||
      floor ||
      paths.length ||
      members.length ||
      view.get(
        'SELECT original_operation_id FROM git_retention_review_targets WHERE original_operation_id = ? UNION ALL SELECT original_operation_id FROM git_retention_transitions WHERE original_operation_id = ? LIMIT 1',
        operationId,
        operationId
      )
    )
      retentionIntegrity();
    return null;
  }
  return {
    retention,
    request,
    base,
    floor,
    paths,
    members,
    admission: readReceipt(view, retention.input.admissionOperationId),
    terminal: readReceipt(view, operationId),
  };
}
function receipt(row: ReceiptRow | null, operationId: string): RetainedReviewReceipt {
  if (
    !row ||
    row.operationId !== operationId ||
    typeof row.kind !== 'string' ||
    !row.kind ||
    (row.intentChange !== 0 && row.intentChange !== 1) ||
    !Number.isSafeInteger(row.writeSequence) ||
    row.writeSequence < 1 ||
    !Number.isSafeInteger(row.intentChangeCounter) ||
    row.intentChangeCounter < 0 ||
    row.intentChangeCounter > row.writeSequence
  )
    retentionIntegrity();
  for (const bytes of [row.targetJson, row.payloadJson, row.expectedStateJson, row.resultJson]) {
    if (typeof bytes !== 'string') retentionIntegrity();
    try {
      serializeDatabaseValue(JSON.parse(bytes));
    } catch (cause) {
      retentionIntegrity(cause);
    }
  }
  if (digest(Buffer.from(row.payloadJson)) !== row.payloadHash) retentionIntegrity();
  const { writeSequence, intentChangeCounter, intentChange, ...value } = row;
  return {
    ...value,
    intentChange: intentChange === 1,
    counters: { writeSequence, intentChangeCounter },
  };
}
export function restorePendingReviewSnapshot(
  snapshot: ReturnType<typeof readPendingReviewSnapshot>
): PendingReviewRetention | null {
  if (!snapshot) return null;
  const { retention, request, base, floor, paths, members } = snapshot;
  if (!request) {
    if (base || floor || paths.length || members.length) retentionIntegrity();
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'This operation has no retained original review input; preserve its publications and use the original domain operation or explicit repair'
    );
  }
  if (
    retention.input.target.kind !== 'review' ||
    (request.baseRevisionId !== null) !== (base !== null) ||
    request.baseRecordId !== (base ? retention.input.operationId : null) ||
    (request.kind === 'floor') !== (floor !== null) ||
    (request.kind === 'floor') !== (request.floorPublicationId !== null) ||
    request.floorInputId !== (floor ? retention.input.operationId : null) ||
    (!floor && (paths.length || members.length))
  )
    retentionIntegrity();
  if (paths.some((path, ordinal) => path.ordinal !== ordinal)) retentionIntegrity();
  let originalBase: { revisionId: string; bytes: Buffer<ArrayBuffer> } | null = null;
  if (base) {
    if (typeof base.bytesHex !== 'string' || !/^(?:[0-9a-fA-F]{2})*$/.test(base.bytesHex))
      retentionIntegrity();
    const bytes = Buffer.from(base.bytesHex, 'hex');
    if (digest(bytes) !== base.sha256) retentionIntegrity();
    originalBase = { revisionId: request.baseRevisionId!, bytes };
  }
  let prepared: PreparedReviewRetention;
  if (floor) {
    if (floor.floorMemberName !== 'floor.json' || floor.diffMemberName !== 'diff.patch')
      retentionIntegrity();
    const {
      observedWriteSequence,
      floorMemberName: _floorName,
      diffMemberName: _diffName,
      ...basis
    } = floor;
    prepared = restoreReviewRetentionPreparation(retention.input, {
      kind: 'floor',
      selectedTransitionId: request.selectedTransitionId,
      base: originalBase,
      floor: {
        publicationId: request.floorPublicationId!,
        observedWriteSequence,
        basis: { ...basis, reviewIncludedUntracked: paths.map((value) => value.path) },
        members,
      },
    });
  } else {
    if (request.kind !== 'base' || !originalBase) retentionIntegrity();
    prepared = restoreReviewRetentionPreparation(retention.input, {
      kind: 'base',
      selectedTransitionId: request.selectedTransitionId,
      base: originalBase,
    });
  }
  const selected = retention.transitions.find((value) => value.kind === 'selected');
  if (
    (selected !== undefined) !== (snapshot.terminal !== null) ||
    (selected && selected.transitionId !== request.selectedTransitionId)
  )
    retentionIntegrity();
  const admission = receipt(snapshot.admission, retention.input.admissionOperationId);
  const terminal = snapshot.terminal
    ? receipt(snapshot.terminal, retention.input.operationId)
    : null;
  if (
    terminal &&
    (terminal.counters.writeSequence <= admission.counters.writeSequence ||
      terminal.counters.intentChangeCounter < admission.counters.intentChangeCounter)
  )
    retentionIntegrity();
  return {
    prepared,
    original: originalReviewInput(reviewRetentionPreparation(prepared)),
    retention,
    admission,
    terminal,
  };
}
export function readProjectPendingReview(database: ProjectDatabase, originalOperationId: string) {
  retentionId(originalOperationId);
  assertProjectDatabasePath(database);
  const observed = database.read((view) => readPendingReviewSnapshot(view, originalOperationId));
  // Copy original bytes in the short snapshot; decode and validate them after releasing it.
  return { value: restorePendingReviewSnapshot(observed.value), counters: observed.counters };
}
export function insertReviewRetentionAdmission(
  tx: ProjectSettlement,
  prepared: PreparedReviewRetention
): void {
  const input = reviewRetentionPreparation(prepared);
  const operationId = input.retention.operationId;
  if (
    tx.get(
      'SELECT operation_id FROM operations WHERE operation_id IN (?, ?) UNION ALL SELECT original_operation_id FROM git_retention_operations WHERE original_operation_id = ? UNION ALL SELECT original_operation_id FROM pending_review_requests WHERE original_operation_id = ? LIMIT 1',
      operationId,
      input.retention.admissionOperationId,
      operationId,
      operationId
    )
  )
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The original review operation or admission identity is already retained; replay and compare its original authored operation before publication'
    );
  assertRetentionTarget(tx, input.retention);
  insertRetentionRecords(tx, input.retention);
  tx.run(
    'INSERT INTO pending_review_requests VALUES (?, ?, ?, ?, ?, ?, ?)',
    operationId,
    input.kind,
    input.selectedTransitionId,
    input.base?.revisionId ?? null,
    input.floor?.publicationId ?? null,
    input.base ? operationId : null,
    input.floor ? operationId : null
  );
  if (input.base)
    tx.run(
      'INSERT INTO pending_review_base_records VALUES (?, ?, ?)',
      operationId,
      Buffer.from(input.base.bytesHex, 'hex'),
      input.base.sha256
    );
  if (input.floor) {
    const { basis } = input.floor;
    tx.run(
      'INSERT INTO pending_review_floor_inputs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      operationId,
      basis.baseSha,
      basis.pinnedTreeSha,
      basis.worktreeHead,
      basis.defaultBranch,
      basis.fingerprintMaxDiffBytes,
      basis.reviewMaxDiffBytes,
      input.floor.observedWriteSequence,
      'floor.json',
      'diff.patch'
    );
    basis.reviewIncludedUntracked.forEach((path, ordinal) =>
      tx.run(
        'INSERT INTO pending_review_untracked_paths VALUES (?, ?, ?)',
        operationId,
        ordinal,
        path
      )
    );
    for (const member of input.floor.members)
      tx.run(
        'INSERT INTO pending_review_evidence_members VALUES (?, ?, ?, ?, ?, ?, ?)',
        operationId,
        member.name,
        member.kind,
        member.schemaVersion,
        member.relativePath,
        member.sha256,
        member.byteLength
      );
  }
}

export function requirePendingReviewRows(
  view: ProjectReadView,
  input: ReviewRetentionPreparation
): void {
  const operationId = input.retention.operationId;
  const rows = readPendingReviewRows(view, operationId);
  if (!rows.request) {
    if (rows.base || rows.floor || rows.paths.length || rows.members.length) retentionIntegrity();
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'Original review admission input is missing; preserve publications and repair its retained history explicitly'
    );
  }
  const request: RequestRow = {
    kind: input.kind,
    selectedTransitionId: input.selectedTransitionId,
    baseRevisionId: input.base?.revisionId ?? null,
    floorPublicationId: input.floor?.publicationId ?? null,
    baseRecordId: input.base ? operationId : null,
    floorInputId: input.floor ? operationId : null,
  };
  const floor: FloorRow | null = input.floor
    ? {
        baseSha: input.floor.basis.baseSha,
        pinnedTreeSha: input.floor.basis.pinnedTreeSha,
        worktreeHead: input.floor.basis.worktreeHead,
        defaultBranch: input.floor.basis.defaultBranch,
        fingerprintMaxDiffBytes: input.floor.basis.fingerprintMaxDiffBytes,
        reviewMaxDiffBytes: input.floor.basis.reviewMaxDiffBytes,
        observedWriteSequence: input.floor.observedWriteSequence,
        floorMemberName: 'floor.json',
        diffMemberName: 'diff.patch',
      }
    : null;
  const paths =
    input.floor?.basis.reviewIncludedUntracked.map((path, ordinal) => ({ path, ordinal })) ?? [];
  if (
    canonicalJson(rows.request) !== canonicalJson(request) ||
    canonicalJson(rows.floor) !== canonicalJson(floor) ||
    canonicalJson(rows.paths) !== canonicalJson(paths) ||
    canonicalJson(rows.members) !== canonicalJson(input.floor?.members ?? []) ||
    (rows.base === null) !== (input.base === null) ||
    rows.base?.bytesHex !== input.base?.bytesHex ||
    rows.base?.sha256 !== input.base?.sha256
  )
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'Pending review input differs from its original admission; restore and compare the original operation without changing its identity'
    );
}
