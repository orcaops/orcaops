import { z } from 'zod';

import { type JournalEvent, reviewedRowsDigest } from '@orcaops/review-core';
import { canonicalJson } from '@orcaops/storage';

import { decodeRetainedReviewRecord, prepareReviewRecords } from './records.js';
import { cancelled, invalid, revisionId, validate } from './request.js';

const eventsSchema = z.strictObject({
  events: z.array(z.strictObject({ revisionId, bytes: z.instanceof(Uint8Array) })).min(1),
  secretAllow: z.array(z.string()),
});
export type PrepareReviewWorkflowEvents = Omit<z.infer<typeof eventsSchema>, 'events'> & {
  events: { revisionId: string; bytes: Uint8Array }[];
};

export function workflowTarget(event: JournalEvent): string {
  switch (event.type) {
    case 'section':
      return canonicalJson(['section', event.threadKey]);
    case 'finding':
      return canonicalJson(['finding', event.findingKey]);
    case 'uncertainty':
      return canonicalJson(['uncertainty', event.citationId]);
    case 'prompt':
      return canonicalJson(['prompt', event.promptKey]);
    case 'unassigned':
      return canonicalJson([
        'unassigned',
        event.target.kind,
        event.target.kind === 'GAP_ROWS' ? event.target.coveredRowsDigest : event.target.hunkKey,
      ]);
    case 'review_coverage':
    case 'review_lifecycle':
      return canonicalJson([event.type]);
  }
}

export async function prepareReviewWorkflowEvents(
  raw: PrepareReviewWorkflowEvents,
  options: { signal?: AbortSignal } = {}
) {
  const signal = options.signal;
  const input = validate(eventsSchema, raw);
  const records = prepareReviewRecords({
    records: input.events.map((event) => ({ kind: 'workflow' as const, bytes: event.bytes })),
    secretAllow: input.secretAllow,
  }).map((record) => decodeRetainedReviewRecord({ kind: 'workflow', bytes: record.bytes }));
  cancelled(signal);
  if (new Set(input.events.map((event) => event.revisionId)).size !== records.length)
    invalid('Every workflow event needs its own immutable revision identity');
  if (
    records.length !== 1 &&
    records.some(
      ({ value }) => value.type === 'review_coverage' || value.type === 'review_lifecycle'
    )
  )
    invalid('Coverage and lifecycle actions must each be the only event in their operation');

  for (const { value } of records) {
    if (value.type === 'unassigned' && value.target.kind === 'GAP_ROWS') {
      if ((await reviewedRowsDigest(value.target.coveredRows)) !== value.target.coveredRowsDigest)
        invalid('The inspected gap digest differs from its exact authored rows');
    }
    if (value.type === 'review_coverage') {
      for (const thread of value.threads) {
        if ((await reviewedRowsDigest(thread.coveredRows)) !== thread.coveredRowsDigest)
          invalid('The coverage digest differs from its exact authored rows');
        if (
          thread.completedRows !== undefined &&
          (await reviewedRowsDigest(thread.completedRows)) !== thread.completedRowsDigest
        )
          invalid('The completion digest differs from its exact authored rows');
      }
    }
    cancelled(signal);
  }
  return records.map((record, position) => ({
    ...record,
    revisionId: input.events[position]!.revisionId,
    targetKey: workflowTarget(record.value),
    source: {
      kind: 'authored' as const,
      eventId: input.events[position]!.revisionId,
      fieldPath: 'events',
      position,
    },
  }));
}
