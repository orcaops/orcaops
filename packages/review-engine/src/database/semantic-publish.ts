import { z } from 'zod';

import {
  type ProjectEvidenceFile,
  type ProjectOperationOptions,
  type ProjectReadView,
  publishProjectEvidence,
} from '@orcaops/storage/history/database';

import { SEMANTIC_ANCHOR_MODEL_FILE } from '../semanticAnchorGenerations.js';
import { SEMANTIC_ANCHOR_PROFILE_V1 } from '../semanticAnchors.js';
import { prepareReviewRecords } from './records.js';
import {
  cancelled,
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
} from './request.js';
import { requireRunTarget } from './run-progress.js';
import { prepareDatabaseSemanticGeneration } from './semantic-preparation.js';
import {
  readSemanticGenerationWithDatabase,
  requireSemanticTables,
  snapshotSemanticGeneration,
} from './semantic-read.js';
import {
  semanticAttemptSelectorSchema,
  semanticAuthoredSchema,
  type SemanticCurrentRow,
  semanticExpectedSchema,
  semanticGenerationId,
  semanticResultSchema,
} from './semantic-records.js';
import { prepareDatabaseSemanticSubmission } from './semantic-submission.js';

const requestSchema = z.strictObject({
  ...operationFields,
  reviewId: revisionId,
  runId: text,
  generationId: semanticGenerationId,
  attemptRevisionId: revisionId,
  modelPublicationId: revisionId.nullable(),
  expected: semanticExpectedSchema,
  authored: semanticAuthoredSchema,
  attempt: semanticAttemptSelectorSchema,
  submissionBytes: z.instanceof(Uint8Array),
});
export type PublishDatabaseSemanticGeneration = Omit<
  z.infer<typeof requestSchema>,
  'submissionBytes'
> & { submissionBytes: Uint8Array };

function requireSemanticTarget(view: ProjectReadView, input: PublishDatabaseSemanticGeneration) {
  requireSemanticTables(view);
  requireRunTarget(view, input.reviewId, input.runId, input.expected);
  const current = view.get<SemanticCurrentRow>(
    'SELECT * FROM review_semantic_current WHERE review_id=? AND run_id=?',
    input.reviewId,
    input.runId
  );
  if (
    (current?.generation_id ?? null) !== input.expected.semanticGenerationId ||
    (current?.version ?? 0) !== input.expected.semanticVersion
  )
    stale('The accepted semantic selection changed; preserve the original generation target');
  const generation = view.get<{
    review_id: string;
    run_id: string;
    terminal_revision_id: string;
    input_publication_id: string;
  }>('SELECT * FROM review_semantic_generations WHERE generation_id=?', input.generationId);
  if (input.attempt.kind === 'initial') {
    if (generation) stale('This generation already began; retain its original attempt identity');
  } else {
    const first = view.get<{ revision_id: string; record_sha256: string; accepted: number }>(
      'SELECT revision_id,record_sha256,accepted FROM review_semantic_attempts WHERE generation_id=? AND attempt_number=1',
      input.generationId
    );
    if (
      !generation ||
      generation.review_id !== input.reviewId ||
      generation.run_id !== input.runId ||
      generation.terminal_revision_id !== input.expected.revisionId ||
      !first ||
      first.revision_id !== input.attempt.firstRevisionId ||
      first.record_sha256 !== input.attempt.firstRecordSha256 ||
      first.accepted !== 0 ||
      view.get(
        'SELECT 1 FROM review_semantic_attempts WHERE generation_id=? AND attempt_number=2',
        input.generationId
      ) ||
      view.get('SELECT 1 FROM review_semantic_terminals WHERE generation_id=?', input.generationId)
    )
      stale('The exact rejected generation no longer admits its original repair attempt');
  }
  return generation;
}

