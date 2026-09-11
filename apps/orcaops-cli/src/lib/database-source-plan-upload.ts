import { z } from 'zod';

import type { OssSourcePlanBaseline } from '@orcaops/core';
import { OssSourcePlanUploadPayload, type SourcePlanUploadResponse } from '@orcaops/sdk';
import {
  canonicalJson,
  firstForbiddenControlChar,
  type SecretFinding,
  sha256Hex,
} from '@orcaops/storage';
import { artifactOperationId } from '@orcaops/storage/history/artifact-operation-id';
import {
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectOperationOptions,
  publishProjectSourcePlanLocator,
  readProjectSourcePlanLocator,
  readProjectSourcePlanNamespace,
  type SourcePlanNamespace,
} from '@orcaops/storage/history/database';
import {
  admitProjectRemoteAttempt,
  beginProjectSourcePlanUpload,
  completeProjectSourcePlanUpload,
  parseSourcePlanUploadResult,
  prepareProjectSourcePlanUploadCommand,
  type ProjectSourcePlanUpload,
  readProjectRemoteRequest,
  readProjectSourcePlanUpload,
  recordProjectRemoteOutcome,
  retainProjectRemoteRequest,
  type SourcePlanUploadPayload,
  type SourcePlanUploadPriorLocator,
} from '@orcaops/storage/history/database/source-plan-upload';
import { canonicalRemoteTarget, type RemoteTarget } from '@orcaops/storage/history/remote-target';

import {
  assertNoSecretsOutbound,
  type AuthoredField,
  type WithSecretWarnings,
  withSecretWarnings,
} from './cloud-secret-gate.js';
import {
  computeUploadExternalId,
  computeUploadFingerprint,
  displaySafeSourceRef,
  formatUploadInputIssues,
  suggestReviewers,
} from './source-plan-upload-shared.js';
import type { PlanUploadResult, UploadClient } from '../commands/plan/upload.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

const responseSchema = z.object({
  id: z.string().min(1),
  externalId: z.string().min(1),
  slug: z.string().min(1),
  status: z.string(),
  unresolved: z.array(z.string()),
});
const locatorSchema = z.strictObject({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  external_id: z.string().min(1),
  unresolved: z.array(z.string()),
});

export interface DatabaseSourcePlanUploadOptions {
  reader: ProjectDatabase;
  openWriter(): Promise<ProjectDatabase>;
  client: UploadClient;
  repoRoot: string;
  target: RemoteTarget;
  absPath: string;
  fileRealpath: string;
  body: string;
  title: string;
  reviewers: string[];
  reviewNote: string | null;
  secretAllow: readonly string[];
  resolveBaseline(): Promise<OssSourcePlanBaseline | null>;
  now(): string;
  signal?: AbortSignal;
  onWait?: ProjectOperationOptions['onWait'];
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ProjectDatabaseError('CANCELLED', 'Plan upload cancelled before the next write');
}

function unknownUpload(): never {
  throw new OrcaopsError(
    ErrorCodes.CLOUD_ERROR,
    'The Source Plan upload response was not acknowledged. The original upload may have reached the cloud and will not be resent. Run `orcaops plan review status` to inspect authored plans. Status cannot prove remote absence; report the retained unknown upload before authoring a separate draft.'
  );
}

function derivedId(projectId: string, family: string, value: unknown): string {
  return artifactOperationId(projectId, canonicalJson(value), family);
}

function readNamespace(reader: ProjectDatabase, target: RemoteTarget) {
  return (
    readProjectSourcePlanNamespace(reader, {
      serverUrl: target.server_url,
      orgId: target.org_id,
      accountId: target.account_id,
    }) ?? {
      namespaceId: derivedId(reader.authority.projectId, 'source_plan.namespace', target),
      scopeKind: 'account' as const,
      serverUrl: target.server_url,
      orgId: target.org_id,
      accountId: target.account_id,
      originalNamespaceHash: null,
      originalLocatorHash: null,
    }
  );
}

