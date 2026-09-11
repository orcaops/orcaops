import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import {
  type ProjectCounters,
  type ProjectDatabase,
  type ProjectEvidenceFile,
  type ProjectReadView,
  readProjectEvidence,
} from '@orcaops/storage/history/database';

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
import { selection } from './reviews.js';
import {
  runCoverageSchema,
  runInputKeys,
  type RunInputName,
  runInputNames,
  sha16,
} from './run-inputs.js';

const requestSchema = z.strictObject({
  authority: authoritySchema,
  reviewId: revisionId,
  runId: text.optional(),
  revisionId: revisionId.optional(),
});
export type ReadDatabaseReviewRun = z.infer<typeof requestSchema>;
export async function readDatabaseReviewRun(raw: ReadDatabaseReviewRun) {
  const input = validate(requestSchema, raw);
  return withReviewDatabase(input.authority, 'reader', (database) =>
    readRunWithDatabase(database, input)
  );
}
export async function readRunWithDatabase(database: ProjectDatabase, input: ReadDatabaseReviewRun) {
  return hydrateReviewRun(
    database,
    database.read((view) => snapshotReviewRun(view, input))
  );
}
export function snapshotReviewRun(view: ProjectReadView, input: ReadDatabaseReviewRun) {
  const current = selection(view, input.reviewId);
  const runId = input.runId ?? current.current_run_id;
  if (runId === null) {
    if (input.revisionId) integrity('An exact run revision needs its retained run identity');
    return null;
  }
  const header = view.get<{ current_revision_id: string; version: number }>(
    'SELECT current_revision_id, version FROM review_runs WHERE run_id = ? AND review_id = ?',
    runId,
    input.reviewId
  );
  if (!header)
    integrity('The expected retained run is missing; preserve history for explicit repair');
  const id = input.revisionId ?? header.current_revision_id;
  const revision = view.get<{
    revision_id: string;
    version: number;
    record_hex: string;
    record_hash: string;
    floor_publication_id: string;
    membership_revision_id: string;
  }>(
    'SELECT revision_id, version, hex(record_bytes) AS record_hex, record_hash, floor_publication_id, membership_revision_id FROM review_run_revisions WHERE revision_id = ? AND run_id = ? AND review_id = ?',
    id,
    runId,
    input.reviewId
  );
  if (!revision || (!input.revisionId && revision.version !== header.version))
    integrity(
      'The expected run revision is missing or inconsistent; preserve history for explicit repair'
    );
  const publication = view.get<{
    publication_id: string;
    run_revision_id: string;
    floor_input_hash: string;
    floor_publication_id: string;
    membership_revision_id: string;
    metadata_json: string;
  }>(
    "SELECT publication_id, run_revision_id, floor_input_hash, floor_publication_id, membership_revision_id, record_json AS metadata_json FROM review_evidence_publications WHERE review_id = ? AND run_id = ? AND kind = 'run-input'",
    input.reviewId,
    runId
  );
  if (
    !publication ||
    publication.floor_publication_id !== revision.floor_publication_id ||
    publication.membership_revision_id !== revision.membership_revision_id
  )
    integrity(
      'The original pinned run input association is missing or inconsistent; preserve history for explicit repair'
    );
  const initial = view.get<{ version: number; record_hex: string; record_hash: string }>(
    'SELECT version, hex(record_bytes) AS record_hex, record_hash FROM review_run_revisions WHERE revision_id = ? AND run_id = ? AND review_id = ?',
    publication.run_revision_id,
    runId,
    input.reviewId
  );
  if (!initial || initial.version !== 1)
    integrity('The original run input revision is missing; preserve history for explicit repair');
  const members = view.all<
    ProjectEvidenceFile & { name: string; kind: string; schema_version: number | null }
  >(
    'SELECT name, kind, schema_version, relative_path AS relativePath, sha256, byte_length AS byteLength FROM review_evidence_members WHERE publication_id = ? ORDER BY name',
    publication.publication_id
  );
  return {
    runId,
    revision,
    publication,
    initial,
    members,
    selection: current,
    currentRevisionId: header.current_revision_id,
    currentVersion: header.version,
  };
}
export async function hydrateReviewRun(
  database: ProjectDatabase,
  snapshot: { value: ReturnType<typeof snapshotReviewRun>; counters: ProjectCounters }
) {
  if (!snapshot.value) return { value: null, counters: snapshot.counters };
  const selected = snapshot.value;
  const run = decodeRetainedReviewRecord({
    kind: 'run',
    bytes: Buffer.from(selected.revision.record_hex, 'hex'),
  });
  const original = decodeRetainedReviewRecord({
    kind: 'run',
    bytes: Buffer.from(selected.initial.record_hex, 'hex'),
  });
  if (
    run.sha256 !== selected.revision.record_hash ||
    original.sha256 !== selected.initial.record_hash ||
    run.value.run_id !== selected.runId ||
    original.value.run_id !== selected.runId
  )
    integrity(
      'Retained run bytes differ from their exact row identity; preserve history for explicit repair'
    );
  const values: Record<string, unknown> = {};
  const inputShas: Record<string, string> = {};
  const members: { name: RunInputName; bytes: Buffer }[] = [];
  for (const member of selected.members) {
    if (member.kind !== 'run-input' || !runInputNames.includes(member.name as RunInputName))
      integrity(
        'The original run input contains an unknown member; preserve history for explicit repair'
      );
    const name = member.name as RunInputName;
    const bytes = await readProjectEvidence(database, member);
    inputShas[runInputKeys[name]] = sha16(bytes);
    let value: unknown;
    switch (name) {
      case 'dossier-v1.json':
        value = decodeRetainedReviewRecord({ kind: 'dossier', bytes }).value;
        break;
      case 'account-projection-v1.json':
        value = decodeRetainedReviewRecord({ kind: 'account-projection', bytes }).value;
        break;
      case 'forensic-input-v1.json':
        value = decodeRetainedReviewRecord({ kind: 'forensic-input', bytes }).value;
        break;
      case 'coverage-v1.json':
        value = decodeRetainedReviewJson(runCoverageSchema, bytes).value;
        break;
      case 'diff.patch':
        value = decodeRetainedReviewText(bytes).text;
        break;
    }
    if (
      name === 'diff.patch'
        ? member.schema_version !== null
        : (value as { schema_version: number }).schema_version !== member.schema_version
    )
      integrity(
        'Retained run member schema differs from its recorded descriptor; preserve history for explicit repair'
      );
    values[name] = value;
    members.push({ name, bytes });
  }
  for (const required of runInputNames.slice(0, 3))
    if (!members.some((member) => member.name === required))
      integrity('A required original run input is missing; preserve history for explicit repair');
  if (
    !isDeepStrictEqual(inputShas, run.value.input_shas) ||
    !isDeepStrictEqual(inputShas, original.value.input_shas)
  )
    integrity(
      'Pinned run input hashes differ from original revision bytes; preserve history for explicit repair'
    );
  const metadata = decodeRetainedReviewJson(
    z.strictObject({ inputShas: z.record(z.string(), z.string()) }),
    Buffer.from(selected.publication.metadata_json)
  ).value;
  const dossier = values['dossier-v1.json'] as { branch: string; floor_input_hash: string };
  if (
    !isDeepStrictEqual(metadata.inputShas, inputShas) ||
    dossier.branch !== run.value.branch ||
    dossier.branch !== original.value.branch ||
    dossier.floor_input_hash !== selected.publication.floor_input_hash
  )
    integrity(
      'Pinned input publication differs from its retained run basis; preserve history for explicit repair'
    );
  return {
    value: {
      runId: selected.runId,
      currentRevisionId: selected.currentRevisionId,
      currentVersion: selected.currentVersion,
      revisionId: selected.revision.revision_id,
      version: selected.revision.version,
      run: run.value,
      runBytes: run.bytes,
      runHash: run.sha256,
      floorPublicationId: selected.revision.floor_publication_id,
      membershipRevisionId: selected.revision.membership_revision_id,
      inputPublicationId: selected.publication.publication_id,
      inputs: members,
      inputValues: values,
      selection: selected.selection,
    },
    counters: snapshot.counters,
  };
}
