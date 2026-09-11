import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { type ProjectDatabase } from '@orcaops/storage/history/database';

import { decodeSemanticSnapshot, readSemanticGenerationWithDatabase } from './semantic-read.js';
import {
  decodeSemanticGeneration,
  decodeSemanticOperation,
  type SemanticAttemptRow,
  type SemanticCurrentRow,
  type SemanticGenerationRow,
  type SemanticOperationRow,
  type SemanticTerminalRow,
} from './semantic-records.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture(status: 'PENDING' | 'VALID' | 'REJECTED' = 'VALID') {
  const generationId = uuidv7(),
    reviewId = uuidv7(),
    runId = 'original-semantic-run',
    terminalRevisionId = uuidv7(),
    inputPublicationId = uuidv7();
  const attempts: SemanticAttemptRow[] = [];
  const count = status === 'REJECTED' ? 2 : 1;
  for (let index = 0; index < count; index++) {
    const accepted = status === 'VALID',
      revisionId = uuidv7(),
      operationId = uuidv7();
    const startedAt = `2026-01-01T00:00:0${index * 2}.000Z`,
      submittedAt = `2026-01-01T00:00:0${index * 2 + 1}.000Z`;
    const event = {
      schema_version: 3,
      generation_id: generationId,
      run_id: runId,
      attempt: index + 1,
      started_at: startedAt,
      submitted_at: submittedAt,
      elapsed_ms: 1000,
      runtime_identity: null,
      declared_profile: 'semantic-anchor-profile-v1',
      profile_source: 'CALLER_DECLARED',
      normalization: 'CLEAN_JSON',
      raw_submission_sha256: hash('{}'),
      normalized_submission_sha256: hash('{}'),
      normalized_submission: {},
      accepted,
      outcome: accepted
        ? 'ACCEPTED_CLEAN_FIRST_PASS'
        : index === 0
          ? 'REJECTED_FIRST_PASS'
          : 'TERMINAL_REJECTED',
      has_focus_warnings: false,
      diagnostics: [],
      warnings: [],
    };
    const record = ' ' + JSON.stringify(event) + '\n',
      sha = hash(record),
      modelPublicationId = accepted ? uuidv7() : null;
    const payload = {
      attemptRevisionId: revisionId,
      modelPublicationId,
      rawSubmissionSha256: hash('{}'),
      authored: {
        startedAt,
        submittedAt,
        runtimeIdentity: null,
        profile: 'semantic-anchor-profile-v1',
      },
      attempt:
        index === 0
          ? { kind: 'initial' }
          : {
              kind: 'repair',
              firstRevisionId: attempts[0]!.revision_id,
              firstRecordSha256: attempts[0]!.record_sha256,
            },
    };
    const target = { reviewId, runId, generationId };
    const result = {
      ...target,
      attemptRevisionId: revisionId,
      attemptNumber: index + 1,
      accepted,
      status: accepted ? 'VALID' : index === 0 ? 'PENDING' : 'REJECTED',
      currentGenerationId: accepted ? generationId : null,
      currentVersion: accepted ? 1 : 0,
      modelPublicationId,
      attemptSha256: sha,
      manifestSha256: accepted || index === 1 ? 'a'.repeat(64) : null,
      modelSha256: accepted ? hash('model') : null,
    };
    const operation: SemanticOperationRow = {
      operation_id: operationId,
      operation_kind: 'review.semantic.submit',
      intent_change: 0,
      target_json: JSON.stringify(target),
      payload_json: JSON.stringify(payload),
      payload_hash: hash(JSON.stringify(payload)),
      expected_state_json: JSON.stringify({
        revisionId: terminalRevisionId,
        version: 4,
        runSelectionVersion: 1,
        semanticGenerationId: null,
        semanticVersion: 0,
      }),
      result_json: JSON.stringify(result),
      committed_write_sequence: index + 1,
      committed_intent_counter: 0,
    };
    attempts.push({
      revision_id: revisionId,
      generation_id: generationId,
      attempt_number: index + 1,
      record_json: record,
      record_sha256: sha,
      operation_id: operationId,
      accepted: Number(accepted),
      outcome: event.outcome,
      operation,
    });
  }
  const generation: SemanticGenerationRow = {
    generation_id: generationId,
    review_id: reviewId,
    run_id: runId,
    terminal_revision_id: terminalRevisionId,
    input_publication_id: inputPublicationId,
    input_kind: 'semantic',
    created_operation_id: attempts[0]!.operation_id,
  };
  let terminal: SemanticTerminalRow | null = null;
  const last = attempts.at(-1)!;
  if (status !== 'PENDING') {
    const lastEvent = JSON.parse(last.record_json),
      payload = JSON.parse(last.operation!.payload_json);
    const createdAt = '2026-01-01T00:00:05.000Z';
    const manifest = {
      schema_version: 3,
      generation_id: generationId,
      run_id: runId,
      status,
      created_at: createdAt,
      lifecycle_started_at: '2026-01-01T00:00:00.000Z',
      lifecycle_elapsed_ms: 5000,
      runtime_identity: null,
      attempt_count: count,
      declared_profile: 'semantic-anchor-profile-v1',
      profile_source: 'CALLER_DECLARED',
      source: 'REVIEW_MODEL_SUBMISSION_COMPILED',
      prepared_input_schema_version: 4,
      submission_schema_version: 3,
      attempt_schema_version: 3,
      target_schema_version: 3,
      model_schema_version: 3,
      model_file: 'semantic-anchor-model-v3.json',
      source_hashes: {
        story_review_model_sha256: 'a'.repeat(64),
        account_projection_sha256: 'b'.repeat(64),
        coverage_sha256: 'c'.repeat(64),
        diff_sha256: 'd'.repeat(64),
        accepted_account_envelope_sha256: 'e'.repeat(64),
        compiled_account_payload_sha256: 'f'.repeat(64),
      },
      prepared_receipt_sha256: 'a'.repeat(64),
      prepared_payload_sha256: 'b'.repeat(64),
      attempt_sha256s: attempts.map((attempt) => attempt.record_sha256),
      accepted_attempt_sha256: status === 'VALID' ? last.record_sha256 : null,
      model_sha256: status === 'VALID' ? hash('model') : null,
      diagnostic_codes: [],
      warning_codes: [],
      final_attempt_outcome: lastEvent.outcome,
    };
    const bytes = '\n' + JSON.stringify(manifest) + '\n';
    terminal = {
      generation_id: generationId,
      terminal_attempt_revision_id: last.revision_id,
      manifest_json: bytes,
      manifest_sha256: hash(bytes),
      model_publication_id: payload.modelPublicationId,
      model_relative_path: payload.modelPublicationId
        ? `evidence/${payload.modelPublicationId}/semantic-anchor-model-v3.json`
        : null,
      model_sha256: manifest.model_sha256,
      model_byte_length: status === 'VALID' ? 5 : null,
      operation_id: last.operation_id,
      status,
    };
    last.operation!.result_json = JSON.stringify({
      ...JSON.parse(last.operation!.result_json),
      manifestSha256: hash(bytes),
    });
  }
  return { generation, attempts, terminal };
}