function readPriorLocator(
  reader: ProjectDatabase,
  namespace: SourcePlanNamespace,
  realPath: string
): SourcePlanUploadPriorLocator | null {
  const current = readProjectSourcePlanLocator(reader, {
    namespaceId: namespace.namespaceId,
    kind: 'upload',
    realPath,
  });
  if (!current) return null;
  const content = locatorSchema.parse(
    JSON.parse(Buffer.from(current.record.recordBase64, 'base64').toString('utf8'))
  );
  return {
    selection: current.selection,
    fingerprint: content.fingerprint,
    externalId: content.external_id,
    unresolved: content.unresolved,
  };
}

function remoteScope(state: ProjectSourcePlanUpload) {
  return {
    target: state.prepared.target,
    artifactId: null,
    method: 'sourcePlan.create' as const,
    targetExternalId: state.prepared.externalId,
    idempotencyKey: state.prepared.commandId,
  };
}

function parseResponse(bytes: Uint8Array): SourcePlanUploadResponse {
  return responseSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
}

function uploadResult(
  response: SourcePlanUploadResponse,
  prior: SourcePlanUploadPriorLocator | null,
  warnings: readonly SecretFinding[],
  suggestions?: PlanUploadResult['reviewer_suggestions']
): WithSecretWarnings<PlanUploadResult> {
  return withSecretWarnings(
    {
      external_id: response.externalId,
      slug: response.slug,
      status: response.status,
      unresolved: [...response.unresolved],
      ...(suggestions?.length ? { reviewer_suggestions: suggestions } : {}),
      ...(prior && prior.externalId !== response.externalId
        ? { prior_external_id: prior.externalId }
        : {}),
    },
    warnings
  );
}

function originalPayload(state: ProjectSourcePlanUpload): SourcePlanUploadPayload {
  return OssSourcePlanUploadPayload.parse(
    JSON.parse(Buffer.from(state.prepared.payloadBase64, 'base64').toString('utf8'))
  );
}

function parseNewPayload(input: unknown): SourcePlanUploadPayload {
  const parsed = OssSourcePlanUploadPayload.safeParse(input);
  if (!parsed.success)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      formatUploadInputIssues(parsed.error),
      'plan-upload'
    );
  return parsed.data;
}

async function acknowledgedResponse(
  writer: ProjectDatabase,
  state: ProjectSourcePlanUpload,
  client: UploadClient,
  secretAllow: readonly string[],
  options: ProjectOperationOptions,
  now: () => string
): Promise<{ response: SourcePlanUploadResponse; outcomeId: string }> {
  const scope = remoteScope(state);
  let remote = readProjectRemoteRequest(writer, state.prepared.requestId).value;
  if (!remote) {
    await retainProjectRemoteRequest(
      writer,
      {
        operationId: state.prepared.requestOperationId,
        requestId: state.prepared.requestId,
        scope,
        expectedSelection: null,
        payloadBytes: Buffer.from(state.prepared.payloadBase64, 'base64'),
        preparedAt: state.prepared.preparedAt,
      },
      { secretAllow: [...secretAllow] },
      options
    );
    remote = readProjectRemoteRequest(writer, state.prepared.requestId).value;
  }
  if (!remote)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The original Source Plan upload request is missing after admission'
    );
  const acknowledged = remote.outcomes.at(-1);
  if (acknowledged?.kind === 'acknowledged') {
    if (acknowledged.responseBytes === null)
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'The acknowledged Source Plan upload response is missing'
      );
    return {
      response: parseResponse(acknowledged.responseBytes),
      outcomeId: acknowledged.outcomeId,
    };
  }
  if (remote.attempt) unknownUpload();

  cancelled(options.signal);
  const attemptId = derivedId(state.prepared.commandId, 'source_plan.upload.attempt', scope);
  const admitted = await admitProjectRemoteAttempt(
    writer,
    {
      operationId: derivedId(
        state.prepared.commandId,
        'source_plan.upload.attempt.operation',
        scope
      ),
      requestId: state.prepared.requestId,
      attemptId,
      scope,
      expectedSelection: remote.current,
      attemptedAt: now(),
    },
    { secretAllow: [...secretAllow] },
    options
  );
  if (!admitted.sendAllowed) unknownUpload();
  cancelled(options.signal);
  const payload = OssSourcePlanUploadPayload.parse(originalPayload(state));
  let response: SourcePlanUploadResponse;
  try {
    response = await client.sourcePlan.create(payload);
  } catch (cause) {
    await recordProjectRemoteOutcome(
      writer,
      {
        operationId: derivedId(state.prepared.commandId, 'source_plan.upload.outcome.operation', {
          scope,
          attemptId,
        }),
        requestId: state.prepared.requestId,
        attemptId,
        outcomeId: derivedId(state.prepared.commandId, 'source_plan.upload.outcome', {
          scope,
          attemptId,
        }),
        scope,
        expectedSelection: admitted.value.selection,
        kind: 'ack_unknown',
        responseBytes: null,
        failure: {
          kind: 'unknown',
          message: cause instanceof Error ? cause.message : String(cause),
        },
        observedAt: now(),
      },
      { secretAllow: [...secretAllow] },
      options
    );
    unknownUpload();
  }
  response = responseSchema.parse(response);
  const outcomeId = derivedId(state.prepared.commandId, 'source_plan.upload.outcome', {
    scope,
    attemptId,
  });
  await recordProjectRemoteOutcome(
    writer,
    {
      operationId: derivedId(state.prepared.commandId, 'source_plan.upload.outcome.operation', {
        scope,
        attemptId,
      }),
      requestId: state.prepared.requestId,
      attemptId,
      outcomeId,
      scope,
      expectedSelection: admitted.value.selection,
      kind: 'acknowledged',
      responseBytes: Buffer.from(canonicalJson(response)),
      failure: null,
      observedAt: now(),
    },
    { secretAllow: [...secretAllow] },
    options
  );
  return { response, outcomeId };
}

