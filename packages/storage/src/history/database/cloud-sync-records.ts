import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { canonicalJson } from '../../events/canonical-json.js';
import { UuidV7Schema } from '../../ids/uuidv7.js';
import { canonicalizeBaseUrl } from '../../source-plan/canonical-base-url.js';
import { digest, DigestSchema } from '../event-integrity.js';
import {
  CloudSyncFailureInputSchema,
  type CloudSyncFailurePreparation,
} from './cloud-sync-input.js';
import type { ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { assertUsageSelection } from './usage-selection.js';

const positive = z.number().int().positive().safe();
const selection = z.strictObject({ revisionId: UuidV7Schema, version: positive });
const keySchema = CloudSyncFailureInputSchema.pick({ artifactId: true, target: true });
export type CloudSyncKey = z.infer<typeof keySchema>;
export type CloudSyncSelection = z.infer<typeof selection>;
export function cloudIntegrity(cause?: unknown): never {
  throw new ProjectDatabaseError(
    'HISTORY_INTEGRITY_REQUIRED',
    'Original cloud state, selection or operation ownership is missing or inconsistent; preserve history for explicit repair',
    { cause }
  );
}
export function parseCloudSyncKey(value: unknown): CloudSyncKey {
  try {
    const key = keySchema.parse(value),
      url = new URL(key.target.server_url);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      canonicalizeBaseUrl(key.target.server_url) !== key.target.server_url
    )
      throw new Error('Noncanonical target');
    return key;
  } catch (cause) {
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Select an exact artifact and known canonical cloud account',
      { cause }
    );
  }
}
const recordSchema = z.strictObject({
  revision_id: UuidV7Schema,
  operation_id: UuidV7Schema,
  kind: z.enum(['failure', 'acknowledgement']),
  artifact_id: UuidV7Schema,
  server_url: z.string().min(1),
  org_id: z.string().min(1),
  account_id: z.string().min(1),
  previous_revision_id: UuidV7Schema.nullable(),
  previous_version: positive.nullable(),
  applied: z.union([z.literal(0), z.literal(1)]),
  push_id: UuidV7Schema.nullable(),
  artifact_generation: positive.nullable(),
  usage_generation: positive.nullable(),
  acknowledged_at: z.string().min(1).nullable(),
  failure_kind: CloudSyncFailureInputSchema.shape.kind.nullable(),
  failure_message: z.string().nullable(),
  attempted_at: z.string().min(1).nullable(),
  attempt_started_at: z.string().min(1).nullable(),
  record_sha256: DigestSchema,
  operationKind: z.string().nullable(),
  targetJson: z.string().nullable(),
  payloadJson: z.string().nullable(),
  payloadHash: z.string().nullable(),
  expectedJson: z.string().nullable(),
  resultJson: z.string().nullable(),
  intentChange: z.number().nullable(),
});
export type CloudSyncRecord = z.infer<typeof recordSchema>;
const recordColumns = `r.*,o.operation_kind AS operationKind,o.target_json AS targetJson,o.payload_json AS payloadJson,
 o.payload_hash AS payloadHash,o.expected_state_json AS expectedJson,o.result_json AS resultJson,o.intent_change AS intentChange`;
