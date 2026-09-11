import { z } from 'zod';

import { disclosureSchema } from '@orcaops/review-core';
import { canonicalJson } from '@orcaops/storage';
import {
  type ProjectCounters,
  type ProjectDatabase,
  type ProjectEvidenceFile,
  type ProjectOperation,
  type ProjectOperationOptions,
  type ProjectReadView,
  type ProjectSettlement,
  readProjectEvidence,
} from '@orcaops/storage/history/database';
import { readProjectPendingReview } from '@orcaops/storage/history/database/review-retention';

import {
  floorBaseSchema,
  floorBasisSchema,
  floorSelectionSchema,
  requireFloorSelection,
} from './floor-preparation.js';
import { retainDatabaseReviewFloor } from './floor-retention.js';
import {
  decodeRetainedReviewRecord,
  prepareReviewJson,
  prepareReviewRecords,
  prepareReviewText,
} from './records.js';
import {
  authoritySchema,
  integrity,
  invalid,
  json,
  operationFields,
  revisionId,
  scanMetadata,
  validate,
  withReviewDatabase,
} from './request.js';
import { baseSchema, selection } from './reviews.js';

const floorRequest = z.strictObject({
  ...operationFields,
  reviewId: revisionId,
  publicationId: revisionId,
  floorBytes: z.instanceof(Uint8Array),
  diffBytes: z.instanceof(Uint8Array),
  expected: floorSelectionSchema,
  basis: floorBasisSchema,
  // The floor's scope-warning disclosures, already folded into `floorBytes`.
  // Carried so the fresh-admission re-verification reassembles the same floor;
  // not persisted separately (the retained bytes already hold them).
  disclosures: z.array(disclosureSchema).optional(),
  base: floorBaseSchema.optional(),
});
export type PublishDatabaseReviewFloor = Omit<
  z.infer<typeof floorRequest>,
  'floorBytes' | 'diffBytes' | 'base'
> & {
  floorBytes: Uint8Array;
  diffBytes: Uint8Array;
  base?: { revisionId: string; bytes: Uint8Array };
};
function prepareFloorPublication(raw: PublishDatabaseReviewFloor) {
  const input = validate(floorRequest, raw);
  const [prepared] = prepareReviewRecords({
    records: [{ kind: 'floor', bytes: input.floorBytes }],
    secretAllow: input.secretAllow,
  });
  const floor = decodeRetainedReviewRecord({ kind: 'floor', bytes: prepared!.bytes });
  const { bytes: diff } = prepareReviewText({
    bytes: input.diffBytes,
    secretAllow: input.secretAllow,
  });
  scanMetadata(
    { authority: input.authority, expected: input.expected, basis: input.basis },
    input.secretAllow
  );
  const base = input.base
    ? {
        revisionId: input.base.revisionId,
        record: prepareReviewJson(baseSchema, {
          bytes: input.base.bytes,
          secretAllow: input.secretAllow,
        }),
      }
    : null;
  const { gitRoot: _gitRoot, ...retainedBasis } = input.basis;
  const operation: ProjectOperation = {
    operationId: input.operationId,
    kind: 'review.floor',
    target: { reviewId: input.reviewId },
    payload: {
      publicationId: input.publicationId,
      basis: json(retainedBasis),
      floorBytes: floor.bytes.toString('base64'),
      diffBytes: diff.toString('base64'),
      ...(base
        ? { base: { revisionId: base.revisionId, baseBytes: base.record.bytes.toString('base64') } }
        : {}),
    },
    expectedState: json(input.expected),
    intentChange: false,
  };
  return { input, floor, diff, base, retainedBasis, operation };
}
export type FloorPublicationPreparation = ReturnType<typeof prepareFloorPublication>;
export async function publishDatabaseReviewFloor(
  raw: PublishDatabaseReviewFloor,
  options: ProjectOperationOptions = {}
) {
  options = { signal: options.signal, onWait: options.onWait };
  return retainDatabaseReviewFloor(prepareFloorPublication(raw), options);
}
export function insertFloorPublicationRows(
  tx: ProjectSettlement,
  prepared: FloorPublicationPreparation,
  descriptors: ProjectEvidenceFile[]
) {
  const { input, floor } = prepared;
  requireFloorSelection(tx, input.reviewId, input.expected);
  const current = selection(tx, input.reviewId);
  const review = tx.get<{ branch: string }>(
    'SELECT branch FROM reviews WHERE review_id = ?',
    input.reviewId
  )!;
  const members = tx.all<{ artifact_id: string }>(
    'SELECT artifact_id FROM review_members WHERE membership_revision_id = ? ORDER BY artifact_id',
    current.membership_revision_id
  );
  if (
    review.branch !== floor.value.scope.branch ||
    canonicalJson(members.map((m) => m.artifact_id)) !==
      canonicalJson([...floor.value.scope.artifact_ids].sort())
  )
    invalid('Floor evidence must retain this exact review branch and membership');
  tx.run(
    'INSERT INTO review_evidence_publications VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)',
    input.publicationId,
    input.reviewId,
    'floor',
    input.operationId,
    current.membership_revision_id,
    floor.value.input_hash,
    canonicalJson({ schemaVersion: floor.value.schema_version })
  );
  for (const descriptor of descriptors) {
    const isFloor = descriptor.relativePath.endsWith('/floor.json');
    tx.run(
      'INSERT INTO review_evidence_members VALUES (?, ?, ?, ?, ?, ?, ?)',
      input.publicationId,
      isFloor ? 'floor.json' : 'diff.patch',
      isFloor ? 'floor' : 'diff',
      isFloor ? floor.value.schema_version : null,
      descriptor.relativePath,
      descriptor.sha256,
      descriptor.byteLength
    );
  }
  return current;
}

