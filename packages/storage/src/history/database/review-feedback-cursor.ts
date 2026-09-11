import { createHash } from 'node:crypto';
import { z } from 'zod';

import { canonicalJson } from '../../events/canonical-json.js';
import { UuidV7Schema } from '../../ids/uuidv7.js';
import { assertNoForbiddenControlChars } from '../../text/control-chars.js';
import { canonicalRemoteTarget, RemoteTargetSchema } from '../remote-target.js';
import { assertProjectDatabasePath, type ProjectDatabase } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { type ProjectOperationOptions, runProjectOperation } from './transactions.js';
import type { DatabaseJson } from './values.js';

const inputSchema = z.strictObject({
  operationId: UuidV7Schema,
  target: RemoteTargetSchema,
  pullRequestId: z.string().min(1),
  cursor: z.string().min(1),
  advancedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
});
const keySchema = inputSchema.pick({ target: true, pullRequestId: true });

export interface ProjectReviewFeedbackWatchCursorInput {
  operationId: string;
  target: z.infer<typeof RemoteTargetSchema>;
  pullRequestId: string;
  cursor: string;
  advancedAt: string;
}

export interface ProjectReviewFeedbackWatchCursor {
  target: z.infer<typeof RemoteTargetSchema>;
  pullRequestId: string;
  cursor: string;
  cursorMs: number;
  version: number;
  operationId: string;
  advancedAt: string;
}

interface CursorRow {
  serverUrl: string;
  orgId: string;
  accountId: string;
  pullRequestId: string;
  cursor: string;
  cursorMs: number;
  version: number;
  operationId: string;
  advancedAt: string;
  operationKind: string | null;
  intentChange: number | null;
  targetJson: string | null;
  payloadJson: string | null;
  payloadHash: string | null;
  resultJson: string | null;
}

