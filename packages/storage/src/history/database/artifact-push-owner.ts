import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { canonicalJson } from '../../events/canonical-json.js';
import { UuidV7Schema } from '../../ids/uuidv7.js';
import { digest, DigestSchema } from '../event-integrity.js';
import {
  ARTIFACT_PUSH_METHODS,
  type ArtifactPushPreparation,
  decodeRetainedArtifactPush,
  type ProjectArtifactPushInput,
} from './artifact-push-input.js';
import type { ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  decodeSessionRevision,
  materializeSessionCurrent,
  materializeSessionRevision,
} from './session-branch-records.js';

const positive = z.number().int().positive().safe(),
  count = z.number().int().nonnegative().safe(),
  text = z.string().min(1);
const revisionSchema = z.strictObject({
  generation: positive,
  orderedHash: DigestSchema,
  eventCount: positive,
  byteLength: positive,
  tailEventId: UuidV7Schema,
  operationId: UuidV7Schema.nullable(),
});
const headerSchema = z.strictObject({
  push_id: UuidV7Schema,
  admission_operation_id: UuidV7Schema,
  terminal_operation_id: UuidV7Schema,
  artifact_id: UuidV7Schema,
  server_url: text,
  org_id: text,
  account_id: text,
  artifact_generation: positive,
  usage_generation: positive.nullable(),
  previous_push_id: UuidV7Schema.nullable(),
  previous_push_version: positive.nullable(),
  expected_cloud_revision_id: UuidV7Schema.nullable(),
  expected_cloud_version: positive.nullable(),
  session_repo_url: text.nullable(),
  session_working_dir: text.nullable(),
  session_revision_id: UuidV7Schema.nullable(),
  session_version: positive.nullable(),
  session_acknowledgement_id: UuidV7Schema.nullable(),
  session_result_revision_id: UuidV7Schema.nullable(),
  cloud_acknowledgement_id: UuidV7Schema,
  prepared_at: text,
  result_checkpoints: count,
  result_summary: z.union([z.literal(0), z.literal(1)]),
  result_evaluators: count,
  result_source_plan_pinned: z.enum(['A', 'B']).nullable(),
  request_sha256: DigestSchema,
  call_count: positive,
  artifact_payload_hash: DigestSchema,
});
const receiptSchema = z.strictObject({
  operation_id: UuidV7Schema,
  operation_kind: text,
  intent_change: z.number(),
  target_json: text,
  payload_json: text,
  payload_hash: DigestSchema,
  expected_state_json: text,
  result_json: text,
  committed_write_sequence: positive,
  committed_intent_counter: count,
});
const callSchema = z.strictObject({
  requestId: UuidV7Schema,
  operationId: UuidV7Schema,
  owner: z.literal('artifact_push'),
  pushId: UuidV7Schema,
  ordinal: positive,
  server: text,
  org: text,
  account: text,
  artifactId: UuidV7Schema,
  artifactScope: text,
  method: z.enum(ARTIFACT_PUSH_METHODS),
  targetExternalId: text,
  idempotencyKey: UuidV7Schema,
  payloadHex: z.string(),
  payloadSha256: DigestSchema,
  requestKey: text,
  preparedAt: text,
});
export type ArtifactPushHeader = z.infer<typeof headerSchema>;
export function pushIntegrity(cause?: unknown): never {
  throw new ProjectDatabaseError(
    'HISTORY_INTEGRITY_REQUIRED',
    'Original grouped push header, call membership, source revision or receipt is missing or inconsistent; preserve it for explicit repair',
    { cause }
  );
}
function originalRevision(
  view: ProjectReadView,
  kind: 'artifact' | 'usage',
  generation: number,
  artifactId: string
) {
  const columns =
    'r.generation,r.ordered_hash AS orderedHash,r.event_count AS eventCount,r.byte_length AS byteLength,r.tail_event_id AS tailEventId,o.operation_id AS operationId';
  return kind === 'artifact'
    ? view.get(
        `SELECT ${columns} FROM artifact_revisions r LEFT JOIN operations o ON o.operation_id=r.operation_id WHERE r.artifact_id=? AND r.generation=?`,
        artifactId,
        generation
      )
    : view.get(
        `SELECT ${columns} FROM usage_revisions r LEFT JOIN operations o ON o.operation_id=r.operation_id WHERE r.generation=?`,
        generation
      );
}
export interface RetainedArtifactPushOwner {
  header: ArtifactPushHeader;
  receipt: unknown;
  calls: z.infer<typeof callSchema>[];
  session: ReturnType<typeof materializeSessionRevision> | null;
  sessionCurrent: ReturnType<typeof materializeSessionCurrent>;
  artifact: ReturnType<typeof originalRevision>;
  usage: ReturnType<typeof originalRevision>;
}
export function selectArtifactPushOwner(
  view: ProjectReadView,
  pushId: string
): RetainedArtifactPushOwner | null {
  const header = view.get<ArtifactPushHeader>(
    'SELECT * FROM artifact_push_requests WHERE push_id=?',
    pushId
  );
  if (header === null) {
    if (
      view.get(
        `SELECT 1 FROM artifact_push_current WHERE push_id=? UNION ALL SELECT 1 FROM remote_requests WHERE push_id=?
      UNION ALL SELECT 1 FROM artifact_push_terminals WHERE push_id=? UNION ALL SELECT 1 FROM cloud_sync_records WHERE push_id=?
      UNION ALL SELECT 1 FROM session_branch_acknowledgements WHERE push_id=?
      UNION ALL SELECT 1 FROM operations WHERE operation_kind IN ('artifact.push.begin','artifact.push.complete') AND json_extract(payload_json,'$.pushId')=? LIMIT 1`,
        pushId,
        pushId,
        pushId,
        pushId,
        pushId,
        pushId
      )
    )
      pushIntegrity();
    return null;
  }
  const receipt = view.get(
    'SELECT * FROM operations WHERE operation_id=?',
    header.admission_operation_id
  );
  const calls = view.all<z.infer<typeof callSchema>>(
    `SELECT request_id AS requestId,operation_id AS operationId,owner_kind AS owner,push_id AS pushId,call_ordinal AS ordinal,
    server_url AS server,org_id AS org,account_id AS account,artifact_id AS artifactId,artifact_scope AS artifactScope,method,target_external_id AS targetExternalId,
    idempotency_key AS idempotencyKey,hex(payload_bytes) AS payloadHex,payload_sha256 AS payloadSha256,request_key AS requestKey,prepared_at AS preparedAt
    FROM remote_requests WHERE push_id=? ORDER BY call_ordinal`,
    pushId
  );
  return {
    header,
    receipt,
    calls,
    session:
      header.session_revision_id === null
        ? null
        : materializeSessionRevision(view, header.session_revision_id),
    sessionCurrent:
      header.session_revision_id === null
        ? null
        : materializeSessionCurrent(view, {
            target: {
              server_url: header.server_url,
              org_id: header.org_id,
              account_id: header.account_id,
            },
            repoUrl: header.session_repo_url!,
            workingDir: header.session_working_dir!,
          }),
    artifact: originalRevision(view, 'artifact', header.artifact_generation, header.artifact_id),
    usage:
      header.usage_generation === null
        ? null
        : originalRevision(view, 'usage', header.usage_generation, header.artifact_id),
  };
}
export function artifactPushOperation(prepared: ArtifactPushPreparation) {
  return {
    operationId: prepared.operationId,
    kind: 'artifact.push.begin',
    intentChange: false,
    target: { artifactId: prepared.artifactId, target: prepared.target },
    payload: { pushId: prepared.pushId, requestSha256: prepared.requestSha256 },
    expectedState: {},
  };
}
export function artifactPushAdmissionResult(prepared: ArtifactPushPreparation) {
  return {
    pushId: prepared.pushId,
    terminalOperationId: prepared.terminalOperationId,
    selection: {
      pushId: prepared.pushId,
      version: (prepared.expectedPushSelection?.version ?? 0) + 1,
    },
    requestIds: prepared.calls.map((call) => call.requestId),
  };
}
function source(value: unknown) {
  const decoded = revisionSchema.parse(value);
  if (decoded.operationId === null) pushIntegrity();
  const { operationId: _, ...revision } = decoded;
  return revision;
}
export function decodeArtifactPushOwner(
  raw: NonNullable<ReturnType<typeof selectArtifactPushOwner>>
) {
  try {
    const header = headerSchema.parse(raw.header),
      receipt = receiptSchema.parse(raw.receipt),
      calls = raw.calls.map((call) => callSchema.parse(call));
    if (
      header.call_count !== calls.length ||
      header.call_count < 2 ||
      header.admission_operation_id === header.terminal_operation_id ||
      (header.previous_push_id === null) !== (header.previous_push_version === null) ||
      (header.expected_cloud_revision_id === null) !== (header.expected_cloud_version === null)
    )
      pushIntegrity();
    const sessionFields = [
      header.session_repo_url,
      header.session_working_dir,
      header.session_revision_id,
      header.session_version,
      header.session_acknowledgement_id,
      header.session_result_revision_id,
    ];
    if (
      !sessionFields.every((value) => value === null) &&
      !sessionFields.every((value) => value !== null)
    )
      pushIntegrity();
    const target = {
      server_url: header.server_url,
      org_id: header.org_id,
      account_id: header.account_id,
    };
    const artifactRevision = source(raw.artifact),
      usageRevision = header.usage_generation === null ? null : source(raw.usage);
    if (
      artifactRevision.generation !== header.artifact_generation ||
      usageRevision?.generation !== (header.usage_generation ?? undefined)
    )
      pushIntegrity();
    calls.forEach((call, index) => {
      if (
        call.operationId !== header.admission_operation_id ||
        call.pushId !== header.push_id ||
        call.ordinal !== index + 1 ||
        call.server !== header.server_url ||
        call.org !== header.org_id ||
        call.account !== header.account_id ||
        call.artifactId !== header.artifact_id ||
        call.artifactScope !== header.artifact_id ||
        call.idempotencyKey !== header.push_id ||
        call.preparedAt !== header.prepared_at
      )
        pushIntegrity();
    });
    const input: ProjectArtifactPushInput = {
      pushId: header.push_id,
      operationId: header.admission_operation_id,
      terminalOperationId: header.terminal_operation_id,
      artifactId: header.artifact_id,
      target,
      artifactRevision,
      usageRevision,
      artifactPayloadHash: header.artifact_payload_hash,
      expectedPushSelection:
        header.previous_push_id === null
          ? null
          : { pushId: header.previous_push_id, version: header.previous_push_version! },
      expectedCloudSelection:
        header.expected_cloud_revision_id === null
          ? null
          : {
              revisionId: header.expected_cloud_revision_id,
              version: header.expected_cloud_version!,
            },
      session:
        header.session_revision_id === null
          ? null
          : {
              key: {
                target,
                repoUrl: header.session_repo_url!,
                workingDir: header.session_working_dir!,
              },
              expectedSelection: {
                revisionId: header.session_revision_id,
                version: header.session_version!,
              },
              acknowledgementId: header.session_acknowledgement_id!,
              resultRevisionId: header.session_result_revision_id!,
            },
      cloudAcknowledgementId: header.cloud_acknowledgement_id,
      preparedAt: header.prepared_at,
      result: {
        checkpoints: header.result_checkpoints,
        summary: header.result_summary === 1,
        evaluators: header.result_evaluators,
        sourcePlanPinned: header.result_source_plan_pinned,
      },
      calls: calls.map((call) => ({
        requestId: call.requestId,
        method: call.method,
        targetExternalId: call.targetExternalId,
        payloadBytes: Buffer.from(call.payloadHex, 'hex'),
      })),
    };
    if (input.session !== null) {
      if (raw.session === null || raw.sessionCurrent === null) pushIntegrity();
      const original = decodeSessionRevision(raw.session),
        current = decodeSessionRevision(raw.sessionCurrent.materialized);
      if (
        !isDeepStrictEqual(original.key, input.session.key) ||
        !isDeepStrictEqual(original.selection, input.session.expectedSelection) ||
        !isDeepStrictEqual(current.key, input.session.key) ||
        !isDeepStrictEqual(current.selection, raw.sessionCurrent.selection)
      )
        pushIntegrity();
    } else if (raw.session !== null || raw.sessionCurrent !== null) pushIntegrity();
    const prepared = decodeRetainedArtifactPush(input, {
      requestSha256: header.request_sha256,
      calls: calls.map((call) => ({
        requestId: call.requestId,
        ordinal: call.ordinal,
        payloadSha256: call.payloadSha256,
        requestKey: call.requestKey,
      })),
    });
    const operation = artifactPushOperation(prepared),
      result = artifactPushAdmissionResult(prepared);
    if (
      receipt.operation_id !== operation.operationId ||
      receipt.operation_kind !== operation.kind ||
      receipt.intent_change !== 0 ||
      receipt.payload_hash !== digest(receipt.payload_json) ||
      !isDeepStrictEqual(JSON.parse(receipt.target_json), operation.target) ||
      !isDeepStrictEqual(JSON.parse(receipt.payload_json), operation.payload) ||
      !isDeepStrictEqual(JSON.parse(receipt.expected_state_json), {}) ||
      !isDeepStrictEqual(JSON.parse(receipt.result_json), result)
    )
      pushIntegrity();
    return { input, prepared, result, receipt };
  } catch (cause) {
    return pushIntegrity(cause);
  }
}
// A scope with no current selection may still hold traces from any push
// family after partial loss; every one of them proves history, never absence.
export function assertPushScopeUntouched(
  view: ProjectReadView,
  artifactId: string,
  target: ProjectArtifactPushInput['target']
) {
  const scope = [artifactId, target.server_url, target.org_id, target.account_id];
  if (
    view.get(
      `SELECT 1 FROM artifact_push_requests WHERE artifact_id=? AND server_url=? AND org_id=? AND account_id=?
      UNION ALL SELECT 1 FROM remote_requests WHERE owner_kind='artifact_push' AND artifact_id=? AND server_url=? AND org_id=? AND account_id=?
      UNION ALL SELECT 1 FROM cloud_sync_records WHERE push_id IS NOT NULL AND artifact_id=? AND server_url=? AND org_id=? AND account_id=?
      UNION ALL SELECT 1 FROM operations WHERE operation_kind IN ('artifact.push.begin','artifact.push.complete')
        AND json_extract(target_json,'$.artifactId')=? AND json_extract(target_json,'$.target.server_url')=?
        AND json_extract(target_json,'$.target.org_id')=? AND json_extract(target_json,'$.target.account_id')=? LIMIT 1`,
      ...scope,
      ...scope,
      ...scope,
      ...scope
    )
  )
    pushIntegrity();
}
export function selectArtifactPushCurrent(
  view: ProjectReadView,
  artifactId: string,
  target: ProjectArtifactPushInput['target']
) {
  const scope = [artifactId, target.server_url, target.org_id, target.account_id];
  const selected = view.get<{ pushId: string; version: number }>(
    'SELECT push_id AS pushId,version FROM artifact_push_current WHERE artifact_id=? AND server_url=? AND org_id=? AND account_id=?',
    ...scope
  );
  if (
    view.get(
      `SELECT 1 FROM operations o WHERE o.operation_kind='artifact.push.begin' AND json_extract(o.target_json,'$.artifactId')=?
      AND json_extract(o.target_json,'$.target.server_url')=? AND json_extract(o.target_json,'$.target.org_id')=? AND json_extract(o.target_json,'$.target.account_id')=?
      AND NOT EXISTS(SELECT 1 FROM artifact_push_requests p WHERE p.admission_operation_id=o.operation_id) LIMIT 1`,
      ...scope
    )
  )
    pushIntegrity();
  if (!selected) {
    assertPushScopeUntouched(view, artifactId, target);
    return null;
  }
  const raw = selectArtifactPushOwner(view, selected.pushId);
  if (
    !raw ||
    !Number.isSafeInteger(selected.version) ||
    selected.version < 1 ||
    raw.header.artifact_id !== artifactId ||
    raw.header.server_url !== target.server_url ||
    raw.header.org_id !== target.org_id ||
    raw.header.account_id !== target.account_id ||
    (raw.header.previous_push_version ?? 0) + 1 !== selected.version
  )
    pushIntegrity();
  const terminal = view.get<{ operationId: string }>(
    'SELECT operation_id AS operationId FROM artifact_push_terminals WHERE push_id=?',
    selected.pushId
  );
  return { selection: selected, raw, terminalOperationId: terminal?.operationId ?? null };
}
export function assertArtifactPushRequestOwner(
  view: ProjectReadView,
  requestId: string,
  pushId: string,
  operationId: string
) {
  try {
    const header = headerSchema.parse(
      view.get('SELECT * FROM artifact_push_requests WHERE push_id=?', pushId)
    );
    if (
      header.session_revision_id !== null &&
      !view.get(
        `SELECT 1 FROM session_branch_revisions r JOIN operations o ON o.operation_id=r.publication_operation_id
       WHERE r.revision_id=? AND r.target_server_url=? AND r.target_org_id=? AND r.target_account_id=? AND r.repo_url=? AND r.working_dir=?`,
        header.session_revision_id,
        header.server_url,
        header.org_id,
        header.account_id,
        header.session_repo_url,
        header.session_working_dir
      )
    )
      pushIntegrity();
    const receipt = receiptSchema.parse(
      view.get('SELECT * FROM operations WHERE operation_id=?', header.admission_operation_id)
    );
    const calls = view.all<{
      requestId: string;
      ordinal: number;
      operationId: string;
      owner: string;
      server: string;
      org: string;
      account: string;
      artifactId: string;
      artifactScope: string;
      idempotencyKey: string;
      preparedAt: string;
    }>(
      `
      SELECT request_id AS requestId,call_ordinal AS ordinal,operation_id AS operationId,owner_kind AS owner,server_url AS server,org_id AS org,account_id AS account,
        artifact_id AS artifactId,artifact_scope AS artifactScope,idempotency_key AS idempotencyKey,prepared_at AS preparedAt FROM remote_requests WHERE push_id=? ORDER BY call_ordinal`,
      pushId
    );
    if (
      header.admission_operation_id !== operationId ||
      header.call_count !== calls.length ||
      header.call_count < 2 ||
      !calls.some((call) => call.requestId === requestId)
    )
      pushIntegrity();
    calls.forEach((call, index) => {
      if (
        call.ordinal !== index + 1 ||
        call.operationId !== operationId ||
        call.owner !== 'artifact_push' ||
        call.server !== header.server_url ||
        call.org !== header.org_id ||
        call.account !== header.account_id ||
        call.artifactId !== header.artifact_id ||
        call.artifactScope !== header.artifact_id ||
        call.idempotencyKey !== header.push_id ||
        call.preparedAt !== header.prepared_at
      )
        pushIntegrity();
    });
    const target = {
      artifactId: header.artifact_id,
      target: {
        server_url: header.server_url,
        org_id: header.org_id,
        account_id: header.account_id,
      },
    };
    const payload = { pushId: header.push_id, requestSha256: header.request_sha256 };
    const result = {
      pushId: header.push_id,
      terminalOperationId: header.terminal_operation_id,
      selection: { pushId: header.push_id, version: (header.previous_push_version ?? 0) + 1 },
      requestIds: calls.map((call) => call.requestId),
    };
    if (
      receipt.operation_id !== operationId ||
      receipt.operation_kind !== 'artifact.push.begin' ||
      receipt.intent_change !== 0 ||
      receipt.payload_hash !== digest(receipt.payload_json) ||
      receipt.target_json !== canonicalJson(target) ||
      receipt.payload_json !== canonicalJson(payload) ||
      receipt.expected_state_json !== '{}' ||
      receipt.result_json !== canonicalJson(result)
    )
      pushIntegrity();
  } catch (cause) {
    return pushIntegrity(cause);
  }
}
