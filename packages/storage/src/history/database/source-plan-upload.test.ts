import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { canonicalJson } from '../../events/canonical-json.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import { normalizeHistoryRoot } from '../paths.js';
import {
  initializeProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import {
  admitProjectRemoteAttempt,
  recordProjectRemoteOutcome,
  retainProjectRemoteRequest,
} from './remote-transport.js';
import { publishProjectSourcePlanLocator } from './source-plan-publication.js';
import {
  type ProjectSourcePlanUploadCommandInput,
  sourcePlanUploadExternalId,
  sourcePlanUploadFingerprint,
  type SourcePlanUploadPayload,
} from './source-plan-upload-input.js';
import {
  beginProjectSourcePlanUpload,
  completeProjectSourcePlanUpload,
  readProjectSourcePlanUpload,
} from './source-plan-upload.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'source-plan-upload-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
  const handle = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: '2026-09-09T00:00:00Z',
    authorize() {},
  });
  handles.push(handle);
  return handle;
}
function command(title = 'Original plan'): ProjectSourcePlanUploadCommandInput {
  const realPath = '/original/plan.md';
  const payload: SourcePlanUploadPayload = {
    schema_version: 1,
    external_id: '',
    title,
    body: '# Plan\n',
    content_hash: digest('# Plan\n'),
    reviewers: ['@alice'],
    review_note: null,
    source_ref: 'docs/plan.md',
    derived_from: null,
    summary: null,
    baseline: null,
    authored_at: '2026-09-09T00:00:00Z',
  };
  const fingerprint = sourcePlanUploadFingerprint(payload);
  payload.external_id = sourcePlanUploadExternalId(realPath, fingerprint);
  const ids = Array.from({ length: 7 }, () => uuidv7());
  return {
    commandId: ids[0]!,
    operationId: ids[1]!,
    terminalOperationId: ids[2]!,
    requestOperationId: ids[3]!,
    requestId: ids[4]!,
    locatorOperationId: ids[5]!,
    locatorRevisionId: ids[6]!,
    target: {
      server_url: 'https://example.test',
      org_id: 'original org',
      account_id: 'original account',
    },
    namespace: {
      namespaceId: uuidv7(),
      scopeKind: 'account',
      serverUrl: 'https://example.test',
      orgId: 'original org',
      accountId: 'original account',
      originalNamespaceHash: null,
      originalLocatorHash: null,
    },
    realPath,
    expectedLocator: null,
    preparedAt: '2026-09-09T00:00:00Z',
    payloadBytes: Buffer.from(canonicalJson(payload)),
  };
}
function scope(input: ProjectSourcePlanUploadCommandInput) {
  const payload = JSON.parse(
    Buffer.from(input.payloadBytes).toString('utf8')
  ) as SourcePlanUploadPayload;
  return {
    target: input.target,
    artifactId: null,
    method: 'sourcePlan.create' as const,
    targetExternalId: payload.external_id,
    idempotencyKey: input.commandId,
  };
}
async function acknowledge(handle: ProjectDatabase, input: ProjectSourcePlanUploadCommandInput) {
  const remoteScope = scope(input);
  const retained = await retainProjectRemoteRequest(
    handle,
    {
      operationId: input.requestOperationId,
      requestId: input.requestId,
      scope: remoteScope,
      expectedSelection: null,
      payloadBytes: input.payloadBytes,
      preparedAt: input.preparedAt,
    },
    { secretAllow: [] }
  );
  const attemptId = uuidv7();
  const attempt = await admitProjectRemoteAttempt(
    handle,
    {
      operationId: uuidv7(),
      requestId: input.requestId,
      attemptId,
      scope: remoteScope,
      expectedSelection: retained.value.selection,
      attemptedAt: '2026-09-09T00:00:01Z',
    },
    { secretAllow: [] }
  );
  const outcomeId = uuidv7();
  await recordProjectRemoteOutcome(
    handle,
    {
      operationId: uuidv7(),
      requestId: input.requestId,
      attemptId,
      outcomeId,
      scope: remoteScope,
      expectedSelection: attempt.value.selection,
      kind: 'acknowledged',
      responseBytes: Buffer.from(
        canonicalJson({
          id: 'row-1',
          externalId: remoteScope.targetExternalId,
          slug: 'original-plan',
          status: 'DRAFT',
          unresolved: ['@alice'],
        })
      ),
      failure: null,
      observedAt: '2026-09-09T00:00:02Z',
    },
    { secretAllow: [] }
  );
  return outcomeId;
}
async function locator(handle: ProjectDatabase, input: ProjectSourcePlanUploadCommandInput) {
  const payload = JSON.parse(
    Buffer.from(input.payloadBytes).toString('utf8')
  ) as SourcePlanUploadPayload;
  return publishProjectSourcePlanLocator(
    handle,
    {
      operationId: input.locatorOperationId,
      revisionId: input.locatorRevisionId,
      namespace: input.namespace,
      kind: 'upload',
      realPath: input.realPath,
      approvedRecordId: null,
      expectedSelection: input.expectedLocator?.selection ?? null,
      recordBytes: Buffer.from(
        canonicalJson({
          fingerprint: sourcePlanUploadFingerprint(payload),
          external_id: payload.external_id,
          unresolved: ['@alice'],
        })
      ),
    },
    { secretAllow: [] }
  );
}

