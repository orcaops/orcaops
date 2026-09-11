import { assertArtifactPushRequestOwner } from './artifact-push-owner.js';
import type { ProjectDatabase, ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  prepareProjectRemoteAttempt,
  prepareProjectRemoteOutcome,
  prepareProjectRemoteRequest,
  type ProjectRemoteAttemptInput,
  type ProjectRemoteOutcomeInput,
  type ProjectRemoteRequestInput,
  remoteAttemptPreparation,
  remoteOutcomePreparation,
  type RemoteOutcomePreparation,
  remoteRequestPreparation,
  type RemoteTransportOptions,
  type RemoteTransportScope,
  type RemoteTransportSelection,
} from './remote-transport-input.js';
import {
  type ProjectOperationOptions,
  type ProjectSettlement,
  runProjectOperation,
} from './transactions.js';
import { canonicalJson } from '../../events/canonical-json.js';
import { isUuidV7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';

export interface ProjectRemotePublication {
  selection: RemoteTransportSelection;
}
function integrity(message: string): never {
  throw new ProjectDatabaseError(
    'HISTORY_INTEGRITY_REQUIRED',
    `${message}; preserve original transport history for explicit repair`
  );
}
function stale(message = 'The original remote selection changed'): never {
  throw new ProjectDatabaseError(
    'STALE_CONTEXT',
    `${message}. Preserve the original request and inspect the owning command's status or view. Inspection cannot prove remote absence; report unresolved delivery rather than resending it`
  );
}
function conflict(): never {
  throw new ProjectDatabaseError(
    'IDENTITY_CONFLICT',
    'This remote identity already has an original publication; retry its original operation ID and exact input'
  );
}
function assertRemoteOperationIdentity(view: ProjectReadView, operationId: string) {
  if (
    view.get(
      'SELECT original_operation_id FROM git_retention_operations WHERE original_operation_id=?',
      operationId
    )
  )
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'This operation ID belongs to an admitted Git publication; preserve its original identity and use a distinct remote operation ID'
    );
  // The standalone-owner trigger already refuses this, but only as a constraint failure;
  // a taken identity is an idempotency conflict, not a transaction to repair and retry.
  if (
    view.get(
      `SELECT push_id FROM artifact_push_requests WHERE admission_operation_id=?
      UNION ALL SELECT push_id FROM artifact_push_requests WHERE terminal_operation_id=? LIMIT 1`,
      operationId,
      operationId
    )
  )
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'This operation ID belongs to an admitted artifact push; preserve its original identity and use a distinct remote operation ID'
    );
}
function slot(scope: RemoteTransportScope) {
  return [
    scope.target.server_url,
    scope.target.org_id,
    scope.target.account_id,
    scope.artifactId ?? '',
    scope.method,
    scope.targetExternalId,
    scope.idempotencyKey,
  ];
}
const slotWhere = `server_url=? AND org_id=? AND account_id=? AND artifact_scope=?
  AND method=? AND target_external_id=? AND idempotency_key=?`;
