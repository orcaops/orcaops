import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { executableIdentitySchema } from '@orcaops/review-core';
import { type ProjectEvidenceFile } from '@orcaops/storage/history/database';

import { SEMANTIC_ANCHOR_PROFILE } from '../semanticAnchors.js';
import { decodeRetainedReviewJson, decodeRetainedReviewRecord } from './records.js';
import { integrity, revisionId, text, version } from './request.js';
import { runTargetSchema } from './run-progress.js';

export const semanticGenerationId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
export const semanticHash = z.string().regex(/^[0-9a-f]{64}$/);
export const semanticExpectedSchema = runTargetSchema
  .extend({
    semanticGenerationId: semanticGenerationId.nullable(),
    semanticVersion: version,
  })
  .refine((value) => (value.semanticGenerationId === null) === (value.semanticVersion === 0));
export const semanticAuthoredSchema = z
  .strictObject({
    startedAt: z.iso.datetime(),
    submittedAt: z.iso.datetime(),
    runtimeIdentity: executableIdentitySchema.nullable(),
    profile: z.literal(SEMANTIC_ANCHOR_PROFILE),
  })
  .refine((value) => Date.parse(value.submittedAt) >= Date.parse(value.startedAt));
export const semanticAttemptSelectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('initial') }),
  z.strictObject({
    kind: z.literal('repair'),
    firstRevisionId: revisionId,
    firstRecordSha256: semanticHash,
  }),
]);
export const semanticTargetSchema = z.strictObject({
  reviewId: revisionId,
  runId: text,
  generationId: semanticGenerationId,
});
export const semanticPayloadSchema = z.strictObject({
  attemptRevisionId: revisionId,
  modelPublicationId: revisionId.nullable(),
  rawSubmissionSha256: semanticHash,
  authored: semanticAuthoredSchema,
  attempt: semanticAttemptSelectorSchema,
});
export const semanticResultSchema = z.strictObject({
  reviewId: revisionId,
  runId: text,
  generationId: semanticGenerationId,
  attemptRevisionId: revisionId,
  attemptNumber: z.union([z.literal(1), z.literal(2)]),
  accepted: z.boolean(),
  status: z.enum(['PENDING', 'VALID', 'REJECTED']),
  currentGenerationId: semanticGenerationId.nullable(),
  currentVersion: version,
  modelPublicationId: revisionId.nullable(),
  attemptSha256: semanticHash,
  manifestSha256: semanticHash.nullable(),
  modelSha256: semanticHash.nullable(),
});
export interface SemanticOperationRow {
  operation_id: string;
  operation_kind: string;
  intent_change: number;
  target_json: string;
  payload_json: string;
  payload_hash: string;
  expected_state_json: string;
  result_json: string;
  committed_write_sequence: number;
  committed_intent_counter: number;
}
export interface SemanticGenerationRow {
  generation_id: string;
  review_id: string;
  run_id: string;
  terminal_revision_id: string;
  input_publication_id: string;
  input_kind: string;
  created_operation_id: string;
}
export interface SemanticAttemptRow {
  revision_id: string;
  generation_id: string;
  attempt_number: number;
  record_json: string;
  record_sha256: string;
  operation_id: string;
  accepted: number;
  outcome: string;
  operation: SemanticOperationRow | null;
}
export interface SemanticTerminalRow {
  generation_id: string;
  terminal_attempt_revision_id: string;
  manifest_json: string;
  manifest_sha256: string;
  model_publication_id: string | null;
  model_relative_path: string | null;
  model_sha256: string | null;
  model_byte_length: number | null;
  operation_id: string;
  status: string;
}
export interface SemanticCurrentRow {
  review_id: string;
  run_id: string;
  generation_id: string;
  terminal_status: string;
  version: number;
  operation_id: string;
}
export function decodeSemanticOperation(row: SemanticOperationRow | null) {
  if (
    !row ||
    row.operation_kind !== 'review.semantic.submit' ||
    row.intent_change !== 0 ||
    createHash('sha256').update(row.payload_json).digest('hex') !== row.payload_hash
  )
    integrity('Retained semantic publication has no matching original operation receipt');
  const target = decodeRetainedReviewJson(semanticTargetSchema, Buffer.from(row.target_json)).value;
  const payload = decodeRetainedReviewJson(
    semanticPayloadSchema,
    Buffer.from(row.payload_json)
  ).value;
  const expected = decodeRetainedReviewJson(
    semanticExpectedSchema,
    Buffer.from(row.expected_state_json)
  ).value;
  const result = decodeRetainedReviewJson(semanticResultSchema, Buffer.from(row.result_json)).value;
  if (
    result.reviewId !== target.reviewId ||
    result.runId !== target.runId ||
    result.generationId !== target.generationId ||
    result.attemptRevisionId !== payload.attemptRevisionId ||
    result.attemptNumber !== (payload.attempt.kind === 'initial' ? 1 : 2) ||
    result.status !==
      (result.accepted ? 'VALID' : result.attemptNumber === 1 ? 'PENDING' : 'REJECTED') ||
    result.currentGenerationId !==
      (result.accepted ? target.generationId : expected.semanticGenerationId) ||
    result.currentVersion !== expected.semanticVersion + (result.accepted ? 1 : 0) ||
    result.modelPublicationId !== (result.accepted ? payload.modelPublicationId : null) ||
    (result.manifestSha256 === null) !== (result.status === 'PENDING') ||
    (result.modelSha256 !== null) !== result.accepted ||
    (result.accepted && result.modelPublicationId === null)
  )
    integrity('The semantic receipt result differs from its original authored target or selection');
  return { operationId: row.operation_id, target, payload, expected, result };
}
export function decodeSemanticGeneration(input: {
  generation: SemanticGenerationRow;
  attempts: SemanticAttemptRow[];
  terminal: SemanticTerminalRow | null;
}) {
  const g = input.generation;
  if (g.input_kind !== 'semantic' || input.attempts.length < 1 || input.attempts.length > 2)
    integrity('Retained semantic generation has incomplete original attempt history');
  const attempts = input.attempts.map((row, index) => {
    const record = decodeRetainedReviewRecord({
      kind: 'semantic-attempt',
      bytes: Buffer.from(row.record_json),
    });
    const event = record.value,
      op = decodeSemanticOperation(row.operation);
    if (
      row.generation_id !== g.generation_id ||
      row.attempt_number !== index + 1 ||
      event.generation_id !== g.generation_id ||
      event.run_id !== g.run_id ||
      event.attempt !== index + 1 ||
      record.sha256 !== row.record_sha256 ||
      Number(event.accepted) !== row.accepted ||
      event.outcome !== row.outcome ||
      op.operationId !== row.operation_id ||
      op.target.reviewId !== g.review_id ||
      op.target.runId !== g.run_id ||
      op.target.generationId !== g.generation_id ||
      op.expected.revisionId !== g.terminal_revision_id ||
      op.payload.attemptRevisionId !== row.revision_id ||
      op.payload.rawSubmissionSha256 !== event.raw_submission_sha256 ||
      op.payload.authored.startedAt !== event.started_at ||
      op.payload.authored.submittedAt !== event.submitted_at ||
      op.payload.authored.profile !== event.declared_profile ||
      !isDeepStrictEqual(op.payload.authored.runtimeIdentity, event.runtime_identity) ||
      op.result.accepted !== event.accepted ||
      op.result.attemptSha256 !== record.sha256 ||
      (event.accepted && event.normalization === 'INVALID_JSON') ||
      event.outcome !==
        (event.accepted
          ? index === 1
            ? 'ACCEPTED_REPAIRED'
            : event.normalization === 'CLEAN_JSON'
              ? 'ACCEPTED_CLEAN_FIRST_PASS'
              : 'ACCEPTED_NORMALIZED_FIRST_PASS'
          : index === 0
            ? 'REJECTED_FIRST_PASS'
            : 'TERMINAL_REJECTED')
    )
      integrity(
        'Retained semantic attempt bytes, original operation or exact run ownership differ'
      );
    return {
      revisionId: row.revision_id,
      operationId: row.operation_id,
      bytes: record.bytes,
      hash: record.sha256,
      event,
      operation: op,
    };
  });
  const first = attempts[0]!,
    last = attempts.at(-1)!;
  if (
    first.operationId !== g.created_operation_id ||
    first.operation.payload.attempt.kind !== 'initial'
  )
    integrity('The semantic generation differs from its original admission');
  if (attempts.length === 2) {
    const selector = last.operation.payload.attempt;
    if (
      first.event.accepted ||
      selector.kind !== 'repair' ||
      selector.firstRevisionId !== first.revisionId ||
      selector.firstRecordSha256 !== first.hash ||
      first.event.declared_profile !== last.event.declared_profile
    )
      integrity('The semantic repair differs from its exact rejected original attempt');
  }
  const row = input.terminal;
  if (!row) {
    if (
      attempts.length !== 1 ||
      first.event.accepted ||
      first.operation.result.status !== 'PENDING'
    )
      integrity('The retained terminal semantic attempt has no terminal record');
    return { generation: g, attempts, terminal: null };
  }
  const record = decodeRetainedReviewRecord({
      kind: 'semantic-manifest',
      bytes: Buffer.from(row.manifest_json),
    }),
    manifest = record.value;
  const status = last.event.accepted ? 'VALID' : 'REJECTED';
  if (
    row.generation_id !== g.generation_id ||
    row.terminal_attempt_revision_id !== last.revisionId ||
    row.operation_id !== last.operationId ||
    manifest.generation_id !== g.generation_id ||
    manifest.run_id !== g.run_id ||
    manifest.status !== status ||
    row.status !== status ||
    manifest.attempt_count !== attempts.length ||
    record.sha256 !== row.manifest_sha256 ||
    !isDeepStrictEqual(
      manifest.attempt_sha256s,
      attempts.map((attempt) => attempt.hash)
    ) ||
    manifest.accepted_attempt_sha256 !== (last.event.accepted ? last.hash : null) ||
    manifest.final_attempt_outcome !== last.event.outcome ||
    manifest.declared_profile !== last.event.declared_profile ||
    manifest.lifecycle_started_at !== first.event.started_at ||
    !isDeepStrictEqual(manifest.runtime_identity, last.event.runtime_identity) ||
    !isDeepStrictEqual(
      manifest.diagnostic_codes,
      last.event.diagnostics.map((diagnostic) => diagnostic.code)
    ) ||
    !isDeepStrictEqual(
      manifest.warning_codes,
      last.event.warnings.map((warning) => warning.code)
    ) ||
    last.operation.result.manifestSha256 !== record.sha256 ||
    last.operation.result.modelSha256 !== row.model_sha256 ||
    last.operation.result.modelPublicationId !== row.model_publication_id ||
    manifest.model_sha256 !== row.model_sha256 ||
    (status === 'REJECTED' && attempts.length !== 2)
  )
    integrity('Retained semantic terminal differs from its original attempts, model or receipt');
  let model: ProjectEvidenceFile | null = null;
  if (last.event.accepted) {
    if (
      !row.model_publication_id ||
      row.model_relative_path !==
        `evidence/${row.model_publication_id}/semantic-anchor-model-v3.json` ||
      !row.model_sha256 ||
      !Number.isSafeInteger(row.model_byte_length) ||
      row.model_byte_length! < 0
    )
      integrity('Accepted semantic generation has an invalid immutable model descriptor');
    model = {
      relativePath: row.model_relative_path,
      sha256: row.model_sha256,
      byteLength: row.model_byte_length!,
    };
  } else if (
    row.model_publication_id !== null ||
    row.model_relative_path !== null ||
    row.model_sha256 !== null ||
    row.model_byte_length !== null
  )
    integrity('Rejected semantic generation unexpectedly references accepted evidence');
  return {
    generation: g,
    attempts,
    terminal: { bytes: record.bytes, hash: record.sha256, manifest, model },
  };
}
