import type { OrcaCloudClient } from '@orcaops/sdk';
import { canonicalJson } from '@orcaops/storage';

import type { ArtifactPushClient } from '../history/sync/dispatch.js';

export interface ArtifactPushSdkClient {
  captureThread: Pick<
    OrcaCloudClient['captureThread'],
    | 'start'
    | 'attachPlan'
    | 'attachPlanRevision'
    | 'attachCheckpointOpened'
    | 'attachCheckpoint'
    | 'attachSummary'
    | 'attachEvaluators'
    | 'attachCodingSessionsUsage'
  >;
  sourcePlan: Pick<OrcaCloudClient['sourcePlan'], 'attachPin'>;
}

function responseBytes(response: unknown): Buffer {
  return Buffer.from(canonicalJson(response));
}

export function createArtifactPushClient(client: ArtifactPushSdkClient): ArtifactPushClient {
  return {
    captureThread: {
      start: async (bytes) => {
        const request: Parameters<OrcaCloudClient['captureThread']['start']>[0] = JSON.parse(
          bytes.toString('utf8')
        );
        return responseBytes(await client.captureThread.start(request));
      },
      attachPlan: async (bytes) => {
        const request: Parameters<OrcaCloudClient['captureThread']['attachPlan']>[0] = JSON.parse(
          bytes.toString('utf8')
        );
        return responseBytes(await client.captureThread.attachPlan(request));
      },
      attachPlanRevision: async (bytes) => {
        const request: Parameters<OrcaCloudClient['captureThread']['attachPlanRevision']>[0] =
          JSON.parse(bytes.toString('utf8'));
        return responseBytes(await client.captureThread.attachPlanRevision(request));
      },
      attachCheckpointOpened: async (bytes) => {
        const request: Parameters<OrcaCloudClient['captureThread']['attachCheckpointOpened']>[0] =
          JSON.parse(bytes.toString('utf8'));
        return responseBytes(await client.captureThread.attachCheckpointOpened(request));
      },
      attachCheckpoint: async (bytes) => {
        const request: Parameters<OrcaCloudClient['captureThread']['attachCheckpoint']>[0] =
          JSON.parse(bytes.toString('utf8'));
        return responseBytes(await client.captureThread.attachCheckpoint(request));
      },
      attachSummary: async (bytes) => {
        const request: Parameters<OrcaCloudClient['captureThread']['attachSummary']>[0] =
          JSON.parse(bytes.toString('utf8'));
        return responseBytes(await client.captureThread.attachSummary(request));
      },
      attachEvaluators: async (bytes) => {
        const request: Parameters<OrcaCloudClient['captureThread']['attachEvaluators']>[0] =
          JSON.parse(bytes.toString('utf8'));
        return responseBytes(await client.captureThread.attachEvaluators(request));
      },
      attachCodingSessionsUsage: async (bytes) => {
        const request: Parameters<
          OrcaCloudClient['captureThread']['attachCodingSessionsUsage']
        >[0] = JSON.parse(bytes.toString('utf8'));
        return responseBytes(await client.captureThread.attachCodingSessionsUsage(request));
      },
    },
    sourcePlan: {
      attachPin: async (bytes) => {
        const request: Parameters<OrcaCloudClient['sourcePlan']['attachPin']>[0] = JSON.parse(
          bytes.toString('utf8')
        );
        return responseBytes(await client.sourcePlan.attachPin(request));
      },
    },
  };
}