interface OperationRow {
  operationKind: string;
  intentChange: number;
  targetJson: string;
  payloadJson: string;
  payloadHash: string;
  resultJson: string;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function invalid(message: string, cause?: unknown): never {
  throw new ProjectDatabaseError('INVALID_INPUT', message, { cause });
}

function integrity(cause?: unknown): never {
  throw new ProjectDatabaseError(
    'HISTORY_INTEGRITY_REQUIRED',
    'The retained review feedback cursor or its operation receipt is missing or inconsistent; preserve history for explicit repair',
    { cause }
  );
}

function parseInput(raw: ProjectReviewFeedbackWatchCursorInput) {
  const parsed = inputSchema.safeParse(structuredClone(raw));
  if (!parsed.success) invalid('Provide a complete review feedback cursor identity', parsed.error);
  try {
    assertNoForbiddenControlChars(parsed.data);
  } catch (cause) {
    invalid('Remove forbidden controls from the review feedback cursor identity', cause);
  }
  const target = canonicalRemoteTarget(parsed.data.target);
  const cursorMs = Date.parse(parsed.data.cursor);
  if (!Number.isSafeInteger(cursorMs)) invalid('Provide a finite review feedback activity cursor');
  return Object.freeze({ ...parsed.data, target, cursorMs });
}

function parseKey(raw: Pick<ProjectReviewFeedbackWatchCursorInput, 'target' | 'pullRequestId'>) {
  const parsed = keySchema.safeParse(
    structuredClone({ target: raw.target, pullRequestId: raw.pullRequestId })
  );
  if (!parsed.success) invalid('Provide a complete review feedback cursor key', parsed.error);
  try {
    assertNoForbiddenControlChars(parsed.data);
  } catch (cause) {
    invalid('Remove forbidden controls from the review feedback cursor key', cause);
  }
  return Object.freeze({ ...parsed.data, target: canonicalRemoteTarget(parsed.data.target) });
}

function target(input: ReturnType<typeof parseInput>) {
  return { target: input.target, pullRequestId: input.pullRequestId };
}

function payload(input: ReturnType<typeof parseInput>) {
  return { cursor: input.cursor, cursorMs: input.cursorMs, advancedAt: input.advancedAt };
}

function selection(row: CursorRow): ProjectReviewFeedbackWatchCursor {
  return {
    target: {
      server_url: row.serverUrl,
      org_id: row.orgId,
      account_id: row.accountId,
    },
    pullRequestId: row.pullRequestId,
    cursor: row.cursor,
    cursorMs: row.cursorMs,
    version: row.version,
    operationId: row.operationId,
    advancedAt: row.advancedAt,
  };
}

function receipt(value: ProjectReviewFeedbackWatchCursor): DatabaseJson {
  return {
    target: {
      server_url: value.target.server_url,
      org_id: value.target.org_id,
      account_id: value.target.account_id,
    },
    pullRequestId: value.pullRequestId,
    cursor: value.cursor,
    cursorMs: value.cursorMs,
    version: value.version,
    operationId: value.operationId,
    advancedAt: value.advancedAt,
  };
}

function cursorRow(handle: ProjectDatabase, input: ReturnType<typeof parseKey>) {
  return handle.read((view) =>
    view.get<CursorRow>(
      `SELECT c.server_url AS serverUrl,c.org_id AS orgId,c.account_id AS accountId,
        c.pull_request_id AS pullRequestId,c.last_seen_human_activity_at AS cursor,
        c.last_seen_human_activity_ms AS cursorMs,c.version,c.operation_id AS operationId,
        c.advanced_at AS advancedAt,o.operation_kind AS operationKind,o.intent_change AS intentChange,
        o.target_json AS targetJson,o.payload_json AS payloadJson,o.payload_hash AS payloadHash,
        o.result_json AS resultJson
      FROM review_feedback_watch_cursors c
      LEFT JOIN operations o ON o.operation_id=c.operation_id
      WHERE c.server_url=? AND c.org_id=? AND c.account_id=? AND c.pull_request_id=?`,
      input.target.server_url,
      input.target.org_id,
      input.target.account_id,
      input.pullRequestId
    )
  );
}

function validated(row: CursorRow | null): ProjectReviewFeedbackWatchCursor | null {
  if (row === null) return null;
  const value = selection(row);
  const targetJson = canonicalJson({ target: value.target, pullRequestId: value.pullRequestId });
  const payloadJson = canonicalJson({
    cursor: value.cursor,
    cursorMs: value.cursorMs,
    advancedAt: value.advancedAt,
  });
  if (
    row.operationKind !== 'review.feedback.cursor.advance' ||
    row.intentChange !== 0 ||
    row.targetJson !== targetJson ||
    row.payloadJson !== payloadJson ||
    row.payloadHash !== digest(payloadJson) ||
    row.resultJson !== canonicalJson(value) ||
    !Number.isSafeInteger(value.cursorMs) ||
    Date.parse(value.cursor) !== value.cursorMs ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !Number.isFinite(Date.parse(value.advancedAt))
  )
    integrity();
  return value;
}

function retainedOperation(handle: ProjectDatabase, operationId: string) {
  return handle.read((view) =>
    view.get<OperationRow>(
      `SELECT operation_kind AS operationKind,intent_change AS intentChange,
        target_json AS targetJson,payload_json AS payloadJson,payload_hash AS payloadHash,
        result_json AS resultJson FROM operations WHERE operation_id=?`,
      operationId
    )
  ).value;
}

function validateRetainedOperation(
  row: OperationRow,
  input: ReturnType<typeof parseInput>
): ProjectReviewFeedbackWatchCursor {
  const targetJson = canonicalJson(target(input));
  const payloadJson = canonicalJson(payload(input));
  if (
    row.operationKind !== 'review.feedback.cursor.advance' ||
    row.intentChange !== 0 ||
    row.targetJson !== targetJson ||
    row.payloadJson !== payloadJson ||
    row.payloadHash !== digest(payloadJson)
  )
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'This cursor operation ID already identifies different content or context; use an explicitly new operation'
    );
  try {
    return z
      .object({
        target: RemoteTargetSchema,
        pullRequestId: z.string().min(1),
        cursor: z.string().min(1),
        cursorMs: z.number().int().safe(),
        version: z.number().int().positive().safe(),
        operationId: z.string().uuid(),
        advancedAt: z.string().min(1),
      })
      .parse(JSON.parse(row.resultJson));
  } catch (cause) {
    integrity(cause);
  }
}

