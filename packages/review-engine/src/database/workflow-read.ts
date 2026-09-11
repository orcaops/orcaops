import { z } from 'zod';

import { reviewLedgerGeneration } from '@orcaops/review-core';
import { type ProjectReadView } from '@orcaops/storage/history/database';

import { decodeRetainedReviewJson, decodeRetainedReviewRecord } from './records.js';
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
import { workflowTarget } from './workflow-events.js';

export const workflowBasisSchema = z.strictObject({
  floor: z.strictObject({ publicationId: revisionId, version, inputHash: text }),
  story: z
    .strictObject({ publicationId: revisionId.nullable(), version, generation: text.nullable() })
    .optional(),
  ledger: z.strictObject({ generation: text, sequence: version }).optional(),
  comments: z.array(z.strictObject({ commentId: text, revisionId, version })).optional(),
});
const sourceSchema = z.strictObject({
  kind: z.literal('authored'),
  eventId: revisionId,
  fieldPath: z.literal('events'),
  position: version,
});
const readSchema = z.strictObject({ authority: authoritySchema, reviewId: revisionId });
export type ReadDatabaseReviewWorkflow = z.infer<typeof readSchema>;
export interface WorkflowHead {
  targetKey: string;
  revisionId: string;
  version: number;
}
interface WorkflowRow {
  revision_id: string;
  target_key: string;
  previous_revision_id: string | null;
  version: number;
  sequence: number;
  operation_id: string;
  record_hex: string;
  record_hash: string;
  basis_json: string;
  source_json: string;
}

export function snapshotReviewWorkflow(view: ProjectReadView, reviewId: string) {
  selection(view, reviewId);
  const heads = view.all<WorkflowHead>(
    'SELECT target_key AS targetKey, revision_id AS revisionId, version FROM review_workflow_current WHERE review_id = ? ORDER BY target_key',
    reviewId
  );
  const rows = view.all<WorkflowRow>(
    'SELECT revision_id, target_key, previous_revision_id, version, sequence, operation_id, hex(record_bytes) AS record_hex, record_hash, basis_json, source_json FROM review_workflow_transitions WHERE review_id = ? ORDER BY sequence',
    reviewId
  );
  return { reviewId, heads, rows };
}

export async function hydrateReviewWorkflow(snapshot: ReturnType<typeof snapshotReviewWorkflow>) {
  const latest = new Map<string, WorkflowHead>();
  const revisions = snapshot.rows.map((row, index) => {
    const record = decodeRetainedReviewRecord({
      kind: 'workflow',
      bytes: Buffer.from(row.record_hex, 'hex'),
    });
    const basis = decodeRetainedReviewJson(workflowBasisSchema, Buffer.from(row.basis_json)).value;
    const source = decodeRetainedReviewJson(sourceSchema, Buffer.from(row.source_json)).value;
    const event = record.value;
    if (event.type === 'review_coverage' || event.type === 'review_lifecycle') {
      if (
        basis.floor.inputHash !== event.floor_input_hash ||
        basis.ledger?.generation !== event.ledger_generation ||
        basis.ledger.sequence !== row.sequence - 1
      )
        integrity('Retained workflow aggregate differs from its original floor or ledger basis');
    }
    if (
      event.type === 'review_lifecycle' &&
      (!basis.story ||
        basis.story.generation !== event.story_generation ||
        (event.action === 'COMPLETE' && basis.comments === undefined))
    )
      integrity('Retained lifecycle lacks its exact Story or completion-comment dependency');
    const previous = latest.get(row.target_key);
    if (
      row.sequence !== index + 1 ||
      row.version !== (previous?.version ?? 0) + 1 ||
      row.previous_revision_id !== (previous?.revisionId ?? null) ||
      row.target_key !== workflowTarget(record.value) ||
      record.sha256 !== row.record_hash ||
      source.eventId !== row.revision_id
    )
      integrity(
        'Retained workflow order, target, source identity or bytes are inconsistent; preserve history for explicit repair'
      );
    latest.set(row.target_key, {
      targetKey: row.target_key,
      revisionId: row.revision_id,
      version: row.version,
    });
    return {
      revisionId: row.revision_id,
      previousRevisionId: row.previous_revision_id,
      targetKey: row.target_key,
      version: row.version,
      sequence: row.sequence,
      operationId: row.operation_id,
      bytes: record.bytes,
      hash: record.sha256,
      event: record.value,
      basis,
      source,
    };
  });
  if (
    latest.size !== snapshot.heads.length ||
    snapshot.heads.some((head) => {
      const expected = latest.get(head.targetKey);
      return (
        !expected || expected.revisionId !== head.revisionId || expected.version !== head.version
      );
    })
  )
    integrity(
      'Retained workflow history differs from its current target selections; preserve history for explicit repair'
    );
  const events = revisions.map((revision) => revision.event);
  return {
    reviewId: snapshot.reviewId,
    heads: snapshot.heads,
    sequence: revisions.length,
    ledgerGeneration: await reviewLedgerGeneration(events),
    revisions,
    events,
  };
}

export async function readDatabaseReviewWorkflow(raw: ReadDatabaseReviewWorkflow) {
  const input = validate(readSchema, raw);
  return withReviewDatabase(input.authority, 'reader', async (database) => {
    const snapshot = database.read((view) => snapshotReviewWorkflow(view, input.reviewId));
    return { value: await hydrateReviewWorkflow(snapshot.value), counters: snapshot.counters };
  });
}
