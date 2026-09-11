import { isDeepStrictEqual } from 'node:util';

import { canonicalJson } from '../../events/canonical-json.js';
import { digest } from '../event-integrity.js';
import type { ProjectCounters, ProjectDatabase, ProjectReadView } from './connection.js';
import { assertProjectDatabasePath } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { readProjectRemoteRequest } from './remote-transport-reader.js';
import {
  decodeSourcePlanLocatorRow,
  retainSourcePlanNamespace,
  sourcePlanIntegrity,
  sourcePlanLocatorReceiptExists,
  sourcePlanLocatorRow,
  sourcePlanNamespaceRow,
} from './source-plan-records.js';
import {
  decodeRetainedProjectSourcePlanUploadCommand,
  parseSourcePlanUploadResponse,
  parseSourcePlanUploadResult,
  prepareProjectSourcePlanUploadCommand,
  projectSourcePlanUploadCommand,
  type ProjectSourcePlanUploadCommandInput,
  type SourcePlanUploadCommandPreparation,
  sourcePlanUploadExpectedSelection,
  type SourcePlanUploadPriorLocator,
  type SourcePlanUploadResponse,
  type SourcePlanUploadResult,
} from './source-plan-upload-input.js';
import { type ProjectOperationOptions, runProjectOperation } from './transactions.js';

interface OperationRow {
  kind: string;
  intentChange: number;
  targetJson: string;
  payloadJson: string;
  payloadHash: string;
  expectedJson: string;
  resultJson: string;
}
interface CommandRow {
  commandId: string;
  operationId: string;
  terminalOperationId: string;
  requestOperationId: string;
  requestId: string;
  locatorOperationId: string;
  locatorRevisionId: string;
  namespaceId: string;
  serverUrl: string;
  orgId: string;
  accountId: string;
  realPath: string;
  fingerprint: string;
  externalId: string;
  expectedLocatorRevisionId: string | null;
  expectedLocatorVersion: number | null;
  payloadSha256: string;
  preparedAt: string;
  retainedNamespaceId: string | null;
  retainedScopeKind: string | null;
  retainedServerUrl: string | null;
  retainedOrgId: string | null;
  retainedAccountId: string | null;
  retainedOriginalNamespaceHash: string | null;
  retainedOriginalLocatorHash: string | null;
  admissionKind: string | null;
  admissionIntentChange: number | null;
  admissionTargetJson: string | null;
  admissionPayloadJson: string | null;
  admissionPayloadHash: string | null;
  admissionExpectedJson: string | null;
  admissionResultJson: string | null;
  terminalKind: string | null;
  terminalIntentChange: number | null;
  terminalTargetJson: string | null;
  terminalPayloadJson: string | null;
  terminalPayloadHash: string | null;
  terminalExpectedJson: string | null;
  terminalResultJson: string | null;
}

export interface ProjectSourcePlanUploadAdmission extends Record<string, string> {
  commandId: string;
  requestId: string;
  locatorRevisionId: string;
}
export interface ProjectSourcePlanUploadTerminal {
  operationId: string;
  outcomeId: string;
  locatorRevisionId: string;
  result: SourcePlanUploadResult;
}
export interface ProjectSourcePlanUpload {
  input: ProjectSourcePlanUploadCommandInput;
  prepared: SourcePlanUploadCommandPreparation;
  admission: ProjectSourcePlanUploadAdmission;
  terminal: ProjectSourcePlanUploadTerminal | null;
}

