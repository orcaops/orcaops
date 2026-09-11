import { isDeepStrictEqual } from 'node:util';

import { UuidV7Schema } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import type { ProjectArtifactPushInput } from './artifact-push-input.js';
import {
  decodeArtifactPushOwner,
  pushIntegrity,
  selectArtifactPushCurrent,
  selectArtifactPushOwner,
} from './artifact-push-owner.js';
import {
  decodeCloudState,
  parseCloudSyncKey,
  selectCloudSources,
  selectCloudState,
} from './cloud-sync-records.js';
import {
  assertProjectDatabasePath,
  type ProjectDatabase,
  type ProjectReadView,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { hydrateRemoteRequest, materializeRemoteRequest } from './remote-transport-reader.js';
import { decodeSessionRevision, materializeSessionRevision } from './session-branch-records.js';

interface Terminal {
  push_id: string;
  operation_id: string;
  acknowledged_at: string;
  session_applied: number | null;
  cloud_applied: number;
  outcome_count: number;
}
interface TerminalReceipt {
  operation_kind: string;
  intent_change: number;
  target_json: string;
  payload_json: string;
  payload_hash: string;
  expected_state_json: string;
  result_json: string;
}
interface TerminalCall {
  push_id: string;
  ordinal: number;
  request_id: string;
  attempt_id: string;
  outcome_id: string;
}
interface RetainedArtifactPush {
  owner: NonNullable<ReturnType<typeof selectArtifactPushOwner>>;
  current: NonNullable<ReturnType<typeof selectArtifactPushCurrent>>;
  calls: NonNullable<ReturnType<typeof materializeRemoteRequest>>[];
  terminal: Terminal | null;
  terminalReceipt: TerminalReceipt | null;
  terminalCalls: TerminalCall[];
  cloud: ReturnType<typeof selectCloudState>;
  sessionAck: Record<string, string | number | null> | null;
  session: ReturnType<typeof materializeSessionRevision> | null;
}
export function selectArtifactPush(
  view: ProjectReadView,
  pushId: string
): RetainedArtifactPush | null {
  const owner = selectArtifactPushOwner(view, pushId);
  if (owner === null) return null;
  const p = owner.header,
    target = { server_url: p.server_url, org_id: p.org_id, account_id: p.account_id };
  if (selectCloudSources(view, p.artifact_id) === null) pushIntegrity();
  const current = selectArtifactPushCurrent(view, p.artifact_id, target);
  if (current === null) pushIntegrity();
  const calls = owner.calls.map((call) => materializeRemoteRequest(view, call.requestId, owner));
  if (calls.some((call) => call === null)) pushIntegrity();
  const terminal = view.get<Terminal>(
    'SELECT * FROM artifact_push_terminals WHERE push_id=?',
    pushId
  );
  const terminalReceipt = view.get<TerminalReceipt>(
    'SELECT operation_kind,intent_change,target_json,payload_json,payload_hash,expected_state_json,result_json FROM operations WHERE operation_id=?',
    p.terminal_operation_id
  );
  const terminalCalls = view.all<TerminalCall>(
    'SELECT * FROM artifact_push_terminal_calls WHERE push_id=? ORDER BY ordinal',
    pushId
  );
  const cloud = selectCloudState(view, { artifactId: p.artifact_id, target });
  const sessionAck = view.get<Record<string, string | number | null>>(
    'SELECT * FROM session_branch_acknowledgements WHERE push_id=?',
    pushId
  );
  const session =
    sessionAck?.result_revision_id == null
      ? null
      : materializeSessionRevision(view, sessionAck.result_revision_id as string);
  return {
    owner,
    current,
    calls: calls as NonNullable<(typeof calls)[number]>[],
    terminal,
    terminalReceipt,
    terminalCalls,
    cloud,
    sessionAck,
    session,
  };
}
export function decodeArtifactPush(raw: NonNullable<ReturnType<typeof selectArtifactPush>>) {
  try {
    const own = decodeArtifactPushOwner(raw.owner),
      p = own.prepared;
    const selected =
      raw.current.selection.pushId === p.pushId ? own : decodeArtifactPushOwner(raw.current.raw);
    if (!isDeepStrictEqual(selected.result.selection, raw.current.selection)) pushIntegrity();
    const calls = raw.calls.map((call) => hydrateRemoteRequest(call, own));
    const cloud = decodeCloudState(raw.cloud),
      cloudAck = cloud.records.find((row) => row.push_id === p.pushId) ?? null;
    let terminal: null | {
      operationId: string;
      result: {
        pushId: string;
        acknowledgedAt: string;
        sessionApplied: boolean | null;
        cloudApplied: boolean;
        result: ProjectArtifactPushInput['result'];
      };
    } = null;
    if (raw.terminal === null) {
      if (
        raw.terminalReceipt !== null ||
        raw.terminalCalls.length > 0 ||
        cloudAck !== null ||
        raw.sessionAck !== null ||
        raw.session !== null
      )
        pushIntegrity();
    } else {
      const t = raw.terminal,
        r = raw.terminalReceipt;
      if (
        !r ||
        t.operation_id !== p.terminalOperationId ||
        t.push_id !== p.pushId ||
        t.outcome_count !== p.calls.length ||
        raw.terminalCalls.length !== p.calls.length ||
        ![0, 1].includes(t.cloud_applied) ||
        (p.session === null ? t.session_applied !== null : ![0, 1].includes(t.session_applied!)) ||
        !cloudAck ||
        cloudAck.operation_id !== t.operation_id ||
        cloudAck.revision_id !== p.cloudAcknowledgementId ||
        cloudAck.applied !== t.cloud_applied ||
        cloudAck.acknowledged_at !== t.acknowledged_at
      )
        pushIntegrity();
      raw.terminalCalls.forEach((call, index) => {
        const original = p.calls[index]!,
          progress = calls[index]!,
          outcome = progress.outcomes.find((row) => row.outcomeId === call.outcome_id);
        if (
          call.push_id !== p.pushId ||
          call.ordinal !== index + 1 ||
          call.request_id !== original.requestId ||
          call.attempt_id !== progress.attempt?.attemptId ||
          !outcome ||
          outcome.kind !== 'acknowledged' ||
          outcome.attemptId !== call.attempt_id
        )
          pushIntegrity();
      });
      if (p.session === null) {
        if (raw.sessionAck !== null || raw.session !== null) pushIntegrity();
      } else {
        const s = p.session,
          a = raw.sessionAck;
        if (
          !a ||
          a.acknowledgement_id !== s.acknowledgementId ||
          a.operation_id !== p.terminalOperationId ||
          a.push_id !== p.pushId ||
          a.target_server_url !== s.key.target.server_url ||
          a.target_org_id !== s.key.target.org_id ||
          a.target_account_id !== s.key.target.account_id ||
          a.repo_url !== s.key.repoUrl ||
          a.working_dir !== s.key.workingDir ||
          a.expected_revision_id !== s.expectedSelection.revisionId ||
          a.expected_version !== s.expectedSelection.version ||
          a.acked_at !== t.acknowledged_at ||
          a.applied !== t.session_applied ||
          a.result_revision_id !== (t.session_applied === 1 ? s.resultRevisionId : null)
        )
          pushIntegrity();
        if (t.session_applied === 1) {
          if (raw.session === null) pushIntegrity();
          const state = decodeSessionRevision(raw.session);
          if (
            state.row.revisionId !== s.resultRevisionId ||
            state.row.operationId !== p.terminalOperationId ||
            !isDeepStrictEqual(state.key, s.key)
          )
            pushIntegrity();
        } else if (raw.session !== null) pushIntegrity();
      }
      const result = {
        pushId: p.pushId,
        acknowledgedAt: t.acknowledged_at,
        sessionApplied: t.session_applied === null ? null : t.session_applied === 1,
        cloudApplied: t.cloud_applied === 1,
        result: p.result,
      };
      if (
        r.operation_kind !== 'artifact.push.complete' ||
        r.intent_change !== 0 ||
        r.payload_hash !== digest(r.payload_json) ||
        !isDeepStrictEqual(JSON.parse(r.target_json), {
          artifactId: p.artifactId,
          target: p.target,
        }) ||
        !isDeepStrictEqual(JSON.parse(r.payload_json), { pushId: p.pushId }) ||
        !isDeepStrictEqual(JSON.parse(r.expected_state_json), {}) ||
        !isDeepStrictEqual(JSON.parse(r.result_json), result)
      )
        pushIntegrity();
      terminal = { operationId: t.operation_id, result };
    }
    return {
      input: own.input,
      prepared: p,
      selection: own.result.selection,
      currentSelection: raw.current.selection,
      calls,
      terminal,
    };
  } catch (cause) {
    return pushIntegrity(cause);
  }
}
export function readProjectArtifactPush(handle: ProjectDatabase, pushId: string) {
  assertProjectDatabasePath(handle);
  if (!UuidV7Schema.safeParse(pushId).success)
    throw new ProjectDatabaseError('INVALID_INPUT', 'Select the exact original grouped push UUID');
  const result = handle.read((view) => selectArtifactPush(view, pushId));
  return { ...result, value: result.value === null ? null : decodeArtifactPush(result.value) };
}
export function readProjectArtifactPushCurrent(
  handle: ProjectDatabase,
  artifactId: string,
  target: ProjectArtifactPushInput['target']
) {
  assertProjectDatabasePath(handle);
  const key = parseCloudSyncKey({ artifactId, target });
  const result = handle.read((view) => {
    const current = selectArtifactPushCurrent(view, key.artifactId, key.target);
    return current === null ? null : selectArtifactPush(view, current.selection.pushId);
  });
  return { ...result, value: result.value === null ? null : decodeArtifactPush(result.value) };
}
