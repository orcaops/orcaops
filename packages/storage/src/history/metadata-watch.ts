import { z } from 'zod';

import type { ArtifactThread } from '../events/artifact-thread.js';

const PREVIEW_LIMIT = 320;
const EVENT_LIMIT = 256;
export const HistoryWatchMetadataSchema = z.strictObject({
  currentLine: z.string().max(PREVIEW_LIMIT).nullable(),
  currentLineTruncated: z.boolean(),
  lastClosed: z
    .strictObject({
      closedAt: z.string(),
      hasSummary: z.boolean(),
      uncertaintyCount: z.number().int().nonnegative(),
    })
    .nullable(),
  events: z.array(z.strictObject({ ts: z.string(), type: z.string() })).max(EVENT_LIMIT),
  omittedEvents: z.number().int().nonnegative(),
});

export function historyWatchMetadata(
  thread: ArtifactThread
): z.infer<typeof HistoryWatchMetadataSchema> {
  const closed = thread.checkpoints.filter((cp) => cp.status === 'closed').at(-1);
  const open = thread.checkpoints.find((cp) => cp.status === 'open');
  const declared = open?.declared_step_ids[0];
  const line =
    thread.plan?.plan_steps.find((step) => step.step_id === declared)?.text ??
    closed?.summary ??
    null;
  return {
    currentLine: line?.slice(0, PREVIEW_LIMIT) ?? null,
    currentLineTruncated: line !== null && line.length > PREVIEW_LIMIT,
    lastClosed: closed
      ? {
          closedAt: closed.closed_at,
          hasSummary: closed.summary.trim().length > 0,
          uncertaintyCount: closed.uncertainty.length,
        }
      : null,
    events: thread.events
      .slice(-EVENT_LIMIT)
      .map(({ record }) => ({ ts: record.ts, type: record.type })),
    omittedEvents: Math.max(0, thread.events.length - EVENT_LIMIT),
  };
}