function integrity(cause?: unknown): never {
  throw new ProjectDatabaseError(
    'HISTORY_INTEGRITY_REQUIRED',
    'Original Source Plan upload command, transport, locator, or operation ownership is missing or inconsistent; preserve history for explicit repair',
    { cause }
  );
}
function conflict(): never {
  throw new ProjectDatabaseError(
    'IDEMPOTENCY_CONFLICT',
    'This Source Plan upload or original child identity owns different retained input; resume the original operation or use explicitly new identities'
  );
}
function stale(): never {
  throw new ProjectDatabaseError(
    'STALE_CONTEXT',
    'The original Source Plan upload locator selection changed; preserve the acknowledged command and prepare an explicitly new upload from current history'
  );
}
function operation(view: ProjectReadView, id: string) {
  return view.get<OperationRow>(
    `SELECT operation_kind AS kind,intent_change AS intentChange,target_json AS targetJson,
    payload_json AS payloadJson,payload_hash AS payloadHash,expected_state_json AS expectedJson,
    result_json AS resultJson FROM operations WHERE operation_id=?`,
    id
  );
}
function commandRow(
  view: ProjectReadView,
  field: 'command_id' | 'admission_operation_id',
  id: string
) {
  return view.get<CommandRow>(
    `SELECT c.command_id AS commandId,c.admission_operation_id AS operationId,
    c.terminal_operation_id AS terminalOperationId,c.request_operation_id AS requestOperationId,
    c.request_id AS requestId,c.locator_operation_id AS locatorOperationId,
    c.locator_revision_id AS locatorRevisionId,c.namespace_id AS namespaceId,
    c.server_url AS serverUrl,c.org_id AS orgId,c.account_id AS accountId,c.real_path AS realPath,
    c.fingerprint,c.external_id AS externalId,c.expected_locator_revision_id AS expectedLocatorRevisionId,
    c.expected_locator_version AS expectedLocatorVersion,c.payload_sha256 AS payloadSha256,
    c.prepared_at AS preparedAt,
    n.namespace_id AS retainedNamespaceId,n.scope_kind AS retainedScopeKind,
    n.server_url AS retainedServerUrl,n.org_id AS retainedOrgId,n.account_id AS retainedAccountId,
    n.original_namespace_hash AS retainedOriginalNamespaceHash,
    n.original_locator_hash AS retainedOriginalLocatorHash,
    a.operation_kind AS admissionKind,a.intent_change AS admissionIntentChange,
    a.target_json AS admissionTargetJson,a.payload_json AS admissionPayloadJson,
    a.payload_hash AS admissionPayloadHash,a.expected_state_json AS admissionExpectedJson,
    a.result_json AS admissionResultJson,
    t.operation_kind AS terminalKind,t.intent_change AS terminalIntentChange,
    t.target_json AS terminalTargetJson,t.payload_json AS terminalPayloadJson,
    t.payload_hash AS terminalPayloadHash,t.expected_state_json AS terminalExpectedJson,
    t.result_json AS terminalResultJson
    FROM source_plan_upload_commands c
    LEFT JOIN source_plan_namespaces n ON n.namespace_id=c.namespace_id
    LEFT JOIN operations a ON a.operation_id=c.admission_operation_id
    LEFT JOIN operations t ON t.operation_id=c.terminal_operation_id
    WHERE c.${field}=?`,
    id
  );
}
function parseJson(value: string): unknown {
  try {
    const parsed = JSON.parse(value);
    if (canonicalJson(parsed) !== value) integrity();
    return parsed;
  } catch (cause) {
    return integrity(cause);
  }
}
function selectedUploadLocator(
  view: ProjectReadView,
  namespaceId: string,
  realPath: string
): SourcePlanUploadPriorLocator | null {
  const selected = view.get<{ recordId: string; version: number }>(
    `SELECT revision_id AS recordId,version FROM source_plan_locator_current
    WHERE namespace_id=? AND kind='upload' AND locator_kind='real_path' AND locator=?`,
    namespaceId,
    realPath
  );
  if (!selected) {
    if (
      view.get(
        "SELECT revision_id FROM source_plan_locator_revisions WHERE namespace_id=? AND kind='upload' AND real_path=? LIMIT 1",
        namespaceId,
        realPath
      ) ||
      sourcePlanLocatorReceiptExists(view, namespaceId, 'upload', realPath)
    )
      sourcePlanIntegrity();
    return null;
  }
  const row = sourcePlanLocatorRow(view, selected.recordId);
  const scope = sourcePlanNamespaceRow(view, namespaceId);
  if (!row || !scope || row.namespaceId !== namespaceId) sourcePlanIntegrity();
  const decoded = decodeSourcePlanLocatorRow(row, scope);
  if (
    decoded.kind !== 'upload' ||
    decoded.realPath !== realPath ||
    decoded.fingerprint === null ||
    selected.version !== (decoded.expectedSelection?.version ?? 0) + 1
  )
    sourcePlanIntegrity();
  const original = parseJson(Buffer.from(decoded.recordBase64, 'base64').toString('utf8')) as {
    fingerprint?: unknown;
    external_id?: unknown;
    unresolved?: unknown;
  };
  if (
    original.fingerprint !== decoded.fingerprint ||
    original.external_id !== decoded.externalId ||
    !Array.isArray(original.unresolved) ||
    !original.unresolved.every((item) => typeof item === 'string')
  )
    sourcePlanIntegrity();
  return {
    selection: selected,
    fingerprint: decoded.fingerprint,
    externalId: decoded.externalId,
    unresolved: original.unresolved,
  };
}
function admissionOperation(prepared: SourcePlanUploadCommandPreparation) {
  return {
    operationId: prepared.operationId,
    kind: 'source_plan.upload.begin',
    target: {
      commandId: prepared.commandId,
      target: prepared.target,
      namespaceId: prepared.namespace.namespaceId,
      realPath: prepared.realPath,
    },
    payload: {
      terminalOperationId: prepared.terminalOperationId,
      requestOperationId: prepared.requestOperationId,
      requestId: prepared.requestId,
      locatorOperationId: prepared.locatorOperationId,
      locatorRevisionId: prepared.locatorRevisionId,
      preparedAt: prepared.preparedAt,
      payloadJson: Buffer.from(prepared.payloadBase64, 'base64').toString('utf8'),
      payloadSha256: prepared.payloadSha256,
      fingerprint: prepared.fingerprint,
      externalId: prepared.externalId,
      expectedLocator: prepared.expectedLocator,
    },
    expectedState: sourcePlanUploadExpectedSelection(prepared.expectedLocator),
    intentChange: false,
  } as const;
}
function admissionResult(
  prepared: SourcePlanUploadCommandPreparation
): ProjectSourcePlanUploadAdmission {
  return {
    commandId: prepared.commandId,
    requestId: prepared.requestId,
    locatorRevisionId: prepared.locatorRevisionId,
  };
}
function decodeCommand(row: CommandRow) {
  if (
    row.admissionKind === null ||
    row.admissionIntentChange === null ||
    row.admissionTargetJson === null ||
    row.admissionPayloadJson === null ||
    row.admissionPayloadHash === null ||
    row.admissionExpectedJson === null ||
    row.admissionResultJson === null
  )
    integrity();
  const target = parseJson(row.admissionTargetJson) as Record<string, unknown>;
  const payload = parseJson(row.admissionPayloadJson) as Record<string, unknown>;
  const expected = parseJson(row.admissionExpectedJson);
  const result = parseJson(row.admissionResultJson);
  if (
    row.admissionKind !== 'source_plan.upload.begin' ||
    row.admissionIntentChange !== 0 ||
    row.admissionPayloadHash !== digest(row.admissionPayloadJson) ||
    !isDeepStrictEqual(result, {
      commandId: row.commandId,
      requestId: row.requestId,
      locatorRevisionId: row.locatorRevisionId,
    }) ||
    !isDeepStrictEqual(
      expected,
      row.expectedLocatorRevisionId === null
        ? null
        : { recordId: row.expectedLocatorRevisionId, version: row.expectedLocatorVersion }
    )
  )
    integrity();
  const targetValue = target.target as ProjectSourcePlanUploadCommandInput['target'];
  if (
    target.commandId !== row.commandId ||
    target.namespaceId !== row.namespaceId ||
    target.realPath !== row.realPath ||
    !targetValue ||
    targetValue.server_url !== row.serverUrl ||
    targetValue.org_id !== row.orgId ||
    targetValue.account_id !== row.accountId
  )
    integrity();
  const scope = rowNamespace(row);
  const expectedLocator = (payload.expectedLocator ?? null) as SourcePlanUploadPriorLocator | null;
  if (
    payload.terminalOperationId !== row.terminalOperationId ||
    payload.requestOperationId !== row.requestOperationId ||
    payload.requestId !== row.requestId ||
    payload.locatorOperationId !== row.locatorOperationId ||
    payload.locatorRevisionId !== row.locatorRevisionId ||
    payload.preparedAt !== row.preparedAt ||
    payload.payloadSha256 !== row.payloadSha256 ||
    payload.fingerprint !== row.fingerprint ||
    payload.externalId !== row.externalId ||
    typeof payload.payloadJson !== 'string' ||
    digest(payload.payloadJson) !== row.payloadSha256 ||
    !isDeepStrictEqual(
      sourcePlanUploadExpectedSelection(expectedLocator),
      row.expectedLocatorRevisionId === null
        ? null
        : { recordId: row.expectedLocatorRevisionId, version: row.expectedLocatorVersion }
    )
  )
    integrity();
  const input: ProjectSourcePlanUploadCommandInput = {
    commandId: row.commandId,
    operationId: row.operationId,
    terminalOperationId: row.terminalOperationId,
    requestOperationId: row.requestOperationId,
    requestId: row.requestId,
    locatorOperationId: row.locatorOperationId,
    locatorRevisionId: row.locatorRevisionId,
    target: targetValue,
    namespace: scope,
    realPath: row.realPath,
    expectedLocator,
    preparedAt: row.preparedAt,
    payloadBytes: Buffer.from(payload.payloadJson, 'utf8'),
  };
  const prepared = projectSourcePlanUploadCommand(
    decodeRetainedProjectSourcePlanUploadCommand(input)
  );
  if (
    prepared.fingerprint !== row.fingerprint ||
    prepared.externalId !== row.externalId ||
    prepared.payloadSha256 !== row.payloadSha256
  )
    integrity();
  return { input, prepared };
}
function rowNamespace(row: CommandRow): ProjectSourcePlanUploadCommandInput['namespace'] {
  if (
    row.retainedNamespaceId !== row.namespaceId ||
    row.retainedScopeKind !== 'account' ||
    row.retainedServerUrl !== row.serverUrl ||
    row.retainedOrgId !== row.orgId ||
    row.retainedAccountId !== row.accountId ||
    row.retainedOriginalNamespaceHash !== null ||
    row.retainedOriginalLocatorHash !== null
  )
    integrity();
  return {
    namespaceId: row.namespaceId,
    scopeKind: 'account',
    serverUrl: row.serverUrl,
    orgId: row.orgId,
    accountId: row.accountId,
    originalNamespaceHash: null,
    originalLocatorHash: null,
  };
}
function validateExpectedLocator(
  view: ProjectReadView,
  row: CommandRow,
  expected: SourcePlanUploadPriorLocator | null
): void {
  if (expected === null) return;
  const retained = sourcePlanLocatorRow(view, expected.selection.recordId);
  const namespace = sourcePlanNamespaceRow(view, row.namespaceId);
  if (!retained || !namespace || retained.namespaceId !== row.namespaceId) integrity();
  const decoded = decodeSourcePlanLocatorRow(retained, namespace);
  const content = parseJson(Buffer.from(decoded.recordBase64, 'base64').toString('utf8')) as {
    fingerprint?: unknown;
    external_id?: unknown;
    unresolved?: unknown;
  };
  if (
    decoded.kind !== 'upload' ||
    decoded.realPath !== row.realPath ||
    expected.selection.version !== (decoded.expectedSelection?.version ?? 0) + 1 ||
    decoded.fingerprint !== expected.fingerprint ||
    decoded.externalId !== expected.externalId ||
    content.fingerprint !== expected.fingerprint ||
    content.external_id !== expected.externalId ||
    !isDeepStrictEqual(content.unresolved, expected.unresolved)
  )
    integrity();
}
function terminal(row: CommandRow): ProjectSourcePlanUploadTerminal | null {
  if (row.terminalKind === null) return null;
  if (
    row.terminalIntentChange === null ||
    row.terminalTargetJson === null ||
    row.terminalPayloadJson === null ||
    row.terminalPayloadHash === null ||
    row.terminalExpectedJson === null ||
    row.terminalResultJson === null
  )
    integrity();
  if (
    row.terminalKind !== 'source_plan.upload.complete' ||
    row.terminalIntentChange !== 0 ||
    row.terminalPayloadHash !== digest(row.terminalPayloadJson) ||
    !isDeepStrictEqual(parseJson(row.terminalTargetJson), { commandId: row.commandId }) ||
    !isDeepStrictEqual(parseJson(row.terminalExpectedJson), {})
  )
    integrity();
  const payload = parseJson(row.terminalPayloadJson) as Record<string, unknown>;
  if (
    payload.requestId !== row.requestId ||
    payload.locatorRevisionId !== row.locatorRevisionId ||
    typeof payload.outcomeId !== 'string'
  )
    integrity();
  return {
    operationId: row.terminalOperationId,
    outcomeId: payload.outcomeId,
    locatorRevisionId: row.locatorRevisionId,
    result: parseSourcePlanUploadResult(parseJson(row.terminalResultJson)),
  };
}
function sourcePlanUploadEffects(
  view: ProjectReadView,
  row: CommandRow,
  outcomeId: string,
  response: SourcePlanUploadResponse,
  result: SourcePlanUploadResult
): void {
  const expectedLocator = decodeCommand(row).prepared.expectedLocator;
  const priorExternalId =
    expectedLocator !== null && expectedLocator.externalId !== row.externalId
      ? expectedLocator.externalId
      : undefined;
  const outcome = view.get<{ kind: string; requestId: string; operationKind: string | null }>(
    `SELECT o.kind,o.request_id AS requestId,p.operation_kind AS operationKind
    FROM remote_outcomes o LEFT JOIN operations p ON p.operation_id=o.operation_id
    WHERE o.outcome_id=?`,
    outcomeId
  );
  const locator = sourcePlanLocatorRow(view, row.locatorRevisionId);
  const namespace = sourcePlanNamespaceRow(view, row.namespaceId);
  if (
    !outcome ||
    outcome.kind !== 'acknowledged' ||
    outcome.requestId !== row.requestId ||
    outcome.operationKind !== 'remote.outcome' ||
    !locator ||
    !namespace ||
    locator.operationId !== row.locatorOperationId ||
    locator.namespaceId !== row.namespaceId ||
    locator.kind !== 'upload' ||
    locator.realPath !== row.realPath ||
    locator.fingerprint !== row.fingerprint ||
    locator.externalId !== row.externalId
  )
    integrity();
  const decoded = decodeSourcePlanLocatorRow(locator, namespace);
  const locatorContent = parseJson(
    Buffer.from(decoded.recordBase64, 'base64').toString('utf8')
  ) as { unresolved?: unknown };
  if (
    decoded.kind !== 'upload' ||
    decoded.namespace.namespaceId !== row.namespaceId ||
    decoded.operationId !== row.locatorOperationId ||
    decoded.revisionId !== row.locatorRevisionId ||
    decoded.realPath !== row.realPath ||
    decoded.fingerprint !== row.fingerprint ||
    decoded.externalId !== row.externalId ||
    response.externalId !== row.externalId ||
    result.external_id !== response.externalId ||
    result.slug !== response.slug ||
    result.status !== response.status ||
    !isDeepStrictEqual(result.unresolved, response.unresolved) ||
    !isDeepStrictEqual(locatorContent.unresolved, response.unresolved) ||
    result.prior_external_id !== priorExternalId
  )
    integrity();
}

