import { expect, it } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import {
  prepareProjectSourcePlanUploadCommand,
  projectSourcePlanUploadCommand,
  type ProjectSourcePlanUploadCommandInput,
  sourcePlanUploadExternalId,
  sourcePlanUploadFingerprint,
  type SourcePlanUploadPayload,
} from './source-plan-upload-input.js';

function input(): ProjectSourcePlanUploadCommandInput {
  const realPath = '/original/plan.md';
  const payload: SourcePlanUploadPayload = {
    schema_version: 1,
    external_id: '',
    title: 'Original plan',
    body: '# Plan\n',
    content_hash: digest('# Plan\n'),
    reviewers: ['@alice', '@bob'],
    review_note: null,
    source_ref: 'docs/plan.md',
    derived_from: null,
    summary: null,
    baseline: { repo_url: 'https://example.test/repo', branch: 'main', head_sha: 'abc123' },
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
      server_url: 'https://EXAMPLE.test:443/',
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
    payloadBytes: Buffer.from(JSON.stringify(payload)),
  };
}

it('prepares one exact authenticated upload command and normalizes only its server identity', () => {
  const original = input();
  const prepared = projectSourcePlanUploadCommand(
    prepareProjectSourcePlanUploadCommand(original, { secretAllow: [] })
  );
  expect(prepared.target.server_url).toBe('https://example.test');
  expect(prepared.externalId).toBe(
    sourcePlanUploadExternalId(original.realPath, prepared.fingerprint)
  );
  expect(Buffer.from(prepared.payloadBase64, 'base64')).toEqual(original.payloadBytes);
  expect(original.target.server_url).toBe('https://EXAMPLE.test:443/');
});

it('refuses changed content identity, unsorted reviewers, and secret-bearing bytes', () => {
  const wrongId = input();
  const changed = JSON.parse(Buffer.from(wrongId.payloadBytes).toString('utf8'));
  changed.body = 'changed';
  wrongId.payloadBytes = Buffer.from(JSON.stringify(changed));
  expect(() => prepareProjectSourcePlanUploadCommand(wrongId, { secretAllow: [] })).toThrow(
    /content hash/
  );

  const unsorted = input();
  const reordered = JSON.parse(Buffer.from(unsorted.payloadBytes).toString('utf8'));
  reordered.reviewers = ['@bob', '@alice'];
  unsorted.payloadBytes = Buffer.from(JSON.stringify(reordered));
  expect(() => prepareProjectSourcePlanUploadCommand(unsorted, { secretAllow: [] })).toThrow(
    /sorted and unique/
  );

  const secret = input();
  const authored = JSON.parse(Buffer.from(secret.payloadBytes).toString('utf8'));
  authored.review_note = 'ghp_' + 'A'.repeat(36);
  authored.external_id = sourcePlanUploadExternalId(
    secret.realPath,
    sourcePlanUploadFingerprint(authored)
  );
  secret.payloadBytes = Buffer.from(JSON.stringify(authored));
  expect(() => prepareProjectSourcePlanUploadCommand(secret, { secretAllow: [] })).toThrow(
    /Secret refusal/
  );
});
