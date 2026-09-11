import type { OrcaCloudClient } from '@orcaops/sdk';
import { canonicalJson, type Checkpoint } from '@orcaops/storage';
import type { ProjectArtifactPushInput } from '@orcaops/storage/history/database/artifact-push';

import type { ArtifactSnapshot } from './hash.js';
import {
  toWireCheckpoint,
  toWireCheckpointOpened,
  toWireEvaluators,
  toWirePlan,
  toWireSummary,
  toWireUsage,
} from './sync-wire.js';

type SnapshotPushCall = {
  method: ProjectArtifactPushInput['calls'][number]['method'];
  target_external_id: string;
  payload_json: string;
};

export async function callsForSnapshot(
  snapshot: ArtifactSnapshot,
  start: Parameters<OrcaCloudClient['captureThread']['start']>[0],
  pin: unknown | null,
  resolveCriterionText: (cp: Checkpoint) => Promise<Map<string, string>>
): Promise<SnapshotPushCall[]> {
  const calls: SnapshotPushCall[] = [];
  const add = (
    method: SnapshotPushCall['method'],
    payload: unknown,
    target = snapshot.plan!.artifact_id
  ) => calls.push({ method, target_external_id: target, payload_json: canonicalJson(payload) });
  add('captureThread.start', start);
  add(
    snapshot.plan!.revision_n === 0
      ? 'captureThread.attachPlan'
      : 'captureThread.attachPlanRevision',
    toWirePlan(snapshot.plan!)
  );
  for (const cp of snapshot.checkpoints) {
    const target = `${cp.artifact_id}:${cp.n}`;
    if (cp.status === 'open') {
      add('captureThread.attachCheckpointOpened', toWireCheckpointOpened(cp), target);
      continue;
    }
    const wire = toWireCheckpoint(
      cp,
      snapshot.fingerprintByN.get(cp.n) ?? null,
      await resolveCriterionText(cp)
    );
    if (wire) add('captureThread.attachCheckpoint', wire, target);
  }
  if (snapshot.summary) add('captureThread.attachSummary', toWireSummary(snapshot.summary));
  if (snapshot.evaluators)
    add('captureThread.attachEvaluators', toWireEvaluators(snapshot.evaluators));
  if (snapshot.usage)
    add(
      'captureThread.attachCodingSessionsUsage',
      toWireUsage(snapshot.usage, snapshot.plan!.artifact_id)
    );
  if (pin) add('sourcePlan.attachPin', pin);
  return calls;
}
