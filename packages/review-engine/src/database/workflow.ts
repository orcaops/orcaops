import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { describeFinishBlocker } from '@orcaops/review-core';
import { canonicalJson } from '@orcaops/storage';
import {
  type ProjectOperationOptions,
  type ProjectReadView,
} from '@orcaops/storage/history/database';

import { hydrateReviewComments, snapshotReviewComments } from './comment-read.js';
import { decodeRetainedReviewText } from './records.js';
import {
  cancelled,
  invalid,
  json,
  operationFields,
  performReviewOperation,
  revisionId,
  scanMetadata,
  stale,
  text,
  validate,
  version,
} from './request.js';
import { prepareReviewWorkflowEvents } from './workflow-events.js';
import { evaluateWorkflowFinish } from './workflow-finish.js';
import {
  prepareWorkflowTargets,
  requireWorkflowSelection,
  workflowSelectionSchema,
} from './workflow-preparation.js';
import {
  hydrateReviewWorkflow,
  snapshotReviewWorkflow,
  workflowBasisSchema,
} from './workflow-read.js';

/**
 * The three aggregate staleness refusals a journal append can raise. They are
 * named because the transport reports each under its own rejection code, and a
 * caller — Watch's Story-read witness in particular — branches on which
 * generation moved. The store raises one code for every stale precondition, so
 * the sentence is the discriminator; keeping it in one place is what makes that
 * safe.
 */
export const WORKFLOW_STALE_FLOOR_MESSAGE =
  'The aggregate workflow floor inputs changed; prepare a new operation against the intended review';
export const WORKFLOW_STALE_LEDGER_MESSAGE =
  'The aggregate workflow ledger changed; prepare a new operation with its current exact history';
export const WORKFLOW_STALE_STORY_MESSAGE =
  'The lifecycle Story inputs changed; retain the authored review basis and prepare a new operation';

const targetSchema = z
  .strictObject({ targetKey: text, revisionId: revisionId.nullable(), version })
  .refine((target) => (target.revisionId === null) === (target.version === 0));
