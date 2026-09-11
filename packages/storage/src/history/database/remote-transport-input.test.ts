import { expect, it } from 'vitest';

import { canonicalJson } from '../../events/canonical-json.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { SecretInPayloadError } from '../../text/secret-guard.js';
import { digest } from '../event-integrity.js';
import { ProjectDatabaseError } from './errors.js';
import {
  decodeRetainedRemoteAttempt,
  decodeRetainedRemoteOutcome,
  decodeRetainedRemoteRequest,
  prepareProjectRemoteAttempt,
  prepareProjectRemoteOutcome,
  prepareProjectRemoteRequest,
  type ProjectRemoteAttemptInput,
  type ProjectRemoteOutcomeInput,
  type ProjectRemoteRequestInput,
  REMOTE_TRANSPORT_METHODS,
  remoteAttemptPreparation,
  remoteOutcomePreparation,
  remoteRequestPreparation,
} from './remote-transport-input.js';

const options = { secretAllow: [] as string[] };
function request(): ProjectRemoteRequestInput {
  return {
    operationId: uuidv7(),
    requestId: uuidv7(),
    expectedSelection: null,
    scope: {
      target: {
        server_url: 'https://example.test/API',
        org_id: 'original-org',
        account_id: 'original-account',
      },
      artifactId: null,
      method: 'captureThread.attachCheckpoint',
      targetExternalId: `${uuidv7()}:12`,
      idempotencyKey: 'original/API-key',
    },
    payloadBytes: Buffer.from('{ "nested": {"body":"original text"}, "n": 2 }\n'),
    preparedAt: '2026-06-01T02:03:04.567Z',
  };
}
function attempt(): ProjectRemoteAttemptInput {
  const input = request();
  return {
    operationId: uuidv7(),
    requestId: input.requestId,
    attemptId: uuidv7(),
    scope: input.scope,
    expectedSelection: { requestId: input.requestId, version: 2, attemptId: null, outcomeId: null },
    attemptedAt: input.preparedAt,
  };
}
function outcome(): Extract<ProjectRemoteOutcomeInput, { kind: 'acknowledged' }> {
  const input = attempt();
  return {
    operationId: uuidv7(),
    requestId: input.requestId,
    attemptId: input.attemptId,
    outcomeId: uuidv7(),
    scope: input.scope,
    expectedSelection: { ...input.expectedSelection, attemptId: input.attemptId, version: 3 },
    kind: 'acknowledged',
    observedAt: input.attemptedAt,
    failure: null,
    responseBytes: Buffer.from(' {"result":"accepted","external_id":"original-response"}\n'),
  };
}
function code(fn: () => unknown, expected: string) {
  try {
    fn();
    throw new Error('Expected refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectDatabaseError);
    expect(error).toMatchObject({ code: expected });
    return error;
  }
}

it('preserves exact request bytes and the original canonical operation key independently', () => {
  const input = request();
  const value = remoteRequestPreparation(prepareProjectRemoteRequest(input, options));
  expect(Buffer.from(value.payloadBase64, 'base64')).toEqual(input.payloadBytes);
  expect(value.payloadSha256).toBe(digest(input.payloadBytes));
  expect(value.requestKey).toBe(
    `operation:${digest(
      canonicalJson([
        input.scope.method,
        input.scope.targetExternalId,
        input.scope.idempotencyKey,
        digest(canonicalJson(JSON.parse(Buffer.from(input.payloadBytes).toString()))),
      ])
    )}`
  );
  expect(decodeRetainedRemoteRequest(input, value)).toEqual(value);
  const compact = {
    ...input,
    payloadBytes: Buffer.from(
      canonicalJson(JSON.parse(Buffer.from(input.payloadBytes).toString()))
    ),
  };
  const other = remoteRequestPreparation(prepareProjectRemoteRequest(compact, options));
  expect(other.requestKey).toBe(value.requestKey);
  expect(other.payloadSha256).not.toBe(value.payloadSha256);
});
it('normalizes server identity while preserving full scope and external string grammar', () => {
  const input = request();
  input.scope.target.server_url = 'HTTPS://EXAMPLE.TEST:443/API///';
  const value = remoteRequestPreparation(prepareProjectRemoteRequest(input, options));
  expect(value.scope.target.server_url).toBe('https://example.test/API');
  expect(value.scope.targetExternalId).toBe(input.scope.targetExternalId);
  for (const key of ['org_id', 'account_id'] as const) {
    const changed = structuredClone(input);
    changed.scope.target[key] += '/other';
    expect(
      remoteRequestPreparation(prepareProjectRemoteRequest(changed, options)).scope
    ).not.toEqual(value.scope);
  }
  const scoped = { ...input, scope: { ...input.scope, artifactId: uuidv7() } };
  expect(remoteRequestPreparation(prepareProjectRemoteRequest(scoped, options)).scope).not.toEqual(
    value.scope
  );
});
it.each(REMOTE_TRANSPORT_METHODS)('retains the finite %s method', (method) => {
  const input = request();
  input.scope.method = method;
  expect(remoteRequestPreparation(prepareProjectRemoteRequest(input, options)).scope.method).toBe(
    method
  );
});
it.each(['arbitrary.send', '', 'sourcePlan.attachPlan'])(
  'refuses unsupported method %s',
  (method) => {
    const input = request();
    Object.assign(input.scope, { method });
    code(() => prepareProjectRemoteRequest(input, options), 'INVALID_INPUT');
  }
);
it.each([
  'bad url',
  'file:///private/data',
  'https://user:password@example.test',
  'https://example.test?account=other',
  'https://example.test/#other',
])('refuses nonruntime server identity %s', (server_url) => {
  const input = request();
  input.scope.target.server_url = server_url;
  code(() => prepareProjectRemoteRequest(input, options), 'INVALID_INPUT');
});
it('refuses historical unknown ownership without inferring current credentials', () => {
  const input = request();
  Object.assign(input.scope.target, { account_id: null });
  code(() => prepareProjectRemoteRequest(input, options), 'INVALID_INPUT');
  Object.assign(input.scope.target, { server_url: null, org_id: null });
  code(() => prepareProjectRemoteRequest(input, options), 'INVALID_INPUT');
});
it('copies caller inputs and never grants prepared status to a forged or cloned token', () => {
  const input = request();
  const token = prepareProjectRemoteRequest(input, options);
  const value = remoteRequestPreparation(token);
  const original = JSON.stringify(value);
  input.payloadBytes.fill(0);
  input.scope.target.account_id = 'changed';
  input.operationId = uuidv7();
  expect(JSON.stringify(value)).toBe(original);
  expect(Object.isFrozen(value.scope.target)).toBe(true);
  code(() => remoteRequestPreparation({ ...token }), 'INVALID_INPUT');
});
it.each([Buffer.from('{'), Buffer.from('1e999'), Buffer.from([0xff])])(
  'refuses malformed or nonfinite JSON bytes',
  (payloadBytes) => {
    code(
      () => prepareProjectRemoteRequest({ ...request(), payloadBytes }, options),
      'INVALID_INPUT'
    );
  }
);
it.each(['{"body":"\\u0000"}', '{"body":"\\u001b[31m"}', '{"body":"\\u0000","body":"later"}'])(
  'refuses escaped forbidden controls in original bytes',
  (json) => {
    code(
      () => prepareProjectRemoteRequest({ ...request(), payloadBytes: Buffer.from(json) }, options),
      'INVALID_INPUT'
    );
    code(
      () =>
        prepareProjectRemoteOutcome({ ...outcome(), responseBytes: Buffer.from(json) }, options),
      'INVALID_INPUT'
    );
  }
);
it('retains typed secret refusal for escaped and overwritten JSON values', () => {
  const secret = ['ghp_', 'A'.repeat(36)].join('');
  const escaped = [...secret]
    .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('');
  const bytes = Buffer.from(`{"body":"${escaped}","body":"later"}`);
  const failure = code(
    () => prepareProjectRemoteRequest({ ...request(), payloadBytes: bytes }, options),
    'SECRET_IN_PAYLOAD'
  );
  expect(failure).toMatchObject({ cause: expect.any(SecretInPayloadError) });
  code(
    () => prepareProjectRemoteOutcome({ ...outcome(), responseBytes: bytes }, options),
    'SECRET_IN_PAYLOAD'
  );
  const unknown = {
    ...outcome(),
    kind: 'ack_unknown' as const,
    responseBytes: null,
    failure: { kind: 'unknown' as const, message: secret },
  };
  code(() => prepareProjectRemoteOutcome(unknown, options), 'SECRET_IN_PAYLOAD');
});
it('preserves the one original admitted attempt and refuses a second send preparation', () => {
  const input = attempt();
  const value = remoteAttemptPreparation(prepareProjectRemoteAttempt(input, options));
  expect(value).toEqual(input);
  expect(decodeRetainedRemoteAttempt(input)).toEqual(value);
  input.expectedSelection.attemptId = input.attemptId;
  expect(code(() => prepareProjectRemoteAttempt(input, options), 'INVALID_INPUT')).toMatchObject({
    message: expect.stringContaining('cannot be admitted or sent again'),
  });
  code(() => remoteAttemptPreparation({ kind: 'prepared-remote-attempt' }), 'INVALID_INPUT');
});
it('preserves acknowledged response bytes and rejects mismatched selected parents', () => {
  const input = outcome();
  const value = remoteOutcomePreparation(prepareProjectRemoteOutcome(input, options));
  expect(Buffer.from(value.responseBase64!, 'base64')).toEqual(input.responseBytes);
  expect(value.operationId).toBe(input.operationId);
  expect(decodeRetainedRemoteOutcome(input, value.responseSha256)).toEqual(value);
  const changed = structuredClone(input);
  changed.expectedSelection.attemptId = uuidv7();
  code(() => prepareProjectRemoteOutcome(changed, options), 'INVALID_INPUT');
  changed.expectedSelection.requestId = uuidv7();
  code(() => prepareProjectRemoteOutcome(changed, options), 'INVALID_INPUT');
  code(() => remoteOutcomePreparation({ kind: 'prepared-remote-outcome' }), 'INVALID_INPUT');
});
it('retains unknown observations without inventing a response or claiming an acknowledged state', () => {
  const input = outcome();
  const unknown = {
    ...input,
    kind: 'ack_unknown' as const,
    responseBytes: null,
    failure: { kind: 'unknown' as const, message: 'Original response was not observed' },
  };
  const value = remoteOutcomePreparation(prepareProjectRemoteOutcome(unknown, options));
  expect(value).toMatchObject({
    kind: 'ack_unknown',
    responseBase64: null,
    responseSha256: null,
    outcomeId: input.outcomeId,
  });
  const next = {
    ...input,
    outcomeId: uuidv7(),
    expectedSelection: { ...input.expectedSelection, outcomeId: input.outcomeId, version: 4 },
  };
  expect(remoteOutcomePreparation(prepareProjectRemoteOutcome(next, options)).kind).toBe(
    'acknowledged'
  );
  Object.assign(unknown, { responseBytes: Buffer.from('{}') });
  code(() => prepareProjectRemoteOutcome(unknown, options), 'INVALID_INPUT');
});
it('retained decoding checks exact hashes and canonical identity without reapplying authored policy', () => {
  const input = request();
  const value = remoteRequestPreparation(prepareProjectRemoteRequest(input, options));
  code(
    () => decodeRetainedRemoteRequest(input, { ...value, payloadSha256: 'a'.repeat(64) }),
    'HISTORY_INTEGRITY_REQUIRED'
  );
  const noncanonical = structuredClone(input);
  noncanonical.scope.target.server_url += '/';
  code(() => decodeRetainedRemoteRequest(noncanonical, value), 'HISTORY_INTEGRITY_REQUIRED');
  const response = outcome();
  code(() => decodeRetainedRemoteOutcome(response, 'a'.repeat(64)), 'HISTORY_INTEGRITY_REQUIRED');
  const secret = ['ghp_', 'A'.repeat(36)].join('');
  response.responseBytes = Buffer.from(JSON.stringify({ original: secret }));
  const retained = decodeRetainedRemoteOutcome(response, digest(response.responseBytes));
  expect(Buffer.from(retained.responseBase64!, 'base64')).toEqual(response.responseBytes);
  code(() => remoteOutcomePreparation(retained as never), 'INVALID_INPUT');
});
it('classifies malformed retained envelopes as integrity failures', () => {
  code(
    () => decodeRetainedRemoteRequest(null as never, null as never),
    'HISTORY_INTEGRITY_REQUIRED'
  );
  code(() => decodeRetainedRemoteAttempt(null as never), 'HISTORY_INTEGRITY_REQUIRED');
  code(() => decodeRetainedRemoteOutcome(null as never, null), 'HISTORY_INTEGRITY_REQUIRED');
});