export function cloudKey(row: CloudSyncRecord): CloudSyncKey {
  return {
    artifactId: row.artifact_id,
    target: { server_url: row.server_url, org_id: row.org_id, account_id: row.account_id },
  };
}
export function cloudScope(key: CloudSyncKey) {
  return [key.artifactId, key.target.server_url, key.target.org_id, key.target.account_id];
}
export function previousCloudSelection(row: CloudSyncRecord): CloudSyncSelection | null {
  if ((row.previous_revision_id === null) !== (row.previous_version === null)) cloudIntegrity();
  return row.previous_revision_id === null
    ? null
    : { revisionId: row.previous_revision_id, version: row.previous_version! };
}
export function cloudFailureOperation(prepared: CloudSyncFailurePreparation) {
  const input = prepared.input;
  return {
    operationId: input.operationId,
    kind: 'cloud.sync.failure',
    intentChange: false,
    target: { artifactId: input.artifactId, target: input.target },
    payload: { revisionId: input.revisionId, inputSha256: prepared.inputSha256 },
    expectedState: {},
  };
}
export function cloudFailureResult(row: CloudSyncRecord) {
  const previousSelection = previousCloudSelection(row);
  return {
    revisionId: row.revision_id,
    previousSelection,
    applied: row.applied === 1,
    selection:
      row.applied === 1
        ? { revisionId: row.revision_id, version: (row.previous_version ?? 0) + 1 }
        : previousSelection,
  };
}
export function originalCloudFailure(row: CloudSyncRecord) {
  return CloudSyncFailureInputSchema.parse({
    operationId: row.operation_id,
    revisionId: row.revision_id,
    ...cloudKey(row),
    kind: row.failure_kind,
    message: row.failure_message,
    attemptedAt: row.attempted_at,
    attemptStartedAt: row.attempt_started_at,
  });
}
export function cloudAcknowledgementHash(row: CloudSyncRecord): string {
  return digest(
    canonicalJson({
      revisionId: row.revision_id,
      operationId: row.operation_id,
      ...cloudKey(row),
      pushId: row.push_id,
      artifactGeneration: row.artifact_generation,
      usageGeneration: row.usage_generation,
      acknowledgedAt: row.acknowledged_at,
      previousSelection: previousCloudSelection(row),
      applied: row.applied === 1,
    })
  );
}
function acknowledgementOwner(view: ProjectReadView, row: CloudSyncRecord) {
  const header = view.get<Record<string, string | number | null>>(
    `SELECT p.*,t.operation_id AS terminalId,t.acknowledged_at AS terminalTime,
    t.cloud_applied AS cloudApplied,t.session_applied AS sessionApplied,o.operation_kind AS admissionKind
    FROM artifact_push_requests p LEFT JOIN artifact_push_terminals t ON t.push_id=p.push_id
    LEFT JOIN operations o ON o.operation_id=p.admission_operation_id WHERE p.push_id=?`,
    row.push_id
  );
  const calls = view.all<{
    ordinal: number;
    requestId: string;
    attemptId: string;
    outcomeId: string;
    kind: string | null;
    owner: string | null;
    requestPush: string | null;
    requestOrdinal: number | null;
    attemptOperation: string | null;
    outcomeOperation: string | null;
  }>(
    `
    SELECT c.ordinal,c.request_id AS requestId,c.attempt_id AS attemptId,c.outcome_id AS outcomeId,o.kind,
      r.owner_kind AS owner,r.push_id AS requestPush,r.call_ordinal AS requestOrdinal,
      ao.operation_id AS attemptOperation,x.operation_id AS outcomeOperation
    FROM artifact_push_terminal_calls c
    LEFT JOIN remote_requests r ON r.request_id=c.request_id
    LEFT JOIN remote_attempts a ON a.attempt_id=c.attempt_id AND a.request_id=c.request_id
    LEFT JOIN operations ao ON ao.operation_id=a.operation_id AND ao.operation_kind='remote.attempt'
    LEFT JOIN remote_outcomes o ON o.outcome_id=c.outcome_id AND o.request_id=c.request_id AND o.attempt_id=c.attempt_id
    LEFT JOIN operations x ON x.operation_id=o.operation_id AND x.operation_kind='remote.outcome'
    WHERE c.push_id=? ORDER BY c.ordinal`,
    row.push_id
  );
  return { header, calls };
}
export function selectCloudState(view: ProjectReadView, key: CloudSyncKey) {
  const scope = cloudScope(key);
  const current = view.get<CloudSyncSelection>(
    'SELECT revision_id AS revisionId,version FROM cloud_sync_current WHERE artifact_id=? AND server_url=? AND org_id=? AND account_id=?',
    ...scope
  );
  const rows = view.all<CloudSyncRecord>(
    `SELECT ${recordColumns} FROM cloud_sync_records r LEFT JOIN operations o ON o.operation_id=r.operation_id
    WHERE r.artifact_id=? AND r.server_url=? AND r.org_id=? AND r.account_id=?`,
    ...scope
  );
  if (
    view.get(
      `SELECT 1 FROM operations o WHERE o.operation_kind IN ('cloud.sync.failure','artifact.push.complete')
    AND json_extract(o.target_json,'$.artifactId')=? AND json_extract(o.target_json,'$.target.server_url')=?
    AND json_extract(o.target_json,'$.target.org_id')=? AND json_extract(o.target_json,'$.target.account_id')=?
    AND NOT EXISTS(SELECT 1 FROM cloud_sync_records r WHERE r.operation_id=o.operation_id) LIMIT 1`,
      ...scope
    )
  )
    cloudIntegrity();
  return {
    key,
    current,
    rows,
    owners: rows
      .filter((row) => row.kind === 'acknowledgement')
      .map((row) => ({ revisionId: row.revision_id, ...acknowledgementOwner(view, row) })),
  };
}
export function decodeCloudState(copied: ReturnType<typeof selectCloudState>) {
  try {
    const current = copied.current === null ? null : selection.parse(copied.current);
    parseCloudSyncKey(copied.key);
    const records = copied.rows.map((row) => recordSchema.parse(row));
    const byId = new Map(records.map((row) => [row.revision_id, row]));
    if (byId.size !== records.length) cloudIntegrity();
    for (const row of records) {
      if (
        !isDeepStrictEqual(cloudKey(row), copied.key) ||
        row.intentChange !== 0 ||
        row.payloadJson === null ||
        row.payloadHash !== digest(row.payloadJson) ||
        row.targetJson === null ||
        !isDeepStrictEqual(JSON.parse(row.targetJson), copied.key) ||
        row.expectedJson === null ||
        !isDeepStrictEqual(JSON.parse(row.expectedJson), {}) ||
        row.resultJson === null
      )
        cloudIntegrity();
      const before = previousCloudSelection(row);
      if (before !== null) {
        const prior = byId.get(before.revisionId);
        if (
          !prior ||
          prior.applied !== 1 ||
          (prior.previous_version ?? 0) + 1 !== before.version ||
          prior.revision_id === row.revision_id
        )
          cloudIntegrity();
      }
      if (row.kind === 'failure') {
        if (
          row.operationKind !== 'cloud.sync.failure' ||
          row.push_id !== null ||
          row.artifact_generation !== null ||
          row.usage_generation !== null ||
          row.acknowledged_at !== null
        )
          cloudIntegrity();
        const input = originalCloudFailure(row),
          inputSha256 = digest(canonicalJson(input));
        if (
          row.record_sha256 !== inputSha256 ||
          !isDeepStrictEqual(JSON.parse(row.payloadJson), {
            revisionId: row.revision_id,
            inputSha256,
          }) ||
          !isDeepStrictEqual(JSON.parse(row.resultJson), cloudFailureResult(row))
        )
          cloudIntegrity();
      } else {
        const owner = copied.owners.find((value) => value.revisionId === row.revision_id),
          p = owner?.header;
        if (
          !p ||
          row.operationKind !== 'artifact.push.complete' ||
          row.push_id === null ||
          row.artifact_generation === null ||
          row.acknowledged_at === null ||
          row.failure_kind !== null ||
          row.failure_message !== null ||
          row.attempted_at !== null ||
          row.attempt_started_at !== null ||
          row.record_sha256 !== cloudAcknowledgementHash(row) ||
          p.admissionKind !== 'artifact.push.begin' ||
          p.terminalId !== row.operation_id ||
          p.terminal_operation_id !== row.operation_id ||
          p.cloud_acknowledgement_id !== row.revision_id ||
          p.artifact_id !== row.artifact_id ||
          p.server_url !== row.server_url ||
          p.org_id !== row.org_id ||
          p.account_id !== row.account_id ||
          p.artifact_generation !== row.artifact_generation ||
          p.usage_generation !== row.usage_generation ||
          p.expected_cloud_revision_id !== row.previous_revision_id ||
          p.expected_cloud_version !== row.previous_version ||
          p.terminalTime !== row.acknowledged_at ||
          p.cloudApplied !== row.applied ||
          ![null, 0, 1].includes(p.sessionApplied as number | null) ||
          // A terminal reports a session outcome exactly when its push reserved
          // session state; anything else attributes a session result to a push
          // that never had one.
          (p.session_acknowledgement_id === null) !== (p.sessionApplied === null) ||
          !isDeepStrictEqual(JSON.parse(row.payloadJson), { pushId: row.push_id })
        )
          cloudIntegrity();
        const terminal = {
          pushId: row.push_id,
          acknowledgedAt: row.acknowledged_at,
          sessionApplied: p.sessionApplied === null ? null : p.sessionApplied === 1,
          cloudApplied: row.applied === 1,
          result: {
            checkpoints: p.result_checkpoints,
            summary: p.result_summary === 1,
            evaluators: p.result_evaluators,
            sourcePlanPinned: p.result_source_plan_pinned,
          },
        };
        if (
          !isDeepStrictEqual(JSON.parse(row.resultJson), terminal) ||
          owner!.calls.length !== p.call_count
        )
          cloudIntegrity();
        owner!.calls.forEach((call, index) => {
          if (
            call.ordinal !== index + 1 ||
            call.requestOrdinal !== call.ordinal ||
            call.requestPush !== row.push_id ||
            call.owner !== 'artifact_push' ||
            call.kind !== 'acknowledged' ||
            call.attemptOperation === null ||
            call.outcomeOperation === null
          )
            cloudIntegrity();
        });
      }
    }
    const chain: CloudSyncRecord[] = [];
    let selected = current;
    while (selected !== null) {
      const row = byId.get(selected.revisionId);
      if (
        !row ||
        row.applied !== 1 ||
        (row.previous_version ?? 0) + 1 !== selected.version ||
        chain.length >= records.length
      )
        cloudIntegrity();
      chain.push(row);
      selected = previousCloudSelection(row);
    }
    if (chain.length !== records.filter((row) => row.applied === 1).length) cloudIntegrity();
    const success = chain.find((row) => row.kind === 'acknowledgement') ?? null;
    const failure = chain[0]?.kind === 'failure' ? chain[0] : null;
    const failures = success === null ? chain.length : chain.indexOf(success);
    const successes = new Map<string, CloudSyncRecord | null>();
    for (const row of [...chain].reverse()) {
      const before = previousCloudSelection(row);
      const ack = before === null ? null : successes.get(before.revisionId)!;
      successes.set(row.revision_id, row.kind === 'acknowledgement' ? row : ack);
    }
    for (const row of records) {
      const before = previousCloudSelection(row);
      if (before !== null && !successes.has(before.revisionId)) cloudIntegrity();
      const ack = before === null ? null : successes.get(before.revisionId)!;
      if (
        row.kind === 'failure' &&
        (row.applied === 1) !== (ack === null || row.attempt_started_at! > ack.acknowledged_at!)
      )
        cloudIntegrity();
      if (
        row.kind === 'acknowledgement' &&
        row.applied === 1 &&
        ack !== null &&
        row.acknowledged_at! <= ack.acknowledged_at!
      )
        cloudIntegrity();
    }
    return {
      key: copied.key,
      selection: current,
      records,
      chain,
      success,
      failure,
      consecutiveFailures: failures,
    };
  } catch (cause) {
    return cloudIntegrity(cause);
  }
}
export function selectCloudSources(view: ProjectReadView, artifactId: string) {
  const artifact = view.get<{ generation: number; operationId: string | null }>(
    `SELECT r.generation,o.operation_id AS operationId FROM artifacts a JOIN artifact_revisions r ON r.artifact_id=a.artifact_id AND r.generation=a.current_generation LEFT JOIN operations o ON o.operation_id=r.operation_id WHERE a.artifact_id=?`,
    artifactId
  );
  if (!artifact) {
    if (
      view.get(
        `SELECT 1 FROM artifacts WHERE artifact_id=? UNION ALL SELECT 1 FROM artifact_revisions WHERE artifact_id=? UNION ALL SELECT 1 FROM artifact_events WHERE artifact_id=?
      UNION ALL SELECT 1 FROM cloud_sync_records WHERE artifact_id=? UNION ALL SELECT 1 FROM artifact_push_requests WHERE artifact_id=?
      UNION ALL SELECT 1 FROM operations WHERE json_extract(target_json,'$.artifactId')=? LIMIT 1`,
        artifactId,
        artifactId,
        artifactId,
        artifactId,
        artifactId,
        artifactId
      )
    )
      cloudIntegrity();
    return null;
  }
  if (artifact.operationId === null) cloudIntegrity();
  assertUsageSelection(view);
  const usage = view.get<{ generation: number; operationId: string | null }>(
    'SELECT s.current_generation AS generation,o.operation_id AS operationId FROM usage_selection s JOIN usage_revisions r ON r.generation=s.current_generation LEFT JOIN operations o ON o.operation_id=r.operation_id WHERE s.singleton=1'
  );
  if (
    usage?.operationId === null ||
    (!usage && view.get("SELECT 1 FROM operations WHERE operation_kind='usage.append' LIMIT 1"))
  )
    cloudIntegrity();
  return { artifactGeneration: artifact.generation, usageGeneration: usage?.generation ?? null };
}