const appendSchema = z.strictObject({
  ...operationFields,
  reviewId: revisionId,
  expected: workflowSelectionSchema.extend({ targets: z.array(targetSchema).min(1) }),
  events: z.array(z.strictObject({ revisionId, bytes: z.instanceof(Uint8Array) })).min(1),
});
export type AppendDatabaseReviewWorkflowEvents = Omit<z.infer<typeof appendSchema>, 'events'> & {
  events: { revisionId: string; bytes: Uint8Array }[];
};
function requireTargets(
  view: ProjectReadView,
  reviewId: string,
  targets: z.infer<typeof targetSchema>[]
) {
  for (const target of targets) {
    const current = view.get<{ revision_id: string; version: number }>(
      'SELECT revision_id, version FROM review_workflow_current WHERE review_id = ? AND target_key = ?',
      reviewId,
      target.targetKey
    );
    if (
      (current?.revision_id ?? null) !== target.revisionId ||
      (current?.version ?? 0) !== target.version
    )
      stale(
        'An authored workflow target changed; preserve the original event batch and prepare a new operation'
      );
  }
}
export async function appendDatabaseReviewWorkflowEvents(
  raw: AppendDatabaseReviewWorkflowEvents,
  options: ProjectOperationOptions = {}
) {
  options = { signal: options.signal, onWait: options.onWait };
  const input = validate(appendSchema, raw);
  scanMetadata(
    { authority: input.authority, reviewId: input.reviewId, expected: input.expected },
    input.secretAllow
  );
  const records = await prepareReviewWorkflowEvents(
    { events: input.events, secretAllow: input.secretAllow },
    options
  );
  const aggregate =
    records.length === 1 &&
    (records[0]!.value.type === 'review_coverage' || records[0]!.value.type === 'review_lifecycle')
      ? records[0]!.value
      : null;
  const complete = aggregate?.type === 'review_lifecycle' && aggregate.action === 'COMPLETE';
  if (aggregate?.type === 'review_lifecycle' && input.expected.story === undefined)
    invalid('Lifecycle actions require an explicit exact Story selection, including its absence');
  if (
    records.some(({ value }) => value.type === 'finding' || value.type === 'prompt') &&
    input.expected.story === undefined
  )
    invalid('Finding and question events require an explicit exact Story selection');
  const targetKeys = new Set(records.map((record) => record.targetKey));
  if (
    input.expected.targets.length !== targetKeys.size ||
    new Set(input.expected.targets.map((target) => target.targetKey)).size !== targetKeys.size ||
    input.expected.targets.some((target) => !targetKeys.has(target.targetKey))
  )
    invalid('Provide exactly one original head for every affected workflow target');
  let basis: z.infer<typeof workflowBasisSchema>;
  return performReviewOperation(
    {
      authority: input.authority,
      operation: {
        operationId: input.operationId,
        kind: 'review.workflow.append',
        target: { reviewId: input.reviewId },
        payload: {
          events: records.map((record) => ({
            revisionId: record.revisionId,
            bytes: record.bytes.toString('base64'),
          })),
        },
        expectedState: json(input.expected),
        intentChange: false,
      },
      async prepareReadOnly(database) {
        const snapshot = database.read((view) => {
          requireWorkflowSelection(view, input.reviewId, input.expected);
          requireTargets(view, input.reviewId, input.expected.targets);
          return {
            workflow: snapshotReviewWorkflow(view, input.reviewId),
            comments: complete ? snapshotReviewComments(view, input.reviewId) : null,
          };
        });
        const workflow = await hydrateReviewWorkflow(snapshot.value.workflow);
        const prepared = await prepareWorkflowTargets(
          database,
          {
            authority: input.authority,
            reviewId: input.reviewId,
            expected: input.expected,
            events: records.map((record) => record.value),
          },
          options.signal
        );
        basis = prepared.basis;
        if (aggregate) {
          if (aggregate.floor_input_hash !== prepared.floor.input_hash)
            stale(WORKFLOW_STALE_FLOOR_MESSAGE);
          if (aggregate.ledger_generation !== workflow.ledgerGeneration)
            stale(WORKFLOW_STALE_LEDGER_MESSAGE);
          basis.ledger = { generation: workflow.ledgerGeneration, sequence: workflow.sequence };
          if (aggregate.type === 'review_coverage') {
            if (
              aggregate.threads.some(
                (thread) =>
                  !prepared.floor.outline.threads.some(
                    (current) => current.threadKey === thread.threadKey
                  )
              )
            )
              invalid('A coverage section is absent from its exact selected floor');
          } else {
            if (aggregate.story_generation !== (basis.story?.generation ?? null))
              stale(WORKFLOW_STALE_STORY_MESSAGE);
            const latest = workflow.events
              .filter((event) => event.type === 'review_lifecycle')
              .at(-1);
            const open = latest === undefined || latest.action === 'REOPEN';
            if (aggregate.action === 'REOPEN' ? open : !open)
              invalid(
                aggregate.action === 'REOPEN'
                  ? 'The review lifecycle is already open'
                  : 'The review is already finished; explicitly reopen before another finish'
              );
            if (complete) {
              const comments = hydrateReviewComments(snapshot.value.comments!);
              basis.comments = comments.heads;
              const gate = await evaluateWorkflowFinish({
                floor: prepared.floor,
                diffText: decodeRetainedReviewText(prepared.diffBytes).text,
                story: prepared.story,
                events: workflow.events,
                comments: comments.comments.map((entry) => entry.comment),
              });
              cancelled(options.signal);
              if (!gate.allowed)
                invalid(
                  `Complete the remaining review work before authoring another finish: ${gate.blockers.map(describeFinishBlocker).join('; ')}`
                );
            }
          }
        }
        scanMetadata(basis, input.secretAllow);
      },
      settle(tx) {
        requireWorkflowSelection(tx, input.reviewId, input.expected);
        requireTargets(tx, input.reviewId, input.expected.targets);
        let sequence = tx.get<{ sequence: number }>(
          'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM review_workflow_transitions WHERE review_id = ?',
          input.reviewId
        )!.sequence;
        if (basis.ledger && sequence !== basis.ledger.sequence)
          stale(
            'The aggregate workflow history changed during preparation; author a new operation with the intended current ledger'
          );
        if (basis.comments) {
          const current = tx.all<{ commentId: string; revisionId: string; version: number }>(
            'SELECT comment_id AS commentId, current_revision_id AS revisionId, version FROM review_comments WHERE review_id = ? ORDER BY comment_id',
            input.reviewId
          );
          if (!isDeepStrictEqual(current, basis.comments))
            stale(
              'Review comments changed during completion preparation; inspect the new obligations before authoring a finish'
            );
        }
        const heads = new Map(
          input.expected.targets.map((target) => [target.targetKey, { ...target }])
        );
        const revisions = [];
        for (const record of records) {
          const previous = heads.get(record.targetKey)!;
          tx.run(
            'INSERT INTO review_workflow_transitions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            record.revisionId,
            input.reviewId,
            record.targetKey,
            previous.revisionId,
            previous.version + 1,
            ++sequence,
            input.operationId,
            record.bytes,
            record.sha256,
            canonicalJson(basis),
            canonicalJson(record.source)
          );
          const current = {
            targetKey: record.targetKey,
            revisionId: record.revisionId,
            version: previous.version + 1,
          };
          heads.set(record.targetKey, current);
          revisions.push({ ...current, sequence });
        }
        for (const head of heads.values())
          tx.run(
            'INSERT INTO review_workflow_current VALUES (?, ?, ?, ?) ON CONFLICT(review_id, target_key) DO UPDATE SET revision_id = excluded.revision_id, version = excluded.version',
            input.reviewId,
            head.targetKey,
            head.revisionId,
            head.version
          );
        return { reviewId: input.reviewId, revisions, sequence };
      },
    },
    options
  );
}
