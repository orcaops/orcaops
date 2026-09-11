import { createHash } from 'node:crypto';

import { uuidv7 } from '@orcaops/storage';
import {
  openProjectDatabase,
  type ProjectDatabaseAuthority,
  publishProjectEvidence,
  runProjectOperation,
} from '@orcaops/storage/history/database';

import { type prepareDatabaseSemanticGeneration } from '../src/database/semantic-preparation.js';
import {
  semanticAnchorAttemptSchema,
  semanticAnchorManifestSchema,
} from '../src/semanticAnchorGenerations.js';

export async function retainSemanticFixture(
  authority: ProjectDatabaseAuthority,
  prepared: Awaited<ReturnType<typeof prepareDatabaseSemanticGeneration>>,
  previous: { generationId: string; version: number } | null = null
) {
  if (!prepared.validation.accepted)
    throw new Error('Fixture requires accepted original semantic preparation');
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
  const operationId = uuidv7(),
    attemptRevisionId = uuidv7(),
    publicationId = uuidv7();
  const authored = {
    startedAt: '2026-06-01T00:05:00.000Z',
    submittedAt: '2026-06-01T00:05:01.000Z',
    runtimeIdentity: null,
    profile: 'semantic-anchor-profile-v1' as const,
  };
  const modelBytes = bytes(prepared.validation.model);
  const attempt = semanticAnchorAttemptSchema.parse({
    schema_version: 3,
    generation_id: prepared.generationId,
    run_id: prepared.runId,
    attempt: 1,
    started_at: authored.startedAt,
    submitted_at: authored.submittedAt,
    elapsed_ms: 1000,
    runtime_identity: null,
    declared_profile: authored.profile,
    profile_source: 'CALLER_DECLARED',
    normalization: prepared.submission.normalization,
    raw_submission_sha256: prepared.submission.raw_sha256,
    normalized_submission_sha256: prepared.submission.normalized_sha256,
    normalized_submission: prepared.submission.canonical,
    accepted: true,
    outcome:
      prepared.submission.normalization === 'CLEAN_JSON'
        ? 'ACCEPTED_CLEAN_FIRST_PASS'
        : 'ACCEPTED_NORMALIZED_FIRST_PASS',
    has_focus_warnings: prepared.validation.warnings.some((w) => w.code.startsWith('FOCUS_')),
    diagnostics: prepared.validation.diagnostics,
    warnings: prepared.validation.warnings,
  });
  const attemptBytes = bytes(attempt);
  const manifest = semanticAnchorManifestSchema.parse({
    schema_version: 3,
    generation_id: prepared.generationId,
    run_id: prepared.runId,
    status: 'VALID',
    created_at: '2026-06-01T00:05:02.000Z',
    lifecycle_started_at: authored.startedAt,
    lifecycle_elapsed_ms: 2000,
    runtime_identity: null,
    attempt_count: 1,
    declared_profile: authored.profile,
    profile_source: 'CALLER_DECLARED',
    source: 'REVIEW_MODEL_SUBMISSION_COMPILED',
    prepared_input_schema_version: 4,
    submission_schema_version: 3,
    attempt_schema_version: 3,
    target_schema_version: 3,
    model_schema_version: 3,
    model_file: 'semantic-anchor-model-v3.json',
    source_hashes: prepared.receipt.source_hashes,
    prepared_receipt_sha256: prepared.receiptSha256,
    prepared_payload_sha256: prepared.receipt.payload_sha256,
    attempt_sha256s: [hash(attemptBytes)],
    accepted_attempt_sha256: hash(attemptBytes),
    model_sha256: hash(modelBytes),
    diagnostic_codes: [],
    warning_codes: prepared.validation.warnings.map((w) => w.code),
    final_attempt_outcome: attempt.outcome,
  });
  const manifestBytes = bytes(manifest);
  const target = {
    reviewId: prepared.reviewId,
    runId: prepared.runId,
    generationId: prepared.generationId,
  };
  const payload = {
    attemptRevisionId,
    modelPublicationId: publicationId,
    rawSubmissionSha256: prepared.submission.raw_sha256,
    authored,
    attempt: { kind: 'initial' },
  };
  const expectedState = {
    ...prepared.expected,
    semanticGenerationId: previous?.generationId ?? null,
    semanticVersion: previous?.version ?? 0,
  };
  const result = {
    ...target,
    attemptRevisionId,
    attemptNumber: 1,
    accepted: true,
    status: 'VALID',
    currentGenerationId: prepared.generationId,
    currentVersion: (previous?.version ?? 0) + 1,
    modelPublicationId: publicationId,
    attemptSha256: hash(attemptBytes),
    manifestSha256: hash(manifestBytes),
    modelSha256: hash(modelBytes),
  };
  const database = await openProjectDatabase({ authority, mode: 'writer' });
  try {
    const [descriptor] = await publishProjectEvidence(database, {
      publicationId,
      members: [{ name: 'semantic-anchor-model-v3.json', bytes: modelBytes }],
      secretAllow: [],
    });
    await runProjectOperation(
      database,
      {
        operationId,
        kind: 'review.semantic.submit',
        target,
        payload,
        expectedState,
        intentChange: false,
      },
      (tx) => {
        tx.run(
          'INSERT INTO review_semantic_generations VALUES (?, ?, ?, ?, ?, ?, ?)',
          prepared.generationId,
          prepared.reviewId,
          prepared.runId,
          prepared.expected.revisionId,
          prepared.inputPublicationId,
          'semantic',
          operationId
        );
        tx.run(
          'INSERT INTO review_semantic_attempts (revision_id,generation_id,attempt_number,record_json,record_sha256,operation_id) VALUES (?, ?, 1, ?, ?, ?)',
          attemptRevisionId,
          prepared.generationId,
          attemptBytes.toString(),
          hash(attemptBytes),
          operationId
        );
        tx.run(
          'INSERT INTO review_semantic_terminals (generation_id,terminal_attempt_revision_id,manifest_json,manifest_sha256,model_publication_id,model_relative_path,model_sha256,model_byte_length,operation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          prepared.generationId,
          attemptRevisionId,
          manifestBytes.toString(),
          hash(manifestBytes),
          publicationId,
          descriptor!.relativePath,
          descriptor!.sha256,
          descriptor!.byteLength,
          operationId
        );
        if (previous)
          tx.run(
            'UPDATE review_semantic_current SET generation_id=?,version=?,operation_id=? WHERE review_id=? AND run_id=?',
            prepared.generationId,
            previous.version + 1,
            operationId,
            prepared.reviewId,
            prepared.runId
          );
        else
          tx.run(
            "INSERT INTO review_semantic_current VALUES (?, ?, ?, 'VALID', 1, ?)",
            prepared.reviewId,
            prepared.runId,
            prepared.generationId,
            operationId
          );
        return result;
      }
    );
    return {
      operationId,
      attemptRevisionId,
      publicationId,
      descriptor: descriptor!,
      attemptBytes,
      manifestBytes,
      modelBytes,
      result,
    };
  } finally {
    database.close();
  }
}