it('retains one upload command, its acknowledged effects, and exact terminal replay', async () => {
  const handle = await fixture();
  const input = command();
  const admitted = await beginProjectSourcePlanUpload(handle, input, { secretAllow: [] });
  expect(admitted.replayed).toBe(false);
  const outcomeId = await acknowledge(handle, input);
  await locator(handle, input);
  const result = {
    external_id: scope(input).targetExternalId,
    slug: 'original-plan',
    status: 'DRAFT',
    unresolved: ['@alice'],
  };
  const completed = await completeProjectSourcePlanUpload(handle, {
    operationId: input.terminalOperationId,
    commandId: input.commandId,
    outcomeId,
    result,
  });
  expect(completed.value).toEqual(result);
  const before = handle.read((view) => view.get('SELECT * FROM project_counters')).value;

  const replay = readProjectSourcePlanUpload(handle, input.operationId).value;
  expect(replay?.terminal?.result).toEqual(result);
  await expect(
    completeProjectSourcePlanUpload(handle, {
      operationId: input.terminalOperationId,
      commandId: input.commandId,
      outcomeId,
      result,
    })
  ).resolves.toMatchObject({ replayed: true, value: result });
  expect(handle.read((view) => view.get('SELECT * FROM project_counters')).value).toEqual(before);
});

it('keeps terminal replay valid after a newer upload locator becomes current', async () => {
  const handle = await fixture();
  const first = command();
  await beginProjectSourcePlanUpload(handle, first, { secretAllow: [] });
  const outcomeId = await acknowledge(handle, first);
  const firstLocator = await locator(handle, first);
  const result = {
    external_id: scope(first).targetExternalId,
    slug: 'original-plan',
    status: 'DRAFT',
    unresolved: ['@alice'],
  };
  await completeProjectSourcePlanUpload(handle, {
    operationId: first.terminalOperationId,
    commandId: first.commandId,
    outcomeId,
    result,
  });

  const second = command('Changed plan');
  second.namespace = first.namespace;
  second.expectedLocator = {
    selection: firstLocator.value.selection,
    fingerprint: sourcePlanUploadFingerprint(
      JSON.parse(Buffer.from(first.payloadBytes).toString('utf8')) as SourcePlanUploadPayload
    ),
    externalId: scope(first).targetExternalId,
    unresolved: ['@alice'],
  };
  await beginProjectSourcePlanUpload(handle, second, { secretAllow: [] });
  await acknowledge(handle, second);
  await locator(handle, second);

  expect(readProjectSourcePlanUpload(handle, first.operationId).value?.terminal?.result).toEqual(
    result
  );
});

it('retains the original locator expectation and refuses rebasing it after admission', async () => {
  const handle = await fixture();
  const original = command();
  await beginProjectSourcePlanUpload(handle, original, { secretAllow: [] });
  const changed = structuredClone(original);
  changed.expectedLocator = {
    selection: { recordId: uuidv7(), version: 1 },
    fingerprint: 'a'.repeat(64),
    externalId: 'other',
    unresolved: [],
  };
  await expect(
    beginProjectSourcePlanUpload(handle, changed, { secretAllow: [] })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(
    readProjectSourcePlanUpload(handle, original.operationId).value?.prepared.expectedLocator
  ).toBeNull();
});
