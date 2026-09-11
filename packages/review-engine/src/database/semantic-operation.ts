import { z } from 'zod';

import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { authoritySchema, integrity, revisionId, validate, withReviewDatabase } from './request.js';
import { requireSemanticTables } from './semantic-read.js';
import { decodeSemanticOperation, type SemanticOperationRow } from './semantic-records.js';

const requestSchema = z.strictObject({ authority: authoritySchema, operationId: revisionId });
export type ReadDatabaseSemanticOperation = z.infer<typeof requestSchema>;

export async function readDatabaseSemanticOperation(raw: ReadDatabaseSemanticOperation) {
  const input = validate(requestSchema, raw);
  return withReviewDatabase(input.authority, 'reader', (database) => {
    const retained = database.read((view) => {
      const row = view.get<SemanticOperationRow>(
        'SELECT * FROM operations WHERE operation_id=?',
        input.operationId
      );
      if (row) return row;
      requireSemanticTables(view);
      if (
        view.get(
          `SELECT 1 FROM review_semantic_generations WHERE created_operation_id=?
           UNION ALL SELECT 1 FROM review_semantic_attempts WHERE operation_id=?
           UNION ALL SELECT 1 FROM review_semantic_terminals WHERE operation_id=?
           UNION ALL SELECT 1 FROM review_semantic_current WHERE operation_id=? LIMIT 1`,
          input.operationId,
          input.operationId,
          input.operationId,
          input.operationId
        )
      )
        integrity('Retained semantic publication is missing its original operation receipt');
      return null;
    });
    const row = retained.value;
    if (row === null) return { value: null, counters: retained.counters };
    if (row.operation_kind !== 'review.semantic.submit')
      throw new ProjectDatabaseError(
        'IDEMPOTENCY_CONFLICT',
        'This operation identity belongs to another authored action; retain its original action or explicitly choose a new operation'
      );
    if (
      row.operation_id !== input.operationId ||
      !Number.isSafeInteger(row.committed_write_sequence) ||
      row.committed_write_sequence < 1 ||
      row.committed_write_sequence > retained.counters.writeSequence ||
      !Number.isSafeInteger(row.committed_intent_counter) ||
      row.committed_intent_counter < 0 ||
      row.committed_intent_counter > retained.counters.intentChangeCounter
    )
      integrity('The original semantic receipt has invalid committed provenance');
    return {
      value: {
        ...decodeSemanticOperation(row),
        committedCounters: {
          writeSequence: row.committed_write_sequence,
          intentChangeCounter: row.committed_intent_counter,
        },
      },
      counters: retained.counters,
    };
  });
}
