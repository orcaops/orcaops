import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { canonicalJson } from '@orcaops/storage';
import {
  type ProjectOperationOptions,
  type ProjectReadView,
  type ProjectSettlement,
} from '@orcaops/storage/history/database';

import { type TwolaneRunFile } from '../twolaneRunFile.js';
import { decodeRetainedReviewRecord, prepareReviewRecords } from './records.js';
import {
  invalid,
  json,
  operationFields,
  performReviewOperation,
  revisionId,
  scanMetadata,
  stale,
  text,
  validate,
  version,
} from './request.js';
import { selection } from './reviews.js';
import { readRunWithDatabase } from './run-read.js';

export const runTargetSchema = z.strictObject({
  revisionId,
  version: version.refine((value) => value > 0),
  runSelectionVersion: version,
});
export function requireRunTarget(
  view: ProjectReadView,
  reviewId: string,
  runId: string,
  expected: z.infer<typeof runTargetSchema>
): void {
  const current = selection(view, reviewId);
  const run = view.get<{ current_revision_id: string; version: number }>(
    'SELECT current_revision_id, version FROM review_runs WHERE run_id = ? AND review_id = ?',
    runId,
    reviewId
  );
  if (
    current.current_run_id !== runId ||
    current.run_selection_version !== expected.runSelectionVersion ||
    !run ||
    run.current_revision_id !== expected.revisionId ||
    run.version !== expected.version
  )
    stale(
      'The selected run or its progress changed; preserve the original target and prepare an explicitly new operation'
    );
}
export function insertRunRevision(
  tx: ProjectSettlement,
  input: {
    reviewId: string;
    runId: string;
    revisionId: string;
    operationId: string;
    expected: z.infer<typeof runTargetSchema>;
    bytes: Buffer;
    sha256: string;
    run: TwolaneRunFile;
    floorPublicationId: string;
    membershipRevisionId: string;
  }
): void {
  requireRunTarget(tx, input.reviewId, input.runId, input.expected);
  tx.run(
    'INSERT INTO review_run_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    input.revisionId,
    input.reviewId,
    input.runId,
    input.expected.revisionId,
    input.expected.version + 1,
    input.operationId,
    input.bytes,
    input.sha256,
    input.floorPublicationId,
    input.membershipRevisionId
  );
  for (let ordinal = 0; ordinal < input.run.attempts.length; ordinal++)
    tx.run(
      'INSERT INTO review_attempts VALUES (?, ?, ?)',
      input.revisionId,
      ordinal + 1,
      canonicalJson(input.run.attempts[ordinal]!)
    );
  tx.run(
    'UPDATE review_runs SET current_revision_id = ?, version = ? WHERE run_id = ? AND review_id = ?',
    input.revisionId,
    input.expected.version + 1,
    input.runId,
    input.reviewId
  );
}
const serveSchema = z.strictObject({
  ...operationFields,
  reviewId: revisionId,
  runId: text,
  revisionId,
  expected: runTargetSchema,
  lane: z.enum(['account', 'forensic']),
  runBytes: z.instanceof(Uint8Array),
});
export type RecordDatabaseReviewInputsServed = Omit<z.infer<typeof serveSchema>, 'runBytes'> & {
  runBytes: Uint8Array;
};
export async function recordDatabaseReviewInputsServed(
  raw: RecordDatabaseReviewInputsServed,
  options: ProjectOperationOptions = {}
) {
  options = { signal: options.signal, onWait: options.onWait };
  const input = validate(serveSchema, raw);
  const [record] = prepareReviewRecords({
    records: [{ kind: 'run', bytes: input.runBytes }],
    secretAllow: input.secretAllow,
  });
  const run = decodeRetainedReviewRecord({ kind: 'run', bytes: record!.bytes });
  scanMetadata({ authority: input.authority, expected: input.expected }, input.secretAllow);
  const servedAt = run.value.lane_inputs_served[input.lane];
  if (run.value.run_id !== input.runId || !z.iso.datetime().safeParse(servedAt).success)
    invalid('Retain the exact run identity and a valid first-served timestamp');
  let retained: NonNullable<Awaited<ReturnType<typeof readRunWithDatabase>>['value']>;
  return performReviewOperation(
    {
      authority: input.authority,
      operation: {
        operationId: input.operationId,
        kind: 'review.run.inputs-served',
        target: { reviewId: input.reviewId, runId: input.runId },
        payload: {
          revisionId: input.revisionId,
          lane: input.lane,
          runBytes: run.bytes.toString('base64'),
        },
        expectedState: json(input.expected),
        intentChange: false,
      },
      async prepareReadOnly(database) {
        database.read((view) => {
          requireRunTarget(view, input.reviewId, input.runId, input.expected);
          return null;
        });
        const read = await readRunWithDatabase(database, {
          authority: input.authority,
          reviewId: input.reviewId,
          runId: input.runId,
          revisionId: input.expected.revisionId,
        });
        if (!read.value)
          stale('The intended run revision is absent; preserve its original identity');
        retained = read.value;
        if (retained.run.lane_inputs_served[input.lane] !== undefined)
          stale(
            'The lane input already has its first-served record; replay the original operation'
          );
        if (retained.run.finalized !== null)
          invalid('A finalized run cannot acquire a new input-served record');
        const forensic = retained.run.slice_state.lanes.forensic;
        if (
          input.lane === 'account' &&
          !forensic.accepted &&
          forensic.outcome !== 'TERMINAL_REJECTED'
        )
          invalid('Account inputs require a terminal forensic lane before serving');
        const expected = {
          ...retained.run,
          lane_inputs_served: { ...retained.run.lane_inputs_served, [input.lane]: servedAt },
        };
        if (!isDeepStrictEqual(expected, run.value))
          invalid('Input-served progress may only append the named first-served timestamp');
      },
      settle(tx) {
        insertRunRevision(tx, {
          reviewId: input.reviewId,
          runId: input.runId,
          revisionId: input.revisionId,
          operationId: input.operationId,
          expected: input.expected,
          bytes: run.bytes,
          sha256: run.sha256,
          run: run.value,
          floorPublicationId: retained.floorPublicationId,
          membershipRevisionId: retained.membershipRevisionId,
        });
        return {
          reviewId: input.reviewId,
          runId: input.runId,
          revisionId: input.revisionId,
          version: input.expected.version + 1,
        };
      },
    },
    options
  );
}
