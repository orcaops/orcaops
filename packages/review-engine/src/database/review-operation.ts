// Receipt-first replay for the public review verbs.
//
// The accepted semantic submission verb is the reference shape: read the
// operation receipt for the caller's original identity BEFORE selection, before
// any read, before any Git observation and before any writer, replay the
// committed result when the identity is known, and refuse an identity that
// carries different authored input. A verb that mints a fresh identity on every
// invocation cannot replay an interrupted write — the retry settles a second
// row instead.

import { createHash } from 'node:crypto';
import { z } from 'zod';

import { uuidv7 } from '@orcaops/storage';
import {
  type ProjectCounters,
  type ProjectDatabaseAuthority,
  ProjectDatabaseError,
  type ProjectOperationResult,
} from '@orcaops/storage/history/database';

import { authoritySchema, integrity, revisionId, validate, withReviewDatabase } from './request.js';

/**
 * A deterministic child identity for a verb that settles more than one
 * operation. Operation identities are unique per row, so a verb whose retry must
 * replay both of its writes cannot reuse one identity for both — and cannot mint
 * a fresh one either. Deriving the child from the caller's original identity
 * keeps every write of one invocation addressable from that one identity.
 *
 * The child keeps the parent's 48-bit timestamp so it sorts beside the operation
 * it belongs to; the remaining bits come from the digest, which `uuidv7` lays out
 * with the version and variant a retained operation identity must carry.
 */
export function deriveReviewOperationId(operationId: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Derive a child review operation from a canonical original operation identity'
    );
  const digest = createHash('sha256')
    .update(`orcaops.review.operation\n${operationId}\n${label}\n`)
    .digest();
  return uuidv7({
    now: Number.parseInt(operationId.replaceAll('-', '').slice(0, 12), 16),
    random: () => digest.subarray(0, 10),
  });
}

export interface RetainedReviewOperation {
  operationId: string;
  kind: string;
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  committedCounters: { writeSequence: number; intentChangeCounter: number };
}

/** The identity is known but names different authored content or selectors. */
export function reviewOperationConflict(): never {
  throw new ProjectDatabaseError(
    'IDEMPOTENCY_CONFLICT',
    'This operation identity belongs to different review content or selectors; retain the original request or explicitly choose a new operation'
  );
}

const requestSchema = z.strictObject({
  authority: authoritySchema,
  operationId: revisionId,
  kinds: z.array(z.string().min(1)).min(1),
});

function decoded(value: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    integrity(`The original review receipt has unreadable ${field}; preserve it for repair`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    integrity(`The original review receipt has unreadable ${field}; preserve it for repair`);
  return parsed as Record<string, unknown>;
}

/**
 * The committed receipt for one original operation identity, or null when the
 * identity has never settled. An identity retained under a kind outside `kinds`
 * belongs to another authored action and refuses rather than replaying.
 */
export async function readRetainedReviewOperation(raw: {
  authority: ProjectDatabaseAuthority;
  operationId: string;
  kinds: readonly string[];
}): Promise<{ value: RetainedReviewOperation | null; counters: ProjectCounters }> {
  const input = validate(requestSchema, raw);
  return withReviewDatabase(input.authority, 'reader', (database) => {
    const retained = database.read((view) =>
      view.get<{
        operation_id: string;
        operation_kind: string;
        target_json: string;
        payload_json: string;
        result_json: string;
        committed_write_sequence: number;
        committed_intent_counter: number;
      }>('SELECT * FROM operations WHERE operation_id = ?', input.operationId)
    );
    const row = retained.value;
    if (!row) return { value: null, counters: retained.counters };
    if (!input.kinds.includes(row.operation_kind))
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
      integrity('The original review receipt has invalid committed provenance');
    return {
      value: {
        operationId: row.operation_id,
        kind: row.operation_kind,
        target: decoded(row.target_json, 'target'),
        payload: decoded(row.payload_json, 'payload'),
        result: decoded(row.result_json, 'result'),
        committedCounters: {
          writeSequence: row.committed_write_sequence,
          intentChangeCounter: row.committed_intent_counter,
        },
      },
      counters: retained.counters,
    };
  });
}

/**
 * The committed receipt rendered as the settlement result the store itself
 * returns for a byte-identical replay: the retained result, the counters the
 * operation committed at, and `replayed: true`. A verb whose retry cannot reach
 * the store's own replay — because it mints identities or timestamps per
 * invocation — reports the original outcome through this instead of settling a
 * second row.
 */
export function replayRetainedReviewOperation<T>(
  original: RetainedReviewOperation
): ProjectOperationResult<T> {
  return {
    value: original.result as T,
    counters: {
      writeSequence: original.committedCounters.writeSequence,
      intentChangeCounter: original.committedCounters.intentChangeCounter,
    },
    replayed: true,
  };
}
