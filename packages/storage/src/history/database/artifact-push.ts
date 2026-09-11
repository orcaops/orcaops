import { isDeepStrictEqual } from 'node:util';

import {
  prepareProjectArtifactPush,
  projectArtifactPush,
  type ProjectArtifactPushInput,
} from './artifact-push-input.js';
import {
  artifactPushAdmissionResult,
  artifactPushOperation,
  assertPushScopeUntouched,
  pushIntegrity,
  selectArtifactPushOwner,
} from './artifact-push-owner.js';
import { decodeArtifactPush, selectArtifactPush } from './artifact-push-reader.js';
import { copyArtifactRevision } from './artifacts.js';
import { decodeCloudState, selectCloudSources, selectCloudState } from './cloud-sync-records.js';
import {
  assertProjectDatabasePath,
  type ProjectDatabase,
  type ProjectReadView,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { readRemoteSelection } from './remote-transport.js';
import { decodeSessionRevision, materializeSessionCurrent } from './session-branch-records.js';
import { type ProjectOperationOptions, runProjectOperation } from './transactions.js';
import { UuidV7Schema } from '../../ids/uuidv7.js';

export interface ArtifactPushAdmissionOptions extends ProjectOperationOptions {
  readonly secretAllow: readonly string[];
}
function conflict(): never {
  throw new ProjectDatabaseError(
    'IDEMPOTENCY_CONFLICT',
    'This push or original operation identity already owns different retained input; resume the original operation or use explicitly new identities'
  );
}
function stale(message: string): never {
  throw new ProjectDatabaseError(
    'STALE_CONTEXT',
    `${message}; preserve the original request and prepare an explicitly new push only from current history`
  );
}
function copy<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch (cause) {
    throw new ProjectDatabaseError('INVALID_INPUT', 'Provide copyable finite original push input', {
      cause,
    });
  }
}
function originalAdmission(handle: ProjectDatabase, operationId: string) {
  const raw = handle.read((view) => {
    const receipt = view.get<{ kind: string }>(
      'SELECT operation_kind AS kind FROM operations WHERE operation_id=?',
      operationId
    );
    const owner = view.get<{ pushId: string }>(
      'SELECT push_id AS pushId FROM artifact_push_requests WHERE admission_operation_id=?',
      operationId
    );
    if (!receipt) {
      if (owner) pushIntegrity();
      return null;
    }
    if (receipt.kind !== 'artifact.push.begin') {
      if (owner) pushIntegrity();
      conflict();
    }
    if (!owner) pushIntegrity();
    return selectArtifactPush(view, owner.pushId);
  });
  return raw.value === null ? null : decodeArtifactPush(raw.value);
}
function currentSources(view: ProjectReadView, artifactId: string) {
  const selected = selectCloudSources(view, artifactId);
  if (selected === null) stale('The original artifact source is absent');
  const columns =
    'generation,ordered_hash AS orderedHash,event_count AS eventCount,byte_length AS byteLength,tail_event_id AS tailEventId';
  const artifact = view.get(
    `SELECT ${columns} FROM artifact_revisions WHERE artifact_id=? AND generation=?`,
    artifactId,
    selected.artifactGeneration
  );
  const usage =
    selected.usageGeneration === null
      ? null
      : view.get(
          `SELECT ${columns} FROM usage_revisions WHERE generation=?`,
          selected.usageGeneration
        );
  if (!artifact || (selected.usageGeneration !== null && !usage)) pushIntegrity();
  return {
    artifact: copyArtifactRevision(artifact as Parameters<typeof copyArtifactRevision>[0]),
    usage:
      usage === null
        ? null
        : copyArtifactRevision(usage as Parameters<typeof copyArtifactRevision>[0]),
  };
}
function scopeState(view: ProjectReadView, input: ProjectArtifactPushInput) {
  const current = view.get<{ pushId: string; version: number }>(
    'SELECT push_id AS pushId,version FROM artifact_push_current WHERE artifact_id=? AND server_url=? AND org_id=? AND account_id=?',
    input.artifactId,
    input.target.server_url,
    input.target.org_id,
    input.target.account_id
  );
  if (current === null) assertPushScopeUntouched(view, input.artifactId, input.target);
  return {
    sources: currentSources(view, input.artifactId),
    current: current === null ? null : selectArtifactPush(view, current.pushId),
    cloud: selectCloudState(view, { artifactId: input.artifactId, target: input.target }),
    session: input.session === null ? null : materializeSessionCurrent(view, input.session.key),
  };
}
function assertOriginalIdentities(view: ProjectReadView, input: ProjectArtifactPushInput) {
  const ids = [input.operationId, input.terminalOperationId];
  if (
    view.get(
      `SELECT 1 FROM operations WHERE operation_id IN (?,?)
    UNION ALL SELECT 1 FROM git_retention_operations WHERE original_operation_id IN (?,?)
    UNION ALL SELECT 1 FROM artifact_push_requests WHERE admission_operation_id IN (?,?) OR terminal_operation_id IN (?,?)
    UNION ALL SELECT 1 FROM operations WHERE operation_kind='git.retention.cleanup.begin' AND json_extract(payload_json,'$.terminalOperationId') IN (?,?)
    -- One equality term per identity: the partial checkout-focus index serves '=' but not
    -- IN or OR, which fall back to seeking every checkout receipt by kind.
    UNION ALL SELECT 1 FROM operations WHERE operation_kind='execution.checkout' AND json_extract(payload_json,'$.focus.operationId')=?
    UNION ALL SELECT 1 FROM operations WHERE operation_kind='execution.checkout' AND json_extract(payload_json,'$.focus.operationId')=? LIMIT 1`,
      ...ids,
      ...ids,
      ...ids,
      ...ids,
      ...ids,
      ids[0],
      ids[1]
    )
  )
    conflict();
  if (selectArtifactPushOwner(view, input.pushId) !== null) conflict();
  if (
    view.get(
      'SELECT 1 FROM cloud_sync_records WHERE revision_id=? UNION ALL SELECT 1 FROM artifact_push_requests WHERE cloud_acknowledgement_id=? LIMIT 1',
      input.cloudAcknowledgementId,
      input.cloudAcknowledgementId
    )
  )
    conflict();
  if (
    input.session !== null &&
    view.get(
      `SELECT 1 FROM session_branch_revisions WHERE revision_id=? UNION ALL SELECT 1 FROM session_branch_acknowledgements WHERE acknowledgement_id=?
    UNION ALL SELECT 1 FROM artifact_push_requests WHERE session_result_revision_id=? OR session_acknowledgement_id=? LIMIT 1`,
      input.session.resultRevisionId,
      input.session.acknowledgementId,
      input.session.resultRevisionId,
      input.session.acknowledgementId
    )
  )
    conflict();
}
export async function beginProjectArtifactPush(
  handle: ProjectDatabase,
  input: ProjectArtifactPushInput,
  options: ArtifactPushAdmissionOptions
) {
  assertProjectDatabasePath(handle);
  if (!UuidV7Schema.safeParse(input?.operationId).success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the original grouped admission operation UUID'
    );
  const supplied = copy(input),
    original = originalAdmission(handle, supplied.operationId);
  if (original) {
    const comparable = {
      ...supplied,
      calls: supplied.calls.map((call) => ({
        ...call,
        payloadBytes: Buffer.from(call.payloadBytes),
      })),
    };
    if (!isDeepStrictEqual(original.input, comparable)) conflict();
    return runProjectOperation(
      handle,
      artifactPushOperation(original.prepared),
      () => pushIntegrity(),
      options
    );
  }
  if (
    !Array.isArray(options?.secretAllow) ||
    !options.secretAllow.every((value) => typeof value === 'string')
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide an explicit grouped push refusal allowlist'
    );
  const prepared = projectArtifactPush(
    prepareProjectArtifactPush(supplied, { secretAllow: [...options.secretAllow] })
  );
  const preflight = handle.read((view) => scopeState(view, supplied));
  const current =
    preflight.value.current === null ? null : decodeArtifactPush(preflight.value.current);
  const cloud = decodeCloudState(preflight.value.cloud);
  const session =
    preflight.value.session === null
      ? null
      : decodeSessionRevision(preflight.value.session.materialized);
  if (
    !isDeepStrictEqual(prepared.artifactRevision, preflight.value.sources.artifact) ||
    !isDeepStrictEqual(prepared.usageRevision, preflight.value.sources.usage)
  )
    stale('The original artifact or project-wide usage source changed');
  if (!isDeepStrictEqual(prepared.expectedPushSelection, current?.currentSelection ?? null))
    stale('The original push selection changed');
  if (current !== null && current.terminal === null)
    stale(`Original push ${current.input.pushId} still requires its own recovery`);
  if (!isDeepStrictEqual(prepared.expectedCloudSelection, cloud.selection))
    stale('The original cloud selection changed');
  if (
    prepared.session !== null &&
    (!session ||
      !isDeepStrictEqual(prepared.session.key, session.key) ||
      !isDeepStrictEqual(prepared.session.expectedSelection, session.selection) ||
      !isDeepStrictEqual(preflight.value.session?.selection, session.selection))
  )
    stale('The original session selection changed');
  const result = artifactPushAdmissionResult(prepared);
  if (!Number.isSafeInteger(result.selection.version)) pushIntegrity();
  return runProjectOperation(
    handle,
    artifactPushOperation(prepared),
    (view) => {
      assertOriginalIdentities(view, supplied);
      const actual = scopeState(view, supplied);
      if (!isDeepStrictEqual(actual, preflight.value))
        stale('The original source or selected state changed before admission');
      const t = prepared.target,
        s = prepared.session;
      const row = {
        push_id: prepared.pushId,
        admission_operation_id: prepared.operationId,
        terminal_operation_id: prepared.terminalOperationId,
        artifact_id: prepared.artifactId,
        server_url: t.server_url,
        org_id: t.org_id,
        account_id: t.account_id,
        artifact_generation: prepared.artifactRevision.generation,
        usage_generation: prepared.usageRevision?.generation ?? null,
        previous_push_id: prepared.expectedPushSelection?.pushId ?? null,
        previous_push_version: prepared.expectedPushSelection?.version ?? null,
        expected_cloud_revision_id: prepared.expectedCloudSelection?.revisionId ?? null,
        expected_cloud_version: prepared.expectedCloudSelection?.version ?? null,
        session_repo_url: s?.key.repoUrl ?? null,
        session_working_dir: s?.key.workingDir ?? null,
        session_revision_id: s?.expectedSelection.revisionId ?? null,
        session_version: s?.expectedSelection.version ?? null,
        session_acknowledgement_id: s?.acknowledgementId ?? null,
        session_result_revision_id: s?.resultRevisionId ?? null,
        cloud_acknowledgement_id: prepared.cloudAcknowledgementId,
        prepared_at: prepared.preparedAt,
        result_checkpoints: prepared.result.checkpoints,
        result_summary: prepared.result.summary ? 1 : 0,
        result_evaluators: prepared.result.evaluators,
        result_source_plan_pinned: prepared.result.sourcePlanPinned,
        request_sha256: prepared.requestSha256,
        call_count: prepared.calls.length,
        artifact_payload_hash: prepared.artifactPayloadHash,
      };
      view.run(
        `INSERT INTO artifact_push_requests (${Object.keys(row).join(',')}) VALUES (${Object.keys(
          row
        )
          .map(() => '?')
          .join(',')})`,
        ...Object.values(row)
      );
      for (const call of prepared.calls) {
        const scope = {
          target: t,
          artifactId: prepared.artifactId,
          method: call.method,
          targetExternalId: call.targetExternalId,
          idempotencyKey: prepared.pushId,
        };
        if (readRemoteSelection(view, scope) !== null) conflict();
        if (
          view.get(
            `SELECT 1 FROM remote_requests WHERE request_id=? UNION ALL SELECT 1 FROM remote_attempts WHERE request_id=? UNION ALL SELECT 1 FROM remote_outcomes WHERE request_id=?
        UNION ALL SELECT 1 FROM operations WHERE operation_kind='remote.request' AND (json_extract(payload_json,'$.requestId')=? OR
          (json_extract(target_json,'$.artifactId')=? AND json_extract(target_json,'$.target.server_url')=? AND json_extract(target_json,'$.target.org_id')=? AND json_extract(target_json,'$.target.account_id')=?
           AND json_extract(target_json,'$.method')=? AND json_extract(target_json,'$.targetExternalId')=? AND json_extract(target_json,'$.idempotencyKey')=?)) LIMIT 1`,
            call.requestId,
            call.requestId,
            call.requestId,
            call.requestId,
            prepared.artifactId,
            t.server_url,
            t.org_id,
            t.account_id,
            call.method,
            call.targetExternalId,
            prepared.pushId
          )
        )
          conflict();
        view.run(
          `INSERT INTO remote_requests (request_id,operation_id,owner_kind,push_id,call_ordinal,server_url,org_id,account_id,artifact_id,artifact_scope,method,target_external_id,idempotency_key,payload_bytes,payload_sha256,request_key,prepared_at)
        VALUES (?,?,'artifact_push',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          call.requestId,
          prepared.operationId,
          prepared.pushId,
          call.ordinal,
          t.server_url,
          t.org_id,
          t.account_id,
          prepared.artifactId,
          prepared.artifactId,
          call.method,
          call.targetExternalId,
          prepared.pushId,
          Buffer.from(call.payloadBase64, 'base64'),
          call.payloadSha256,
          call.requestKey,
          prepared.preparedAt
        );
        view.run(
          'INSERT INTO remote_current (server_url,org_id,account_id,artifact_scope,method,target_external_id,idempotency_key,request_id,attempt_id,outcome_id,version) VALUES (?,?,?,?,?,?,?,?,NULL,NULL,1)',
          t.server_url,
          t.org_id,
          t.account_id,
          prepared.artifactId,
          call.method,
          call.targetExternalId,
          prepared.pushId,
          call.requestId
        );
      }
      const scope = [prepared.artifactId, t.server_url, t.org_id, t.account_id];
      if (prepared.expectedPushSelection === null)
        view.run(
          'INSERT INTO artifact_push_current VALUES (?,?,?,?,?,1)',
          ...scope,
          prepared.pushId
        );
      else if (
        view.run(
          'UPDATE artifact_push_current SET push_id=?,version=? WHERE artifact_id=? AND server_url=? AND org_id=? AND account_id=? AND push_id=? AND version=?',
          prepared.pushId,
          result.selection.version,
          ...scope,
          prepared.expectedPushSelection.pushId,
          prepared.expectedPushSelection.version
        ).changes !== 1
      )
        pushIntegrity();
      return result;
    },
    options
  );
}
