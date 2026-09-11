import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { DoneCriterionSchema, EventRecordSchema } from '@orcaops/storage';
import {
  type ArtifactRevision,
  type ProjectDatabase,
  type ProjectReadView,
  readProjectArtifact,
} from '@orcaops/storage/history/database';

import { type DossierV1 } from '../dossier.js';
import { type PrepareReviewCommentLink } from './comment-link-records.js';
import { readDatabaseReviewComment } from './comments.js';
import { decodeRetainedReviewJson } from './records.js';
import { cancelled, integrity, invalid, revisionId, version } from './request.js';
import { membershipSchema, selection } from './reviews.js';
import { hydrateReviewRun, snapshotReviewRun } from './run-read.js';

export type ReviewCommentLinkTarget = Pick<
  PrepareReviewCommentLink,
  'authority' | 'reviewId' | 'commentId' | 'commentRevisionId' | 'endpoint'
>;
const closeClaimsSchema = z.object({
  artifact_id: revisionId,
  n: version.min(1),
  done_criteria: z.array(DoneCriterionSchema),
});

export async function resolveReviewCommentLink(
  database: ProjectDatabase,
  input: ReviewCommentLinkTarget,
  signal?: AbortSignal
) {
  cancelled(signal);
  const retainedComment = await readDatabaseReviewComment({
    authority: input.authority,
    reviewId: input.reviewId,
    commentId: input.commentId,
    revisionId: input.commentRevisionId,
  });
  if (!retainedComment.value) invalid('The link needs an existing exact comment revision');
  const comment = retainedComment.value;
  const commentRevision = comment.revisions.at(-1)!;
  const endpoint = input.endpoint;
  if (endpoint.kind === 'run-ledger-entry') {
    const snapshot = database.read((view) =>
      snapshotReviewRun(view, {
        authority: input.authority,
        reviewId: input.reviewId,
        runId: endpoint.runId,
        revisionId: endpoint.runRevisionId,
      })
    );
    const retained = await hydrateReviewRun(database, snapshot);
    if (!retained.value || !snapshot.value)
      integrity('The exact linked run is missing; restore its retained history');
    if (retained.value.inputPublicationId !== endpoint.inputPublicationId)
      invalid('The linked input publication does not belong to this exact run');
    const dossier = retained.value.inputValues['dossier-v1.json'] as DossierV1;
    const entries = dossier.account_core.ledger.filter(
      (entry) => entry.id === endpoint.ledgerEntryId
    );
    if (entries.length > 1)
      integrity('The retained dossier repeats a ledger identity; preserve its original evidence');
    if (!entries.length)
      invalid('The linked ledger entry is absent from the original served run input');
    cancelled(signal);
    return {
      comment,
      value: entries[0]!,
      proof: {
        kind: 'run-ledger-entry' as const,
        commentHash: commentRevision.hash,
        runHash: retained.value.runHash,
        inputRevisionId: snapshot.value.publication.run_revision_id,
        floorPublicationId: retained.value.floorPublicationId,
        membershipRevisionId: retained.value.membershipRevisionId,
      },
    };
  }
  const membershipRow = database.read((view) =>
    view.get<{ record_hex: string; record_hash: string }>(
      'SELECT hex(record_bytes) AS record_hex, record_hash FROM review_membership_revisions WHERE review_id = ? AND revision_id = ?',
      input.reviewId,
      endpoint.membershipRevisionId
    )
  ).value;
  if (!membershipRow)
    invalid('The linked membership must be an exact retained revision of this review');
  const membership = decodeRetainedReviewJson(
    membershipSchema,
    Buffer.from(membershipRow.record_hex, 'hex')
  );
  if (
    membership.sha256 !== membershipRow.record_hash ||
    membership.value.revisionId !== endpoint.membershipRevisionId
  )
    integrity('The linked membership differs from its retained identity');
  const member = membership.value.members.find(
    (member) => member.artifactId === endpoint.artifactId
  );
  if (
    !member ||
    member.generation !== endpoint.artifactRevision.generation ||
    member.orderedHash !== endpoint.artifactRevision.orderedHash
  )
    invalid('The linked artifact revision is outside this exact review membership');
  const artifact = readProjectArtifact(database, endpoint.artifactId, endpoint.artifactRevision);
  if (!artifact)
    integrity('The exact linked artifact revision is missing; preserve history for repair');
  const line = artifact.eventBytes
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .find((line) => JSON.parse(line).event_id === endpoint.sourceEventId);
  if (!line) invalid('The linked source event is absent from the selected artifact revision');
  const event = decodeRetainedReviewJson(EventRecordSchema, Buffer.from(line)).value;
  if (event.type !== 'checkpoint_closed')
    invalid('A captured criterion link requires its original checkpoint close event');
  const payload =
    'sidecar_sha256' in event
      ? artifact.sidecarPayloads.find((sidecar) => sidecar.eventId === event.event_id)!.bytes
      : Buffer.from(JSON.stringify(event.payload));
  const close = decodeRetainedReviewJson(closeClaimsSchema, payload).value;
  const checkpoint = artifact.thread.checkpoints.find((checkpoint) => checkpoint.n === close.n);
  if (
    close.artifact_id !== endpoint.artifactId ||
    checkpoint?.status !== 'closed' ||
    checkpoint.source_event_ids?.closed !== event.event_id ||
    !isDeepStrictEqual(checkpoint.done_criteria, close.done_criteria)
  )
    integrity('The linked close event differs from its original reconstructed checkpoint');
  const claim = close.done_criteria[endpoint.position];
  if (!claim) invalid('The linked criterion occurrence is absent at its original position');
  cancelled(signal);
  return {
    comment,
    value: claim,
    proof: {
      kind: 'captured-occurrence' as const,
      commentHash: commentRevision.hash,
      membershipHash: membership.sha256,
      eventHash: createHash('sha256')
        .update(line + '\n')
        .digest('hex'),
    },
  };
}

