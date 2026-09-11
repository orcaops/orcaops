import { decodeArtifactPushOwner, selectArtifactPushOwner } from './artifact-push-owner.js';
import { canonicalJson } from '../../events/canonical-json.js';
import { isUuidV7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import {
  assertProjectDatabasePath,
  type ProjectDatabase,
  type ProjectReadView,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  decodeRetainedRemoteAttempt,
  decodeRetainedRemoteOutcome,
  decodeRetainedRemoteRequest,
  normalizeRemoteTransportScope,
  type ProjectRemoteOutcomeInput,
  type RemoteTransportScope,
  type RemoteTransportSelection,
} from './remote-transport-input.js';
import { readRemoteSelection, remoteOutcomeReceipt } from './remote-transport.js';

interface Receipt {
  operationId: string;
  operationKind: string | null;
  targetJson: string | null;
  payloadJson: string | null;
  payloadHash: string | null;
  expectedJson: string | null;
}
interface RequestRow extends Receipt {
  requestId: string;
  ownerKind: string;
  pushId: string | null;
  callOrdinal: number | null;
  server: string;
  organization: string;
  account: string;
  artifactId: string | null;
  method: RemoteTransportScope['method'];
  externalId: string;
  idempotencyKey: string;
  payloadHex: string;
  payloadSha256: string;
  requestKey: string;
  preparedAt: string;
}
interface AttemptRow extends Receipt {
  requestId: string;
  attemptId: string;
  attemptedAt: string;
}
interface OutcomeRow extends Receipt {
  requestId: string;
  attemptId: string;
  outcomeId: string;
  ordinal: number;
  kind: 'ack_unknown' | 'acknowledged';
  observedAt: string;
  responseHex: string | null;
  responseSha256: string | null;
  failureKind: 'unknown' | null;
  failureMessage: string | null;
}
const receiptColumns = `o.operation_kind AS operationKind,o.target_json AS targetJson,
  o.payload_json AS payloadJson,o.payload_hash AS payloadHash,o.expected_state_json AS expectedJson`;
function integrity(cause?: unknown): never {
  throw new ProjectDatabaseError(
    'HISTORY_INTEGRITY_REQUIRED',
    'Original remote history or its receipt is missing or inconsistent; preserve it for explicit repair',
    { cause }
  );
}
function scope(row: RequestRow): RemoteTransportScope {
  return {
    target: { server_url: row.server, org_id: row.organization, account_id: row.account },
    artifactId: row.artifactId,
    method: row.method,
    targetExternalId: row.externalId,
    idempotencyKey: row.idempotencyKey,
  };
}
function selected(row: RemoteTransportSelection): RemoteTransportSelection {
  return {
    requestId: row.requestId,
    attemptId: row.attemptId,
    outcomeId: row.outcomeId,
    version: row.version,
  };
}
export function materializeRemoteRequest(
  view: ProjectReadView,
  requestId: string,
  retainedGroup?: NonNullable<ReturnType<typeof selectArtifactPushOwner>>
) {
  const request = view.get<RequestRow>(
    `SELECT r.request_id AS requestId,r.operation_id AS operationId,r.owner_kind AS ownerKind,r.push_id AS pushId,r.call_ordinal AS callOrdinal,
    r.server_url AS server,r.org_id AS organization,r.account_id AS account,r.artifact_id AS artifactId,
    r.method,r.target_external_id AS externalId,r.idempotency_key AS idempotencyKey,
    hex(r.payload_bytes) AS payloadHex,r.payload_sha256 AS payloadSha256,r.request_key AS requestKey,r.prepared_at AS preparedAt,
    ${receiptColumns} FROM remote_requests r LEFT JOIN operations o ON o.operation_id=r.operation_id WHERE r.request_id=?`,
    requestId
  );
  if (request === null) {
    if (
      view.get(
        `SELECT request_id FROM remote_attempts WHERE request_id=? UNION ALL SELECT request_id FROM remote_outcomes WHERE request_id=? UNION ALL SELECT request_id FROM remote_current WHERE request_id=? LIMIT 1`,
        requestId,
        requestId,
        requestId
      )
    )
      integrity();
    return null;
  }
  const attempt = view.get<AttemptRow>(
    `SELECT a.request_id AS requestId,a.attempt_id AS attemptId,a.operation_id AS operationId,a.attempted_at AS attemptedAt,${receiptColumns}
    FROM remote_attempts a LEFT JOIN operations o ON o.operation_id=a.operation_id WHERE a.request_id=?`,
    requestId
  );
  const outcomes = view.all<OutcomeRow>(
    `SELECT r.request_id AS requestId,r.attempt_id AS attemptId,r.outcome_id AS outcomeId,r.operation_id AS operationId,r.outcome_n AS ordinal,r.kind,r.observed_at AS observedAt,
    CASE WHEN r.response_bytes IS NULL THEN NULL ELSE hex(r.response_bytes) END AS responseHex,r.response_sha256 AS responseSha256,r.failure_kind AS failureKind,r.failure_message AS failureMessage,
    ${receiptColumns} FROM remote_outcomes r LEFT JOIN operations o ON o.operation_id=r.operation_id WHERE r.request_id=? ORDER BY r.outcome_n`,
    requestId
  );
  const current = readRemoteSelection(view, scope(request));
  if (current === null || (outcomes.length > 0 && attempt === null)) integrity();
  const groupOwner =
    request.ownerKind === 'artifact_push' && request.pushId !== null
      ? (retainedGroup ?? selectArtifactPushOwner(view, request.pushId))
      : null;
  if (request.ownerKind === 'artifact_push' && groupOwner === null) integrity();
  return { request, attempt, outcomes, current: selected(current), groupOwner };
}
function expected(row: Receipt): RemoteTransportSelection | null {
  if (row.expectedJson === null) integrity();
  return JSON.parse(row.expectedJson) as RemoteTransportSelection | null;
}
function receipt(row: Receipt, kind: string, target: RemoteTransportScope, payload: unknown) {
  if (
    row.operationKind !== kind ||
    row.targetJson !== canonicalJson(target) ||
    row.payloadJson !== canonicalJson(payload) ||
    row.payloadHash !== digest(row.payloadJson)
  )
    integrity();
}
export function hydrateRemoteRequest(
  raw: NonNullable<ReturnType<typeof materializeRemoteRequest>>,
  retainedGroup?: ReturnType<typeof decodeArtifactPushOwner>
) {
  try {
    const row = raw.request;
    const originalScope = scope(row);
    const group =
      raw.groupOwner === null ? null : (retainedGroup ?? decodeArtifactPushOwner(raw.groupOwner));
    if (
      row.ownerKind === 'standalone'
        ? row.pushId !== null || row.callOrdinal !== null || group !== null
        : row.ownerKind !== 'artifact_push' || group === null
    )
      integrity();
    const request = decodeRetainedRemoteRequest(
      {
        operationId: row.operationId,
        requestId: row.requestId,
        expectedSelection: group === null ? expected(row) : null,
        scope: originalScope,
        payloadBytes: Buffer.from(row.payloadHex, 'hex'),
        preparedAt: row.preparedAt,
      },
      row
    );
    if (group === null)
      receipt(row, 'remote.request', request.scope, {
        requestId: request.requestId,
        preparedAt: request.preparedAt,
        payloadSha256: request.payloadSha256,
      });
    else {
      const original = group.prepared.calls.find((call) => call.requestId === request.requestId);
      if (
        !original ||
        row.operationId !== group.prepared.operationId ||
        row.pushId !== group.prepared.pushId ||
        row.callOrdinal !== original.ordinal ||
        original.payloadBase64 !== request.payloadBase64 ||
        original.payloadSha256 !== request.payloadSha256 ||
        original.requestKey !== request.requestKey ||
        original.method !== request.scope.method ||
        original.targetExternalId !== request.scope.targetExternalId ||
        canonicalJson(request.scope.target) !== canonicalJson(group.prepared.target) ||
        request.scope.artifactId !== group.prepared.artifactId ||
        request.scope.idempotencyKey !== group.prepared.pushId ||
        row.operationKind !== group.receipt.operation_kind ||
        row.targetJson !== group.receipt.target_json ||
        row.payloadJson !== group.receipt.payload_json ||
        row.payloadHash !== group.receipt.payload_hash ||
        row.expectedJson !== group.receipt.expected_state_json
      )
        integrity();
    }
    let previous: RemoteTransportSelection = {
      requestId: request.requestId,
      attemptId: null,
      outcomeId: null,
      version: (request.expectedSelection?.version ?? 0) + 1,
    };
    const attempt =
      raw.attempt === null
        ? null
        : decodeRetainedRemoteAttempt({
            operationId: raw.attempt.operationId,
            requestId: raw.attempt.requestId,
            attemptId: raw.attempt.attemptId,
            scope: originalScope,
            expectedSelection: expected(raw.attempt)!,
            attemptedAt: raw.attempt.attemptedAt,
          });
    if (attempt !== null) {
      receipt(raw.attempt!, 'remote.attempt', attempt.scope, {
        requestId: attempt.requestId,
        attemptId: attempt.attemptId,
        attemptedAt: attempt.attemptedAt,
      });
      if (canonicalJson(attempt.expectedSelection) !== canonicalJson(previous)) integrity();
      previous = { ...previous, attemptId: attempt.attemptId, version: previous.version + 1 };
    }
    const outcomes = raw.outcomes.map((outcome, index) => {
      if (
        outcome.ordinal !== index + 1 ||
        outcome.attemptId !== attempt?.attemptId ||
        outcome.requestId !== row.requestId
      )
        integrity();
      const input = {
        operationId: outcome.operationId,
        requestId: outcome.requestId,
        attemptId: outcome.attemptId,
        outcomeId: outcome.outcomeId,
        scope: originalScope,
        expectedSelection: expected(outcome)!,
        observedAt: outcome.observedAt,
      };
      let value: ProjectRemoteOutcomeInput;
      if (outcome.kind === 'acknowledged') {
        if (
          outcome.responseHex === null ||
          outcome.failureKind !== null ||
          outcome.failureMessage !== null ||
          index !== raw.outcomes.length - 1
        )
          integrity();
        value = {
          ...input,
          kind: 'acknowledged',
          responseBytes: Buffer.from(outcome.responseHex, 'hex'),
          failure: null,
        };
      } else {
        if (
          outcome.kind !== 'ack_unknown' ||
          outcome.responseHex !== null ||
          (outcome.failureKind === null) !== (outcome.failureMessage === null)
        )
          integrity();
        value = {
          ...input,
          kind: 'ack_unknown',
          responseBytes: null,
          failure:
            outcome.failureKind === null
              ? null
              : { kind: outcome.failureKind, message: outcome.failureMessage! },
        };
      }
      const decoded = decodeRetainedRemoteOutcome(value, outcome.responseSha256);
      receipt(outcome, 'remote.outcome', decoded.scope, remoteOutcomeReceipt(decoded));
      if (canonicalJson(decoded.expectedSelection) !== canonicalJson(previous)) integrity();
      previous = { ...previous, outcomeId: outcome.outcomeId, version: previous.version + 1 };
      return {
        ...decoded,
        ordinal: outcome.ordinal,
        responseBytes:
          decoded.responseBase64 === null ? null : Buffer.from(decoded.responseBase64, 'base64'),
      };
    });
    if (
      !Number.isSafeInteger(previous.version) ||
      (raw.current.requestId === request.requestId
        ? canonicalJson(raw.current) !== canonicalJson(previous)
        : outcomes.at(-1)?.kind !== 'acknowledged')
    )
      integrity();
    return {
      request: { ...request, payloadBytes: Buffer.from(request.payloadBase64, 'base64') },
      attempt,
      outcomes,
      current: raw.current,
    };
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError && cause.code === 'HISTORY_INTEGRITY_REQUIRED')
      throw cause;
    return integrity(cause);
  }
}
export function readProjectRemoteRequest(handle: ProjectDatabase, requestId: string) {
  if (!isUuidV7(requestId))
    throw new ProjectDatabaseError('INVALID_INPUT', 'Provide the exact original request UUID');
  assertProjectDatabasePath(handle);
  const snapshot = handle.read((view) => materializeRemoteRequest(view, requestId));
  return {
    ...snapshot,
    value: snapshot.value === null ? null : hydrateRemoteRequest(snapshot.value),
  };
}
export function readProjectRemoteCurrent(handle: ProjectDatabase, input: RemoteTransportScope) {
  const normalized = normalizeRemoteTransportScope(input);
  assertProjectDatabasePath(handle);
  const snapshot = handle.read((view) => {
    const current = readRemoteSelection(view, normalized);
    return current === null ? null : materializeRemoteRequest(view, current.requestId);
  });
  return {
    ...snapshot,
    value: snapshot.value === null ? null : hydrateRemoteRequest(snapshot.value),
  };
}