const readFloorRequest = z.strictObject({
  authority: authoritySchema,
  reviewId: revisionId,
  publicationId: revisionId.optional(),
});
export async function readDatabaseReviewFloor(raw: z.infer<typeof readFloorRequest>) {
  const input = validate(readFloorRequest, raw);
  return withReviewDatabase(input.authority, 'reader', (database) =>
    hydrateDatabaseReviewFloor(
      database,
      input,
      database.read((view) => snapshotDatabaseReviewFloor(view, input))
    )
  );
}

export function snapshotDatabaseReviewFloor(
  view: ProjectReadView,
  input: z.infer<typeof readFloorRequest>
) {
  const current = selection(view, input.reviewId);
  const publicationId = input.publicationId ?? current.floor_publication_id;
  if (publicationId === null) return null;
  const publication = view.get<{
    publication_id: string;
    operation_id: string;
    floor_input_hash: string;
    membership_revision_id: string;
  }>(
    "SELECT publication_id, operation_id, floor_input_hash, membership_revision_id FROM review_evidence_publications WHERE publication_id = ? AND review_id = ? AND kind = 'floor'",
    publicationId,
    input.reviewId
  );
  if (!publication)
    integrity(
      'The exact retained floor publication is missing; preserve history for explicit repair'
    );
  const members = view.all<
    ProjectEvidenceFile & { name: string; kind: string; schema_version: number | null }
  >(
    'SELECT name, kind, schema_version, relative_path AS relativePath, sha256, byte_length AS byteLength FROM review_evidence_members WHERE publication_id = ? ORDER BY name',
    publicationId
  );
  return { publication, members };
}

export async function hydrateDatabaseReviewFloor(
  database: ProjectDatabase,
  input: z.infer<typeof readFloorRequest>,
  snapshot: { value: ReturnType<typeof snapshotDatabaseReviewFloor>; counters: ProjectCounters }
) {
  if (snapshot.value === null) return { value: null, counters: snapshot.counters };
  const { publication, members } = snapshot.value;
  const pending = readProjectPendingReview(database, publication.operation_id).value;
  const original = pending?.original.floor ?? null;
  if (
    pending &&
    (!pending.terminal ||
      pending.terminal.kind !== 'review.floor' ||
      pending.original.kind !== 'floor' ||
      !original ||
      original.publicationId !== publication.publication_id ||
      pending.retention.input.target.kind !== 'review' ||
      pending.retention.input.target.reviewId !== input.reviewId ||
      pending.retention.input.target.membershipRevisionId !== publication.membership_revision_id ||
      original.observedWriteSequence > snapshot.counters.writeSequence ||
      original.members.length !== members.length ||
      original.members.some(
        (retained) =>
          !members.some(
            (member) =>
              member.name === retained.name &&
              member.kind === retained.kind &&
              member.schema_version === retained.schemaVersion &&
              member.relativePath === retained.relativePath &&
              member.sha256 === retained.sha256 &&
              member.byteLength === retained.byteLength
          )
      ))
  )
    integrity(
      'Retained floor provenance differs from its original publication; preserve history for repair'
    );
  const sourceWriteSequence = original?.observedWriteSequence ?? null;
  const floorMember = members.find(
    (member) => member.name === 'floor.json' && member.kind === 'floor'
  );
  const diffMember = members.find(
    (member) => member.name === 'diff.patch' && member.kind === 'diff'
  );
  if (!floorMember || !diffMember || members.length !== 2)
    integrity('The retained floor bundle is incomplete; preserve history for explicit repair');
  const floorBytes = await readProjectEvidence(database, floorMember);
  const diffBytes = await readProjectEvidence(database, diffMember);
  const floor = decodeRetainedReviewRecord({ kind: 'floor', bytes: floorBytes });
  if (
    floor.value.input_hash !== publication.floor_input_hash ||
    floor.value.schema_version !== floorMember.schema_version
  )
    integrity(
      'Retained floor identity differs from its publication; preserve history for explicit repair'
    );
  return {
    value: {
      publicationId: publication.publication_id,
      membershipRevisionId: publication.membership_revision_id,
      sourceWriteSequence,
      floor: floor.value,
      floorBytes,
      diffBytes,
    },
    counters: snapshot.counters,
  };
}
