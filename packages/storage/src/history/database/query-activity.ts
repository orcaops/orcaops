import { z } from 'zod';

import type { ArtifactThread } from '../../events/artifact-thread.js';
import type {
  AbandonedCheckpoint,
  ClosedCheckpoint,
  OpenCheckpoint,
} from '../../schema/checkpoint.js';
type ActivityCheckpoint =
  | Pick<OpenCheckpoint, 'status' | 'opened_at'>
  | Pick<ClosedCheckpoint, 'status' | 'opened_at' | 'closed_at'>
  | Pick<AbandonedCheckpoint, 'status' | 'opened_at' | 'abandoned_at'>;

const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
export const ArtifactActivitySchema = z.strictObject({
  startedAt: timestamp,
  summaryAt: timestamp.nullable(),
  checkpoints: z.array(z.strictObject({ openedAt: timestamp, endedAt: timestamp.nullable() })),
});

export function prepareArtifactActivity(thread: {
  plan: Pick<NonNullable<ArtifactThread['plan']>, 'started_at'> | null;
  summary: Pick<NonNullable<ArtifactThread['summary']>, 'ts'> | null;
  checkpoints: readonly ActivityCheckpoint[];
}): z.infer<typeof ArtifactActivitySchema> {
  return ArtifactActivitySchema.parse({
    startedAt: thread.plan!.started_at,
    summaryAt: thread.summary?.ts ?? null,
    checkpoints: thread.checkpoints.map((checkpoint) => ({
      openedAt: checkpoint.opened_at,
      endedAt:
        checkpoint.status === 'closed'
          ? checkpoint.closed_at
          : checkpoint.status === 'abandoned'
            ? checkpoint.abandoned_at
            : null,
    })),
  });
}

export function artifactActivityPredicate(lower?: number, upper?: number) {
  if (lower === undefined && upper === undefined) return null;
  const point = (field: string) => {
    const expression = `orcaops_history_time(json_extract(activity_metadata.details_json, '$.activity.${field}'))`;
    return {
      sql: [
        lower === undefined ? null : `${expression}>=?`,
        upper === undefined ? null : `${expression}<=?`,
      ]
        .filter(Boolean)
        .join(' AND '),
      parameters: [lower, upper].filter((value): value is number => value !== undefined),
    };
  };
  const start = point('startedAt');
  const summary = point('summaryAt');
  const interval: string[] = [];
  const parameters: number[] = [];
  if (upper !== undefined) {
    interval.push("orcaops_history_time(json_extract(activity.value,'$.openedAt'))<=?");
    parameters.push(upper);
  }
  if (lower !== undefined) {
    interval.push(
      "(json_extract(activity.value,'$.endedAt') IS NULL OR orcaops_history_time(json_extract(activity.value,'$.endedAt'))>=?)"
    );
    parameters.push(lower);
  }
  return {
    sql: `EXISTS (SELECT 1 FROM artifact_query_metadata activity_metadata WHERE activity_metadata.artifact_id=a.artifact_id AND ((${start.sql}) OR (${summary.sql}) OR EXISTS (SELECT 1 FROM json_each(activity_metadata.details_json,'$.activity.checkpoints') activity WHERE ${interval.join(' AND ')})))`,
    parameters: [...start.parameters, ...summary.parameters, ...parameters],
  };
}
