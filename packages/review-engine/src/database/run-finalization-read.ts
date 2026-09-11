import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { executableIdentitySchema } from '@orcaops/review-core';
import {
  type ProjectCounters,
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectEvidenceFile,
  type ProjectReadView,
  readProjectEvidence,
} from '@orcaops/storage/history/database';

import { SEMANTIC_ANCHOR_INPUT_FILE, SEMANTIC_ANCHOR_RECEIPT_FILE } from '../semanticAnchors.js';
import {
  STORY_REVIEW_MODEL_FILE,
  storyReviewGeneration,
  type StoryReviewModel,
} from '../storyReviewModel.js';
import {
  decodeRetainedReviewJson,
  decodeRetainedReviewRecord,
  decodeRetainedReviewText,
} from './records.js';
import {
  authoritySchema,
  integrity,
  revisionId,
  text,
  validate,
  version,
  withReviewDatabase,
} from './request.js';
import { selection } from './reviews.js';
import { finalizationTargetSchema } from './story-preparation.js';
import { buildTerminalRecord, decodeRetainedTerminalRecord } from './terminal-record.js';

const requestSchema = z.strictObject({
  authority: authoritySchema,
  reviewId: revisionId,
  runId: text,
});
const payloadSchema = z.strictObject({
  revisionId,
  publicationId: revisionId.nullable(),
  finalizedAt: z.iso.datetime(),
  runtimeIdentity: executableIdentitySchema.nullable(),
  runBytes: z.base64(),
  members: z.array(z.strictObject({ name: text, bytes: z.base64() })),
});
const metadataSchema = z.strictObject({
  outcome: z.enum(['FULL', 'DEGRADED', 'FAILED']),
  observedWriteSequence: version,
});
type EvidenceMember = ProjectEvidenceFile & {
  name: string;
  kind: string;
  schema_version: number | null;
};
interface Publication {
  publication_id: string;
  kind: string;
  operation_id: string;
  floor_publication_id: string;
  membership_revision_id: string;
  generation: string | null;
  record_json: string;
}
export type ReadDatabaseReviewFinalization = z.infer<typeof requestSchema>;

export async function readDatabaseReviewFinalization(raw: ReadDatabaseReviewFinalization) {
  const input = validate(requestSchema, raw);
  return withReviewDatabase(input.authority, 'reader', (database) =>
    hydrateDatabaseReviewFinalization(
      database,
      input,
      database.read((view) => snapshotDatabaseReviewFinalization(view, input))
    )
  );
}

export function snapshotDatabaseReviewFinalization(
  view: ProjectReadView,
  input: ReadDatabaseReviewFinalization
) {
  const current = selection(view, input.reviewId);
  const run = view.get<{
    revision_id: string;
    previous_revision_id: string;
    version: number;
    header_version: number;
    operation_id: string;
    record_hex: string;
    record_hash: string;
    floor_publication_id: string;
    membership_revision_id: string;
  }>(
    `SELECT r.revision_id, r.previous_revision_id, r.version, h.version AS header_version, r.operation_id, hex(r.record_bytes) AS record_hex, r.record_hash, r.floor_publication_id, r.membership_revision_id
FROM review_runs h JOIN review_run_revisions r ON r.run_id = h.run_id AND r.review_id = h.review_id AND r.revision_id = h.current_revision_id
WHERE h.run_id = ? AND h.review_id = ?`,
    input.runId,
    input.reviewId
  );
  if (!run || run.version !== run.header_version)
    integrity(
      'The exact retained run selection is missing or inconsistent; preserve history for repair'
    );
  const terminal = view.get<{
    run_revision_id: string;
    operation_id: string;
    record_hex: string;
    record_hash: string;
  }>(
    'SELECT run_revision_id, operation_id, hex(record_bytes) AS record_hex, record_hash FROM review_run_finalizations WHERE review_id = ? AND run_id = ?',
    input.reviewId,
    input.runId
  );
  const operation =
    terminal &&
    view.get<{
      operation_kind: string;
      target_json: string;
      payload_json: string;
      expected_state_json: string;
    }>(
      'SELECT operation_kind, target_json, payload_json, expected_state_json FROM operations WHERE operation_id = ?',
      terminal.operation_id
    );
  const publications = view
    .all<Publication>(
      "SELECT publication_id, kind, operation_id, floor_publication_id, membership_revision_id, generation, record_json FROM review_evidence_publications WHERE review_id = ? AND run_id = ? AND kind IN ('story', 'semantic') AND run_revision_id = ? ORDER BY kind",
      input.reviewId,
      input.runId,
      run.revision_id
    )
    .map((publication) => ({
      ...publication,
      members: view.all<EvidenceMember>(
        'SELECT name, kind, schema_version, relative_path AS relativePath, sha256, byte_length AS byteLength FROM review_evidence_members WHERE publication_id = ? ORDER BY name',
        publication.publication_id
      ),
    }));
  return { run, terminal, operation, publications, current };
}