describe('semantic retained record ownership', () => {
  it.each(['PENDING', 'VALID', 'REJECTED'] as const)(
    'decodes complete %s records with exact original bytes',
    (status) => {
      const f = fixture(status),
        decoded = decodeSemanticGeneration(f);
      expect(decoded.generation.run_id).toBe('original-semantic-run');
      expect(decoded.attempts[0]!.bytes.toString()).toBe(f.attempts[0]!.record_json);
      expect(decoded.terminal?.bytes.toString() ?? null).toBe(f.terminal?.manifest_json ?? null);
      expect(decoded.terminal?.manifest.created_at ?? null).toBe(
        status === 'PENDING' ? null : '2026-01-01T00:00:05.000Z'
      );
    }
  );

  it.each([
    'operation',
    'kind',
    'intent',
    'hash',
    'result',
    'payload-authority',
    'target',
    'expected',
  ] as const)('refuses a damaged original %s receipt', (kind) => {
    const f = fixture(),
      row = f.attempts[0]!;
    if (kind === 'operation') row.operation = null;
    else if (kind === 'kind') row.operation!.operation_kind = 'review.comment';
    else if (kind === 'intent') row.operation!.intent_change = 1;
    else if (kind === 'hash') row.operation!.payload_hash = '0'.repeat(64);
    else if (kind === 'result')
      row.operation!.result_json = JSON.stringify({
        ...JSON.parse(row.operation!.result_json),
        currentVersion: 2,
      });
    else if (kind === 'payload-authority') {
      row.operation!.payload_json = JSON.stringify({
        ...JSON.parse(row.operation!.payload_json),
        normalizedSubmission: {},
      });
      row.operation!.payload_hash = hash(row.operation!.payload_json);
    } else if (kind === 'target')
      row.operation!.target_json = JSON.stringify({
        ...JSON.parse(row.operation!.target_json),
        runId: 'foreign',
      });
    else
      row.operation!.expected_state_json = JSON.stringify({
        ...JSON.parse(row.operation!.expected_state_json),
        revisionId: uuidv7(),
      });
    expect(() => decodeSemanticGeneration(f)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
  });

  it.each(['bytes', 'generation', 'ordinal', 'admission', 'outcome', 'counter'] as const)(
    'refuses damaged attempt %s ownership',
    (kind) => {
      const f = fixture(),
        row = f.attempts[0]!;
      if (kind === 'bytes') row.record_json += ' ';
      else if (kind === 'generation') row.generation_id = uuidv7();
      else if (kind === 'ordinal') row.attempt_number = 2;
      else if (kind === 'admission') f.generation.created_operation_id = uuidv7();
      else if (kind === 'outcome') row.outcome = 'ACCEPTED_REPAIRED';
      else row.accepted = 0;
      expect(() => decodeSemanticGeneration(f)).toThrow(
        expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
      );
    }
  );

  it('requires the exact rejected repair predecessor and all terminal history', () => {
    const f = fixture('REJECTED'),
      last = f.attempts[1]!;
    const payload = JSON.parse(last.operation!.payload_json);
    payload.attempt.firstRevisionId = uuidv7();
    last.operation!.payload_json = JSON.stringify(payload);
    last.operation!.payload_hash = hash(last.operation!.payload_json);
    expect(() => decodeSemanticGeneration(f)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
    const accepted = fixture();
    accepted.terminal = null;
    expect(() => decodeSemanticGeneration(accepted)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
  });

  it.each(['attempt', 'operation', 'hash', 'path', 'size', 'model'] as const)(
    'refuses a damaged terminal %s association',
    (kind) => {
      const f = fixture(),
        row = f.terminal!;
      if (kind === 'attempt') row.terminal_attempt_revision_id = uuidv7();
      else if (kind === 'operation') row.operation_id = uuidv7();
      else if (kind === 'hash') row.manifest_json += ' ';
      else if (kind === 'path') row.model_relative_path = 'evidence/foreign/model.json';
      else if (kind === 'size') row.model_byte_length = -1;
      else row.model_sha256 = '0'.repeat(64);
      expect(() => decodeSemanticGeneration(f)).toThrow(
        expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
      );
    }
  );

  it('requires current selection to match the original accepted receipt', () => {
    const f = fixture(),
      current: SemanticCurrentRow = {
        review_id: f.generation.review_id,
        run_id: f.generation.run_id,
        generation_id: f.generation.generation_id,
        terminal_status: 'VALID',
        version: 1,
        operation_id: f.attempts[0]!.operation_id,
      };
    expect(decodeSemanticSnapshot({ selected: f, current, selectedCurrent: f }).current).toEqual(
      current
    );
    expect(() =>
      decodeSemanticSnapshot({
        selected: f,
        current: { ...current, version: 2 },
        selectedCurrent: f,
      })
    ).toThrow(expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' }));
    expect(decodeSemanticOperation(f.attempts[0]!.operation).payload).not.toHaveProperty(
      'normalizedSubmission'
    );
  });
});

it('refuses an imitated database handle before invoking its reader', async () => {
  let invoked = false;
  const fake = {
    read() {
      invoked = true;
      throw new Error('Imitated read invoked');
    },
  } as unknown as ProjectDatabase;
  await expect(
    readSemanticGenerationWithDatabase(fake, {
      authority: {
        resolvedRoot: '/unopened',
        rootKey: 'unopened',
        projectId: uuidv7(),
        storeInstanceId: uuidv7(),
        repositoryInstanceId: uuidv7(),
      },
      reviewId: uuidv7(),
      runId: 'original-run',
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(invoked).toBe(false);
});
