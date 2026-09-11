import childProcess from 'node:child_process';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import {
  decodeRetainedArtifactPush,
  prepareProjectArtifactPush,
  projectArtifactPush,
  type ProjectArtifactPushCallInput,
  type ProjectArtifactPushInput,
} from './artifact-push-input.js';

afterEach(() => vi.restoreAllMocks());
const options = { secretAllow: [] as string[] };
const invalid = expect.objectContaining({ code: 'INVALID_INPUT' });
const refused = expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' });
function call(
  artifactId: string,
  method: ProjectArtifactPushCallInput['method'],
  fields: Record<string, unknown> = {}
): ProjectArtifactPushCallInput {
  const checkpoint =
    method === 'captureThread.attachCheckpoint' ||
    method === 'captureThread.attachCheckpointOpened';
  return {
    requestId: uuidv7(),
    method,
    targetExternalId: checkpoint ? `${artifactId}:${fields.n}` : artifactId,
    payloadBytes: Buffer.from(
      JSON.stringify(
        {
          [method === 'captureThread.start' ? 'externalId' : 'artifact_id']: artifactId,
          ...fields,
        },
        null,
        3
      ) + '\n'
    ),
  };
}
function input(): ProjectArtifactPushInput {
  const artifactId = uuidv7();
  const target = {
    server_url: 'https://example.test',
    org_id: 'original org',
    account_id: 'account',
  };
  return {
    pushId: uuidv7(),
    operationId: uuidv7(),
    terminalOperationId: uuidv7(),
    artifactId,
    target,
    artifactRevision: {
      generation: 2,
      orderedHash: 'a'.repeat(64),
      eventCount: 5,
      byteLength: 300,
      tailEventId: uuidv7(),
    },
    artifactPayloadHash: 'b'.repeat(64),
    usageRevision: {
      generation: 3,
      orderedHash: 'c'.repeat(64),
      eventCount: 7,
      byteLength: 500,
      tailEventId: uuidv7(),
    },
    expectedPushSelection: { pushId: uuidv7(), version: 2 },
    expectedCloudSelection: { revisionId: uuidv7(), version: 4 },
    session: {
      key: { target, repoUrl: 'ssh://git@example.test/repo', workingDir: '/original/worktree' },
      expectedSelection: { revisionId: uuidv7(), version: 5 },
      acknowledgementId: uuidv7(),
      resultRevisionId: uuidv7(),
    },
    cloudAcknowledgementId: uuidv7(),
    preparedAt: '2026-09-01T00:00:00Z',
    result: { checkpoints: 2, summary: true, evaluators: 3, sourcePlanPinned: 'A' },
    calls: [
      call(artifactId, 'captureThread.start'),
      call(artifactId, 'captureThread.attachPlan'),
      call(artifactId, 'captureThread.attachCheckpoint', { n: 1 }),
      call(artifactId, 'captureThread.attachCheckpointOpened', { n: 2 }),
      call(artifactId, 'captureThread.attachSummary'),
      call(artifactId, 'captureThread.attachEvaluators'),
      call(artifactId, 'captureThread.attachCodingSessionsUsage'),
      call(artifactId, 'sourcePlan.attachPin'),
    ],
  };
}
it('preserves exact original ordered wire bytes and genuine group identities', () => {
  const value = input();
  const result = projectArtifactPush(prepareProjectArtifactPush(value, options));
  expect(result.pushId).toBe(value.pushId);
  expect(result.operationId).toBe(value.operationId);
  expect(result.terminalOperationId).toBe(value.terminalOperationId);
  expect(result.artifactRevision).toEqual(value.artifactRevision);
  expect(result.usageRevision).toEqual(value.usageRevision);
  expect(result.session).toEqual(value.session);
  expect(result.expectedCloudSelection).toEqual(value.expectedCloudSelection);
  expect(result.expectedPushSelection).toEqual(value.expectedPushSelection);
  expect(result.result).toEqual(value.result);
  result.calls.forEach((item, index) => {
    expect(item.requestId).toBe(value.calls[index]!.requestId);
    expect(item.ordinal).toBe(index + 1);
    expect(Buffer.from(item.payloadBase64, 'base64')).toEqual(
      Buffer.from(value.calls[index]!.payloadBytes)
    );
    expect(item.payloadSha256).toBe(digest(value.calls[index]!.payloadBytes));
    expect(item).not.toHaveProperty('operationId');
  });
  expect(result).not.toHaveProperty('acknowledgedAt');
  expect(result).not.toHaveProperty('applied');
  expect(result).not.toHaveProperty('receipt');
});
it('permits a historical artifact push with no current session or usage association', () => {
  const value = input();
  value.session =
    value.usageRevision =
    value.expectedCloudSelection =
    value.expectedPushSelection =
      null;
  value.result.summary = false;
  value.result.sourcePlanPinned = null;
  value.calls = value.calls.filter(
    (item) =>
      ![
        'captureThread.attachSummary',
        'sourcePlan.attachPin',
        'captureThread.attachCodingSessionsUsage',
      ].includes(item.method)
  );
  value.calls[1] = call(value.artifactId, 'captureThread.attachPlanRevision');
  const result = projectArtifactPush(prepareProjectArtifactPush(value, options));
  expect(result.session).toBeNull();
  expect(result.usageRevision).toBeNull();
  expect(result.calls[1]!.method).toBe('captureThread.attachPlanRevision');
});
it('retains copied input and refuses counterfeit preparations', () => {
  const value = input();
  const original = structuredClone(value);
  const prepared = prepareProjectArtifactPush(value, options);
  value.calls[0]!.payloadBytes.fill(0);
  value.calls.reverse();
  value.session!.key.repoUrl = 'changed';
  value.terminalOperationId = uuidv7();
  value.result.checkpoints = 999;
  const result = projectArtifactPush(prepared);
  expect(result.terminalOperationId).toBe(original.terminalOperationId);
  expect(result.result).toEqual(original.result);
  expect(result.session).toEqual(original.session);
  expect(Buffer.from(result.calls[0]!.payloadBase64, 'base64')).toEqual(
    Buffer.from(original.calls[0]!.payloadBytes)
  );
  expect(() => (result.calls as unknown[]).push('changed')).toThrow();
  expect(() => {
    result.session!.expectedSelection.version = 99;
  }).toThrow();
  expect(() => projectArtifactPush(structuredClone(prepared))).toThrowError(invalid);
});
it('compares original call order and exact byte representation without reserialization', () => {
  const value = input();
  const first = projectArtifactPush(prepareProjectArtifactPush(value, options));
  const copied = structuredClone(value);
  expect(projectArtifactPush(prepareProjectArtifactPush(copied, options)).requestSha256).toBe(
    first.requestSha256
  );
  [copied.calls[2], copied.calls[3]] = [copied.calls[3]!, copied.calls[2]!];
  expect(projectArtifactPush(prepareProjectArtifactPush(copied, options)).requestSha256).not.toBe(
    first.requestSha256
  );
  copied.calls = structuredClone(value.calls);
  copied.calls[0]!.payloadBytes = Buffer.from(
    JSON.stringify(JSON.parse(Buffer.from(copied.calls[0]!.payloadBytes).toString()))
  );
  const changed = projectArtifactPush(prepareProjectArtifactPush(copied, options));
  expect(changed.requestSha256).not.toBe(first.requestSha256);
  expect(changed.calls[0]!.requestKey).toBe(first.calls[0]!.requestKey);
});
it.each([
  'duplicateRequest',
  'duplicateSlot',
  'terminalIdentity',
  'wrongAccount',
  'wrongArtifact',
  'wrongCheckpoint',
  'wrongOrder',
  'unknownMethod',
  'childOperation',
])('refuses invalid fixed ownership %s', (kind) => {
  const value = input();
  if (kind === 'duplicateRequest') value.calls[2]!.requestId = value.calls[0]!.requestId;
  if (kind === 'duplicateSlot') value.calls.push({ ...value.calls[2]!, requestId: uuidv7() });
  if (kind === 'terminalIdentity') value.terminalOperationId = value.operationId;
  if (kind === 'wrongAccount') value.session!.key.target = { ...value.target, account_id: 'other' };
  if (kind === 'wrongArtifact') value.calls[1] = call(uuidv7(), 'captureThread.attachPlan');
  if (kind === 'wrongCheckpoint') value.calls[2]!.targetExternalId = `${value.artifactId}:9`;
  if (kind === 'wrongOrder') value.calls.reverse();
  if (kind === 'unknownMethod')
    value.calls[0]!.method = 'sourcePlan.create' as ProjectArtifactPushCallInput['method'];
  if (kind === 'childOperation') Object.assign(value.calls[0]!, { operationId: uuidv7() });
  expect(() => prepareProjectArtifactPush(value, options)).toThrowError(invalid);
});
it.each(['summary', 'pin'])('refuses inconsistent declared %s call membership', (kind) => {
  const value = input();
  if (kind === 'summary') value.result.summary = false;
  else value.result.sourcePlanPinned = null;
  expect(() => prepareProjectArtifactPush(value, options)).toThrowError(invalid);
});
it('refuses noncanonical or unknown targets and invalid original selection', () => {
  const value = input();
  value.target.server_url = 'https://EXAMPLE.test/';
  expect(() => prepareProjectArtifactPush(value, options)).toThrowError(invalid);
  const unknown = input();
  unknown.target.account_id = '';
  expect(() => prepareProjectArtifactPush(unknown, options)).toThrowError(invalid);
  const invalidSelection = input();
  invalidSelection.artifactRevision.eventCount = 0;
  expect(() => prepareProjectArtifactPush(invalidSelection, options)).toThrowError(invalid);
});
it('refuses malformed wire bytes without producing a prepared group', () => {
  for (const payloadBytes of [Buffer.from([0xff]), Buffer.from('{'), Buffer.from('null')]) {
    const value = input();
    value.calls[0]!.payloadBytes = payloadBytes;
    expect(() => prepareProjectArtifactPush(value, options)).toThrowError(invalid);
  }
});
it('refuses raw and overwritten escaped secrets while preserving accepted allowlisted bytes', () => {
  const value = input();
  const secret = ['ghp_', 'A'.repeat(36)].join('');
  const safe = Buffer.from(value.calls[0]!.payloadBytes).toString();
  const raw =
    '{"description":' +
    JSON.stringify(secret).replace('g', '\\u0067') +
    ',"description":"safe",' +
    safe.slice(1);
  value.calls[0]!.payloadBytes = Buffer.from(raw);
  expect(() => prepareProjectArtifactPush(value, options)).toThrowError(refused);
  const result = projectArtifactPush(prepareProjectArtifactPush(value, { secretAllow: [secret] }));
  expect(Buffer.from(result.calls[0]!.payloadBase64, 'base64').toString()).toBe(raw);
  expect(value.calls[0]!.payloadBytes).toEqual(Buffer.from(raw));
});
it('performs pure preparation without filesystem or subprocess operations', () => {
  const spies = [
    vi.spyOn(fs, 'readFileSync'),
    vi.spyOn(fs, 'writeFileSync'),
    vi.spyOn(promises, 'readFile'),
    vi.spyOn(promises, 'writeFile'),
    vi.spyOn(childProcess, 'spawn'),
    vi.spyOn(childProcess, 'execFile'),
  ];
  prepareProjectArtifactPush(input(), options);
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

function comparison(prepared: ReturnType<typeof projectArtifactPush>) {
  return {
    requestSha256: prepared.requestSha256,
    calls: prepared.calls.map((call) => ({
      requestId: call.requestId,
      ordinal: call.ordinal,
      payloadSha256: call.payloadSha256,
      requestKey: call.requestKey,
    })),
  };
}
it('decodes retained original calls without granting authored preparation authority', () => {
  const value = input(),
    authored = projectArtifactPush(prepareProjectArtifactPush(value, options));
  const retained = decodeRetainedArtifactPush(value, comparison(authored));
  expect(retained).toEqual(authored);
  value.calls[0]!.payloadBytes.fill(0);
  expect(Buffer.from(retained.calls[0]!.payloadBase64, 'base64')).toEqual(
    Buffer.from(authored.calls[0]!.payloadBase64, 'base64')
  );
  expect(() => projectArtifactPush(retained as never)).toThrowError(invalid);
  expect(() => (retained.calls as unknown as unknown[]).push(retained.calls[0]!)).toThrow();
});
it('retains previously accepted exact content without reapplying authored refusal', () => {
  const value = input(),
    token = ['ghp', 'A'.repeat(36)].join('_');
  value.calls[0]!.payloadBytes = Buffer.from(
    JSON.stringify({ externalId: value.artifactId, original: token })
  );
  const authored = projectArtifactPush(prepareProjectArtifactPush(value, { secretAllow: [token] }));
  expect(() => prepareProjectArtifactPush(value, options)).toThrowError(refused);
  expect(decodeRetainedArtifactPush(value, comparison(authored))).toEqual(authored);
});
it.each([
  'bytes',
  'request hash',
  'payload hash',
  'request key',
  'order',
  'source',
  'missing metadata',
] as const)('refuses changed retained %s', (change) => {
  const value = input(),
    authored = projectArtifactPush(prepareProjectArtifactPush(value, options)),
    expected = comparison(authored);
  if (change === 'bytes')
    value.calls[0]!.payloadBytes = Buffer.from(
      JSON.stringify({ externalId: value.artifactId, changed: true })
    );
  if (change === 'request hash') expected.requestSha256 = 'c'.repeat(64);
  if (change === 'payload hash') expected.calls[0]!.payloadSha256 = 'c'.repeat(64);
  if (change === 'request key') expected.calls[0]!.requestKey = 'operation:changed';
  if (change === 'order') value.calls.reverse();
  if (change === 'source') value.artifactRevision.generation++;
  if (change === 'missing metadata') expected.calls.pop();
  expect(() => decodeRetainedArtifactPush(value, expected)).toThrowError(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
});
