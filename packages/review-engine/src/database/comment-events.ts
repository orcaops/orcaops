import { z } from 'zod';

import { canonicalJson } from '@orcaops/storage';
import {
  type ArtifactRevision,
  type ProjectOperationOptions,
  type ProjectReadView,
  readProjectArtifact,
} from '@orcaops/storage/history/database';

import { commentBasisSchema, readDatabaseReviewComment } from './comments.js';
import {
  decodeRetainedReviewJson,
  decodeRetainedReviewRecord,
  prepareReviewRecords,
} from './records.js';
import {
  integrity,
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
import { membershipSchema, selection } from './reviews.js';

const membershipTarget = z.strictObject({
  revisionId,
  version: version.refine((value) => value > 0),
});
const appendSchema = z.strictObject({
  ...operationFields,
  reviewId: revisionId,
  commentId: text,
  expected: z.strictObject({ revisionId, version: version.refine((value) => value > 0) }),
  membership: membershipTarget.nullable(),
  events: z.array(z.strictObject({ revisionId, bytes: z.instanceof(Uint8Array) })).min(1),
});
export type AppendDatabaseReviewCommentEvents = Omit<z.infer<typeof appendSchema>, 'events'> & {
  events: { revisionId: string; bytes: Uint8Array }[];
};
function requireMembership(
  view: ProjectReadView,
  reviewId: string,
  target: z.infer<typeof membershipTarget>
) {
  const current = selection(view, reviewId);
  if (
    current.membership_revision_id !== target.revisionId ||
    current.membership_version !== target.version
  )
    stale(
      'The reply checkpoint membership changed; retain the original target and prepare a new operation'
    );
}
export async function appendDatabaseReviewCommentEvents(
  raw: AppendDatabaseReviewCommentEvents,
  options: ProjectOperationOptions = {}
) {
  options = { signal: options.signal, onWait: options.onWait };
  const input = validate(appendSchema, raw);
  const records = prepareReviewRecords({
    records: input.events.map((event) => ({ kind: 'comment' as const, bytes: event.bytes })),
    secretAllow: input.secretAllow,
  }).map((record) => decodeRetainedReviewRecord({ kind: 'comment', bytes: record.bytes }));
  scanMetadata(
    {
      authority: input.authority,
      reviewId: input.reviewId,
      commentId: input.commentId,
      expected: input.expected,
      membership: input.membership,
    },
    input.secretAllow
  );
  if (new Set(input.events.map((event) => event.revisionId)).size !== records.length)
    invalid('Every appended comment event needs its own immutable revision identity');
  if (records.some(({ value }) => value.type === 'add' || value.comment_id !== input.commentId))
    invalid('Append only replies and status events for this exact existing comment');
  const hasReferences = records.some(
    ({ value }) => value.type === 'reply' && value.checkpoint_ref !== undefined
  );
  if (hasReferences !== (input.membership !== null))
    invalid('Supply an exact selected membership only when a reply names a checkpoint');
  let bases: z.infer<typeof commentBasisSchema>[];
  return performReviewOperation(
    {
      authority: input.authority,
      operation: {
        operationId: input.operationId,
        kind: 'review.comment.append',
        target: { reviewId: input.reviewId, commentId: input.commentId },
        payload: {
          events: records.map((record, i) => ({
            revisionId: input.events[i]!.revisionId,
            bytes: record.bytes.toString('base64'),
          })),
        },
        expectedState: json({ comment: input.expected, membership: input.membership }),
        intentChange: false,
      },
      async prepareReadOnly(database) {
        const retained = await readDatabaseReviewComment({
          authority: input.authority,
          reviewId: input.reviewId,
          commentId: input.commentId,
        });
        if (
          !retained.value ||
          retained.value.revisionId !== input.expected.revisionId ||
          retained.value.version !== input.expected.version
        )
          stale('The comment head changed or is absent; preserve the intended reply/status target');
        const originalBasis = retained.value.revisions[0]!.basis;
        const membershipTarget = input.membership;
        let membership: z.infer<typeof membershipSchema> | null = null;
        if (membershipTarget) {
          const row = database.read((view) => {
            requireMembership(view, input.reviewId, membershipTarget);
            return view.get<{ bytes: string; hash: string }>(
              'SELECT hex(record_bytes) AS bytes, record_hash AS hash FROM review_membership_revisions WHERE review_id = ? AND revision_id = ?',
              input.reviewId,
              membershipTarget.revisionId
            );
          }).value;
          if (!row)
            integrity('The exact reply membership history is missing; preserve it for repair');
          const decoded = decodeRetainedReviewJson(membershipSchema, Buffer.from(row.bytes, 'hex'));
          if (
            decoded.sha256 !== row.hash ||
            decoded.value.revisionId !== membershipTarget.revisionId
          )
            integrity('Retained reply membership differs from its original identity or hash');
          membership = decoded.value;
        }
        const closed = new Map<string, Set<number>>();
        bases = records.map(({ value }) => {
          if (value.type !== 'reply' || !value.checkpoint_ref) return { ...originalBasis };
          const ref = value.checkpoint_ref;
          const member = membership!.members.find((member) => member.artifactId === ref.artifact);
          if (!member) invalid('The reply checkpoint is outside its exact retained membership');
          let checkpoints = closed.get(member.artifactId);
          if (!checkpoints) {
            const revision = database.read((view) =>
              view.get<ArtifactRevision>(
                'SELECT generation, ordered_hash AS orderedHash, event_count AS eventCount, byte_length AS byteLength, tail_event_id AS tailEventId FROM artifact_revisions WHERE artifact_id = ? AND generation = ?',
                member.artifactId,
                member.generation
              )
            ).value;
            if (!revision || revision.orderedHash !== member.orderedHash)
              integrity(
                'The exact reply artifact revision is missing; preserve its history for repair'
              );
            const artifact = readProjectArtifact(database, member.artifactId, revision);
            if (!artifact)
              integrity('The exact reply artifact is missing; preserve its history for repair');
            checkpoints = new Set(
              artifact.thread.checkpoints
                .filter((checkpoint) => checkpoint.status === 'closed')
                .map((checkpoint) => checkpoint.n)
            );
            closed.set(member.artifactId, checkpoints);
          }
          if (!checkpoints.has(ref.cp))
            invalid(
              'The reply checkpoint was not closed in the explicitly retained artifact revision'
            );
          return {
            ...originalBasis,
            checkpointTarget: {
              membershipRevisionId: membershipTarget!.revisionId,
              membershipVersion: membershipTarget!.version,
              artifactId: member.artifactId,
              generation: member.generation,
              orderedHash: member.orderedHash,
              cp: ref.cp,
            },
          };
        });
      },
      settle(tx) {
        const header = tx.get<{ current_revision_id: string; version: number }>(
          'SELECT current_revision_id, version FROM review_comments WHERE review_id = ? AND comment_id = ?',
          input.reviewId,
          input.commentId
        );
        if (
          !header ||
          header.current_revision_id !== input.expected.revisionId ||
          header.version !== input.expected.version
        )
          stale(
            'The comment head changed; retain the original event batch and prepare a new operation'
          );
        if (input.membership) requireMembership(tx, input.reviewId, input.membership);
        let previous = input.expected.revisionId;
        for (let i = 0; i < records.length; i++) {
          const record = records[i]!;
          const id = input.events[i]!.revisionId;
          tx.run(
            'INSERT INTO review_comment_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            id,
            input.reviewId,
            input.commentId,
            previous,
            input.expected.version + i + 1,
            input.operationId,
            record.bytes,
            record.sha256,
            canonicalJson(bases[i]),
            canonicalJson({ kind: 'authored', eventId: id, fieldPath: 'events', position: i })
          );
          previous = id;
        }
        tx.run(
          'UPDATE review_comments SET current_revision_id = ?, version = ? WHERE review_id = ? AND comment_id = ?',
          previous,
          input.expected.version + records.length,
          input.reviewId,
          input.commentId
        );
        return {
          reviewId: input.reviewId,
          commentId: input.commentId,
          revisionId: previous,
          version: input.expected.version + records.length,
          revisionIds: input.events.map((event) => event.revisionId),
        };
      },
    },
    options
  );
}
