import { createHash } from 'node:crypto';
import { z } from 'zod';

import { canonicalJson } from '@orcaops/storage';
import {
  ProjectDatabaseError,
  type ProjectOperationOptions,
  readProjectEvidence,
} from '@orcaops/storage/history/database';
import {
  type PendingReviewRetention,
  readProjectPendingReview,
} from '@orcaops/storage/history/database/review-retention';

import { publishDatabaseReviewFloor } from './floors.js';
import { decodeRetainedReviewRecord } from './records.js';
import {
  cancelled,
  integrity,
  invalid,
  operationFields,
  revisionId,
  scanMetadata,
  validate,
  withReviewDatabase,
} from './request.js';
import { changeDatabaseReviewBase } from './reviews.js';

const resumeRequest = z.strictObject({
  ...operationFields,
  reviewId: revisionId,
  gitRoot: z.string().min(1).optional(),
});
export type ResumeDatabaseReviewPublication = z.infer<typeof resumeRequest>;
export type ResumedDatabaseReviewPublication =
  | ({ kind: 'base' } & Awaited<ReturnType<typeof changeDatabaseReviewBase>>)
  | ({ kind: 'floor' } & Awaited<ReturnType<typeof publishDatabaseReviewFloor>>);

function floorSelection(pending: PendingReviewRetention) {
  const target = pending.retention.input.target;
  if (target.kind !== 'review') integrity('Original review publication target is missing');
  return {
    membershipRevisionId: target.membershipRevisionId,
    membershipVersion: target.membershipVersion,
    baseRevisionId: target.baseRevisionId,
    baseVersion: target.baseVersion,
    floorVersion: target.floorVersion,
  };
}
function retainedBase(pending: PendingReviewRetention) {
  const base = pending.original.base;
  return base ? { revisionId: base.revisionId, bytes: Buffer.from(base.bytesHex, 'hex') } : null;
}
function receiptBytes(value: unknown) {
  if (typeof value !== 'string') integrity('Original floor receipt bytes are missing');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) integrity('Original floor receipt bytes are invalid');
  return bytes;
}
function originalReceipt(
  pending: PendingReviewRetention,
  reviewId: string
): ResumedDatabaseReviewPublication | null {
  const terminal = pending.terminal;
  if (!terminal) return null;
  const base = retainedBase(pending);
  const expected = floorSelection(pending);
  let expectedPayload: unknown;
  let expectedState: unknown;
  let result: ResumedDatabaseReviewPublication;
  if (pending.original.kind === 'base') {
    if (!base) integrity('Original base publication bytes are missing');
    expectedPayload = { revisionId: base.revisionId, baseBytes: base.bytes.toString('base64') };
    expectedState = expected.baseVersion;
    result = {
      kind: 'base',
      value: { reviewId, baseRevisionId: base.revisionId, baseVersion: expected.baseVersion + 1 },
      counters: terminal.counters,
      replayed: true,
    };
  } else {
    const floor = pending.original.floor;
    if (!floor) integrity('Original floor publication input is missing');
    const payload = JSON.parse(terminal.payloadJson) as Record<string, unknown> | null;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
      integrity('Original floor receipt payload is invalid');
    const floorBytes = receiptBytes(payload.floorBytes);
    const diffBytes = receiptBytes(payload.diffBytes);
    for (const member of floor.members) {
      const bytes = member.name === 'floor.json' ? floorBytes : diffBytes;
      if (
        bytes.length !== member.byteLength ||
        createHash('sha256').update(bytes).digest('hex') !== member.sha256
      )
        integrity('Original floor receipt differs from its admitted evidence; preserve for repair');
    }
    const decoded = decodeRetainedReviewRecord({ kind: 'floor', bytes: floorBytes });
    if (
      floor.members.find((member) => member.name === 'floor.json')?.schemaVersion !==
      decoded.value.schema_version
    )
      integrity('Original floor receipt schema differs from its admitted evidence');
    expectedPayload = {
      publicationId: floor.publicationId,
      basis: floor.basis,
      floorBytes: floorBytes.toString('base64'),
      diffBytes: diffBytes.toString('base64'),
      ...(base
        ? { base: { revisionId: base.revisionId, baseBytes: base.bytes.toString('base64') } }
        : {}),
    };
    expectedState = expected;
    result = {
      kind: 'floor',
      value: {
        reviewId,
        publicationId: floor.publicationId,
        floorVersion: expected.floorVersion + 1,
        floorInputHash: decoded.value.input_hash,
      },
      counters: terminal.counters,
      replayed: true,
    };
  }
  if (
    terminal.kind !== `review.${pending.original.kind}` ||
    terminal.intentChange ||
    canonicalJson(JSON.parse(terminal.targetJson)) !== canonicalJson({ reviewId }) ||
    canonicalJson(JSON.parse(terminal.payloadJson)) !== canonicalJson(expectedPayload) ||
    canonicalJson(JSON.parse(terminal.expectedStateJson)) !== canonicalJson(expectedState) ||
    canonicalJson(JSON.parse(terminal.resultJson)) !== canonicalJson(result.value)
  )
    integrity('Original review receipt differs from its admitted request; preserve it for repair');
  return result;
}
function requireOriginalTarget(pending: PendingReviewRetention | null, reviewId: string) {
  if (!pending)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'No retained original review publication exists for this operation; use its original domain request or explicit repair'
    );
  const target = pending.retention.input.target;
  if (target.kind !== 'review' || target.reviewId !== reviewId)
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'This original operation belongs to another review; retry its original target'
    );
  return pending;
}
export async function resumeDatabaseReviewPublication(
  raw: ResumeDatabaseReviewPublication,
  options: ProjectOperationOptions = {}
): Promise<ResumedDatabaseReviewPublication> {
  options = { signal: options.signal, onWait: options.onWait };
  const input = validate(resumeRequest, raw);
  scanMetadata(input, input.secretAllow);
  cancelled(options.signal);
  const observed = await withReviewDatabase(
    input.authority,
    'reader',
    async (database) => {
      const pending = requireOriginalTarget(
        readProjectPendingReview(database, input.operationId).value,
        input.reviewId
      );
      const completed = originalReceipt(pending, input.reviewId);
      if (completed) return { completed, pending, floorBytes: null, diffBytes: null };
      if (pending.original.kind === 'base')
        return { completed: null, pending, floorBytes: null, diffBytes: null };
      const floor = pending.original.floor!;
      let floorBytes: Buffer | null = null;
      let diffBytes: Buffer | null = null;
      try {
        for (const member of floor.members) {
          cancelled(options.signal);
          const bytes = await readProjectEvidence(database, member);
          if (member.name === 'floor.json') floorBytes = bytes;
          else diffBytes = bytes;
        }
      } catch (cause) {
        cancelled(options.signal);
        const completed = originalReceipt(
          requireOriginalTarget(
            readProjectPendingReview(database, input.operationId).value,
            input.reviewId
          ),
          input.reviewId
        );
        if (completed) return { completed, pending, floorBytes: null, diffBytes: null };
        throw cause;
      }
      if (!floorBytes || !diffBytes) integrity('Original admitted floor evidence is incomplete');
      return { completed: null, pending, floorBytes, diffBytes };
    },
    (observed) => observed.completed !== null
  );
  cancelled(options.signal);
  if (observed.completed) return observed.completed;
  if (!input.gitRoot)
    invalid('Provide the original registered checkout to resume this pending review publication');
  const base = retainedBase(observed.pending);
  if (observed.pending.original.kind === 'base') {
    if (!base) integrity('Original base publication bytes are missing');
    const result = await changeDatabaseReviewBase(
      {
        ...input,
        revisionId: base.revisionId,
        baseBytes: base.bytes,
        expectedVersion: floorSelection(observed.pending).baseVersion,
      },
      options
    );
    return { kind: 'base', ...result };
  }
  const floor = observed.pending.original.floor!;
  const result = await publishDatabaseReviewFloor(
    {
      authority: input.authority,
      reviewId: input.reviewId,
      operationId: input.operationId,
      secretAllow: input.secretAllow,
      publicationId: floor.publicationId,
      basis: {
        ...floor.basis,
        reviewIncludedUntracked: [...floor.basis.reviewIncludedUntracked],
        gitRoot: input.gitRoot,
      },
      expected: floorSelection(observed.pending),
      floorBytes: observed.floorBytes!,
      diffBytes: observed.diffBytes!,
      ...(base ? { base } : {}),
    },
    options
  );
  return { kind: 'floor', ...result };
}
