import { z } from 'zod';

import { type JournalEvent, journalEventSchema } from '@orcaops/review-core';
import { canonicalJson, uuidv7 } from '@orcaops/storage';
import { type ProjectOperationOptions } from '@orcaops/storage/history/database';

import { readDatabaseReviewContext, readDatabaseReviewWorkflowContext } from './read-context.js';
import { integrity, invalid, revisionId, text, validate } from './request.js';
import {
  readRetainedReviewOperation,
  replayRetainedReviewOperation,
  type RetainedReviewOperation,
  reviewOperationConflict,
} from './review-operation.js';
import { resolveDatabaseReviewAuthority } from './source-scope.js';
import { workflowTarget } from './workflow-events.js';
import { appendDatabaseReviewWorkflowEvents } from './workflow.js';

const requestSchema = z.strictObject({
  branch: text.refine((value) => Boolean(value.trim()) && !/[\0\r\n]/u.test(value)),
  cwd: text,
  projectId: revisionId.optional(),
  dataRoot: text.optional(),
  operationId: revisionId,
  events: z.array(journalEventSchema).min(1),
  secretAllow: z.array(z.string()),
});
export type ApplyDatabaseReviewWorkflow = Omit<z.infer<typeof requestSchema>, 'events'> & {
  events: JournalEvent[];
};

function bytes(event: JournalEvent): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(`${JSON.stringify(event, null, 2)}\n`));
}

/**
 * A workflow batch is authored whole by its caller — the reviewer's disposition
 * events arrive with their own timestamps — so the retained bytes and the
 * retried bytes are comparable in full. Anything else under this identity is a
 * different disposition wearing the first one's identity.
 */
function requireOriginalWorkflow(
  original: RetainedReviewOperation,
  events: readonly JournalEvent[]
): void {
  const retained = original.payload.events;
  if (!Array.isArray(retained) || retained.length !== events.length) reviewOperationConflict();
  retained.forEach((entry, index) => {
    const encoded = (entry as { bytes?: unknown }).bytes;
    if (typeof encoded !== 'string')
      integrity('The original workflow receipt lost an authored event; preserve it for repair');
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    } catch {
      integrity('The original workflow receipt has an unreadable event; preserve it for repair');
    }
    if (canonicalJson(parsed) !== canonicalJson(events[index])) reviewOperationConflict();
  });
}

/**
 * Append an authored workflow batch to the review's retained disposition
 * history.
 *
 * Each event's target is pinned to the revision and version currently selected
 * for it, so a concurrent write on the same target refuses as stale rather than
 * overwriting it. The floor and Story selections are pinned the same way, which
 * is what makes a coverage or lifecycle event a claim about the generation the
 * reviewer actually read.
 */
export async function applyDatabaseReviewWorkflow(
  raw: ApplyDatabaseReviewWorkflow,
  options: ProjectOperationOptions = {}
) {
  options = { signal: options.signal, onWait: options.onWait };
  const input = validate(requestSchema, raw);

  // Receipt first, before the review is selected and before any writer: an
  // authored disposition whose response was lost replays under its original
  // identity instead of appending the same events a second time.
  const authority = await resolveDatabaseReviewAuthority({
    cwd: input.cwd,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.dataRoot === undefined ? {} : { dataRoot: input.dataRoot }),
  });
  const committed = await readRetainedReviewOperation({
    authority,
    operationId: input.operationId,
    kinds: ['review.workflow.append'],
  });
  if (committed.value) {
    requireOriginalWorkflow(committed.value, input.events);
    return replayRetainedReviewOperation<
      Awaited<ReturnType<typeof appendDatabaseReviewWorkflowEvents>>['value']
    >(committed.value);
  }

  const context = await readDatabaseReviewWorkflowContext({
    branch: input.branch,
    cwd: input.cwd,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.dataRoot === undefined ? {} : { dataRoot: input.dataRoot }),
  });
  if (context.floor === null)
    invalid(`no selected floor for '${input.branch}'; run review data first`);

  const heads = new Map(context.workflow.heads.map((head) => [head.targetKey, head]));
  const targets = new Map<
    string,
    { targetKey: string; revisionId: string | null; version: number }
  >();
  for (const event of input.events) {
    const targetKey = workflowTarget(event);
    if (targets.has(targetKey)) continue;
    const head = heads.get(targetKey);
    targets.set(targetKey, {
      targetKey,
      revisionId: head?.revisionId ?? null,
      version: head?.version ?? 0,
    });
  }
  return appendDatabaseReviewWorkflowEvents(
    {
      authority: context.authority,
      reviewId: context.reviewId,
      operationId: input.operationId,
      secretAllow: input.secretAllow,
      expected: {
        floor: {
          publicationId: context.floor.publicationId,
          version: context.selection.floor_version,
        },
        // Always the current Story selection, including its absence: a lifecycle,
        // finding or prompt event refuses without an explicit Story selection, and
        // a review with no sealed Story still authors those. A null publication id
        // is exactly that explicit absence.
        story: {
          publicationId: context.selection.story_publication_id,
          version: context.selection.story_version,
        },
        targets: [...targets.values()],
      },
      events: input.events.map((event) => ({ revisionId: uuidv7(), bytes: bytes(event) })),
    },
    options
  );
}

/** The review's retained workflow events, oldest first. */
export async function readDatabaseReviewWorkflowEvents(input: {
  branch: string;
  cwd: string;
  projectId?: string;
  dataRoot?: string;
}) {
  const context = await readDatabaseReviewContext({
    branch: input.branch,
    cwd: input.cwd,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.dataRoot === undefined ? {} : { dataRoot: input.dataRoot }),
  });
  return { context, events: context.workflow.events as JournalEvent[] };
}