export async function runDatabaseSourcePlanUpload(
  raw: DatabaseSourcePlanUploadOptions
): Promise<WithSecretWarnings<PlanUploadResult>> {
  const input = { ...raw, reviewers: [...raw.reviewers], secretAllow: [...raw.secretAllow] };
  let target: RemoteTarget;
  try {
    target = canonicalRemoteTarget(input.target);
  } catch (cause) {
    throw new ProjectDatabaseError('INVALID_INPUT', 'Provide a complete cloud target', { cause });
  }
  const fields: AuthoredField[] = [
    ['abs_path', input.absPath],
    ['file_realpath', input.fileRealpath],
    ['body', input.body],
    ['title', input.title],
    ['review_note', input.reviewNote],
    ['server_url', target.server_url],
    ['org_id', target.org_id],
    ['account_id', target.account_id],
    ...input.reviewers.map((reviewer, index): AuthoredField => [`reviewer[${index}]`, reviewer]),
  ];
  const warnings = assertNoSecretsOutbound('plan-upload', fields, input.secretAllow);
  const forbidden = firstForbiddenControlChar(input.body);
  if (forbidden !== null)
    throw new OrcaopsError(
      ErrorCodes.NO_INPUT,
      `the plan body contains a forbidden control character (U+${forbidden.code.toString(16).toUpperCase().padStart(4, '0')} at offset ${forbidden.index}).`,
      'plan-upload'
    );
  cancelled(input.signal);
  const namespace = readNamespace(input.reader, target);
  const reviewers = [...new Set(input.reviewers)].sort();
  const sourceRef = displaySafeSourceRef(input.absPath, input.repoRoot);
  const fingerprint = computeUploadFingerprint({
    body: input.body,
    title: input.title,
    reviewers,
    review_note: input.reviewNote,
    source_ref: sourceRef,
    derived_from: null,
  });
  const externalId = computeUploadExternalId(input.fileRealpath, fingerprint);
  const commandId = derivedId(input.reader.authority.projectId, 'source_plan.upload.command', {
    target,
    realPath: input.fileRealpath,
    fingerprint,
  });
  const operationId = derivedId(commandId, 'source_plan.upload.admission', commandId);
  const existing = readProjectSourcePlanUpload(input.reader, operationId).value;
  if (
    existing &&
    (existing.prepared.commandId !== commandId ||
      existing.prepared.fingerprint !== fingerprint ||
      existing.prepared.externalId !== externalId ||
      existing.prepared.realPath !== input.fileRealpath ||
      canonicalJson(existing.prepared.target) !== canonicalJson(target))
  )
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The retained Source Plan upload identity belongs to different authored input'
    );
  if (existing?.terminal) return existing.terminal.result;
  const expectedLocator = existing
    ? existing.prepared.expectedLocator
    : readPriorLocator(input.reader, namespace, input.fileRealpath);
  const payload = existing
    ? originalPayload(existing)
    : parseNewPayload({
        schema_version: 1,
        external_id: externalId,
        title: input.title,
        body: input.body,
        content_hash: sha256Hex(input.body),
        reviewers,
        review_note: input.reviewNote,
        source_ref: sourceRef,
        derived_from: null,
        baseline: await input.resolveBaseline(),
        authored_at: input.now(),
      });
  const identities = {
    terminalOperationId: derivedId(commandId, 'source_plan.upload.terminal', commandId),
    requestOperationId: derivedId(commandId, 'source_plan.upload.request.operation', commandId),
    requestId: derivedId(commandId, 'source_plan.upload.request', commandId),
    locatorOperationId: derivedId(commandId, 'source_plan.upload.locator.operation', commandId),
    locatorRevisionId: derivedId(commandId, 'source_plan.upload.locator.revision', commandId),
  };
  const commandInput = {
    commandId,
    operationId,
    ...identities,
    target,
    namespace,
    realPath: input.fileRealpath,
    expectedLocator,
    preparedAt: existing?.prepared.preparedAt ?? payload.authored_at,
    payloadBytes: Buffer.from(canonicalJson(payload)),
  };
  if (!existing)
    prepareProjectSourcePlanUploadCommand(commandInput, { secretAllow: input.secretAllow });
  cancelled(input.signal);
  const writer = await input.openWriter();
  try {
    await beginProjectSourcePlanUpload(writer, commandInput, {
      secretAllow: input.secretAllow,
      signal: input.signal,
      onWait: input.onWait,
    });
    const state = readProjectSourcePlanUpload(writer, operationId).value;
    if (!state)
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'The Source Plan upload command is missing after admission'
      );
    if (state.terminal) return state.terminal.result;
    const options = { signal: input.signal, onWait: input.onWait };
    const acknowledged = await acknowledgedResponse(
      writer,
      state,
      input.client,
      input.secretAllow,
      options,
      input.now
    );
    if (acknowledged.response.externalId !== state.prepared.externalId)
      throw new OrcaopsError(
        ErrorCodes.CLOUD_ERROR,
        `the cloud did not honor the upload id we sent (sent ${state.prepared.externalId}, got ${acknowledged.response.externalId}).`,
        'plan-upload'
      );
    const currentLocator = readProjectSourcePlanLocator(writer, {
      namespaceId: state.prepared.namespace.namespaceId,
      kind: 'upload',
      realPath: state.prepared.realPath,
    });
    if (currentLocator?.selection.recordId !== state.prepared.locatorRevisionId) {
      await publishProjectSourcePlanLocator(
        writer,
        {
          operationId: state.prepared.locatorOperationId,
          revisionId: state.prepared.locatorRevisionId,
          namespace: state.prepared.namespace,
          kind: 'upload',
          realPath: state.prepared.realPath,
          approvedRecordId: null,
          expectedSelection: state.prepared.expectedLocator?.selection ?? null,
          recordBytes: Buffer.from(
            canonicalJson({
              fingerprint: state.prepared.fingerprint,
              external_id: state.prepared.externalId,
              unresolved: acknowledged.response.unresolved,
            })
          ),
        },
        { secretAllow: input.secretAllow, ...options }
      );
    }
    let suggestions: PlanUploadResult['reviewer_suggestions'];
    if (acknowledged.response.unresolved.length) {
      try {
        const discovery = await input.client.sourcePlan.listReviewers({
          schema_version: 1,
          repo_url: originalPayload(state).baseline?.repo_url ?? null,
        });
        suggestions = suggestReviewers(acknowledged.response.unresolved, discovery.members);
      } catch {
        suggestions = undefined;
      }
    }
    const result = parseSourcePlanUploadResult(
      uploadResult(acknowledged.response, state.prepared.expectedLocator, warnings, suggestions)
    );
    const completed = await completeProjectSourcePlanUpload(
      writer,
      {
        operationId: state.prepared.terminalOperationId,
        commandId: state.prepared.commandId,
        outcomeId: acknowledged.outcomeId,
        result,
      },
      options
    );
    return completed.value;
  } finally {
    writer.close();
  }
}
