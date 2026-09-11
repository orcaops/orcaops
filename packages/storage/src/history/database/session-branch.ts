import { isDeepStrictEqual } from 'node:util';

import { assertProjectDatabasePath, type ProjectDatabase } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { parseSessionBranchKey } from './session-branch-codec.js';
import {
  prepareProjectSessionBranch,
  projectSessionBranch,
  type ProjectSessionBranchInput,
  type ProjectSessionBranchKey,
} from './session-branch-input.js';
import {
  type SessionBranchGitObservation,
  validateSessionBranchObservation,
} from './session-branch-observation.js';
import {
  decodeSessionRevision,
  materializeSessionCurrent,
  materializeSessionRevision,
  sessionIntegrity,
  sessionObservationOperation,
} from './session-branch-records.js';
import { type ProjectOperationOptions, runProjectOperation } from './transactions.js';
import { UuidV7Schema } from '../../ids/uuidv7.js';

export interface SessionBranchObservationInput extends ProjectSessionBranchInput {
  readonly observation: SessionBranchGitObservation;
}
export interface SessionBranchObservationOptions extends ProjectOperationOptions {
  readonly secretAllow: readonly string[];
}
function stale(): never {
  throw new ProjectDatabaseError(
    'STALE_CONTEXT',
    'The original session selection changed; inspect current history before preparing an explicitly new observation'
  );
}
function conflict(): never {
  throw new ProjectDatabaseError(
    'IDEMPOTENCY_CONFLICT',
    'This original session operation has different input; resume its original request or use an explicitly new operation ID'
  );
}
function copy<T>(input: T): T {
  try {
    return structuredClone(input);
  } catch (cause) {
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide copyable finite session observation input',
      { cause }
    );
  }
}
export function readProjectSessionBranch(handle: ProjectDatabase, input: ProjectSessionBranchKey) {
  assertProjectDatabasePath(handle);
  const key = parseSessionBranchKey(input);
  const read = handle.read((view) => materializeSessionCurrent(view, key));
  if (!read.value) return null;
  const decoded = decodeSessionRevision(read.value.materialized);
  if (
    !isDeepStrictEqual(decoded.selection, read.value.selection) ||
    !isDeepStrictEqual(decoded.key, key)
  )
    sessionIntegrity();
  return {
    key: decoded.key,
    selection: decoded.selection,
    state: decoded.state,
    stateBytes: Buffer.from(decoded.stateBase64, 'base64'),
    counters: read.counters,
  };
}
/** Whether any session-branch state is retained across every session key on this database. */
export function hasProjectSessionBranchState(handle: ProjectDatabase): boolean {
  assertProjectDatabasePath(handle);
  return handle.read((view) => view.get('SELECT 1 FROM session_branch_revisions LIMIT 1') !== null)
    .value;
}
function ownedObservation(handle: ProjectDatabase, operationId: string) {
  const read = handle.read((view) => {
    const receipt = view.get<{ kind: string }>(
      'SELECT operation_kind AS kind FROM operations WHERE operation_id=?',
      operationId
    );
    const row = view.get<{ revisionId: string }>(
      'SELECT revision_id AS revisionId FROM session_branch_revisions WHERE publication_operation_id=?',
      operationId
    );
    if (!receipt) {
      if (row) sessionIntegrity();
      return null;
    }
    if (receipt.kind !== 'session.branch.observe') {
      // A settled push publishes its acknowledgment revision under the terminal
      // operation ID, so that family legitimately owns this row: the ID is taken,
      // not corrupt. Any other kind holding a session revision is corruption.
      if (row && receipt.kind !== 'artifact.push.complete') sessionIntegrity();
      conflict();
    }
    if (!row) sessionIntegrity();
    return materializeSessionRevision(view, row.revisionId);
  });
  if (!read.value) return null;
  const decoded = decodeSessionRevision(read.value);
  if (decoded.observation === null) sessionIntegrity();
  return decoded;
}
function retainedObservation(original: NonNullable<ReturnType<typeof ownedObservation>>) {
  return {
    operationId: original.row.operationId,
    revisionId: original.row.revisionId,
    key: original.key,
    expectedSelection: original.expectedSelection,
    stateBytes: new Uint8Array(Buffer.from(original.stateBase64, 'base64')),
    observation: original.observation!,
  };
}
export function readProjectSessionObservation(
  handle: ProjectDatabase,
  operationId: string
): SessionBranchObservationInput | null {
  assertProjectDatabasePath(handle);
  if (!UuidV7Schema.safeParse(operationId).success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the original session observation operation UUID'
    );
  const original = ownedObservation(handle, operationId);
  return original === null ? null : retainedObservation(original);
}
export async function observeProjectSessionBranch(
  handle: ProjectDatabase,
  input: SessionBranchObservationInput,
  options: SessionBranchObservationOptions
) {
  assertProjectDatabasePath(handle);
  if (!UuidV7Schema.safeParse(input?.operationId).success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the original session observation operation UUID'
    );
  const supplied = copy(input);
  const original = ownedObservation(handle, supplied.operationId);
  if (original) {
    const originalInput = retainedObservation(original);
    const comparable = {
      ...supplied,
      stateBytes:
        supplied.stateBytes instanceof Uint8Array
          ? new Uint8Array(supplied.stateBytes)
          : supplied.stateBytes,
    };
    if (!isDeepStrictEqual(comparable, originalInput)) conflict();
    const current = readProjectSessionBranch(handle, original.key);
    if (!current) sessionIntegrity();
    return runProjectOperation(
      handle,
      sessionObservationOperation({ ...originalInput, stateSha256: original.stateSha256 }),
      () => sessionIntegrity(),
      options
    );
  }
  const { observation, ...authored } = supplied;
  if (
    !Array.isArray(options?.secretAllow) ||
    !options.secretAllow.every((value) => typeof value === 'string')
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide an explicit session refusal allowlist'
    );
  const prepared = projectSessionBranch(
    prepareProjectSessionBranch(authored, { secretAllow: [...options.secretAllow] })
  );
  const read = handle.read((view) => materializeSessionCurrent(view, prepared.key));
  const selected = read.value === null ? null : decodeSessionRevision(read.value.materialized);
  if (
    read.value !== null &&
    (!isDeepStrictEqual(read.value.selection, selected!.selection) ||
      !isDeepStrictEqual(prepared.key, selected!.key))
  )
    sessionIntegrity();
  if (!isDeepStrictEqual(prepared.expectedSelection, read.value?.selection ?? null)) stale();
  const transition = validateSessionBranchObservation(
    prepared,
    selected?.state ?? null,
    observation
  );
  if (!transition.changed) {
    if (selected === null) sessionIntegrity();
    return {
      value: { selection: selected.selection, changed: false },
      counters: read.counters,
      replayed: false,
    };
  }
  const version = (prepared.expectedSelection?.version ?? 0) + 1;
  if (!Number.isSafeInteger(version)) sessionIntegrity();
  const operation = sessionObservationOperation({
    ...prepared,
    observation: transition.observation,
  });
  return runProjectOperation(
    handle,
    operation,
    (view) => {
      const current = materializeSessionCurrent(view, prepared.key);
      if (!isDeepStrictEqual(current?.selection ?? null, prepared.expectedSelection)) stale();
      if (!isDeepStrictEqual(current, read.value)) sessionIntegrity();
      if (
        view.get(
          `SELECT revision_id FROM session_branch_revisions WHERE revision_id=? UNION ALL SELECT session_result_revision_id FROM artifact_push_requests WHERE session_result_revision_id=? LIMIT 1`,
          prepared.revisionId,
          prepared.revisionId
        )
      )
        conflict();
      const key = prepared.key;
      const scope = [
        key.target.server_url,
        key.target.org_id,
        key.target.account_id,
        key.repoUrl,
        key.workingDir,
      ];
      view.run(
        `INSERT INTO session_branch_revisions (revision_id,publication_operation_id,state_bytes,origin_kind,acknowledgement_id,
      target_server_url,target_org_id,target_account_id,repo_url,working_dir,state_sha256,current_branch,base_commit_sha,last_acked_at)
      VALUES (?,?,?,'observation',NULL,?,?,?,?,?,?,?,?,?)`,
        prepared.revisionId,
        prepared.operationId,
        Buffer.from(prepared.stateBase64, 'base64'),
        ...scope,
        prepared.stateSha256,
        prepared.state.current_branch,
        prepared.state.base_commit_sha,
        prepared.state.last_acked_at
      );
      if (prepared.expectedSelection === null)
        view.run(
          'INSERT INTO session_branch_current (target_server_url,target_org_id,target_account_id,repo_url,working_dir,revision_id,version) VALUES (?,?,?,?,?,?,1)',
          ...scope,
          prepared.revisionId
        );
      else if (
        view.run(
          `UPDATE session_branch_current SET revision_id=?,version=? WHERE target_server_url=? AND target_org_id=? AND target_account_id=? AND repo_url=? AND working_dir=? AND revision_id=? AND version=?`,
          prepared.revisionId,
          version,
          ...scope,
          prepared.expectedSelection.revisionId,
          prepared.expectedSelection.version
        ).changes !== 1
      )
        stale();
      return { selection: { revisionId: prepared.revisionId, version }, changed: true };
    },
    options
  );
}
