import { canonicalJson } from '@orcaops/storage';
import {
  type ArtifactRevision,
  type ProjectDatabase,
  readProjectArtifact,
} from '@orcaops/storage/history/database';

import { decodeRetainedReviewJson, type ReviewRecordValue } from './records.js';
import { integrity, invalid, stale } from './request.js';
import { membershipSchema } from './reviews.js';

export function validateFloorReferences(
  database: ProjectDatabase,
  reviewId: string,
  membershipRevisionId: string,
  floor: ReviewRecordValue<'floor'>
): void {
  const retained = database.read((view) =>
    view.get<{ bytes: string; hash: string; branch: string }>(
      `SELECT hex(m.record_bytes) AS bytes, m.record_hash AS hash, r.branch
       FROM review_membership_revisions m JOIN reviews r ON r.review_id = m.review_id
       WHERE m.revision_id = ? AND m.review_id = ?`,
      membershipRevisionId,
      reviewId
    )
  ).value;
  if (!retained) stale('The exact floor membership is absent; prepare a new operation');
  const membership = decodeRetainedReviewJson(membershipSchema, Buffer.from(retained.bytes, 'hex'));
  if (membership.sha256 !== retained.hash || membership.value.revisionId !== membershipRevisionId)
    integrity('Retained floor membership differs from its identity; preserve history for repair');
  const members = new Map(membership.value.members.map((member) => [member.artifactId, member]));
  if (
    retained.branch !== floor.scope.branch ||
    canonicalJson([...members.keys()].sort()) !==
      canonicalJson([...floor.scope.artifact_ids].sort())
  )
    invalid('Floor evidence must retain this exact review branch and membership');
  const checkpoints = new Map<string, Set<number>>();
  // Only traverse the complete strict floor schema: every artifact/cp field is a history reference.
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.artifact === 'string') {
      if (!members.has(record.artifact))
        invalid('Floor references an artifact outside its exact membership');
      if (typeof record.cp === 'number') {
        const selected = checkpoints.get(record.artifact) ?? new Set<number>();
        selected.add(record.cp);
        checkpoints.set(record.artifact, selected);
      }
    } else if (typeof record.cp === 'number') {
      invalid('A floor checkpoint reference must identify its member artifact');
    }
    for (const child of Object.values(record)) visit(child);
  }
  visit(floor);
  for (const thread of floor.outline.threads)
    if (thread.checkpoints.some((checkpoint) => checkpoint.checkpoint.artifact !== thread.artifact))
      invalid('Floor outline checkpoints must belong to their containing artifact');
  for (const [artifactId, requested] of checkpoints) {
    const member = members.get(artifactId)!;
    const revision = database.read((view) =>
      view.get<ArtifactRevision>(
        `SELECT generation, ordered_hash AS orderedHash, event_count AS eventCount,
       byte_length AS byteLength, tail_event_id AS tailEventId FROM artifact_revisions
       WHERE artifact_id = ? AND generation = ?`,
        artifactId,
        member.generation
      )
    ).value;
    if (!revision || revision.orderedHash !== member.orderedHash)
      integrity('The retained member revision is missing; preserve history for explicit repair');
    const artifact = readProjectArtifact(database, artifactId, revision);
    if (!artifact)
      integrity('The retained member artifact is missing; preserve history for explicit repair');
    const available = new Set(
      artifact.thread.checkpoints
        .filter((checkpoint) => checkpoint.status === 'closed')
        .map((checkpoint) => checkpoint.n)
    );
    if ([...requested].some((checkpoint) => !available.has(checkpoint)))
      invalid('Floor references a checkpoint not closed in its exact member revision');
  }
}