export async function hydrateDatabaseReviewFinalization(
  database: ProjectDatabase,
  input: ReadDatabaseReviewFinalization,
  snapshot: {
    value: ReturnType<typeof snapshotDatabaseReviewFinalization>;
    counters: ProjectCounters;
  }
) {
  const { run: row, terminal: terminalRow, operation, publications } = snapshot.value;
  const run = decodeRetainedReviewRecord({
    kind: 'run',
    bytes: Buffer.from(row.record_hex, 'hex'),
  });
  if (run.sha256 !== row.record_hash || run.value.run_id !== input.runId)
    integrity('Retained run bytes differ from their exact identity or hash');
  if (!terminalRow) {
    if (run.value.finalized !== null || publications.length !== 0)
      integrity(
        'The sealed run terminal receipt is missing; preserve committed history for explicit repair'
      );
    return { value: null, counters: snapshot.counters };
  }
  const terminal = decodeRetainedTerminalRecord(Buffer.from(terminalRow.record_hex, 'hex'));
  if (
    !operation ||
    operation.operation_kind !== 'review.run.finalize' ||
    terminalRow.run_revision_id !== row.revision_id ||
    terminalRow.operation_id !== row.operation_id ||
    terminal.sha256 !== terminalRow.record_hash ||
    terminal.value.run_id !== input.runId ||
    run.value.finalized?.at !== terminal.value.finalized_at ||
    run.value.finalized.outcome !== terminal.value.outcome
  )
    integrity(
      'The terminal receipt no longer matches its sealed run and original publication operation'
    );
  const payload = decodeRetainedReviewJson(
    payloadSchema,
    Buffer.from(operation.payload_json)
  ).value;
  const expected = decodeRetainedReviewJson(
    finalizationTargetSchema,
    Buffer.from(operation.expected_state_json)
  ).value;
  const target = decodeRetainedReviewJson(
    z.strictObject({ reviewId: revisionId, runId: text }),
    Buffer.from(operation.target_json)
  ).value;
  if (
    target.reviewId !== input.reviewId ||
    target.runId !== input.runId ||
    payload.revisionId !== row.revision_id ||
    payload.finalizedAt !== terminal.value.finalized_at ||
    !Buffer.from(payload.runBytes, 'base64').equals(run.bytes) ||
    expected.revisionId !== row.previous_revision_id ||
    expected.version + 1 !== row.version ||
    expected.floorPublicationId !== row.floor_publication_id ||
    expected.membershipRevisionId !== row.membership_revision_id ||
    (run.value.runtime_identity !== null &&
      run.value.runtime_identity.runtimeFingerprintSha256 !==
        payload.runtimeIdentity?.runtimeFingerprintSha256)
  )
    integrity(
      'The original terminal operation no longer binds its exact authored run and reviewed version'
    );
  let rebuilt;
  try {
    rebuilt = buildTerminalRecord({
      run: run.value,
      finalizedAt: terminal.value.finalized_at,
      rangeValidation: terminal.value.range_validation,
      ownershipSummary: terminal.value.ownership_summary,
      outputs: terminal.value.outputs,
      semanticInput: terminal.value.semantic_anchor_input,
    });
  } catch (cause) {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Retained terminal metadata cannot be validated against its original run; preserve history for repair',
      { cause }
    );
  }
  if (!isDeepStrictEqual(rebuilt, terminal.value))
    integrity('The retained terminal receipt differs from its original run metadata');
  const storyRows = publications.filter((p) => p.kind === 'story');
  const semanticRows = publications.filter((p) => p.kind === 'semantic');
  if (
    storyRows.length !== (terminal.value.outputs === null ? 0 : 1) ||
    semanticRows.length !== (terminal.value.semantic_anchor_input.receipt_file === null ? 0 : 1) ||
    (storyRows[0]?.publication_id ?? null) !== payload.publicationId
  )
    integrity(
      'The terminal receipt required publications are missing or ambiguous; preserve them for repair'
    );
  const hydrated = [];
  for (const publication of publications) {
    if (
      publication.operation_id !== terminalRow.operation_id ||
      publication.floor_publication_id !== row.floor_publication_id ||
      publication.membership_revision_id !== row.membership_revision_id
    )
      integrity('Retained terminal evidence is associated with a different reviewed version');
    const metadata = decodeRetainedReviewJson(
      metadataSchema,
      Buffer.from(publication.record_json)
    ).value;
    if (
      metadata.outcome !== terminal.value.outcome ||
      metadata.observedWriteSequence > snapshot.counters.writeSequence
    )
      integrity('Retained terminal evidence has inconsistent source-read provenance');
    const members = [];
    for (const member of publication.members) {
      if (
        member.kind !== publication.kind ||
        member.relativePath !== `evidence/${publication.publication_id}/${member.name}`
      )
        integrity('Retained evidence member belongs to a different publication identity');
      const bytes = await readProjectEvidence(database, member);
      members.push({ ...member, ...decodeRetainedReviewText(bytes) });
    }
    if (publication.kind === 'story') {
      if (members.length !== payload.members.length || members.length !== 4)
        integrity('Required retained Story output members are incomplete');
      for (const authored of payload.members) {
        const member = members.find((m) => m.name === authored.name);
        if (!member || !member.bytes.equals(Buffer.from(authored.bytes, 'base64')))
          integrity('Retained Story bytes differ from their original authored publication');
      }
      const modelMember = members.find((m) => m.name === STORY_REVIEW_MODEL_FILE);
      if (!modelMember || modelMember.sha256 !== terminal.value.outputs?.story_review_model_sha256)
        integrity('The exact retained Story model differs from the terminal receipt');
      const model = decodeRetainedReviewRecord({ kind: 'story-model', bytes: modelMember.bytes });
      // The validated historical schema retains dispositions beyond the composer output type.
      if ((await storyReviewGeneration(model.value as StoryReviewModel)) !== publication.generation)
        integrity('The retained Story generation differs from its original model identity');
    } else {
      if (publication.generation !== (storyRows[0]?.generation ?? null))
        integrity('Retained semantic evidence belongs to a different Story generation');
      const receiptMember = members.find((m) => m.name === SEMANTIC_ANCHOR_RECEIPT_FILE);
      if (!receiptMember) integrity('The committed optional semantic receipt is missing');
      const receipt = decodeRetainedReviewRecord({
        kind: 'semantic-input',
        bytes: receiptMember.bytes,
      });
      const { receipt_file: _receiptFile, ...expectedReceipt } =
        terminal.value.semantic_anchor_input;
      if (!isDeepStrictEqual(receipt.value, expectedReceipt))
        integrity('The semantic receipt file differs from its retained terminal disclosure');
      const payloadMember = members.find((m) => m.name === SEMANTIC_ANCHOR_INPUT_FILE);
      if (
        members.length !== (receipt.value.payload_file === null ? 1 : 2) ||
        (receipt.value.payload_file === null
          ? payloadMember !== undefined
          : !payloadMember ||
            payloadMember.sha256 !== receipt.value.payload_sha256 ||
            payloadMember.byteLength !== receipt.value.payload_bytes)
      )
        integrity('The committed semantic payload differs from its retained receipt');
    }
    hydrated.push({
      publicationId: publication.publication_id,
      kind: publication.kind,
      generation: publication.generation,
      observedWriteSequence: metadata.observedWriteSequence,
      members,
    });
  }
  return {
    value: {
      reviewId: input.reviewId,
      runId: input.runId,
      revisionId: row.revision_id,
      version: row.version,
      operationId: terminalRow.operation_id,
      bytes: terminal.bytes,
      hash: terminal.sha256,
      terminal: terminal.value,
      runBytes: run.bytes,
      publications: hydrated,
      selection: snapshot.value.current,
    },
    counters: snapshot.counters,
  };
}
