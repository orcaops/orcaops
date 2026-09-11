import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { executableIdentitySchema } from '@orcaops/review-core';
import { canonicalJson } from '@orcaops/storage';
import {
  type ProjectDatabase,
  type ProjectEvidenceFile,
  type ProjectOperationOptions,
  publishProjectEvidence,
} from '@orcaops/storage/history/database';

import { type AccountProjection, type DossierV1 } from '../dossier.js';
import {
  canonicalJsonSha256,
  normalizeSubmission,
  canonicalJson as submissionJson,
} from '../submissionNormalization.js';
import {
  ISOLATION_VALUES,
  type RoutineNormalizationCode,
  type TwolaneRunFile,
} from '../twolaneRunFile.js';
import {
  type AccountPayload,
  type AuthoredAccountPayload,
  sliceContext,
  submitLane,
} from '../twolaneSlice.js';
import { decodeRetainedReviewRecord, prepareReviewRecords, prepareReviewText } from './records.js';
import {
  authoritySchema,
  cancelled,
  invalid,
  json,
  operationFields,
  performReviewOperation,
  revisionId,
  scanMetadata,
  stale,
  text,
  validate,
  withReviewDatabase,
} from './request.js';
import { insertRunRevision, requireRunTarget, runTargetSchema } from './run-progress.js';
import { readRunWithDatabase } from './run-read.js';

export const attemptAuthoredSchema = z.strictObject({
  lane: z.enum(['account', 'forensic']),
  at: z.iso.datetime(),
  isolation: z.enum(ISOLATION_VALUES),
  usageTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  usageSource: text.nullable(),
  runtimeIdentity: executableIdentitySchema.nullable(),
});
const prepareSchema = z.strictObject({
  authority: authoritySchema,
  reviewId: revisionId,
  runId: text,
  expected: runTargetSchema,
  authored: attemptAuthoredSchema,
  rawSubmissionBytes: z.instanceof(Uint8Array),
  secretAllow: z.array(z.string()),
});
export type PrepareDatabaseReviewAttempt = Omit<
  z.infer<typeof prepareSchema>,
  'rawSubmissionBytes'