export type ResolvedReviewCommentLink = Awaited<ReturnType<typeof resolveReviewCommentLink>>;
export function requireReviewCommentLinkTargets(
  view: ProjectReadView,
  input: ReviewCommentLinkTarget,
  proof: ResolvedReviewCommentLink['proof']
) {
  selection(view, input.reviewId);
  const comment = view.get<{ record_hash: string }>(
    'SELECT r.record_hash FROM review_comment_revisions r JOIN review_comments c ON c.review_id = r.review_id AND c.comment_id = r.comment_id WHERE r.review_id = ? AND r.comment_id = ? AND r.revision_id = ?',
    input.reviewId,
    input.commentId,
    input.commentRevisionId
  );
  if (comment?.record_hash !== proof.commentHash)
    integrity('The exact linked comment disappeared or changed; preserve its retained history');
  const endpoint = input.endpoint;
  if (endpoint.kind === 'run-ledger-entry' && proof.kind === 'run-ledger-entry') {
    const run = view.get<{
      record_hash: string;
      floor_publication_id: string;
      membership_revision_id: string;
    }>(
      'SELECT record_hash, floor_publication_id, membership_revision_id FROM review_run_revisions WHERE review_id = ? AND run_id = ? AND revision_id = ?',
      input.reviewId,
      endpoint.runId,
      endpoint.runRevisionId
    );
    const publication = view.get<{
      run_revision_id: string;
      floor_publication_id: string;
      membership_revision_id: string;
    }>(
      "SELECT run_revision_id, floor_publication_id, membership_revision_id FROM review_evidence_publications WHERE review_id = ? AND run_id = ? AND publication_id = ? AND kind = 'run-input'",
      input.reviewId,
      endpoint.runId,
      endpoint.inputPublicationId
    );
    if (
      run?.record_hash !== proof.runHash ||
      run.floor_publication_id !== proof.floorPublicationId ||
      run.membership_revision_id !== proof.membershipRevisionId ||
      publication?.run_revision_id !== proof.inputRevisionId ||
      publication.floor_publication_id !== proof.floorPublicationId ||
      publication.membership_revision_id !== proof.membershipRevisionId
    )
      integrity('The linked run input association changed; preserve its exact retained history');
    return;
  }
  if (endpoint.kind === 'captured-occurrence' && proof.kind === 'captured-occurrence') {
    const membership = view.get<{ record_hash: string }>(
      'SELECT record_hash FROM review_membership_revisions WHERE review_id = ? AND revision_id = ?',
      input.reviewId,
      endpoint.membershipRevisionId
    );
    const revision = view.get<ArtifactRevision>(
      'SELECT generation, ordered_hash AS orderedHash, event_count AS eventCount, byte_length AS byteLength, tail_event_id AS tailEventId FROM artifact_revisions WHERE artifact_id = ? AND generation = ?',
      endpoint.artifactId,
      endpoint.artifactRevision.generation
    );
    const event = view.get<{ record_hash: string; ordinal: number }>(
      'SELECT record_hash, ordinal FROM artifact_events WHERE artifact_id = ? AND event_id = ?',
      endpoint.artifactId,
      endpoint.sourceEventId
    );
    if (
      membership?.record_hash !== proof.membershipHash ||
      !isDeepStrictEqual(revision, endpoint.artifactRevision) ||
      event?.record_hash !== proof.eventHash ||
      event.ordinal > endpoint.artifactRevision.eventCount
    )
      integrity('The linked captured occurrence changed; preserve its exact retained history');
    return;
  }
  integrity('The prepared link proof does not identify its original endpoint');
}
