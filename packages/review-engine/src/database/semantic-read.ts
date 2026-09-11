import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import {
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectReadView,
  readProjectEvidence,
  readProjectInitialization,
} from '@orcaops/storage/history/database';

import { SEMANTIC_ANCHOR_RECEIPT_FILE } from '../semanticAnchors.js';
import { decodeRetainedReviewRecord } from './records.js';
import {
  authoritySchema,
  integrity,
  revisionId,
  text,
  validate,
  withReviewDatabase,
} from './request.js';
import { selection } from './reviews.js';
import { readDatabaseReviewFinalization } from './run-finalization-read.js';
import { readRunWithDatabase } from './run-read.js';
import {
  decodeSemanticGeneration,
  type SemanticAttemptRow,
  type SemanticCurrentRow,
  semanticGenerationId,
  type SemanticGenerationRow,
  type SemanticOperationRow,
  type SemanticTerminalRow,
} from './semantic-records.js';

const readSchema = z.strictObject({
  authority: authoritySchema,
  reviewId: revisionId,
  runId: text,
  generationId: semanticGenerationId.optional(),
});
export type ReadDatabaseSemanticGeneration = z.infer<typeof readSchema>;
export function requireSemanticTables(view: ProjectReadView) {
  const row = view.get<{ count: number }>(
    "SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name IN ('review_semantic_generations','review_semantic_attempts','review_semantic_terminals','review_semantic_current')"
  );
  if (row?.count === 0) {
    if (view.get("SELECT 1 FROM operations WHERE operation_kind='review.semantic.submit' LIMIT 1"))
      integrity(
        'Committed semantic publication history is missing; preserve its original receipts'
      );
    throw new ProjectDatabaseError(
      'HISTORY_FORMAT_UNSUPPORTED',
      'Semantic generation storage is not installed; use an explicit supported schema upgrade'
    );
  }
  if (row?.count !== 4)
    integrity('Semantic generation storage is incomplete; preserve history for explicit repair');
}
function operation(view: ProjectReadView, id: string) {
  return (
    view.get<SemanticOperationRow>('SELECT * FROM operations WHERE operation_id=?', id) ?? null
  );
}
function generation(view: ProjectReadView, id: string) {
  const g = view.get<SemanticGenerationRow>(
    'SELECT * FROM review_semantic_generations WHERE generation_id=?',
    id
  );
  if (!g) return null;
  const attempts = view.all<Omit<SemanticAttemptRow, 'operation'>>(
    'SELECT * FROM review_semantic_attempts WHERE generation_id=? ORDER BY attempt_number',
    id
  );
  const terminal =
    view.get<SemanticTerminalRow>(
      'SELECT * FROM review_semantic_terminals WHERE generation_id=?',
      id
    ) ?? null;
  return {
    generation: g,
    attempts: attempts.map((row) => ({ ...row, operation: operation(view, row.operation_id) })),
    terminal,
  };
}
export function snapshotSemanticGeneration(
  view: ProjectReadView,
  input: Omit<ReadDatabaseSemanticGeneration, 'authority'>
) {
  requireSemanticTables(view);
  selection(view, input.reviewId);
  if (
    view.get(
      `SELECT 1 FROM operations o WHERE o.operation_kind='review.semantic.submit'
        AND json_extract(o.target_json,'$.reviewId')=? AND json_extract(o.target_json,'$.runId')=?
        AND NOT EXISTS (
          SELECT 1 FROM review_semantic_generations g JOIN review_semantic_attempts a ON a.generation_id=g.generation_id
          WHERE g.generation_id=json_extract(o.target_json,'$.generationId')
            AND g.review_id=? AND g.run_id=? AND a.operation_id=o.operation_id
        ) LIMIT 1`,
      input.reviewId,
      input.runId,
      input.reviewId,
      input.runId
    )
  )
    integrity('Committed semantic publication rows are missing; preserve their original receipts');
  // Children without an owner cannot safely be assigned to a requested scope.
  if (
    view.get(
      `SELECT 1 FROM review_semantic_attempts a WHERE NOT EXISTS (SELECT 1 FROM review_semantic_generations g WHERE g.generation_id=a.generation_id) LIMIT 1`
    ) ||
    view.get(
      `SELECT 1 FROM review_semantic_terminals t WHERE NOT EXISTS (SELECT 1 FROM review_semantic_generations g WHERE g.generation_id=t.generation_id) LIMIT 1`
    )
  )
    integrity('Semantic history has a missing generation owner; preserve its retained children');
  const current =
    view.get<SemanticCurrentRow>(
      'SELECT * FROM review_semantic_current WHERE review_id=? AND run_id=?',
      input.reviewId,
      input.runId
    ) ?? null;
  if (
    !current &&
    view.get(
      `SELECT 1 FROM review_semantic_generations g JOIN review_semantic_attempts a ON a.generation_id=g.generation_id
WHERE g.review_id=? AND g.run_id=? AND a.accepted=1 LIMIT 1`,
      input.reviewId,
      input.runId
    )
  )
    integrity(
      'Accepted semantic history has no current selection; preserve it for explicit repair'
    );
  const id = input.generationId ?? current?.generation_id;
  const selected = id ? generation(view, id) : null;
  if (current && !selected && input.generationId === undefined)
    integrity('The selected semantic generation is missing; preserve its current reference');
  if (
    !selected ||
    selected.generation.review_id !== input.reviewId ||
    selected.generation.run_id !== input.runId
  )
    return { selected: null, current, selectedCurrent: null };
  const selectedCurrent = current
    ? current.generation_id === selected.generation.generation_id
      ? selected
      : generation(view, current.generation_id)
    : null;
  if (
    current &&
    (!selectedCurrent ||
      selectedCurrent.generation.review_id !== input.reviewId ||
      selectedCurrent.generation.run_id !== input.runId)
  )
    integrity('The current semantic selection belongs to missing or different retained history');
  return { selected, current, selectedCurrent };
}
export function decodeSemanticSnapshot(snapshot: ReturnType<typeof snapshotSemanticGeneration>) {
  if (!snapshot.selected) return { value: null, current: snapshot.current };
  const value = decodeSemanticGeneration(snapshot.selected);
  const current = snapshot.current;
  if (current) {
    if (!snapshot.selectedCurrent) integrity('The semantic current generation snapshot is missing');
    const selected =
      snapshot.selectedCurrent === snapshot.selected
        ? value
        : decodeSemanticGeneration(snapshot.selectedCurrent);
    const last = selected.attempts.at(-1)!;
    if (
      current.terminal_status !== 'VALID' ||
      selected.terminal?.manifest.status !== 'VALID' ||
      current.operation_id !== last.operationId ||
      current.version !== last.operation.result.currentVersion ||
      current.generation_id !== last.operation.result.currentGenerationId
    )
      integrity('The current semantic generation differs from its original accepted receipt');
  }
  return { value, current };
}
export async function readDatabaseSemanticGeneration(raw: ReadDatabaseSemanticGeneration) {
  const input = validate(readSchema, raw);
  return withReviewDatabase(input.authority, 'reader', (database) =>
    readSemanticGenerationWithDatabase(database, input)
  );
}
export async function readSemanticGenerationWithDatabase(
  database: ProjectDatabase,
  input: ReadDatabaseSemanticGeneration
) {
  if (!isDeepStrictEqual(readProjectInitialization(database).authority, input.authority))
    throw new ProjectDatabaseError(
      'AUTHORITY_MISMATCH',
      'Use the exact registered project authority for semantic reads'
    );
  const snapshot = database.read((view) => snapshotSemanticGeneration(view, input));
  const decoded = decodeSemanticSnapshot(snapshot.value);
  if (!decoded.value) return { value: null, counters: snapshot.counters };
  const { generation: g, attempts, terminal } = decoded.value;
  for (const row of snapshot.value.selected!.attempts) {
    const op = row.operation;
    if (
      !op ||
      !Number.isSafeInteger(op.committed_write_sequence) ||
      op.committed_write_sequence < 1 ||
      op.committed_write_sequence > snapshot.counters.writeSequence ||
      !Number.isSafeInteger(op.committed_intent_counter) ||
      op.committed_intent_counter < 0 ||
      op.committed_intent_counter > snapshot.counters.intentChangeCounter
    )
      integrity('The semantic receipt counters exceed their retained read snapshot');
  }
  const finalized = await readDatabaseReviewFinalization({
    authority: input.authority,
    reviewId: input.reviewId,
    runId: input.runId,
  });
  const source = finalized.value;
  if (!source || source.revisionId !== g.terminal_revision_id)
    integrity('The semantic generation refers to missing or different terminal run history');
  const original = await readRunWithDatabase(database, {
    authority: input.authority,
    reviewId: g.review_id,
    runId: g.run_id,
    revisionId: g.terminal_revision_id,
  });
  if (!original.value || !original.value.runBytes.equals(source.runBytes))
    integrity('The semantic input source differs from its exact retained terminal run');
  const semantic = source.publications.find(
    (publication) =>
      publication.kind === 'semantic' && publication.publicationId === g.input_publication_id
  );
  const member = semantic?.members.find((file) => file.name === SEMANTIC_ANCHOR_RECEIPT_FILE);
  if (!member) integrity('The original semantic generation input publication is missing');
  const receipt = decodeRetainedReviewRecord({ kind: 'semantic-input', bytes: member.bytes }).value;
  if (
    receipt.status !== 'READY' ||
    receipt.run_id !== g.run_id ||
    attempts.some((attempt) => attempt.operation.expected.version !== source.version)
  )
    integrity('The semantic generation differs from its original READY run version');
  let model = null;
  if (terminal) {
    if (
      terminal.manifest.prepared_receipt_sha256 !== member.sha256 ||
      terminal.manifest.prepared_payload_sha256 !== receipt.payload_sha256 ||
      !isDeepStrictEqual(terminal.manifest.source_hashes, receipt.source_hashes)
    )
      integrity('The semantic manifest differs from its retained input source hashes');
    if (terminal.model) {
      const bytes = await readProjectEvidence(database, terminal.model);
      const record = decodeRetainedReviewRecord({ kind: 'semantic-model', bytes });
      if (
        record.value.run_id !== g.run_id ||
        record.value.generation_id !== g.generation_id ||
        record.value.floor_input_hash !== receipt.floor_input_hash ||
        record.value.prepared_payload_sha256 !== receipt.payload_sha256
      )
        integrity('The accepted semantic model differs from its exact retained run and input');
      model = { bytes: record.bytes, hash: record.sha256, value: record.value };
    }
  }
  return {
    value: {
      reviewId: g.review_id,
      runId: g.run_id,
      generationId: g.generation_id,
      terminalRevisionId: g.terminal_revision_id,
      inputPublicationId: g.input_publication_id,
      attempts,
      terminal,
      model,
      current: decoded.current,
    },
    counters: snapshot.counters,
  };
}