function acknowledgedUploadResponse(
  handle: ProjectDatabase,
  row: CommandRow,
  outcomeId: string
): SourcePlanUploadResponse {
  const remote = readProjectRemoteRequest(handle, row.requestId).value;
  const outcome = remote?.outcomes.at(-1);
  if (
    !remote ||
    remote.request.operationId !== row.requestOperationId ||
    remote.request.requestId !== row.requestId ||
    remote.request.scope.method !== 'sourcePlan.create' ||
    remote.request.scope.target.server_url !== row.serverUrl ||
    remote.request.scope.target.org_id !== row.orgId ||
    remote.request.scope.target.account_id !== row.accountId ||
    remote.request.scope.targetExternalId !== row.externalId ||
    remote.request.scope.idempotencyKey !== row.commandId ||
    remote.request.payloadSha256 !== row.payloadSha256 ||
    outcome?.kind !== 'acknowledged' ||
    outcome.outcomeId !== outcomeId ||
    outcome.responseBytes === null
  )
    integrity();
  return parseSourcePlanUploadResponse(
    parseJson(Buffer.from(outcome.responseBytes).toString('utf8'))
  );
}

export async function beginProjectSourcePlanUpload(
  handle: ProjectDatabase,
  raw: ProjectSourcePlanUploadCommandInput,
  options: ProjectOperationOptions & { secretAllow: readonly string[] }
) {
  assertProjectDatabasePath(handle);
  if (
    !Array.isArray(options?.secretAllow) ||
    !options.secretAllow.every((item) => typeof item === 'string')
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide an explicit Source Plan upload refusal allowlist'
    );
  const existing = handle.read((view) => {
    const receipt = operation(view, raw.operationId);
    const row = commandRow(view, 'admission_operation_id', raw.operationId);
    if (!receipt) {
      if (row) integrity();
      return null;
    }
    if (receipt.kind !== 'source_plan.upload.begin') conflict();
    if (!row) integrity();
    return row;
  }).value;
  if (existing) {
    const original = decodeCommand(existing);
    handle.read((view) => {
      validateExpectedLocator(view, existing, original.prepared.expectedLocator);
      return true;
    });
    const supplied = projectSourcePlanUploadCommand(
      decodeRetainedProjectSourcePlanUploadCommand(raw)
    );
    if (!isDeepStrictEqual(original.prepared, supplied)) conflict();
    return runProjectOperation(
      handle,
      admissionOperation(original.prepared),
      () => integrity(),
      options
    );
  }
  const prepared = projectSourcePlanUploadCommand(
    prepareProjectSourcePlanUploadCommand(raw, { secretAllow: [...options.secretAllow] })
  );
  const observed = handle.read((view) =>
    selectedUploadLocator(view, prepared.namespace.namespaceId, prepared.realPath)
  ).value;
  if (!isDeepStrictEqual(observed, prepared.expectedLocator)) stale();
  return runProjectOperation(
    handle,
    admissionOperation(prepared),
    (view) => {
      retainSourcePlanNamespace(view, prepared.namespace);
      if (
        !isDeepStrictEqual(
          selectedUploadLocator(view, prepared.namespace.namespaceId, prepared.realPath),
          observed
        )
      )
        stale();
      const identities = [
        prepared.commandId,
        prepared.operationId,
        prepared.terminalOperationId,
        prepared.requestOperationId,
        prepared.requestId,
        prepared.locatorOperationId,
        prepared.locatorRevisionId,
      ];
      if (
        view.get(
          `WITH incoming(id) AS (VALUES (?),(?),(?),(?),(?),(?),(?))
          SELECT c.command_id FROM source_plan_upload_commands c JOIN incoming i ON i.id IN
          (c.command_id,c.admission_operation_id,c.terminal_operation_id,c.request_operation_id,
           c.request_id,c.locator_operation_id,c.locator_revision_id)
          UNION ALL SELECT command_id FROM source_plan_upload_commands WHERE
          server_url=? AND org_id=? AND account_id=? AND real_path=? AND fingerprint=? LIMIT 1`,
          ...identities,
          prepared.target.server_url,
          prepared.target.org_id,
          prepared.target.account_id,
          prepared.realPath,
          prepared.fingerprint
        ) ||
        view.get(
          `SELECT 1 FROM operations WHERE operation_id IN (?,?,?,?,?,?,?)
          UNION ALL SELECT 1 FROM remote_requests WHERE request_id IN (?,?,?,?,?,?,?) OR operation_id IN (?,?,?,?,?,?,?)
          UNION ALL SELECT 1 FROM source_plan_locator_revisions WHERE revision_id IN (?,?,?,?,?,?,?) OR publication_operation_id IN (?,?,?,?,?,?,?) LIMIT 1`,
          ...identities,
          ...identities,
          ...identities,
          ...identities,
          ...identities
        )
      )
        conflict();
      const expected = sourcePlanUploadExpectedSelection(prepared.expectedLocator);
      view.run(
        `INSERT INTO source_plan_upload_commands
        (command_id,admission_operation_id,terminal_operation_id,request_operation_id,request_id,
        locator_operation_id,locator_revision_id,namespace_id,server_url,org_id,account_id,real_path,
        fingerprint,external_id,expected_locator_revision_id,expected_locator_version,payload_sha256,prepared_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        prepared.commandId,
        prepared.operationId,
        prepared.terminalOperationId,
        prepared.requestOperationId,
        prepared.requestId,
        prepared.locatorOperationId,
        prepared.locatorRevisionId,
        prepared.namespace.namespaceId,
        prepared.target.server_url,
        prepared.target.org_id,
        prepared.target.account_id,
        prepared.realPath,
        prepared.fingerprint,
        prepared.externalId,
        expected?.recordId ?? null,
        expected?.version ?? null,
        prepared.payloadSha256,
        prepared.preparedAt
      );
      return admissionResult(prepared);
    },
    options
  );
}

export function readProjectSourcePlanUpload(
  handle: ProjectDatabase,
  operationId: string
): { value: ProjectSourcePlanUpload | null; counters: ProjectCounters } {
  assertProjectDatabasePath(handle);
  const snapshot = handle.read((view) => commandRow(view, 'admission_operation_id', operationId));
  if (!snapshot.value) return { ...snapshot, value: null };
  const decoded = decodeCommand(snapshot.value);
  handle.read((view) => {
    validateExpectedLocator(view, snapshot.value!, decoded.prepared.expectedLocator);
    return true;
  });
  const completed = terminal(snapshot.value);
  if (completed) {
    const response = acknowledgedUploadResponse(handle, snapshot.value, completed.outcomeId);
    handle.read((view) => {
      sourcePlanUploadEffects(
        view,
        snapshot.value!,
        completed.outcomeId,
        response,
        completed.result
      );
      return true;
    });
  }
  return {
    ...snapshot,
    value: {
      ...decoded,
      admission: admissionResult(decoded.prepared),
      terminal: completed,
    },
  };
}

export async function completeProjectSourcePlanUpload(
  handle: ProjectDatabase,
  input: {
    operationId: string;
    commandId: string;
    outcomeId: string;
    result: SourcePlanUploadResult;
  },
  options: ProjectOperationOptions = {}
) {
  assertProjectDatabasePath(handle);
  const read = handle.read((view) => commandRow(view, 'command_id', input.commandId));
  if (!read.value)
    throw new ProjectDatabaseError('HISTORY_MISSING', 'Source Plan upload command is missing');
  const row = read.value;
  decodeCommand(row);
  if (input.operationId !== row.terminalOperationId) conflict();
  const result = parseSourcePlanUploadResult(input.result);
  const response = acknowledgedUploadResponse(handle, row, input.outcomeId);
  const operationInput = {
    operationId: row.terminalOperationId,
    kind: 'source_plan.upload.complete',
    target: { commandId: row.commandId },
    payload: {
      requestId: row.requestId,
      outcomeId: input.outcomeId,
      locatorRevisionId: row.locatorRevisionId,
    },
    expectedState: {},
    intentChange: false,
  } as const;
  handle.read((view) => {
    validateExpectedLocator(view, row, decodeCommand(row).prepared.expectedLocator);
    sourcePlanUploadEffects(view, row, input.outcomeId, response, result);
    return true;
  });
  return runProjectOperation(
    handle,
    operationInput,
    (view) => {
      sourcePlanUploadEffects(view, row, input.outcomeId, response, result);
      return JSON.parse(canonicalJson(result));
    },
    options
  );
}
