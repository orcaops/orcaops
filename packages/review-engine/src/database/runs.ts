import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { canonicalJson } from '@orcaops/storage';
import {
  type ProjectEvidenceFile,
  type ProjectOperationOptions,
  publishProjectEvidence,
} from '@orcaops/storage/history/database';

import { latencyProfileFor } from '../twolaneRunMetadata.js';
import { freshSliceRunState } from '../twolaneSlice.js';
import { requireFloorSelection } from './floor-preparation.js';
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
import {
  prepareRunInputMembers,
  prepareRunInputsWithDatabase,
  requirePreparedRunInputs,
  type RunInputMember,
  runInputNames,
  runInputPolicySchema,
  runInputSelectionSchema,
} from './run-inputs.js';

const startSchema = z.strictObject({
  ...operationFields,
  reviewId: revisionId,
  revisionId,
  publicationId: revisionId,
  runBytes: z.instanceof(Uint8Array),
  inputs: z.array(z.strictObject({ name: z.enum(runInputNames), bytes: z.instanceof(Uint8Array) })),
  policy: runInputPolicySchema,
  expected: runInputSelectionSchema.extend({
    currentRunId: text.nullable(),
    runSelectionVersion: version,
  }),
});
export type StartDatabaseReviewRun = Omit<z.infer<typeof startSchema>, 'runBytes' | 'inputs'> & {
  runBytes: Uint8Array;
  inputs: RunInputMember[];
};
export async function startDatabaseReviewRun(
  raw: StartDatabaseReviewRun,
  options: ProjectOperationOptions = {}
) {
  options = { signal: options.signal, onWait: options.onWait };
  const input = validate(startSchema, raw);
  const [record] = prepareReviewRecords({
    records: [{ kind: 'run', bytes: input.runBytes }],
    secretAllow: input.secretAllow,
  });
  const run = decodeRetainedReviewRecord({ kind: 'run', bytes: record!.bytes });
  const inputs = prepareRunInputMembers(input.inputs, input.secretAllow);
  scanMetadata(
    { authority: input.authority, expected: input.expected, policy: input.policy },
    input.secretAllow
  );
  if (
    !z.iso.datetime().safeParse(run.value.created_at).success ||
    !isDeepStrictEqual(run.value.slice_state, freshSliceRunState()) ||
    Object.keys(run.value.lane_inputs_served).length !== 0 ||
    run.value.attempts.length !== 0 ||
    run.value.account_lineage !== null ||
    run.value.finalized !== null ||
    !isDeepStrictEqual(run.value.input_shas, inputs.inputShas)
  )
    invalid('A new run must retain fresh lane state and the exact original pinned input hashes');
  const forensicMember = inputs.members.find((member) => member.name === 'forensic-input-v1.json')!;
  const forensic = decodeRetainedReviewRecord({
    kind: 'forensic-input',
    bytes: forensicMember.bytes,
  }).value;
  if (
    run.value.latency_input_bytes !== Buffer.byteLength(forensic.diff, 'utf8') ||
    run.value.latency_input_bytes !== forensic.metrics.eligibleDiffBytes
  )
    invalid('Run latency input bytes must match the exact eligible forensic diff');
  try {
    latencyProfileFor(run.value.latency_input_bytes);
  } catch {
    invalid('Run forensic input exceeds the routine latency ceiling');
  }
  const dossierMember = inputs.members.find((member) => member.name === 'dossier-v1.json')!;
  const dossier = decodeRetainedReviewRecord({ kind: 'dossier', bytes: dossierMember.bytes }).value;
  if (run.value.branch !== dossier.branch) invalid('The run must retain its pinned dossier branch');
  let descriptors: ProjectEvidenceFile[] = [];
  return performReviewOperation(
    {
      authority: input.authority,
      operation: {
        operationId: input.operationId,
        kind: 'review.run.start',
        target: { reviewId: input.reviewId, runId: run.value.run_id },
        payload: {
          revisionId: input.revisionId,
          publicationId: input.publicationId,
          runBytes: run.bytes.toString('base64'),
          inputs: inputs.members.map((member) => ({
            name: member.name,
            bytes: member.bytes.toString('base64'),
          })),
          policy: json(input.policy),
        },
        expectedState: json(input.expected),
        intentChange: false,
      },
      async prepareReadOnly(database) {
        database.read((view) => {
          const current = selection(view, input.reviewId);
          if (
            current.current_run_id !== input.expected.currentRunId ||
            current.run_selection_version !== input.expected.runSelectionVersion
          )
            stale(
              'The current review run changed; start an explicitly new operation for the intended run'
            );
          return null;
        });
        const prepared = await prepareRunInputsWithDatabase(
          database,
          {
            authority: input.authority,
            reviewId: input.reviewId,
            expected: input.expected,
            policy: input.policy,
            generatedAt: dossier.generated_at,
            secretAllow: input.secretAllow,
          },
          { signal: options.signal }
        );
        if (prepared.branch !== run.value.branch)
          invalid('The run must retain its exact review branch');
        requirePreparedRunInputs(inputs, prepared);
      },
      async prepareEvidence(database) {
        descriptors = await publishProjectEvidence(
          database,
          {
            publicationId: input.publicationId,
            members: inputs.members,
            secretAllow: input.secretAllow,
          },
          { signal: options.signal }
        );
      },
      settle(tx) {
        requireFloorSelection(tx, input.reviewId, input.expected);
        const current = selection(tx, input.reviewId);
        if (
          current.floor_publication_id !== input.expected.floorPublicationId ||
          current.current_run_id !== input.expected.currentRunId ||
          current.run_selection_version !== input.expected.runSelectionVersion
        )
          stale(
            'The selected floor or current run changed; preserve this operation target and prepare a new operation'
          );
        if (tx.get('SELECT run_id FROM review_runs WHERE run_id = ?', run.value.run_id))
          stale(
            'This run identity already exists; replay its original operation or use an explicitly new run identity'
          );
        tx.run(
          'INSERT INTO review_runs VALUES (?, ?, ?, 1)',
          run.value.run_id,
          input.reviewId,
          input.revisionId
        );
        tx.run(
          'INSERT INTO review_run_revisions VALUES (?, ?, ?, NULL, 1, ?, ?, ?, ?, ?)',
          input.revisionId,
          input.reviewId,
          run.value.run_id,
          input.operationId,
          run.bytes,
          run.sha256,
          input.expected.floorPublicationId,
          input.expected.membershipRevisionId
        );
        tx.run(
          'INSERT INTO review_evidence_publications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)',
          input.publicationId,
          input.reviewId,
          'run-input',
          input.operationId,
          input.expected.membershipRevisionId,
          input.expected.floorPublicationId,
          dossier.floor_input_hash,
          run.value.run_id,
          input.revisionId,
          canonicalJson({ inputShas: inputs.inputShas })
        );
        for (let index = 0; index < inputs.members.length; index += 1) {
          const member = inputs.members[index]!;
          const descriptor = descriptors[index]!;
          const value = inputs.values[member.name] as { schema_version?: number };
          tx.run(
            'INSERT INTO review_evidence_members VALUES (?, ?, ?, ?, ?, ?, ?)',
            input.publicationId,
            member.name,
            'run-input',
            member.name === 'diff.patch' ? null : value.schema_version!,
            descriptor.relativePath,
            descriptor.sha256,
            descriptor.byteLength
          );
        }
        tx.run(
          'UPDATE review_selections SET current_run_id = ?, run_selection_version = run_selection_version + 1 WHERE review_id = ?',
          run.value.run_id,
          input.reviewId
        );
        return {
          reviewId: input.reviewId,
          runId: run.value.run_id,
          revisionId: input.revisionId,
          version: 1,
          publicationId: input.publicationId,
          runSelectionVersion: current.run_selection_version + 1,
        };
      },
    },
    options
  );
}