> & { rawSubmissionBytes: Uint8Array };
function prepareRequest(raw: PrepareDatabaseReviewAttempt) {
  const input = validate(prepareSchema, raw);
  const submission = prepareReviewText({
    bytes: input.rawSubmissionBytes,
    secretAllow: input.secretAllow,
  });
  scanMetadata(
    { authority: input.authority, expected: input.expected, authored: input.authored },
    input.secretAllow
  );
  return { ...input, rawSubmissionBytes: submission.bytes };
}
export async function prepareDatabaseReviewAttempt(
  raw: PrepareDatabaseReviewAttempt,
  options: { signal?: AbortSignal } = {}
) {
  options = { signal: options.signal };
  const input = prepareRequest(raw);
  cancelled(options.signal);
  return withReviewDatabase(input.authority, 'reader', (database) =>
    prepareAttemptWithDatabase(database, input, options)
  );
}
async function prepareAttemptWithDatabase(
  database: ProjectDatabase,
  input: PrepareDatabaseReviewAttempt,
  options: { signal?: AbortSignal }
) {
  options = { signal: options.signal };
  const snapshot = database.read((view) => {
    requireRunTarget(view, input.reviewId, input.runId, input.expected);
    return null;
  });
  const read = await readRunWithDatabase(database, {
    authority: input.authority,
    reviewId: input.reviewId,
    runId: input.runId,
    revisionId: input.expected.revisionId,
  });
  if (!read.value) stale('The intended run is missing; preserve its original identity');
  const retained = read.value;
  const {
    run: next,
    members,
    accepted,
    diagnostics,
  } = deriveRunAttempt({
    run: retained.run,
    authored: input.authored,
    raw: prepareReviewText({ bytes: input.rawSubmissionBytes, secretAllow: input.secretAllow }),
    dossier: retained.inputValues['dossier-v1.json'] as DossierV1,
    projection: retained.inputValues['account-projection-v1.json'] as AccountProjection,
  });
  for (const member of members)
    prepareReviewText({ bytes: member.bytes, secretAllow: input.secretAllow });
  const [record] = prepareReviewRecords({
    records: [{ kind: 'run', bytes: Buffer.from(JSON.stringify(next, null, 2) + '\n') }],
    secretAllow: input.secretAllow,
  });
  cancelled(options.signal);
  return {
    run: next,
    runBytes: record!.bytes,
    members,
    accepted,
    diagnostics,
    floorPublicationId: retained.floorPublicationId,
    membershipRevisionId: retained.membershipRevisionId,
    counters: snapshot.counters,
  };
}
const publishSchema = prepareSchema.extend({
  operationId: operationFields.operationId,
  revisionId,
  publicationId: revisionId,
  runBytes: z.instanceof(Uint8Array),
});
export type PublishDatabaseReviewAttempt = PrepareDatabaseReviewAttempt & {
  operationId: string;
  revisionId: string;
  publicationId: string;
  runBytes: Uint8Array;
};
export async function publishDatabaseReviewAttempt(
  raw: PublishDatabaseReviewAttempt,
  options: ProjectOperationOptions = {}
) {
  options = { signal: options.signal, onWait: options.onWait };
  const input = validate(publishSchema, raw);
  const copied = prepareRequest({
    authority: input.authority,
    reviewId: input.reviewId,
    runId: input.runId,
    expected: input.expected,
    authored: input.authored,
    rawSubmissionBytes: input.rawSubmissionBytes,
    secretAllow: input.secretAllow,
  });
  const [record] = prepareReviewRecords({
    records: [{ kind: 'run', bytes: input.runBytes }],
    secretAllow: input.secretAllow,
  });
  const run = decodeRetainedReviewRecord({ kind: 'run', bytes: record!.bytes });
  let prepared: Awaited<ReturnType<typeof prepareAttemptWithDatabase>>;
  let descriptors: ProjectEvidenceFile[] = [];
  return performReviewOperation(
    {
      authority: input.authority,
      operation: {
        operationId: input.operationId,
        kind: 'review.run.attempt',
        target: { reviewId: input.reviewId, runId: input.runId },
        payload: {
          revisionId: input.revisionId,
          publicationId: input.publicationId,
          authored: json(input.authored),
          rawSubmissionBytes: copied.rawSubmissionBytes.toString('base64'),
          runBytes: run.bytes.toString('base64'),
        },
        expectedState: json(input.expected),
        intentChange: false,
      },
      async prepareReadOnly(database) {
        prepared = await prepareAttemptWithDatabase(database, copied, options);
        if (!isDeepStrictEqual(run.value, prepared.run))
          invalid(
            'The authored run revision differs from the exact prepared attempt; retain the original target and prepared record'
          );
      },
      async prepareEvidence(database) {
        descriptors = await publishProjectEvidence(
          database,
          {
            publicationId: input.publicationId,
            members: prepared.members,
            secretAllow: input.secretAllow,
          },
          { signal: options.signal }
        );
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
          floorPublicationId: prepared.floorPublicationId,
          membershipRevisionId: prepared.membershipRevisionId,
        });
        const floor = tx.get<{ floor_input_hash: string }>(
          'SELECT floor_input_hash FROM review_evidence_publications WHERE publication_id = ? AND review_id = ?',
          prepared.floorPublicationId,
          input.reviewId
        );
        if (!floor) stale('The exact retained floor is missing; preserve its identity for repair');
        tx.run(
          'INSERT INTO review_evidence_publications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)',
          input.publicationId,
          input.reviewId,
          'run-attempt',
          input.operationId,
          prepared.membershipRevisionId,
          prepared.floorPublicationId,
          floor.floor_input_hash,
          input.runId,
          input.revisionId,
          canonicalJson({ ordinal: run.value.attempts.length, lane: input.authored.lane })
        );
        for (let i = 0; i < prepared.members.length; i++) {
          const member = prepared.members[i]!;
          const descriptor = descriptors[i]!;
          tx.run(
            'INSERT INTO review_evidence_members VALUES (?, ?, ?, ?, ?, ?, ?)',
            input.publicationId,
            member.name,
            'run-attempt',
            member.schemaVersion,
            descriptor.relativePath,
            descriptor.sha256,
            descriptor.byteLength
          );
        }
        return {
          reviewId: input.reviewId,
          runId: input.runId,
          revisionId: input.revisionId,
          version: input.expected.version + 1,
          publicationId: input.publicationId,
          accepted: prepared.accepted,
        };
      },
    },
    options
  );
}