interface CurrentRow extends RemoteTransportSelection {
  retainedRequest: string | null;
  requestOwner: string | null;
  requestPushId: string | null;
  requestOperationId: string | null;
  requestOperation: string | null;
  retainedAttempt: string | null;
  attemptOperation: string | null;
  latestOutcome: string | null;
  outcomeOperation: string | null;
  outcomeKind: 'ack_unknown' | 'acknowledged' | null;
  outcomeAttempt: string | null;
  outcomeOrdinal: number | null;
}
export function readRemoteSelection(view: ProjectReadView, scope: RemoteTransportScope) {
  const current = view.get<CurrentRow>(
    `SELECT c.request_id AS requestId,c.attempt_id AS attemptId,c.outcome_id AS outcomeId,c.version,
      r.request_id AS retainedRequest,r.owner_kind AS requestOwner,r.push_id AS requestPushId,r.operation_id AS requestOperationId,ro.operation_kind AS requestOperation,
      a.attempt_id AS retainedAttempt,ao.operation_kind AS attemptOperation,
      o.outcome_id AS latestOutcome,oo.operation_kind AS outcomeOperation,o.kind AS outcomeKind,
      o.attempt_id AS outcomeAttempt,o.outcome_n AS outcomeOrdinal
    FROM remote_current c
    LEFT JOIN remote_requests r ON r.request_id=c.request_id
      AND r.server_url=c.server_url AND r.org_id=c.org_id AND r.account_id=c.account_id
      AND r.artifact_scope=c.artifact_scope AND r.method=c.method
      AND r.target_external_id=c.target_external_id AND r.idempotency_key=c.idempotency_key
    LEFT JOIN operations ro ON ro.operation_id=r.operation_id
    LEFT JOIN remote_attempts a ON a.request_id=c.request_id
    LEFT JOIN operations ao ON ao.operation_id=a.operation_id
    LEFT JOIN remote_outcomes o ON o.request_id=c.request_id
      AND o.outcome_n=(SELECT max(outcome_n) FROM remote_outcomes WHERE request_id=c.request_id)
    LEFT JOIN operations oo ON oo.operation_id=o.operation_id
    WHERE ${slotWhere.replace(/\b(server_url|org_id|account_id|artifact_scope|method|target_external_id|idempotency_key)\b/g, 'c.$1')}`,
    ...slot(scope)
  );
  if (!current) {
    if (
      view.get(`SELECT request_id FROM remote_requests WHERE ${slotWhere} LIMIT 1`, ...slot(scope))
    )
      integrity('Remote requests exist without their original current selection');
    return null;
  }
  if (
    !isUuidV7(current.requestId) ||
    !Number.isSafeInteger(current.version) ||
    current.version < 1 ||
    current.retainedRequest !== current.requestId ||
    !['standalone', 'artifact_push'].includes(current.requestOwner ?? '') ||
    (current.requestOwner === 'standalone' &&
      (current.requestOperation !== 'remote.request' || current.requestPushId !== null)) ||
    (current.requestOwner === 'artifact_push' &&
      (current.requestOperation !== 'artifact.push.begin' ||
        current.requestPushId === null ||
        current.requestOperationId === null)) ||
    current.retainedAttempt !== current.attemptId ||
    (current.attemptId !== null &&
      (!isUuidV7(current.attemptId) || current.attemptOperation !== 'remote.attempt')) ||
    current.latestOutcome !== current.outcomeId ||
    (current.outcomeId !== null &&
      (!isUuidV7(current.outcomeId) ||
        current.outcomeOperation !== 'remote.outcome' ||
        current.outcomeAttempt !== current.attemptId ||
        !Number.isSafeInteger(current.outcomeOrdinal) ||
        current.outcomeOrdinal! < 1))
  )
    integrity(
      'The selected remote request, attempt, outcome or original receipt is missing or inconsistent'
    );
  if (current.requestOwner === 'artifact_push')
    assertArtifactPushRequestOwner(
      view,
      current.requestId,
      current.requestPushId!,
      current.requestOperationId!
    );
  return current;
}
function selection(row: RemoteTransportSelection): RemoteTransportSelection {
  return {
    requestId: row.requestId,
    attemptId: row.attemptId,
    outcomeId: row.outcomeId,
    version: row.version,
  };
}
function expectedSelection(
  view: ProjectReadView,
  scope: RemoteTransportScope,
  expected: RemoteTransportSelection | null
) {
  const current = readRemoteSelection(view, scope);
  if (canonicalJson(current === null ? null : selection(current)) !== canonicalJson(expected))
    stale();
  return current;
}
function publishSelection(
  transaction: ProjectSettlement,
  scope: RemoteTransportScope,
  next: RemoteTransportSelection,
  previous: RemoteTransportSelection | null
) {
  if (previous === null) {
    transaction.run(
      `INSERT INTO remote_current (server_url,org_id,account_id,artifact_scope,method,target_external_id,idempotency_key,request_id,attempt_id,outcome_id,version) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ...slot(scope),
      next.requestId,
      next.attemptId,
      next.outcomeId,
      next.version
    );
  } else {
    const changed = transaction.run(
      `UPDATE remote_current SET request_id=?,attempt_id=?,outcome_id=?,version=? WHERE ${slotWhere} AND version=?`,
      next.requestId,
      next.attemptId,
      next.outcomeId,
      next.version,
      ...slot(scope),
      previous.version
    );
    if (changed.changes !== 1) stale();
  }
}
function nextVersion(previous: RemoteTransportSelection | null) {
  const version = (previous?.version ?? 0) + 1;
  if (!Number.isSafeInteger(version)) integrity('The remote selection version cannot advance');
  return version;
}
export async function retainProjectRemoteRequest(
  handle: ProjectDatabase,
  input: ProjectRemoteRequestInput,
  refusal: RemoteTransportOptions,
  options: ProjectOperationOptions = {}
) {
  const prepared = remoteRequestPreparation(prepareProjectRemoteRequest(input, refusal));
  const operationOptions = { signal: options.signal, onWait: options.onWait };
  return runProjectOperation(
    handle,
    {
      operationId: prepared.operationId,
      kind: 'remote.request',
      target: { ...prepared.scope, target: { ...prepared.scope.target } },
      payload: {
        requestId: prepared.requestId,
        preparedAt: prepared.preparedAt,
        payloadSha256: prepared.payloadSha256,
      },
      expectedState: prepared.expectedSelection === null ? null : { ...prepared.expectedSelection },
      intentChange: false,
    },
    (transaction) => {
      assertRemoteOperationIdentity(transaction, prepared.operationId);
      const current = expectedSelection(transaction, prepared.scope, prepared.expectedSelection);
      if (current !== null && current.outcomeKind !== 'acknowledged')
        stale('The previous remote request still lacks a retained acknowledgement');
      if (
        transaction.get(
          'SELECT request_id FROM remote_requests WHERE request_id=?',
          prepared.requestId
        ) ||
        transaction.get(
          `SELECT request_id FROM remote_requests WHERE ${slotWhere} AND request_key=?`,
          ...slot(prepared.scope),
          prepared.requestKey
        )
      )
        conflict();
      transaction.run(
        `INSERT INTO remote_requests (request_id,operation_id,server_url,org_id,account_id,artifact_id,artifact_scope,method,target_external_id,idempotency_key,payload_bytes,payload_sha256,request_key,prepared_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        prepared.requestId,
        prepared.operationId,
        ...slot(prepared.scope).slice(0, 3),
        prepared.scope.artifactId,
        ...slot(prepared.scope).slice(3),
        Buffer.from(prepared.payloadBase64, 'base64'),
        prepared.payloadSha256,
        prepared.requestKey,
        prepared.preparedAt
      );
      const next = {
        requestId: prepared.requestId,
        attemptId: null,
        outcomeId: null,
        version: nextVersion(current),
      };
      publishSelection(transaction, prepared.scope, next, current);
      return { selection: next };
    },
    operationOptions
  );
}
export async function admitProjectRemoteAttempt(
  handle: ProjectDatabase,
  input: ProjectRemoteAttemptInput,
  refusal: RemoteTransportOptions,
  options: ProjectOperationOptions = {}
) {
  const prepared = remoteAttemptPreparation(prepareProjectRemoteAttempt(input, refusal));
  const operationOptions = { signal: options.signal, onWait: options.onWait };
  const result = await runProjectOperation(
    handle,
    {
      operationId: prepared.operationId,
      kind: 'remote.attempt',
      target: { ...prepared.scope, target: { ...prepared.scope.target } },
      payload: {
        requestId: prepared.requestId,
        attemptId: prepared.attemptId,
        attemptedAt: prepared.attemptedAt,
      },
      expectedState: { ...prepared.expectedSelection },
      intentChange: false,
    },
    (transaction) => {
      assertRemoteOperationIdentity(transaction, prepared.operationId);
      const current = expectedSelection(transaction, prepared.scope, prepared.expectedSelection);
      if (current === null || current.attemptId !== null || current.outcomeId !== null)
        stale('The remote request has already been admitted');
      if (
        transaction.get(
          'SELECT attempt_id FROM remote_attempts WHERE attempt_id=?',
          prepared.attemptId
        )
      )
        conflict();
      transaction.run(
        'INSERT INTO remote_attempts (attempt_id,request_id,operation_id,attempted_at) VALUES (?,?,?,?)',
        prepared.attemptId,
        prepared.requestId,
        prepared.operationId,
        prepared.attemptedAt
      );
      const next = {
        requestId: prepared.requestId,
        attemptId: prepared.attemptId,
        outcomeId: null,
        version: nextVersion(current),
      };
      publishSelection(transaction, prepared.scope, next, current);
      return { selection: next };
    },
    operationOptions
  );
  return { ...result, sendAllowed: !result.replayed && !operationOptions.signal?.aborted };
}

