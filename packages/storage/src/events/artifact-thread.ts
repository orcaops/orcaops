import {
  type EventWithPayload,
  rebuildAllCheckpointsFromEvents,
  rebuildArtifactJsonFromEvents,
  rebuildEvaluatorLogFromEvents,
  rebuildPlanFromEvents,
  rebuildSummaryFromEvents,
} from './rebuilders.js';
import type { ArtifactJson } from '../schema/artifact-json.js';
import type { Checkpoint } from '../schema/checkpoint.js';
import type { EvaluatorLog } from '../schema/evaluator-run.js';
import type { Plan } from '../schema/plan.js';
import type { Summary } from '../schema/summary.js';

export interface ArtifactThread {
  artifactId: string;
  events: EventWithPayload[];
  plan: Plan | null;
  checkpoints: Checkpoint[];
  summary: Summary | null;
  evaluatorLog: EvaluatorLog | null;
  artifactJson: ArtifactJson | null;
}

// Callers establish source integrity; reconstruction never substitutes a cache for missing events.
export function reconstructArtifactThread(
  artifactId: string,
  events: EventWithPayload[]
): ArtifactThread {
  for (const event of events) {
    if (
      event.payload === null ||
      typeof event.payload !== 'object' ||
      Array.isArray(event.payload) ||
      !Object.prototype.hasOwnProperty.call(event.payload, 'artifact_id')
    ) {
      continue;
    }
    const payloadArtifactId = (event.payload as Record<string, unknown>).artifact_id;
    if (payloadArtifactId !== artifactId) {
      throw new Error(
        `Artifact ${JSON.stringify(artifactId)} contains a ${event.record.type} event for ${JSON.stringify(payloadArtifactId)}.`
      );
    }
  }
  return {
    artifactId,
    events,
    plan: rebuildPlanFromEvents(events)?.plan ?? null,
    checkpoints: rebuildAllCheckpointsFromEvents(events),
    summary: rebuildSummaryFromEvents(events)?.summary ?? null,
    evaluatorLog: rebuildEvaluatorLogFromEvents(events, artifactId)?.log ?? null,
    artifactJson: rebuildArtifactJsonFromEvents(events)?.json ?? null,
  };
}