export async function publishDatabaseSemanticGeneration(
  raw: PublishDatabaseSemanticGeneration,
  options: ProjectOperationOptions = {}
) {
  options = { signal: options.signal, onWait: options.onWait };
  const input = validate(requestSchema, raw);
  const submission = prepareDatabaseSemanticSubmission({
    bytes: input.submissionBytes,
    maximumBytes: SEMANTIC_ANCHOR_PROFILE_V1.maximum_submission_bytes,
    secretAllow: input.secretAllow,
  });
  scanMetadata({ ...input, submissionBytes: undefined }, input.secretAllow);
  cancelled(options.signal);
  const target = { reviewId: input.reviewId, runId: input.runId, generationId: input.generationId };
  const payload = {
    attemptRevisionId: input.attemptRevisionId,
    modelPublicationId: input.modelPublicationId,
    rawSubmissionSha256: submission.raw_sha256,
    authored: input.authored,
    attempt: input.attempt,
  };
  let prepared: Awaited<ReturnType<typeof prepareDatabaseSemanticGeneration>>;
  let records: ReturnType<typeof prepareReviewRecords>;
  let result: z.infer<typeof semanticResultSchema>;
  let model: ProjectEvidenceFile | null = null;
  return performReviewOperation(
    {
      authority: input.authority,
      operation: {
        operationId: input.operationId,
        kind: 'review.semantic.submit',
        target,
        payload: json(payload),
        expectedState: json(input.expected),
        intentChange: false,
      },
      async prepareReadOnly(database) {
        database.read((view) => {
          snapshotSemanticGeneration(view, input);
          requireSemanticTarget(view, input);
          return null;
        });
        let first:
          | NonNullable<
              Awaited<ReturnType<typeof readSemanticGenerationWithDatabase>>['value']
            >['attempts'][number]
          | null = null;
        if (input.attempt.kind === 'repair') {
          const retained = await readSemanticGenerationWithDatabase(database, input);
          if (!retained.value || retained.value.terminal || retained.value.attempts.length !== 1)
            stale('Repair requires the exact retained pending generation');
          first = retained.value.attempts[0]!;
          if (
            first.revisionId !== input.attempt.firstRevisionId ||
            first.hash !== input.attempt.firstRecordSha256 ||
            first.event.accepted ||
            first.event.declared_profile !== input.authored.profile ||
            Date.parse(input.authored.startedAt) < Date.parse(first.event.submitted_at)
          )
            invalid(
              'Retain the original rejected attempt, profile and subsequent repair timestamps'
            );
        }
        const expected = {
          revisionId: input.expected.revisionId,
          version: input.expected.version,
          runSelectionVersion: input.expected.runSelectionVersion,
        };
        prepared = await prepareDatabaseSemanticGeneration(
          {
            authority: input.authority,
            reviewId: input.reviewId,
            runId: input.runId,
            generationId: input.generationId,
            expected,
            submissionBytes: new Uint8Array(submission.bytes),
            secretAllow: input.secretAllow,
          },
          options
        );
        if (first) {
          const generation = database.read((view) => requireSemanticTarget(view, input)).value;
          if (generation?.input_publication_id !== prepared.inputPublicationId)
            integrity('The repair source differs from its originally retained semantic input');
        }
        const accepted = prepared.validation.accepted;
        if (accepted && input.modelPublicationId === null)
          invalid(
            'An accepted semantic model requires its original immutable publication identity'
          );
        const attemptNumber = input.attempt.kind === 'initial' ? 1 : 2;
        const outcome = accepted
          ? attemptNumber === 2
            ? 'ACCEPTED_REPAIRED'
            : submission.normalization === 'CLEAN_JSON'
              ? 'ACCEPTED_CLEAN_FIRST_PASS'
              : 'ACCEPTED_NORMALIZED_FIRST_PASS'
          : attemptNumber === 1
            ? 'REJECTED_FIRST_PASS'
            : 'TERMINAL_REJECTED';
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
        const attempt = {
          schema_version: 3,
          generation_id: input.generationId,
          run_id: input.runId,
          attempt: attemptNumber,
          started_at: input.authored.startedAt,
          submitted_at: input.authored.submittedAt,
          elapsed_ms: Date.parse(input.authored.submittedAt) - Date.parse(input.authored.startedAt),
          runtime_identity: input.authored.runtimeIdentity,
          declared_profile: input.authored.profile,
          profile_source: 'CALLER_DECLARED',
          normalization: submission.normalization,
          raw_submission_sha256: submission.raw_sha256,
          normalized_submission_sha256: submission.normalized_sha256,
          normalized_submission: submission.canonical,
          accepted,
          outcome,
          has_focus_warnings: prepared.validation.warnings.some((warning) =>
            warning.code.startsWith('FOCUS_')
          ),
          diagnostics: prepared.validation.diagnostics,
          warnings: prepared.validation.warnings,
        };
        const [attemptRecord] = prepareReviewRecords({
          records: [{ kind: 'semantic-attempt', bytes: encode(attempt) }],
          secretAllow: input.secretAllow,
        });
        records = [attemptRecord!];
        let modelRecord: ReturnType<typeof prepareReviewRecords>[number] | null = null;
        if (accepted && prepared.validation.accepted) {
          [modelRecord = null] = prepareReviewRecords({
            records: [{ kind: 'semantic-model', bytes: encode(prepared.validation.model) }],
            secretAllow: input.secretAllow,
          });
        }
        const terminal = accepted || attemptNumber === 2;
        if (terminal) {
          const startedAt = first?.event.started_at ?? input.authored.startedAt;
          const [manifest] = prepareReviewRecords({
            records: [
              {
                kind: 'semantic-manifest',
                bytes: encode({
                  schema_version: 3,
                  generation_id: input.generationId,
                  run_id: input.runId,
                  status: accepted ? 'VALID' : 'REJECTED',
                  created_at: input.authored.submittedAt,
                  lifecycle_started_at: startedAt,
                  lifecycle_elapsed_ms:
                    Date.parse(input.authored.submittedAt) - Date.parse(startedAt),
                  runtime_identity: input.authored.runtimeIdentity,
                  attempt_count: attemptNumber,
                  declared_profile: input.authored.profile,
                  profile_source: 'CALLER_DECLARED',
                  source: 'REVIEW_MODEL_SUBMISSION_COMPILED',
                  prepared_input_schema_version: 4,
                  submission_schema_version: 3,
                  attempt_schema_version: 3,
                  target_schema_version: 3,
                  model_schema_version: 3,
                  model_file: SEMANTIC_ANCHOR_MODEL_FILE,
                  source_hashes: prepared.receipt.source_hashes,
                  prepared_receipt_sha256: prepared.receiptSha256,
                  prepared_payload_sha256: prepared.receipt.payload_sha256,
                  attempt_sha256s: [...(first ? [first.hash] : []), attemptRecord!.sha256],
                  accepted_attempt_sha256: accepted ? attemptRecord!.sha256 : null,
                  model_sha256: modelRecord?.sha256 ?? null,
                  diagnostic_codes: prepared.validation.diagnostics.map(
                    (diagnostic) => diagnostic.code
                  ),
                  warning_codes: prepared.validation.warnings.map((warning) => warning.code),
                  final_attempt_outcome: outcome,
                }),
              },
            ],
            secretAllow: input.secretAllow,
          });
          records.push(manifest!);
        }
        if (modelRecord) records.push(modelRecord);
        result = validate(semanticResultSchema, {
          ...target,
          attemptRevisionId: input.attemptRevisionId,
          attemptNumber,
          accepted,
          status: accepted ? 'VALID' : terminal ? 'REJECTED' : 'PENDING',
          currentGenerationId: accepted ? input.generationId : input.expected.semanticGenerationId,
          currentVersion: input.expected.semanticVersion + (accepted ? 1 : 0),
          modelPublicationId: accepted ? input.modelPublicationId : null,
          attemptSha256: attemptRecord!.sha256,
          manifestSha256: terminal ? records[1]!.sha256 : null,
          modelSha256: modelRecord?.sha256 ?? null,
        });
        cancelled(options.signal);
      },
      async prepareEvidence(database) {
        if (result.accepted) {
          const member = records.find((record) => record.kind === 'semantic-model')!;
          [model = null] = await publishProjectEvidence(
            database,
            {
              publicationId: input.modelPublicationId!,
              members: [{ name: SEMANTIC_ANCHOR_MODEL_FILE, bytes: member.bytes }],
              secretAllow: input.secretAllow,
            },
            { signal: options.signal }
          );
          if (!model || model.sha256 !== result.modelSha256)
            integrity('The immutable semantic model differs from its prepared record');
        }
      },
      settle(tx) {
        requireSemanticTarget(tx, input);
        if (input.attempt.kind === 'initial')
          tx.run(
            'INSERT INTO review_semantic_generations VALUES (?, ?, ?, ?, ?, ?, ?)',
            input.generationId,
            input.reviewId,
            input.runId,
            input.expected.revisionId,
            prepared.inputPublicationId,
            'semantic',
            input.operationId
          );
        tx.run(
          'INSERT INTO review_semantic_attempts (revision_id,generation_id,attempt_number,record_json,record_sha256,operation_id) VALUES (?, ?, ?, ?, ?, ?)',
          input.attemptRevisionId,
          input.generationId,
          result.attemptNumber,
          records[0]!.bytes.toString('utf8'),
          records[0]!.sha256,
          input.operationId
        );
        if (result.status !== 'PENDING')
          tx.run(
            'INSERT INTO review_semantic_terminals (generation_id,terminal_attempt_revision_id,manifest_json,manifest_sha256,model_publication_id,model_relative_path,model_sha256,model_byte_length,operation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            input.generationId,
            input.attemptRevisionId,
            records[1]!.bytes.toString('utf8'),
            records[1]!.sha256,
            result.modelPublicationId,
            model?.relativePath ?? null,
            model?.sha256 ?? null,
            model?.byteLength ?? null,
            input.operationId
          );
        if (result.accepted) {
          if (input.expected.semanticGenerationId === null)
            tx.run(
              "INSERT INTO review_semantic_current VALUES (?, ?, ?, 'VALID', 1, ?)",
              input.reviewId,
              input.runId,
              input.generationId,
              input.operationId
            );
          else
            tx.run(
              'UPDATE review_semantic_current SET generation_id=?,version=?,operation_id=? WHERE review_id=? AND run_id=?',
              input.generationId,
              result.currentVersion,
              input.operationId,
              input.reviewId,
              input.runId
            );
        }
        return result;
      },
    },
    options
  );
}