export function remoteOutcomeReceipt(value: RemoteOutcomePreparation) {
  return {
    requestId: value.requestId,
    attemptId: value.attemptId,
    outcomeId: value.outcomeId,
    observedAt: value.observedAt,
    outcomeSha256: digest(
      canonicalJson({
        kind: value.kind,
        responseSha256: value.responseSha256,
        failure: value.failure,
      })
    ),
  };
}
export async function recordProjectRemoteOutcome(
  handle: ProjectDatabase,
  input: ProjectRemoteOutcomeInput,
  refusal: RemoteTransportOptions,
  options: ProjectOperationOptions = {}
) {
  const prepared = remoteOutcomePreparation(prepareProjectRemoteOutcome(input, refusal));
  const operationOptions = { signal: options.signal, onWait: options.onWait };
  return runProjectOperation(
    handle,
    {
      operationId: prepared.operationId,
      kind: 'remote.outcome',
      target: { ...prepared.scope, target: { ...prepared.scope.target } },
      payload: remoteOutcomeReceipt(prepared),
      expectedState: { ...prepared.expectedSelection },
      intentChange: false,
    },
    (transaction) => {
      assertRemoteOperationIdentity(transaction, prepared.operationId);
      const current = expectedSelection(transaction, prepared.scope, prepared.expectedSelection);
      if (
        current === null ||
        current.attemptId !== prepared.attemptId ||
        current.outcomeKind === 'acknowledged'
      )
        stale('The original remote attempt is no longer awaiting acknowledgment');
      if (
        transaction.get(
          'SELECT outcome_id FROM remote_outcomes WHERE outcome_id=?',
          prepared.outcomeId
        )
      )
        conflict();
      const ordinal = (current.outcomeOrdinal ?? 0) + 1;
      if (!Number.isSafeInteger(ordinal)) integrity('Remote outcome ordering cannot advance');
      transaction.run(
        'INSERT INTO remote_outcomes (outcome_id,request_id,attempt_id,operation_id,outcome_n,kind,observed_at,response_bytes,response_sha256,failure_kind,failure_message) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        prepared.outcomeId,
        prepared.requestId,
        prepared.attemptId,
        prepared.operationId,
        ordinal,
        prepared.kind,
        prepared.observedAt,
        prepared.responseBase64 === null ? null : Buffer.from(prepared.responseBase64, 'base64'),
        prepared.responseSha256,
        prepared.failure?.kind ?? null,
        prepared.failure?.message ?? null
      );
      const next = {
        requestId: prepared.requestId,
        attemptId: prepared.attemptId,
        outcomeId: prepared.outcomeId,
        version: nextVersion(current),
      };
      publishSelection(transaction, prepared.scope, next, current);
      return { selection: next };
    },
    operationOptions
  );
}