export function readProjectReviewFeedbackWatchCursor(
  handle: ProjectDatabase,
  raw: Pick<ProjectReviewFeedbackWatchCursorInput, 'target' | 'pullRequestId'>
) {
  const input = parseKey(raw);
  assertProjectDatabasePath(handle);
  const snapshot = cursorRow(handle, input);
  return { ...snapshot, value: validated(snapshot.value) };
}

export async function advanceProjectReviewFeedbackWatchCursor(
  handle: ProjectDatabase,
  raw: ProjectReviewFeedbackWatchCursorInput,
  options: ProjectOperationOptions = {}
) {
  const input = parseInput(raw);
  assertProjectDatabasePath(handle);
  const retained = retainedOperation(handle, input.operationId);
  if (retained) {
    validateRetainedOperation(retained, input);
    return readProjectReviewFeedbackWatchCursor(handle, input);
  }
  await runProjectOperation(
    handle,
    {
      operationId: input.operationId,
      kind: 'review.feedback.cursor.advance',
      target: target(input),
      payload: payload(input),
      expectedState: null,
      intentChange: false,
    },
    (transaction) => {
      const current = validated(
        transaction.get<CursorRow>(
          `SELECT c.server_url AS serverUrl,c.org_id AS orgId,c.account_id AS accountId,
            c.pull_request_id AS pullRequestId,c.last_seen_human_activity_at AS cursor,
            c.last_seen_human_activity_ms AS cursorMs,c.version,c.operation_id AS operationId,
            c.advanced_at AS advancedAt,o.operation_kind AS operationKind,o.intent_change AS intentChange,
            o.target_json AS targetJson,o.payload_json AS payloadJson,o.payload_hash AS payloadHash,
            o.result_json AS resultJson
          FROM review_feedback_watch_cursors c
          LEFT JOIN operations o ON o.operation_id=c.operation_id
          WHERE c.server_url=? AND c.org_id=? AND c.account_id=? AND c.pull_request_id=?`,
          input.target.server_url,
          input.target.org_id,
          input.target.account_id,
          input.pullRequestId
        )
      );
      if (current !== null && input.cursorMs <= current.cursorMs) return receipt(current);
      const next: ProjectReviewFeedbackWatchCursor = {
        target: input.target,
        pullRequestId: input.pullRequestId,
        cursor: input.cursor,
        cursorMs: input.cursorMs,
        version: (current?.version ?? 0) + 1,
        operationId: input.operationId,
        advancedAt: input.advancedAt,
      };
      if (current === null)
        transaction.run(
          'INSERT INTO review_feedback_watch_cursors VALUES (?,?,?,?,?,?,?,?,?)',
          input.target.server_url,
          input.target.org_id,
          input.target.account_id,
          input.pullRequestId,
          input.cursor,
          input.cursorMs,
          next.version,
          input.operationId,
          input.advancedAt
        );
      else {
        const updated = transaction.run(
          `UPDATE review_feedback_watch_cursors SET
            last_seen_human_activity_at=?,last_seen_human_activity_ms=?,version=?,operation_id=?,advanced_at=?
          WHERE server_url=? AND org_id=? AND account_id=? AND pull_request_id=? AND version=?`,
          input.cursor,
          input.cursorMs,
          next.version,
          input.operationId,
          input.advancedAt,
          input.target.server_url,
          input.target.org_id,
          input.target.account_id,
          input.pullRequestId,
          current.version
        );
        if (updated.changes !== 1) integrity();
      }
      return receipt(next);
    },
    options
  );
  return readProjectReviewFeedbackWatchCursor(handle, input);
}
