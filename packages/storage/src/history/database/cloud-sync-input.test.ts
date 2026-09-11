import { expect, it } from 'vitest';

import {
  cloudSyncFailure,
  prepareProjectCloudSyncFailure,
  type ProjectCloudSyncFailureInput,
} from './cloud-sync-input.js';
import { uuidv7 } from '../../ids/uuidv7.js';

function input(): ProjectCloudSyncFailureInput {
  return {
    operationId: uuidv7(),
    revisionId: uuidv7(),
    artifactId: uuidv7(),
    target: {
      server_url: 'https://example.test/Api',
      org_id: 'original org',
      account_id: 'account',
    },
    kind: 'network',
    message: 'Original scrubbed message\n',
    attemptedAt: '2026-09-01T03:00:00.000Z',
    attemptStartedAt: '2026-09-01T02:59:59.000Z',
  };
}

it('retains original failure fields in an authentic detached preparation', () => {
  const original = input();
  const copy = structuredClone(original);
  const result = cloudSyncFailure(prepareProjectCloudSyncFailure(original, []));
  original.target.account_id = 'changed';
  original.message = 'changed';
  expect(result.input).toEqual(copy);
  expect(result.inputSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.isFrozen(result.input.target)).toBe(true);
  expect(() => cloudSyncFailure({ kind: 'prepared-cloud-sync-failure' })).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
});

it.each([
  'timeout',
  'http-4xx',
  'http-5xx',
  'network',
  'wire-invalid',
  'content-invalid',
  'upgrade-required',
  'server-behind',
  'unknown',
] as const)('preserves the finite failure kind %s', (kind) => {
  const value = input();
  value.kind = kind;
  value.message = null;
  expect(cloudSyncFailure(prepareProjectCloudSyncFailure(value, [])).input).toEqual(value);
});

it.each(['NotConnected', 'MissingGitRemote', 'ArtifactNotFound', 'caller-success'])(
  'refuses non-cloud failure %s',
  (kind) => {
    expect(() =>
      prepareProjectCloudSyncFailure({ ...input(), kind } as ProjectCloudSyncFailureInput, [])
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  }
);

it('refuses unknown or noncanonical live ownership and extra result fields', () => {
  const value = input();
  for (const target of [
    { ...value.target, account_id: '' },
    { ...value.target, server_url: 'https://example.test/Api/' },
    { ...value.target, server_url: 'https://user:password@example.test' },
  ]) {
    expect(() => prepareProjectCloudSyncFailure({ ...value, target }, [])).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
  }
  expect(() =>
    prepareProjectCloudSyncFailure({ ...value, applied: true } as ProjectCloudSyncFailureInput, [])
  ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
});

it('refuses escaped credential content and honors only the explicit allowance', () => {
  const secret = ['ghp_', 'A'.repeat(36)].join('');
  const value = { ...input(), message: `${secret.slice(0, 12)}\0${secret.slice(12)}` };
  expect(() => prepareProjectCloudSyncFailure(value, [])).toThrow(
    expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' })
  );
  const allowed = cloudSyncFailure(
    prepareProjectCloudSyncFailure({ ...value, message: secret }, [secret])
  );
  expect(allowed.input.message).toBe(secret);
});

it('preserves opaque time spelling without comparing or inventing an outcome', () => {
  const value = {
    ...input(),
    attemptedAt: 'original time',
    attemptStartedAt: 'original start',
    message: '',
  };
  expect(cloudSyncFailure(prepareProjectCloudSyncFailure(value, [])).input).toEqual(value);
  expect(cloudSyncFailure(prepareProjectCloudSyncFailure(value, [])).input).not.toHaveProperty(
    'applied'
  );
});
