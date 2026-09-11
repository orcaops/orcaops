import { expect, it } from 'vitest';

import { CloudWireError, TrpcRequestError } from '@orcaops/sdk';
import { ForbiddenControlCharError } from '@orcaops/storage';

import { classifyCloudSyncFailure } from './cloud-sync-failure.js';
import { CloudCapabilityError } from './handshake.js';

it.each([
  ['http-4xx', new TrpcRequestError('payload too large', { httpStatus: 413 })],
  ['http-5xx', new TrpcRequestError('upstream 502', { httpStatus: 502 })],
  [
    'upgrade-required',
    new TrpcRequestError('client below minimum', {
      httpStatus: 422,
      appCode: 'CLIENT_BELOW_MINIMUM',
      appData: { minimum: '1.0.0', received: null },
    }),
  ],
  [
    'upgrade-required',
    new TrpcRequestError('unsupported schema_version', {
      httpStatus: 422,
      appCode: 'PAYLOAD_SCHEMA_UNSUPPORTED',
    }),
  ],
  [
    'server-behind',
    new TrpcRequestError('anything', { httpStatus: 404, appCode: 'UNKNOWN_PROCEDURE' }),
  ],
  [
    'http-4xx',
    new TrpcRequestError('No "mutation"-procedure on path "captureThread.start"', {
      code: 'NOT_FOUND',
      httpStatus: 404,
    }),
  ],
  ['wire-invalid', new CloudWireError('non-JSON response from cloud')],
  ['network', new TrpcRequestError('fetch failed', {})],
  ['unknown', new Error('boom')],
] as const)('classifies %s without inferring a typed condition from prose', (kind, error) => {
  expect(classifyCloudSyncFailure(error)).toEqual({ kind, message: error.message });
});

it.each(['server-behind', 'upgrade-required', 'wire-invalid'] as const)(
  'preserves the local capability failure %s',
  (kind) => {
    const result = classifyCloudSyncFailure(
      new CloudCapabilityError(kind, 'pushing a pinned plan', 'Missing source-plan-owner-ref/v1.')
    );
    expect(result.kind).toBe(kind);
    expect(result.message).toContain('source-plan-owner-ref/v1');
  }
);

it('retains the field path for content that the cloud cannot store', () => {
  const result = classifyCloudSyncFailure(
    new ForbiddenControlCharError('evaluators.runs[0].raw.output')
  );
  expect(result.kind).toBe('content-invalid');
  expect(result.message).toContain('evaluators.runs[0].raw.output');
});

it('scrubs credentials before an error can be retained', () => {
  const result = classifyCloudSyncFailure(
    new TrpcRequestError('Authorization: Bearer abc123def456 rejected', { httpStatus: 401 })
  );
  expect(result.kind).toBe('http-4xx');
  expect(result.message).not.toContain('abc123def456');
  expect(result.message).toContain('[REDACTED_SECRET]');
});
