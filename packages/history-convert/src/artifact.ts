import { HistoryConversionError } from './errors.js';
import type { EventRecord } from './legacy/storage/events/event-log.js';
import {
  type EventWithPayload,
  rebuildAllCheckpointsFromEvents,
  rebuildArtifactJsonFromEvents,
  rebuildCheckpointFromEvents,
  rebuildEvaluatorLogFromEvents,
  rebuildPlanFromEvents,
  rebuildSummaryFromEvents,
} from './legacy/storage/events/rebuilders.js';
import { isUuidV7 } from './legacy/storage/ids/uuidv7.js';
import { PrePrCheckedPayloadSchema } from './legacy/storage/schema/pre-pr-checked.js';
import { decodeLegacyLog } from './log.js';

export function decodeLegacyArtifact(input: {
  artifactId: string;
  bytes: Buffer;
  sidecars?: ReadonlyMap<string, Buffer>;
}) {
  if (!isUuidV7(input.artifactId))
    throw new HistoryConversionError('SOURCE_INTEGRITY', 'Legacy artifact identity is invalid');
  const log = decodeLegacyLog({ ...input, kind: 'artifact' });
  if (log.events[0]?.record.type !== 'plan_captured')
    throw new HistoryConversionError('SOURCE_INTEGRITY', 'Legacy artifact has no initial plan');
  try {
    const events: EventWithPayload[] = [];
    for (const event of log.events) {
      const payload = event.payload;
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
        throw new Error('Expected structured artifact payload');
      if ('artifact_id' in payload && payload.artifact_id !== input.artifactId)
        throw new Error('Payload belongs to another artifact');
      if (event.record.type === 'plan_captured' && events.length)
        throw new Error('A captured artifact cannot begin twice');
      events.push({ record: event.record as EventRecord, payload });
      // Validate superseded payloads too; replaying only the final view can hide an invalid earlier record.
      if (event.record.type === 'plan_captured' || event.record.type === 'plan_revised')
        rebuildPlanFromEvents(events);
      if (event.record.type === 'summary_captured') rebuildSummaryFromEvents(events);
      if (event.record.type.startsWith('checkpoint_')) {
        if (
          !('n' in payload) ||
          typeof payload.n !== 'number' ||
          !Number.isInteger(payload.n) ||
          payload.n < 1
        )
          throw new Error('Checkpoint payload has no valid ordinal');
        rebuildCheckpointFromEvents(events, payload.n);
      }
      if (event.record.type === 'pre_pr_checked') PrePrCheckedPayloadSchema.parse(payload);
    }
    const plan = rebuildPlanFromEvents(events)?.plan;
    const artifact = rebuildArtifactJsonFromEvents(events)?.json;
    if (!plan || !artifact) throw new Error('Artifact replay is incomplete');
    return {
      artifactId: input.artifactId,
      log,
      plan,
      artifact,
      checkpoints: rebuildAllCheckpointsFromEvents(events),
      summary: rebuildSummaryFromEvents(events)?.summary ?? null,
      evaluatorLog: rebuildEvaluatorLogFromEvents(events, input.artifactId)?.log ?? null,
    };
  } catch {
    throw new HistoryConversionError(
      'SOURCE_INTEGRITY',
      'Legacy artifact cannot be replayed with the complete frozen source semantics',
      input.artifactId
    );
  }
}
