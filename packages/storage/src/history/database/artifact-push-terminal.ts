import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { UuidV7Schema } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import { pushIntegrity } from './artifact-push-owner.js';
import { decodeArtifactPush, selectArtifactPush } from './artifact-push-reader.js';
import {
  cloudAcknowledgementHash,
  cloudScope,
  type CloudSyncRecord,
  decodeCloudState,
  selectCloudSources,
} from './cloud-sync-records.js';
import { assertProjectDatabasePath, type ProjectDatabase } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { decodeRetainedSessionBranch } from './session-branch-codec.js';
import { decodeSessionRevision } from './session-branch-records.js';
import { type ProjectOperationOptions, runProjectOperation } from './transactions.js';

const terminalInput = z.strictObject({ pushId: UuidV7Schema, operationId: UuidV7Schema });
export type ProjectArtifactPushTerminalInput = z.infer<typeof terminalInput>;
function conflict(): never {
  throw new ProjectDatabaseError(
    'IDEMPOTENCY_CONFLICT',
    'Use the original terminal operation ID retained by this artifact push; another original identity cannot complete it'
  );
}
function pending(): never {
  throw new ProjectDatabaseError(
    'STALE_CONTEXT',
    'The original push has not retained all acknowledged outcomes. Resume it so unsent calls can run. An admitted call without an acknowledged outcome will not be resent; run `orcaops push-status` and report the unknown delivery'
  );
}
function unretained(): never {
  throw new ProjectDatabaseError(
    'STALE_CONTEXT',
    'No retained push has this identity; admit or recover the original push before completing it'
  );
}
function terminalOperation(group: ReturnType<typeof decodeArtifactPush>) {
  return {
    operationId: group.input.terminalOperationId,
    kind: 'artifact.push.complete',
    intentChange: false,
    target: { artifactId: group.input.artifactId, target: group.input.target },
    payload: { pushId: group.input.pushId },
    expectedState: {},
  };
}
function immutableInput(raw: NonNullable<ReturnType<typeof selectArtifactPush>>) {
  const { sessionCurrent: _, ...owner } = raw.owner;
  return {
    owner,
    selection: raw.current.selection,
    // A slot may select a later request once this call is acknowledged; only the
    // original request's own rows are the immutable input of its settlement.
    calls: raw.calls.map(({ request, attempt, outcomes }) => ({ request, attempt, outcomes })),
    terminal: raw.terminal,
    terminalReceipt: raw.terminalReceipt,
    terminalCalls: raw.terminalCalls,
    sessionAck: raw.sessionAck,
    session: raw.session,
  };
}
export async function completeProjectArtifactPush(
  handle: ProjectDatabase,
  input: ProjectArtifactPushTerminalInput,
  options: ProjectOperationOptions = {}
) {
  assertProjectDatabasePath(handle);
  const parsed = terminalInput.safeParse(input);
  if (!parsed.success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the original push and terminal operation UUIDs',
      { cause: parsed.error }
    );
  const supplied = parsed.data;
  const observed = handle.read((view) => {
    const receipt = view.get<{ kind: string }>(
      'SELECT operation_kind AS kind FROM operations WHERE operation_id=?',
      supplied.operationId
    );
    const owned = view.get<{ pushId: string }>(
      'SELECT push_id AS pushId FROM artifact_push_requests WHERE terminal_operation_id=?',
      supplied.operationId
    );
    if (receipt && receipt.kind !== 'artifact.push.complete') conflict();
    if (owned && owned.pushId !== supplied.pushId) conflict();
    const raw = selectArtifactPush(view, supplied.pushId);
    if (raw === null) {
      if (receipt || owned) pushIntegrity();
      unretained();
    }
    if (raw.owner.header.terminal_operation_id !== supplied.operationId) conflict();
    return raw;
  });
  const group = decodeArtifactPush(observed.value),
    p = group.input;
  const operation = terminalOperation(group);
  if (group.terminal !== null)
    return runProjectOperation(handle, operation, () => pushIntegrity(), options);
  const calls = group.calls.map((call, index) => {
    const outcome = call.outcomes.find((value) => value.kind === 'acknowledged');
    if (!call.attempt || !outcome || outcome.attemptId !== call.attempt.attemptId) pending();
    return {
      pushId: p.pushId,
      ordinal: index + 1,
      requestId: call.request.requestId,
      attemptId: call.attempt.attemptId,
      outcomeId: outcome.outcomeId,
    };
  });
  const acknowledgedAt = new Date().toISOString();
  const originalSession =
    observed.value.owner.session === null
      ? null
      : decodeSessionRevision(observed.value.owner.session);
  const sessionBytes =
    originalSession === null
      ? null
      : Buffer.from(
          JSON.stringify({
            ...originalSession.state,
            branch_history: [],
            last_acked_at: acknowledgedAt,
          })
        );
  const sessionState =
    sessionBytes === null || p.session === null
      ? null
      : decodeRetainedSessionBranch({
          key: p.session.key,
          stateBytes: sessionBytes,
          stateSha256: digest(sessionBytes),
        });
  return runProjectOperation(
    handle,
    operation,
    (view) => {
      const actual = selectArtifactPush(view, p.pushId);
      if (
        actual === null ||
        !isDeepStrictEqual(immutableInput(actual), immutableInput(observed.value))
      )
        pushIntegrity();
      const cloud = decodeCloudState(actual.cloud),
        sources = selectCloudSources(view, p.artifactId);
      if (sources === null) pushIntegrity();
      const cloudApplied =
        isDeepStrictEqual(cloud.selection, p.expectedCloudSelection) &&
        sources.artifactGeneration === p.artifactRevision.generation &&
        sources.usageGeneration === (p.usageRevision?.generation ?? null) &&
        (cloud.success === null || acknowledgedAt > cloud.success.acknowledged_at!);
      let sessionApplied: boolean | null = null;
      if (p.session !== null) {
        const selected = actual.owner.sessionCurrent;
        if (!selected || !originalSession || !sessionState || !sessionBytes) pushIntegrity();
        const row = selected.materialized.row;
        if (
          !UuidV7Schema.safeParse(row.operationId).success ||
          row.payloadJson === null ||
          row.resultJson === null ||
          row.payloadHash !== digest(row.payloadJson) ||
          row.originalVersion !== selected.selection.version ||
          (row.originKind === 'observation'
            ? row.acknowledgementId !== null || row.operationKind !== 'session.branch.observe'
            : row.originKind !== 'acknowledgement' ||
              row.acknowledgementId === null ||
              row.operationKind !== 'artifact.push.complete' ||
              selected.materialized.ack === null) ||
          row.server !== p.target.server_url ||
          row.org !== p.target.org_id ||
          row.account !== p.target.account_id ||
          row.repoUrl !== p.session.key.repoUrl ||
          row.workingDir !== p.session.key.workingDir
        )
          pushIntegrity();
        sessionApplied =
          isDeepStrictEqual(selected.selection, p.session.expectedSelection) &&
          (originalSession.state.last_acked_at === null ||
            acknowledgedAt > originalSession.state.last_acked_at);
        if (sessionApplied && !Number.isSafeInteger(p.session.expectedSelection.version + 1))
          pushIntegrity();
      }
      if (cloudApplied && !Number.isSafeInteger((p.expectedCloudSelection?.version ?? 0) + 1))
        pushIntegrity();
      for (const call of calls)
        view.run(
          'INSERT INTO artifact_push_terminal_calls VALUES (?,?,?,?,?)',
          call.pushId,
          call.ordinal,
          call.requestId,
          call.attemptId,
          call.outcomeId
        );
      if (p.session !== null) {
        const s = p.session,
          k = s.key;
        if (sessionApplied) {
          const state = sessionState!.state;
          view.run(
            `INSERT INTO session_branch_revisions
          (revision_id,publication_operation_id,state_bytes,origin_kind,acknowledgement_id,target_server_url,target_org_id,target_account_id,repo_url,working_dir,state_sha256,current_branch,base_commit_sha,last_acked_at)
          VALUES (?,?,?,'acknowledgement',?,?,?,?,?,?,?,?,?,?)`,
            s.resultRevisionId,
            p.terminalOperationId,
            sessionBytes!,
            s.acknowledgementId,
            k.target.server_url,
            k.target.org_id,
            k.target.account_id,
            k.repoUrl,
            k.workingDir,
            digest(sessionBytes!),
            state.current_branch,
            state.base_commit_sha,
            state.last_acked_at
          );
        }
        view.run(
          `INSERT INTO session_branch_acknowledgements
        (acknowledgement_id,operation_id,target_server_url,target_org_id,target_account_id,repo_url,working_dir,expected_revision_id,expected_version,push_id,acked_at,applied,result_revision_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          s.acknowledgementId,
          p.terminalOperationId,
          k.target.server_url,
          k.target.org_id,
          k.target.account_id,
          k.repoUrl,
          k.workingDir,
          s.expectedSelection.revisionId,
          s.expectedSelection.version,
          p.pushId,
          acknowledgedAt,
          sessionApplied ? 1 : 0,
          sessionApplied ? s.resultRevisionId : null
        );
        if (
          sessionApplied &&
          view.run(
            `UPDATE session_branch_current SET revision_id=?,version=? WHERE
        target_server_url=? AND target_org_id=? AND target_account_id=? AND repo_url=? AND working_dir=? AND revision_id=? AND version=?`,
            s.resultRevisionId,
            s.expectedSelection.version + 1,
            k.target.server_url,
            k.target.org_id,
            k.target.account_id,
            k.repoUrl,
            k.workingDir,
            s.expectedSelection.revisionId,
            s.expectedSelection.version
          ).changes !== 1
        )
          pushIntegrity();
      }
      const cloudRow = {
        revision_id: p.cloudAcknowledgementId,
        operation_id: p.terminalOperationId,
        kind: 'acknowledgement',
        artifact_id: p.artifactId,
        server_url: p.target.server_url,
        org_id: p.target.org_id,
        account_id: p.target.account_id,
        previous_revision_id: p.expectedCloudSelection?.revisionId ?? null,
        previous_version: p.expectedCloudSelection?.version ?? null,
        applied: cloudApplied ? 1 : 0,
        push_id: p.pushId,
        artifact_generation: p.artifactRevision.generation,
        usage_generation: p.usageRevision?.generation ?? null,
        acknowledged_at: acknowledgedAt,
        failure_kind: null,
        failure_message: null,
        attempted_at: null,
        attempt_started_at: null,
      };
      view.run(
        `INSERT INTO cloud_sync_records
      (revision_id,operation_id,kind,artifact_id,server_url,org_id,account_id,previous_revision_id,previous_version,applied,push_id,artifact_generation,usage_generation,acknowledged_at,failure_kind,failure_message,attempted_at,attempt_started_at,record_sha256)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ...Object.values(cloudRow),
        cloudAcknowledgementHash(cloudRow as CloudSyncRecord)
      );
      if (cloudApplied) {
        const scope = cloudScope({ artifactId: p.artifactId, target: p.target });
        if (p.expectedCloudSelection === null)
          view.run(
            'INSERT INTO cloud_sync_current VALUES (?,?,?,?,?,1)',
            ...scope,
            p.cloudAcknowledgementId
          );
        else if (
          view.run(
            `UPDATE cloud_sync_current SET revision_id=?,version=? WHERE artifact_id=? AND server_url=? AND org_id=? AND account_id=? AND revision_id=? AND version=?`,
            p.cloudAcknowledgementId,
            p.expectedCloudSelection.version + 1,
            ...scope,
            p.expectedCloudSelection.revisionId,
            p.expectedCloudSelection.version
          ).changes !== 1
        )
          pushIntegrity();
      }
      view.run(
        'INSERT INTO artifact_push_terminals VALUES (?,?,?,?,?,?)',
        p.pushId,
        p.terminalOperationId,
        acknowledgedAt,
        sessionApplied === null ? null : sessionApplied ? 1 : 0,
        cloudApplied ? 1 : 0,
        calls.length
      );
      return { pushId: p.pushId, acknowledgedAt, sessionApplied, cloudApplied, result: p.result };
    },
    options
  );
}
