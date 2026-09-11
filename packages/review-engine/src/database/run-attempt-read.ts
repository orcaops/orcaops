import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import {
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectEvidenceFile,
  readProjectEvidence,
} from '@orcaops/storage/history/database';

import { type AccountProjection, type DossierV1 } from '../dossier.js';
import { type AccountPayload, type ForensicPayload } from '../twolaneSlice.js';
import {
  decodeRetainedReviewJson,
  decodeRetainedReviewRecord,
  decodeRetainedReviewText,
} from './records.js';
import {
  authoritySchema,
  integrity,
  revisionId,
  text,
  validate,
  withReviewDatabase,
} from './request.js';
import { attemptAuthoredSchema, deriveRunAttempt } from './run-attempts.js';
import { runTargetSchema } from './run-progress.js';
import { hydrateReviewRun, type ReadDatabaseReviewRun, snapshotReviewRun } from './run-read.js';

const requestSchema = z.strictObject({
  authority: authoritySchema,
  reviewId: revisionId,
  runId: text.optional(),
  revisionId: revisionId.optional(),
});
const payloadSchema = z.strictObject({
  revisionId,
  publicationId: revisionId,
  authored: attemptAuthoredSchema,
  rawSubmissionBytes: z.base64(),
  runBytes: z.base64(),
});
const metadataSchema = z.strictObject({
  ordinal: z.number().int().positive(),
  lane: z.enum(['account', 'forensic']),
});
export async function readDatabaseReviewAttempts(raw: ReadDatabaseReviewRun) {
  const input = validate(requestSchema, raw);
  return withReviewDatabase(input.authority, 'reader', (database) =>
    readAttemptsWithDatabase(database, input)
  );
}
export async function readAttemptsWithDatabase(
  database: ProjectDatabase,
  input: ReadDatabaseReviewRun
) {
  const snapshot = database.read((view) => {
    const run = snapshotReviewRun(view, input);
    if (!run) return null;
    const rows = view.all<{
      revision_id: string;
      previous_revision_id: string;
      version: number;
      record_hex: string;
      record_hash: string;
      publication_id: string;
      record_json: string;
      floor_publication_id: string;
      membership_revision_id: string;
      previous_hex: string;
      previous_hash: string;
      previous_version: number;
      operation_kind: string;
      target_json: string;
      payload_json: string;
      expected_state_json: string;
    }>(
      `SELECT r.revision_id, r.previous_revision_id, r.version, hex(r.record_bytes) AS record_hex, r.record_hash, p.publication_id, p.record_json, p.floor_publication_id, p.membership_revision_id, hex(prior.record_bytes) AS previous_hex, prior.record_hash AS previous_hash, prior.version AS previous_version, o.operation_kind, o.target_json, o.payload_json, o.expected_state_json
 FROM review_run_revisions r JOIN review_evidence_publications p ON p.run_revision_id = r.revision_id AND p.run_id = r.run_id AND p.review_id = r.review_id AND p.kind = 'run-attempt'
 JOIN review_run_revisions prior ON prior.revision_id = r.previous_revision_id AND prior.run_id = r.run_id
 JOIN operations o ON o.operation_id = r.operation_id AND p.operation_id = r.operation_id
 WHERE r.review_id = ? AND r.run_id = ? AND r.version <= ? ORDER BY r.version`,
      input.reviewId,
      run.runId,
      run.revision.version
    );
    return {
      run,
      rows: rows.map((row) => ({
        ...row,
        descriptors: view.all<
          ProjectEvidenceFile & { name: string; kind: string; schema_version: number | null }
        >(
          'SELECT name, kind, schema_version, relative_path AS relativePath, sha256, byte_length AS byteLength FROM review_evidence_members WHERE publication_id = ? ORDER BY name',
          row.publication_id
        ),
      })),
    };
  });
  if (!snapshot.value) return { value: null, counters: snapshot.counters };
  const read = await hydrateReviewRun(database, {
    value: snapshot.value.run,
    counters: snapshot.counters,
  });
  if (!read.value) integrity('The retained run snapshot is incomplete');
  const retained = read.value;
  const rows = snapshot.value.rows;
  if (rows.length !== retained.run.attempts.length)
    integrity(
      'The exact retained run attempt publications are incomplete; preserve history for explicit repair'
    );
  const accepted: { account: AccountPayload | null; forensic: ForensicPayload | null } = {
    account: null,
    forensic: null,
  };
  const attempts: {
    revisionId: string;
    publicationId: string;
    version: number;
    lane: 'account' | 'forensic';
    accepted: boolean;
    members: { name: string; bytes: Buffer }[];
  }[] = [];
  for (let ordinal = 0; ordinal < rows.length; ordinal++) {
    const row = rows[ordinal]!;
    const metadata = decodeRetainedReviewJson(metadataSchema, Buffer.from(row.record_json)).value;
    const payload = decodeRetainedReviewJson(payloadSchema, Buffer.from(row.payload_json)).value;
    const target = decodeRetainedReviewJson(
      z.strictObject({ reviewId: revisionId, runId: text }),
      Buffer.from(row.target_json)
    ).value;
    const expected = decodeRetainedReviewJson(
      runTargetSchema,
      Buffer.from(row.expected_state_json)
    ).value;
    const previous = decodeRetainedReviewRecord({
      kind: 'run',
      bytes: Buffer.from(row.previous_hex, 'hex'),
    });
    const current = decodeRetainedReviewRecord({
      kind: 'run',
      bytes: Buffer.from(row.record_hex, 'hex'),
    });
    if (
      row.operation_kind !== 'review.run.attempt' ||
      target.reviewId !== input.reviewId ||
      target.runId !== retained.runId ||
      payload.revisionId !== row.revision_id ||
      payload.publicationId !== row.publication_id ||
      metadata.ordinal !== ordinal + 1 ||
      metadata.lane !== payload.authored.lane ||
      row.floor_publication_id !== retained.floorPublicationId ||
      row.membership_revision_id !== retained.membershipRevisionId ||
      previous.sha256 !== row.previous_hash ||
      current.sha256 !== row.record_hash ||
      previous.value.run_id !== retained.runId ||
      current.value.run_id !== retained.runId ||
      expected.revisionId !== row.previous_revision_id ||
      expected.version !== row.previous_version ||
      row.version !== row.previous_version + 1 ||
      !Buffer.from(payload.runBytes, 'base64').equals(current.bytes) ||
      !isDeepStrictEqual(current.value.attempts, retained.run.attempts.slice(0, ordinal + 1))
    )
      integrity(
        'The retained attempt differs from its original operation or exact run revision; preserve history for explicit repair'
      );
    const descriptors = row.descriptors;
    const members = [];
    for (const descriptor of descriptors)
      members.push({ ...descriptor, bytes: await readProjectEvidence(database, descriptor) });
    const raw = members.find((member) => member.name === 'submission.txt');
    if (!raw || !raw.bytes.equals(Buffer.from(payload.rawSubmissionBytes, 'base64')))
      integrity(
        'The original raw submission is missing or differs from its operation; preserve history for explicit repair'
      );
    let derived: ReturnType<typeof deriveRunAttempt>;
    try {
      derived = deriveRunAttempt({
        run: previous.value,
        authored: payload.authored,
        raw: decodeRetainedReviewText(raw.bytes),
        dossier: retained.inputValues['dossier-v1.json'] as DossierV1,
        projection: retained.inputValues['account-projection-v1.json'] as AccountProjection,
      });
    } catch (cause) {
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'The retained attempt no longer validates against its original input contract; preserve original evidence for explicit repair',
        { cause }
      );
    }
    if (!isDeepStrictEqual(derived.run, current.value) || members.length !== derived.members.length)
      integrity(
        'Retained attempt state or evidence differs from its exact normalized input; preserve history for explicit repair'
      );
    for (const expected of derived.members) {
      const actual = members.find((member) => member.name === expected.name);
      if (
        !actual ||
        actual.kind !== 'run-attempt' ||
        actual.schema_version !== expected.schemaVersion ||
        !actual.bytes.equals(expected.bytes)
      )
        integrity(
          'Retained normalized, diagnostic or accepted bytes differ from their original attempt; preserve history for explicit repair'
        );
    }
    if (derived.accepted) {
      if (payload.authored.lane === 'account') accepted.account = derived.payload as AccountPayload;
      else accepted.forensic = derived.payload as ForensicPayload;
    }
    attempts.push({
      revisionId: row.revision_id,
      publicationId: row.publication_id,
      version: row.version,
      lane: payload.authored.lane,
      accepted: derived.accepted,
      members: members.map(({ name, bytes }) => ({ name, bytes })),
    });
  }
  if (
    (accepted.account !== null) !== retained.run.slice_state.lanes.account.accepted ||
    (accepted.forensic !== null) !== retained.run.slice_state.lanes.forensic.accepted
  )
    integrity(
      'Accepted lane state has no matching retained attempt evidence; preserve history for explicit repair'
    );
  return { value: { ...retained, attempts, accepted }, counters: read.counters };
}
