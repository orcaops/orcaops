import { describe, expect, it, vi } from 'vitest';

import type { OrcaCloudClient } from '@orcaops/sdk';
import { canonicalJson } from '@orcaops/storage';

import {
  type ArtifactPushSdkClient,
  createArtifactPushClient,
} from './database-artifact-push-transport.js';

const methods = [
  'captureThread.start',
  'captureThread.attachPlan',
  'captureThread.attachPlanRevision',
  'captureThread.attachCheckpointOpened',
  'captureThread.attachCheckpoint',
  'captureThread.attachSummary',
  'captureThread.attachEvaluators',
  'captureThread.attachCodingSessionsUsage',
  'sourcePlan.attachPin',
] as const;

function sdkClient(): {
  client: ArtifactPushSdkClient;
  received: Array<{ method: (typeof methods)[number]; request: unknown }>;
} {
  const received: Array<{ method: (typeof methods)[number]; request: unknown }> = [];
  const record = (method: (typeof methods)[number], request: unknown) => {
    received.push({ method, request });
  };
  const captureThread = {
    start: vi.fn(async (request) => {
      record('captureThread.start', request);
      return { commandId: 'command-1', status: 'accepted' as const };
    }),
    attachPlan: vi.fn(async (request) => {
      record('captureThread.attachPlan', request);
      return { id: 'attachment-2', z: 'captureThread.attachPlan' };
    }),
    attachPlanRevision: vi.fn(async (request) => {
      record('captureThread.attachPlanRevision', request);
      return { id: 'attachment-3', z: 'captureThread.attachPlanRevision' };
    }),
    attachCheckpointOpened: vi.fn(async (request) => {
      record('captureThread.attachCheckpointOpened', request);
      return { id: 'attachment-4', z: 'captureThread.attachCheckpointOpened' };
    }),
    attachCheckpoint: vi.fn(async (request) => {
      record('captureThread.attachCheckpoint', request);
      return { id: 'attachment-5', z: 'captureThread.attachCheckpoint' };
    }),
    attachSummary: vi.fn(async (request) => {
      record('captureThread.attachSummary', request);
      return { id: 'attachment-6', z: 'captureThread.attachSummary' };
    }),
    attachEvaluators: vi.fn(async (request) => {
      record('captureThread.attachEvaluators', request);
      return [{ id: 'attachment-7', z: 'captureThread.attachEvaluators' }];
    }),
    attachCodingSessionsUsage: vi.fn(async (request) => {
      record('captureThread.attachCodingSessionsUsage', request);
      return [{ id: 'attachment-8', z: 'captureThread.attachCodingSessionsUsage' }];
    }),
  } satisfies ArtifactPushSdkClient['captureThread'];
  const sourcePlan = {
    attachPin: vi.fn(async (request) => {
      record('sourcePlan.attachPin', request);
      return { id: 'attachment-9', z: 'sourcePlan.attachPin' };
    }),
  } satisfies ArtifactPushSdkClient['sourcePlan'];
  return {
    client: { captureThread, sourcePlan },
    received,
  };
}

describe('createArtifactPushClient', () => {
  it('dispatches each retained request to the matching SDK method', async () => {
    const sdk = sdkClient();
    const client = createArtifactPushClient(sdk.client);
    const calls = [
      client.captureThread.start,
      client.captureThread.attachPlan,
      client.captureThread.attachPlanRevision,
      client.captureThread.attachCheckpointOpened,
      client.captureThread.attachCheckpoint,
      client.captureThread.attachSummary,
      client.captureThread.attachEvaluators,
      client.captureThread.attachCodingSessionsUsage,
      client.sourcePlan.attachPin,
    ];

    const expectedResponses = [
      { commandId: 'command-1', status: 'accepted' },
      { id: 'attachment-2', z: methods[1] },
      { id: 'attachment-3', z: methods[2] },
      { id: 'attachment-4', z: methods[3] },
      { id: 'attachment-5', z: methods[4] },
      { id: 'attachment-6', z: methods[5] },
      [{ id: 'attachment-7', z: methods[6] }],
      [{ id: 'attachment-8', z: methods[7] }],
      { id: 'attachment-9', z: methods[8] },
    ];
    for (const [index, call] of calls.entries()) {
      const request = { method: methods[index], nested: { index } };
      const response = await call(Buffer.from(canonicalJson(request)));
      expect(response.toString('utf8')).toBe(canonicalJson(expectedResponses[index]));
    }

    expect(sdk.received).toEqual(
      methods.map((method, index) => ({ method, request: { method, nested: { index } } }))
    );
  });

  it('propagates SDK failures without rewriting them', async () => {
    const failure = Object.assign(new Error('delivery outcome is unknown'), {
      code: 'TRANSPORT_UNKNOWN',
    });
    const start = vi.fn<OrcaCloudClient['captureThread']['start']>().mockRejectedValue(failure);
    const sdk = sdkClient();
    sdk.client.captureThread.start = start;

    await expect(
      createArtifactPushClient(sdk.client).captureThread.start(Buffer.from('{"externalId":"a"}'))
    ).rejects.toBe(failure);
  });
});