export function deriveRunAttempt(input: {
  run: TwolaneRunFile;
  authored: z.infer<typeof attemptAuthoredSchema>;
  raw: { bytes: Buffer; text: string };
  dossier: DossierV1;
  projection: AccountProjection;
}) {
  const { run, authored, raw } = input;
  if (run.finalized !== null)
    invalid('The run is finalized; prepare an explicitly new run before submitting');
  if (
    run.runtime_identity !== null &&
    run.runtime_identity.runtimeFingerprintSha256 !==
      authored.runtimeIdentity?.runtimeFingerprintSha256
  )
    invalid('Use the executable identity pinned by this run before submitting');
  const forensic = run.slice_state.lanes.forensic;
  if (authored.lane === 'account' && !forensic.accepted && forensic.outcome !== 'TERMINAL_REJECTED')
    invalid('Account submissions require a terminal forensic lane');
  const normalized = normalizeSubmission(raw.text);
  const ctx = sliceContext(input.dossier, input.projection, authored.lane);
  const normalizationCodes: RoutineNormalizationCode[] = [normalized.code];
  const result = submitLane(run.slice_state, authored.lane, normalized.value, ctx, {
    routine: true,
    normalized: normalized.code !== 'CLEAN_JSON',
  });
  const next: TwolaneRunFile = { ...run, slice_state: result.state, attempts: [...run.attempts] };
  const members: { name: string; bytes: Buffer; schemaVersion: number | null }[] = [
    { name: 'submission.txt', bytes: raw.bytes, schemaVersion: null },
    {
      name: 'normalized-submission.json',
      bytes: Buffer.from(submissionJson(normalized.value) + '\n'),
      schemaVersion: null,
    },
    {
      name: 'diagnostics.json',
      bytes: Buffer.from(
        JSON.stringify({ schema_version: 1, diagnostics: result.diagnostics }, null, 2) + '\n'
      ),
      schemaVersion: 1,
    },
  ];
  let compiledPayloadSha256: string | null = null;
  let acceptedEnvelopeSha256: string | null = null;
  if (result.accepted && result.payload !== null) {
    if (authored.lane === 'account') {
      const compiled = result.payload as AccountPayload;
      compiledPayloadSha256 = canonicalJsonSha256(compiled);
      const accepted = {
        schema_version: 1,
        normalization_code: normalized.code,
        normalization_codes: normalizationCodes,
        normalized_authored: normalized.value as AuthoredAccountPayload,
        compiled_payload: compiled,
        inner: {
          raw_submission_sha256: normalized.raw_sha256,
          normalized_authored_sha256: normalized.normalized_sha256,
          compiled_payload_sha256: compiledPayloadSha256,
          diagnostic_codes: result.state.lanes.account.diagnostics.map((item) => item.code),
        },
      };
      acceptedEnvelopeSha256 = canonicalJsonSha256(accepted);
      next.account_lineage = {
        ...accepted.inner,
        accepted_envelope_sha256: acceptedEnvelopeSha256,
        normalization_code: normalized.code,
        normalization_codes: normalizationCodes,
      };
      members.push(
        {
          name: 'compiled-account.json',
          bytes: Buffer.from(submissionJson(compiled) + '\n'),
          schemaVersion: null,
        },
        {
          name: 'accepted-account.json',
          bytes: Buffer.from(JSON.stringify(accepted, null, 2) + '\n'),
          schemaVersion: 1,
        }
      );
    } else
      members.push({
        name: 'accepted-forensic.json',
        bytes: Buffer.from(JSON.stringify(result.payload, null, 2) + '\n'),
        schemaVersion: null,
      });
  }
  next.attempts.push({
    lane: authored.lane,
    at: authored.at,
    accepted: result.accepted,
    is_repair: run.slice_state.lanes[authored.lane].attempts >= 1,
    declared_isolation: authored.isolation,
    diagnostic_codes: result.diagnostics.map((item) => item.code),
    normalization_code: normalized.code,
    normalization_codes: normalizationCodes,
    raw_submission_sha256: normalized.raw_sha256,
    normalized_submission_sha256: normalized.normalized_sha256,
    compiled_payload_sha256: compiledPayloadSha256,
    accepted_envelope_sha256: acceptedEnvelopeSha256,
    usage_tokens: authored.usageTokens,
    usage_source: authored.usageSource,
  });
  return {
    run: next,
    members,
    accepted: result.accepted,
    diagnostics: result.diagnostics,
    payload: result.payload,
  };
}
