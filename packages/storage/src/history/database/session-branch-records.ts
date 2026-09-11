import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { canonicalJson } from '../../events/canonical-json.js';
import { UuidV7Schema } from '../../ids/uuidv7.js';
import { digest, DigestSchema } from '../event-integrity.js';
import type { ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  decodeRetainedSessionBranch,
  SessionBranchSelectionSchema,
} from './session-branch-codec.js';
import type {
  ProjectSessionBranchKey,
  ProjectSessionBranchSelection,
} from './session-branch-input.js';
import { validateSessionBranchObservation } from './session-branch-observation.js';

const observation = z.strictObject({
  headOid: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  priorBranchExists: z.boolean().nullable(),
});
export const SessionObservationPayloadSchema = z.strictObject({
  revisionId: UuidV7Schema,
  stateSha256: DigestSchema,
  observation,
});
const expected = z.strictObject({ selection: SessionBranchSelectionSchema.nullable() });
const result = z.strictObject({
  selection: SessionBranchSelectionSchema,
  changed: z.literal(true),
});
export function sessionIntegrity(cause?: unknown): never {
  throw new ProjectDatabaseError(
    'HISTORY_INTEGRITY_REQUIRED',
    'Original session state, selection or receipt is missing or inconsistent; preserve it for explicit repair',
    { cause }
  );
}
export interface SessionBranchRow {
  revisionId: string;
  operationId: string;
  stateHex: string;
  stateSha256: string;
  originKind: 'observation' | 'acknowledgement';
  acknowledgementId: string | null;
  server: string;
  org: string;
  account: string;
  repoUrl: string;
  workingDir: string;
  branch: string;
  base: string | null;
  ackedAt: string | null;
  operationKind: string | null;
  targetJson: string | null;
  payloadJson: string | null;
  payloadHash: string | null;
  expectedJson: string | null;
  resultJson: string | null;
  intentChange: number | null;
  priorId: string | null;
  originalVersion: number | null;
}
export function sessionKey(row: SessionBranchRow): ProjectSessionBranchKey {
  return {
    target: { server_url: row.server, org_id: row.org, account_id: row.account },
    repoUrl: row.repoUrl,
    workingDir: row.workingDir,
  };
}
export function readSessionSelection(
  view: ProjectReadView,
  key: ProjectSessionBranchKey
): ProjectSessionBranchSelection | null {
  return view.get(
    `SELECT revision_id AS revisionId,version FROM session_branch_current
    WHERE target_server_url=? AND target_org_id=? AND target_account_id=? AND repo_url=? AND working_dir=?`,
    key.target.server_url,
    key.target.org_id,
    key.target.account_id,
    key.repoUrl,
    key.workingDir
  );
}
export function assertSessionPresent(
  view: ProjectReadView,
  key: ProjectSessionBranchKey,
  selection: ProjectSessionBranchSelection | null
): void {
  if (selection !== null) return;
  const args = [
    key.target.server_url,
    key.target.org_id,
    key.target.account_id,
    key.repoUrl,
    key.workingDir,
  ];
  if (
    view.get(
      `SELECT 1 FROM session_branch_revisions WHERE target_server_url=? AND target_org_id=? AND target_account_id=? AND repo_url=? AND working_dir=?
    UNION ALL SELECT 1 FROM session_branch_acknowledgements WHERE target_server_url=? AND target_org_id=? AND target_account_id=? AND repo_url=? AND working_dir=?
    UNION ALL SELECT 1 FROM artifact_push_requests WHERE server_url=? AND org_id=? AND account_id=? AND session_repo_url=? AND session_working_dir=?
    UNION ALL SELECT 1 FROM operations WHERE operation_kind='session.branch.observe'
      AND json_extract(target_json,'$.target.server_url')=? AND json_extract(target_json,'$.target.org_id')=? AND json_extract(target_json,'$.target.account_id')=?
      AND json_extract(target_json,'$.repoUrl')=? AND json_extract(target_json,'$.workingDir')=? LIMIT 1`,
      ...args,
      ...args,
      ...args,
      ...args
    )
  )
    sessionIntegrity();
}
function revision(view: ProjectReadView, id: string): SessionBranchRow | null {
  return view.get(
    `SELECT r.revision_id AS revisionId,r.publication_operation_id AS operationId,
    hex(r.state_bytes) AS stateHex,r.state_sha256 AS stateSha256,r.origin_kind AS originKind,r.acknowledgement_id AS acknowledgementId,
    r.target_server_url AS server,r.target_org_id AS org,r.target_account_id AS account,r.repo_url AS repoUrl,r.working_dir AS workingDir,
    r.current_branch AS branch,r.base_commit_sha AS base,r.last_acked_at AS ackedAt,
    o.operation_kind AS operationKind,o.target_json AS targetJson,o.payload_json AS payloadJson,o.payload_hash AS payloadHash,
    o.expected_state_json AS expectedJson,o.result_json AS resultJson,o.intent_change AS intentChange,
    CASE r.origin_kind WHEN 'observation' THEN json_extract(o.result_json,'$.selection.version') ELSE a.expected_version+1 END AS originalVersion,
    CASE r.origin_kind WHEN 'observation' THEN json_extract(o.expected_state_json,'$.selection.revisionId')
      ELSE a.expected_revision_id END AS priorId
    FROM session_branch_revisions r LEFT JOIN operations o ON o.operation_id=r.publication_operation_id
    LEFT JOIN session_branch_acknowledgements a ON a.acknowledgement_id=r.acknowledgement_id
    WHERE r.revision_id=?`,
    id
  );
}
interface SessionAcknowledgementOwner {
  acknowledgementId: string;
  operationId: string;
  expectedRevisionId: string;
  expectedVersion: number;
  resultRevisionId: string | null;
  pushId: string;
  ackedAt: string;
  applied: number;
  server: string;
  org: string;
  account: string;
  repoUrl: string;
  workingDir: string;
  pushArtifactId: string;
  terminalOperationId: string;
  reservedAcknowledgementId: string;
  reservedResultRevisionId: string;
  pushSessionRevisionId: string;
  pushSessionVersion: number;
  pushServer: string;
  pushOrg: string;
  pushAccount: string;
  pushRepoUrl: string;
  pushWorkingDir: string;
  terminalId: string | null;
  terminalTime: string | null;
  sessionApplied: number | null;
  cloudApplied: number | null;
  admissionKind: string | null;
  cloudRecordKind: string | null;
  cloudRecordApplied: number | null;
  cloudRecordPushId: string | null;
  resultCheckpoints: number;
  resultSummary: number;
  resultEvaluators: number;
  resultSourcePlanPinned: 'A' | 'B' | null;
}
function acknowledgement(view: ProjectReadView, id: string): SessionAcknowledgementOwner | null {
  return view.get(
    `SELECT a.acknowledgement_id AS acknowledgementId,a.operation_id AS operationId,a.expected_revision_id AS expectedRevisionId,
    a.expected_version AS expectedVersion,a.result_revision_id AS resultRevisionId,a.push_id AS pushId,a.acked_at AS ackedAt,a.applied,
    a.target_server_url AS server,a.target_org_id AS org,a.target_account_id AS account,a.repo_url AS repoUrl,a.working_dir AS workingDir,
    p.artifact_id AS pushArtifactId,p.terminal_operation_id AS terminalOperationId,p.session_acknowledgement_id AS reservedAcknowledgementId,
    p.session_result_revision_id AS reservedResultRevisionId,p.session_revision_id AS pushSessionRevisionId,p.session_version AS pushSessionVersion,
    p.server_url AS pushServer,p.org_id AS pushOrg,p.account_id AS pushAccount,p.session_repo_url AS pushRepoUrl,p.session_working_dir AS pushWorkingDir,
    t.operation_id AS terminalId,t.acknowledged_at AS terminalTime,t.session_applied AS sessionApplied,t.cloud_applied AS cloudApplied,
    o.operation_kind AS admissionKind,c.kind AS cloudRecordKind,c.applied AS cloudRecordApplied,c.push_id AS cloudRecordPushId,
    p.result_checkpoints AS resultCheckpoints,p.result_summary AS resultSummary,
    p.result_evaluators AS resultEvaluators,p.result_source_plan_pinned AS resultSourcePlanPinned
    FROM session_branch_acknowledgements a JOIN artifact_push_requests p ON p.push_id=a.push_id
    LEFT JOIN artifact_push_terminals t ON t.push_id=p.push_id LEFT JOIN operations o ON o.operation_id=p.admission_operation_id
    LEFT JOIN cloud_sync_records c ON c.revision_id=p.cloud_acknowledgement_id AND c.operation_id=p.terminal_operation_id
    WHERE a.acknowledgement_id=?`,
    id
  );
}
export function materializeSessionRevision(view: ProjectReadView, id: string) {
  const row = revision(view, id);
  if (!row) sessionIntegrity();
  if (row.priorId === row.revisionId) sessionIntegrity();
  const prior = row.priorId === null ? null : revision(view, row.priorId);
  if (row.priorId !== null && !prior) sessionIntegrity();
  return {
    row,
    prior,
    ack: row.acknowledgementId === null ? null : acknowledgement(view, row.acknowledgementId),
  };
}
export function materializeSessionCurrent(view: ProjectReadView, key: ProjectSessionBranchKey) {
  const selection = readSessionSelection(view, key);
  assertSessionPresent(view, key, selection);
  return selection === null
    ? null
    : { selection, materialized: materializeSessionRevision(view, selection.revisionId) };
}
function originalState(row: SessionBranchRow) {
  if (
    !UuidV7Schema.safeParse(row.revisionId).success ||
    !UuidV7Schema.safeParse(row.operationId).success ||
    row.intentChange !== 0 ||
    row.payloadJson === null ||
    row.payloadHash !== digest(row.payloadJson) ||
    row.targetJson === null ||
    row.expectedJson === null ||
    row.resultJson === null ||
    !Number.isSafeInteger(row.originalVersion) ||
    row.originalVersion! < 1 ||
    !['session.branch.observe', 'artifact.push.complete'].includes(row.operationKind ?? '')
  )
    sessionIntegrity();
  if (row.originKind === 'observation') {
    const payload = SessionObservationPayloadSchema.parse(JSON.parse(row.payloadJson!));
    const before = expected.parse(JSON.parse(row.expectedJson!));
    const original = result.parse(JSON.parse(row.resultJson!));
    if (
      row.operationKind !== 'session.branch.observe' ||
      row.acknowledgementId !== null ||
      !isDeepStrictEqual(JSON.parse(row.targetJson!), sessionKey(row)) ||
      payload.revisionId !== row.revisionId ||
      payload.stateSha256 !== row.stateSha256 ||
      original.selection.revisionId !== row.revisionId ||
      original.selection.version !== row.originalVersion ||
      original.selection.version !== (before.selection?.version ?? 0) + 1 ||
      (before.selection?.revisionId ?? null) !== row.priorId
    )
      sessionIntegrity();
  } else if (
    row.originKind !== 'acknowledgement' ||
    row.operationKind !== 'artifact.push.complete' ||
    !UuidV7Schema.safeParse(row.acknowledgementId).success
  )
    sessionIntegrity();
  const value = decodeRetainedSessionBranch({
    key: sessionKey(row),
    stateBytes: Buffer.from(row.stateHex, 'hex'),
    stateSha256: row.stateSha256,
  });
  if (
    value.state.current_branch !== row.branch ||
    value.state.base_commit_sha !== row.base ||
    value.state.last_acked_at !== row.ackedAt
  )
    sessionIntegrity();
  return value;
}
export function decodeSessionRevision(materialized: ReturnType<typeof materializeSessionRevision>) {
  try {
    const { row, prior, ack } = materialized,
      key = sessionKey(row),
      decoded = originalState(row);
    const priorState = prior === null ? null : originalState(prior);
    if (prior !== null && !isDeepStrictEqual(sessionKey(prior), key)) sessionIntegrity();
    let selection: ProjectSessionBranchSelection;
    let expectedSelection: ProjectSessionBranchSelection | null;
    let gitObservation: z.infer<typeof observation> | null = null;
    if (row.originKind === 'observation') {
      if (
        row.operationKind !== 'session.branch.observe' ||
        row.acknowledgementId !== null ||
        ack !== null
      )
        sessionIntegrity();
      const payload = SessionObservationPayloadSchema.parse(JSON.parse(row.payloadJson!));
      const before = expected.parse(JSON.parse(row.expectedJson!));
      const original = result.parse(JSON.parse(row.resultJson!));
      if (
        !isDeepStrictEqual(JSON.parse(row.targetJson!), key) ||
        payload.revisionId !== row.revisionId ||
        payload.stateSha256 !== row.stateSha256 ||
        original.selection.revisionId !== row.revisionId ||
        original.selection.version !== (before.selection?.version ?? 0) + 1 ||
        (before.selection?.revisionId ?? null) !== (prior?.revisionId ?? null)
      )
        sessionIntegrity();
      const transition = validateSessionBranchObservation(
        {
          operationId: row.operationId,
          revisionId: row.revisionId,
          key,
          expectedSelection: before.selection,
          ...decoded,
        },
        priorState?.state ?? null,
        payload.observation
      );
      if (!transition.changed) sessionIntegrity();
      if (before.selection !== null && before.selection.version !== prior!.originalVersion)
        sessionIntegrity();
      selection = original.selection;
      expectedSelection = before.selection;
      gitObservation = payload.observation;
    } else {
      if (
        row.originKind !== 'acknowledgement' ||
        row.operationKind !== 'artifact.push.complete' ||
        !ack ||
        !prior ||
        !priorState
      )
        sessionIntegrity();
      const ownKey = {
        target: { server_url: ack.server, org_id: ack.org, account_id: ack.account },
        repoUrl: ack.repoUrl,
        workingDir: ack.workingDir,
      };
      if (
        !isDeepStrictEqual(ownKey, key) ||
        ack.pushServer !== row.server ||
        ack.pushOrg !== row.org ||
        ack.pushAccount !== row.account ||
        ack.pushRepoUrl !== row.repoUrl ||
        ack.pushWorkingDir !== row.workingDir ||
        ack.acknowledgementId !== row.acknowledgementId ||
        ack.reservedAcknowledgementId !== row.acknowledgementId ||
        ack.resultRevisionId !== row.revisionId ||
        ack.reservedResultRevisionId !== row.revisionId ||
        ack.operationId !== row.operationId ||
        ack.terminalOperationId !== row.operationId ||
        ack.terminalId !== row.operationId ||
        ack.applied !== 1 ||
        ack.sessionApplied !== 1 ||
        ack.admissionKind !== 'artifact.push.begin' ||
        ![0, 1].includes(ack.cloudApplied!) ||
        // The same terminal receipt records the push's cloud acknowledgment; the
        // session revision is only original history if that counterpart agrees.
        ack.cloudRecordKind !== 'acknowledgement' ||
        ack.cloudRecordApplied !== ack.cloudApplied ||
        ack.cloudRecordPushId !== ack.pushId ||
        ack.expectedVersion !== prior.originalVersion ||
        ack.expectedRevisionId !== prior.revisionId ||
        ack.pushSessionRevisionId !== prior.revisionId ||
        ack.pushSessionVersion !== ack.expectedVersion ||
        ack.ackedAt !== ack.terminalTime ||
        ack.ackedAt !== row.ackedAt ||
        (priorState.state.last_acked_at !== null &&
          ack.ackedAt <= priorState.state.last_acked_at) ||
        !isDeepStrictEqual(decoded.state, {
          ...priorState.state,
          branch_history: [],
          last_acked_at: ack.ackedAt,
        })
      )
        sessionIntegrity();
      const target = { artifactId: ack.pushArtifactId, target: key.target };
      const terminal = {
        pushId: ack.pushId,
        acknowledgedAt: ack.ackedAt,
        sessionApplied: true,
        cloudApplied: ack.cloudApplied === 1,
        result: {
          checkpoints: ack.resultCheckpoints,
          summary: ack.resultSummary === 1,
          evaluators: ack.resultEvaluators,
          sourcePlanPinned: ack.resultSourcePlanPinned,
        },
      };
      if (
        !isDeepStrictEqual(JSON.parse(row.targetJson!), target) ||
        !isDeepStrictEqual(JSON.parse(row.payloadJson!), { pushId: ack.pushId }) ||
        !isDeepStrictEqual(JSON.parse(row.expectedJson!), {}) ||
        !isDeepStrictEqual(JSON.parse(row.resultJson!), terminal)
      )
        sessionIntegrity();
      selection = SessionBranchSelectionSchema.parse({
        revisionId: row.revisionId,
        version: ack.expectedVersion + 1,
      });
      expectedSelection = SessionBranchSelectionSchema.parse({
        revisionId: prior.revisionId,
        version: ack.expectedVersion,
      });
    }
    return { row, key, ...decoded, selection, expectedSelection, observation: gitObservation };
  } catch (cause) {
    return sessionIntegrity(cause);
  }
}
export function sessionObservationOperation(input: {
  operationId: string;
  revisionId: string;
  key: ProjectSessionBranchKey;
  expectedSelection: ProjectSessionBranchSelection | null;
  stateSha256: string;
  observation: z.infer<typeof observation>;
}) {
  return {
    operationId: input.operationId,
    kind: 'session.branch.observe',
    intentChange: false,
    target: JSON.parse(canonicalJson(input.key)),
    payload: {
      revisionId: input.revisionId,
      stateSha256: input.stateSha256,
      observation: input.observation,
    },
    expectedState: { selection: input.expectedSelection },
  };
}
