import { type artifactPushFixture, pushOptions, pushTarget } from './artifact-push-fixture.js';
import type { ProjectArtifactPushInput } from '../src/history/database/artifact-push-input.js';
import { completeProjectArtifactPush } from '../src/history/database/artifact-push-terminal.js';
import { beginProjectArtifactPush } from '../src/history/database/artifact-push.js';
import type { ProjectDatabase } from '../src/history/database/connection.js';
import { readProjectRemoteRequest } from '../src/history/database/remote-transport-reader.js';
import {
  admitProjectRemoteAttempt,
  recordProjectRemoteOutcome,
} from '../src/history/database/remote-transport.js';
import type { ProjectSessionBranchSelection } from '../src/history/database/session-branch-input.js';
import { observeProjectSessionBranch } from '../src/history/database/session-branch.js';
import { uuidv7 } from '../src/ids/uuidv7.js';

export type ArtifactPushFixture = Awaited<ReturnType<typeof artifactPushFixture>>;
type Fixture = ArtifactPushFixture;
export const sessionKey = {
  target: pushTarget,
  repoUrl: 'ssh://example.test/project',
  workingDir: '/original checkout',
};
export async function admitAttempt(handle: ProjectDatabase, requestId: string) {
  const request = readProjectRemoteRequest(handle, requestId).value!;
  const value = {
    operationId: uuidv7(),
    attemptId: uuidv7(),
    requestId,
    scope: request.request.scope,
    expectedSelection: request.current,
    attemptedAt: '2026-09-01T00:00:02Z',
  };
  await admitProjectRemoteAttempt(handle, value, pushOptions);
  return value;
}
export async function observeOutcome(
  handle: ProjectDatabase,
  requestId: string,
  attemptId: string,
  kind: 'acknowledged' | 'ack_unknown'
) {
  const selected = readProjectRemoteRequest(handle, requestId).value!;
  const common = {
    operationId: uuidv7(),
    outcomeId: uuidv7(),
    requestId,
    attemptId,
    scope: selected.request.scope,
    expectedSelection: selected.current,
    observedAt: '2026-09-01T00:00:03Z',
  };
  const value =
    kind === 'acknowledged'
      ? { ...common, kind, responseBytes: Buffer.from('{"accepted":true}'), failure: null }
      : {
          ...common,
          kind,
          responseBytes: null,
          failure: { kind: 'unknown' as const, message: 'transport interrupted' },
        };
  await recordProjectRemoteOutcome(handle, value, pushOptions);
  return value;
}
export async function acknowledgeCalls(
  f: Fixture,
  input: ProjectArtifactPushInput,
  indexes = input.calls.map((_, index) => index)
) {
  const sent = [];
  for (const index of indexes) {
    const call = input.calls[index]!;
    const admitted = await admitAttempt(f.handle, call.requestId);
    await observeOutcome(f.handle, call.requestId, admitted.attemptId, 'acknowledged');
    sent.push(admitted);
  }
  return sent;
}
export function terminalInput(input: ProjectArtifactPushInput) {
  return { pushId: input.pushId, operationId: input.terminalOperationId };
}
export function retainedPushRows(handle: ProjectDatabase) {
  return handle.read((view) => ({
    headers: view.all('SELECT * FROM artifact_push_requests ORDER BY push_id'),
    current: view.all('SELECT * FROM artifact_push_current ORDER BY push_id'),
    requests: view.all(
      'SELECT request_id,operation_id,owner_kind,push_id,call_ordinal,hex(payload_bytes) AS bytes,payload_sha256 FROM remote_requests ORDER BY request_id'
    ),
    attempts: view.all('SELECT * FROM remote_attempts ORDER BY attempt_id'),
    outcomes: view.all(
      'SELECT outcome_id,request_id,attempt_id,operation_id,outcome_n,kind,observed_at,hex(response_bytes) AS response,failure_kind,failure_message FROM remote_outcomes ORDER BY outcome_id'
    ),
    remote: view.all('SELECT * FROM remote_current ORDER BY request_id'),
    terminals: view.all('SELECT * FROM artifact_push_terminals ORDER BY push_id'),
    terminalCalls: view.all('SELECT * FROM artifact_push_terminal_calls ORDER BY push_id,ordinal'),
    sessionRevisions: view.all(
      'SELECT revision_id,publication_operation_id,hex(state_bytes) AS state,origin_kind,acknowledgement_id,state_sha256,current_branch,base_commit_sha,last_acked_at FROM session_branch_revisions ORDER BY revision_id'
    ),
    sessionCurrent: view.all('SELECT * FROM session_branch_current ORDER BY repo_url'),
    sessionAcks: view.all(
      'SELECT * FROM session_branch_acknowledgements ORDER BY acknowledgement_id'
    ),
    cloudRecords: view.all('SELECT * FROM cloud_sync_records ORDER BY revision_id'),
    cloudCurrent: view.all('SELECT * FROM cloud_sync_current ORDER BY artifact_id'),
    receipts: view.all('SELECT * FROM operations ORDER BY operation_id'),
  }));
}
export function sessionState(
  branch: string,
  history: string[] = [],
  lastAckedAt: string | null = null
) {
  return {
    schema_version: 1,
    target: pushTarget,
    repo_url: sessionKey.repoUrl,
    working_dir: sessionKey.workingDir,
    current_branch: branch,
    branch_history: history,
    base_commit_sha: 'a'.repeat(40),
    last_acked_at: lastAckedAt,
  };
}
export async function observeMain(handle: ProjectDatabase, key = sessionKey) {
  const state = { ...sessionState('main'), repo_url: key.repoUrl, working_dir: key.workingDir };
  const observed = await observeProjectSessionBranch(
    handle,
    {
      operationId: uuidv7(),
      revisionId: uuidv7(),
      key,
      expectedSelection: null,
      stateBytes: Buffer.from(JSON.stringify(state)),
      observation: { headOid: 'a'.repeat(40), priorBranchExists: null },
    },
    pushOptions
  );
  return observed.value.selection;
}
export function renamed(
  selection: ProjectSessionBranchSelection,
  lastAckedAt: string | null = null
) {
  return {
    operationId: uuidv7(),
    revisionId: uuidv7(),
    key: sessionKey,
    expectedSelection: selection,
    stateBytes: Buffer.from(JSON.stringify(sessionState('renamed', ['main'], lastAckedAt))),
    observation: { headOid: 'b'.repeat(40), priorBranchExists: false },
  };
}
export function renamedAgain(selection: ProjectSessionBranchSelection) {
  return {
    ...renamed(selection),
    stateBytes: Buffer.from(JSON.stringify(sessionState('again', ['main', 'renamed']))),
    observation: { headOid: 'c'.repeat(40), priorBranchExists: false },
  };
}
export async function sessionPush(f: Fixture) {
  const selection = await observeMain(f.handle);
  const input = f.input();
  input.session = {
    key: sessionKey,
    expectedSelection: selection,
    acknowledgementId: uuidv7(),
    resultRevisionId: uuidv7(),
  };
  await beginProjectArtifactPush(f.handle, input, pushOptions);
  return { input, selection };
}
export async function completedPush(f: Fixture, withSession = false) {
  const input = withSession ? (await sessionPush(f)).input : f.input();
  if (!withSession) await beginProjectArtifactPush(f.handle, input, pushOptions);
  await acknowledgeCalls(f, input);
  const result = await completeProjectArtifactPush(f.handle, terminalInput(input));
  return { input, result };
}
