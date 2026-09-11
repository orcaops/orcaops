import { isDeepStrictEqual } from 'node:util';

import {
  cloudSyncFailure,
  prepareProjectCloudSyncFailure,
  type ProjectCloudSyncFailureInput,
} from './cloud-sync-input.js';
import {
  cloudFailureOperation,
  cloudFailureResult,
  cloudIntegrity,
  cloudScope,
  type CloudSyncKey,
  type CloudSyncRecord,
  decodeCloudState,
  originalCloudFailure,
  parseCloudSyncKey,
  selectCloudSources,
  selectCloudState,
} from './cloud-sync-records.js';
import {
  assertProjectDatabasePath,
  type ProjectCounters,
  type ProjectDatabase,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { type ProjectOperationOptions, runProjectOperation } from './transactions.js';
import { UuidV7Schema } from '../../ids/uuidv7.js';

export interface CloudSyncFailureOptions extends ProjectOperationOptions {
  readonly secretAllow: readonly string[];
}
function conflict(): never {
  throw new ProjectDatabaseError(
    'IDEMPOTENCY_CONFLICT',
    'This cloud failure operation or revision already owns different original input; resume its original request or use an explicitly new identity'
  );
}
function copy<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch (cause) {
    throw new ProjectDatabaseError('INVALID_INPUT', 'Provide copyable finite cloud failure input', {
      cause,
    });
  }
}
export function readProjectCloudSyncState(
  handle: ProjectDatabase,
  artifactId: string,
  target: CloudSyncKey['target']
) {
  assertProjectDatabasePath(handle);
  const key = parseCloudSyncKey({ artifactId, target });
  const observed = handle.read((view) => ({
    cloud: selectCloudState(view, key),
    sources: selectCloudSources(view, key.artifactId),
  }));
  return hydrateProjectCloudSyncState(key, observed);
}
export function hydrateProjectCloudSyncState(
  key: CloudSyncKey,
  observed: {
    value: {
      cloud: ReturnType<typeof selectCloudState>;
      sources: ReturnType<typeof selectCloudSources>;
    };
    counters: ProjectCounters;
  }
) {
  const state = decodeCloudState(observed.value.cloud);
  if (observed.value.sources === null) {
    if (state.records.length > 0) cloudIntegrity();
    return null;
  }
  const success = state.success,
    failure = state.failure;
  const owner =
    success === null
      ? null
      : observed.value.cloud.owners.find((value) => value.revisionId === success.revision_id)
          ?.header;
  if (success !== null && !owner) cloudIntegrity();
  return {
    key,
    selection: state.selection,
    counters: observed.counters,
    sources: observed.value.sources,
    publicState:
      success === null
        ? null
        : {
            syncedAt: success.acknowledged_at!,
            hash: owner!.artifact_payload_hash as string,
            externalId: key.artifactId,
            orgId: key.target.org_id,
          },
    lastAttemptAt: failure?.attempted_at ?? success?.acknowledged_at ?? null,
    lastError:
      failure === null ? null : { kind: failure.failure_kind!, message: failure.failure_message },
    consecutiveFailures: state.consecutiveFailures,
    pending:
      success === null ||
      state.consecutiveFailures > 0 ||
      success.artifact_generation !== observed.value.sources.artifactGeneration ||
      success.usage_generation !== observed.value.sources.usageGeneration,
  };
}
function originalFailure(handle: ProjectDatabase, operationId: string) {
  const observed = handle.read((view) => {
    const receipt = view.get<{ kind: string }>(
      'SELECT operation_kind AS kind FROM operations WHERE operation_id=?',
      operationId
    );
    const row = view.get<{ artifactId: string; server: string; org: string; account: string }>(
      'SELECT artifact_id AS artifactId,server_url AS server,org_id AS org,account_id AS account FROM cloud_sync_records WHERE operation_id=?',
      operationId
    );
    if (!receipt) {
      if (row) cloudIntegrity();
      return null;
    }
    if (receipt.kind !== 'cloud.sync.failure') {
      // A settled push records its cloud acknowledgment under the terminal
      // operation ID, so that family legitimately owns this row: the ID is taken,
      // not corrupt. Any other kind holding a cloud record is corruption.
      if (row && receipt.kind !== 'artifact.push.complete') cloudIntegrity();
      conflict();
    }
    if (!row) cloudIntegrity();
    const key = {
      artifactId: row.artifactId,
      target: { server_url: row.server, org_id: row.org, account_id: row.account },
    };
    if (!selectCloudSources(view, key.artifactId)) cloudIntegrity();
    return selectCloudState(view, key);
  });
  if (observed.value === null) return null;
  const state = decodeCloudState(observed.value),
    row = state.records.find((value) => value.operation_id === operationId);
  if (!row || row.kind !== 'failure') cloudIntegrity();
  return { row, input: originalCloudFailure(row) };
}
export async function recordProjectCloudSyncFailure(
  handle: ProjectDatabase,
  input: ProjectCloudSyncFailureInput,
  options: CloudSyncFailureOptions
) {
  assertProjectDatabasePath(handle);
  if (!UuidV7Schema.safeParse(input?.operationId).success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the original cloud failure operation UUID'
    );
  const supplied = copy(input),
    original = originalFailure(handle, supplied.operationId);
  if (original) {
    if (!isDeepStrictEqual(original.input, supplied)) conflict();
    return runProjectOperation(
      handle,
      cloudFailureOperation({ input: original.input, inputSha256: original.row.record_sha256 }),
      () => cloudIntegrity(),
      options
    );
  }
  const prepared = cloudSyncFailure(prepareProjectCloudSyncFailure(supplied, options?.secretAllow)),
    value = prepared.input;
  const key = { artifactId: value.artifactId, target: value.target };
  return runProjectOperation(
    handle,
    cloudFailureOperation(prepared),
    (view) => {
      const sources = selectCloudSources(view, key.artifactId);
      if (!sources)
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'The requested artifact is absent; select its retained original identity before recording a cloud failure'
        );
      const state = decodeCloudState(selectCloudState(view, key));
      if (
        view.get(
          `SELECT revision_id FROM cloud_sync_records WHERE revision_id=? UNION ALL SELECT cloud_acknowledgement_id FROM artifact_push_requests WHERE cloud_acknowledgement_id=? LIMIT 1`,
          value.revisionId,
          value.revisionId
        )
      )
        conflict();
      const applied =
        state.success === null || value.attemptStartedAt > state.success.acknowledged_at!;
      const row = {
        revision_id: value.revisionId,
        operation_id: value.operationId,
        kind: 'failure',
        artifact_id: key.artifactId,
        server_url: key.target.server_url,
        org_id: key.target.org_id,
        account_id: key.target.account_id,
        previous_revision_id: state.selection?.revisionId ?? null,
        previous_version: state.selection?.version ?? null,
        applied: applied ? 1 : 0,
        push_id: null,
        artifact_generation: null,
        usage_generation: null,
        acknowledged_at: null,
        failure_kind: value.kind,
        failure_message: value.message,
        attempted_at: value.attemptedAt,
        attempt_started_at: value.attemptStartedAt,
        record_sha256: prepared.inputSha256,
      };
      if (applied && !Number.isSafeInteger((row.previous_version ?? 0) + 1)) cloudIntegrity();
      view.run(
        `INSERT INTO cloud_sync_records (revision_id,operation_id,kind,artifact_id,server_url,org_id,account_id,
      previous_revision_id,previous_version,applied,push_id,artifact_generation,usage_generation,acknowledged_at,
      failure_kind,failure_message,attempted_at,attempt_started_at,record_sha256)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ...Object.values(row)
      );
      if (applied) {
        if (state.selection === null)
          view.run(
            'INSERT INTO cloud_sync_current VALUES (?,?,?,?,?,1)',
            ...cloudScope(key),
            value.revisionId
          );
        else if (
          view.run(
            `UPDATE cloud_sync_current SET revision_id=?,version=? WHERE artifact_id=? AND server_url=? AND org_id=? AND account_id=? AND revision_id=? AND version=?`,
            value.revisionId,
            state.selection.version + 1,
            ...cloudScope(key),
            state.selection.revisionId,
            state.selection.version
          ).changes !== 1
        )
          cloudIntegrity();
      }
      return cloudFailureResult(row as CloudSyncRecord);
    },
    options
  );
}
