import { createHash } from 'node:crypto';
import { z } from 'zod';

import { executableIdentitySchema } from '@orcaops/review-core';
import { SecretInPayloadError } from '@orcaops/storage';
import { HistoryError } from '@orcaops/storage/history/authority';
import { type ProjectDatabase, ProjectDatabaseError } from '@orcaops/storage/history/database';

import { type AccountProjection, type DossierV1, type ForensicInput } from '../dossier.js';
import {
  prepareSemanticAnchorInput,
  type SemanticAnchorPreparation,
  unavailableSemanticAnchorPreparation,
} from '../semanticAnchors.js';
import { type CoverageInput } from '../storyOwnership.js';
import {
  projectStoryReviewModel,
  serializeStoryReviewModelForInstall,
  STORY_REVIEW_MODEL_FILE,
  storyReviewGeneration,
} from '../storyReviewModel.js';
import { ownershipSummaryFromComposed } from '../twolaneRunMetadata.js';
import { composeStory, renderSlice } from '../twolaneSlice.js';
import { prepareReviewRecords, prepareReviewText } from './records.js';
import {
  authoritySchema,
  cancelled,
  invalid,
  revisionId,
  scanMetadata,
  stale,
  text,
  validate,
  version,
  withReviewDatabase,
} from './request.js';
import { readAttemptsWithDatabase } from './run-attempt-read.js';
import { runTargetSchema } from './run-progress.js';
import { buildTerminalRecord, type TerminalRecord } from './terminal-record.js';

export const finalizationTargetSchema = runTargetSchema.extend({
  floorPublicationId: revisionId,
  membershipRevisionId: revisionId,
  storyVersion: version,
});
const requestSchema = z.strictObject({
  authority: authoritySchema,
  reviewId: revisionId,
  runId: text,
  expected: finalizationTargetSchema,
  finalizedAt: z.iso.datetime(),
  runtimeIdentity: executableIdentitySchema.nullable(),
  secretAllow: z.array(z.string()),
});
export type PrepareDatabaseReviewFinalization = z.infer<typeof requestSchema>;
export async function prepareDatabaseReviewFinalization(
  raw: PrepareDatabaseReviewFinalization,
  options: { signal?: AbortSignal } = {}
) {
  options = { signal: options.signal };
  const input = validate(requestSchema, raw);
  scanMetadata(input, input.secretAllow);
  cancelled(options.signal);
  return withReviewDatabase(input.authority, 'reader', (database) =>
    prepareFinalizationWithDatabase(database, input, options)
  );
}
export async function prepareFinalizationWithDatabase(
  database: ProjectDatabase,
  input: PrepareDatabaseReviewFinalization,
  options: { signal?: AbortSignal }
) {
  options = { signal: options.signal };
  const proof = await readAttemptsWithDatabase(database, {
    authority: input.authority,
    reviewId: input.reviewId,
    runId: input.runId,
    revisionId: input.expected.revisionId,
  });
  if (!proof.value) stale('The intended run is missing; preserve its original identity');
  const retained = proof.value;
  const current = retained.selection;
  if (
    current.current_run_id !== input.runId ||
    current.run_selection_version !== input.expected.runSelectionVersion ||
    retained.currentRevisionId !== input.expected.revisionId ||
    retained.currentVersion !== input.expected.version ||
    retained.floorPublicationId !== input.expected.floorPublicationId ||
    retained.membershipRevisionId !== input.expected.membershipRevisionId ||
    current.floor_publication_id !== input.expected.floorPublicationId ||
    current.membership_revision_id !== input.expected.membershipRevisionId ||
    current.story_version !== input.expected.storyVersion
  )
    stale(
      'The run, reviewed scope or current Story changed; retain the intended target and prepare an explicitly new finalization'
    );
  const run = retained.run;
  if (run.finalized !== null)
    invalid(
      'This run is already sealed; read its retained terminal result or replay its original operation'
    );
  if (
    run.runtime_identity !== null &&
    run.runtime_identity.runtimeFingerprintSha256 !==
      input.runtimeIdentity?.runtimeFingerprintSha256
  )
    invalid('Use the executable identity pinned by this run before finalizing');
  const { account, forensic } = retained.accepted;
  const outcome = account && forensic ? 'FULL' : account || forensic ? 'DEGRADED' : 'FAILED';
  let semanticPreparation: SemanticAnchorPreparation = prepareSemanticAnchorInput({
    runId: run.run_id,
    storyModel: null,
    storyModelBytes: null,
    accountProjection: null,
    accountProjectionBytes: null,
    coverage: null,
    coverageBytes: null,
    pinnedDiffText: null,
    forensicInput: null,
    forensicInputBytes: null,
    accountLineage: null,
  });
  let rangeValidation: TerminalRecord['range_validation'] = 'NOT_APPLICABLE';
  let ownershipSummary: TerminalRecord['ownership_summary'] = null;
  let outputs: TerminalRecord['outputs'] = null;
  let generation: string | null = null;
  const requiredMembers: { name: string; bytes: Buffer; schemaVersion: number | null }[] = [];
  if (outcome !== 'FAILED') {
    const dossier = retained.inputValues['dossier-v1.json'] as DossierV1;
    const projection = retained.inputValues['account-projection-v1.json'] as AccountProjection;
    const forensicInput = retained.inputValues['forensic-input-v1.json'] as ForensicInput;
    const coverageValue = retained.inputValues['coverage-v1.json'] as CoverageInput | undefined;
    const coverage = coverageValue
      ? { items: coverageValue.items, summary: coverageValue.summary }
      : null;
    const diff = retained.inputValues['diff.patch'] as string | undefined;
    const composed = composeStory({ account, forensic, projection, dossier, coverage });
    ownershipSummary = ownershipSummaryFromComposed(composed);
    const rendered = renderSlice({
      dossier,
      projection,
      merge: composed.merge,
      composed,
      accountPresent: account !== null,
      forensicPresent: forensic !== null,
      policyStubs: forensicInput.policyStubs,
    });
    const model = projectStoryReviewModel(composed, projection);
    const modelText = serializeStoryReviewModelForInstall({
      model,
      ...(diff === undefined ? {} : { diffText: diff }),
    });
    const [validated] = prepareReviewRecords({
      records: [{ kind: 'story-model', bytes: Buffer.from(modelText) }],
      secretAllow: input.secretAllow,
    });
    generation = await storyReviewGeneration(model);
    rangeValidation = diff === undefined ? 'SKIPPED_NO_PINNED_DIFF' : 'PERFORMED';
    const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
    requiredMembers.push(
      { name: 'review.md', bytes: Buffer.from(rendered.markdown), schemaVersion: null },
      { name: 'brief.json', bytes: jsonBytes(rendered.brief), schemaVersion: null },
      {
        name: 'composed-story-v2.json',
        bytes: jsonBytes(composed),
        schemaVersion: composed.schema_version,
      },
      {
        name: STORY_REVIEW_MODEL_FILE,
        bytes: validated!.bytes,
        schemaVersion: model.schema_version,
      }
    );
    outputs = {
      review_md: 'review.md',
      brief_json: 'brief.json',
      composed_story: 'composed-story-v2.json',
      story_review_model: STORY_REVIEW_MODEL_FILE,
      story_review_model_sha256: createHash('sha256').update(modelText).digest('hex'),
      ownership_label: composed.ownership.label,
    };
    const retainedText = (name: string) =>
      retained.inputs.find((member) => member.name === name)?.bytes.toString('utf8') ?? null;
    const semanticInput = {
      runId: run.run_id,
      storyModel: model,
      storyModelBytes: modelText,
      accountProjection: projection,
      accountProjectionBytes: retainedText('account-projection-v1.json'),
      coverage,
      coverageBytes: retainedText('coverage-v1.json'),
      pinnedDiffText: diff ?? null,
      forensicInput,
      forensicInputBytes: retainedText('forensic-input-v1.json'),
      accountLineage:
        run.account_lineage === null
          ? null
          : {
              acceptedEnvelopeSha256: run.account_lineage.accepted_envelope_sha256,
              compiledPayloadSha256: run.account_lineage.compiled_payload_sha256,
            },
    };
    try {
      semanticPreparation = prepareSemanticAnchorInput(semanticInput);
    } catch (cause) {
      cancelled(options.signal);
      if (
        cause instanceof ProjectDatabaseError ||
        cause instanceof HistoryError ||
        cause instanceof SecretInPayloadError
      )
        throw cause;
      if (cause instanceof Error && cause.name === 'AbortError')
        throw new ProjectDatabaseError(
          'CANCELLED',
          'Review preparation was cancelled; retain the original operation identity',
          { cause }
        );
      semanticPreparation = unavailableSemanticAnchorPreparation(
        run.run_id,
        'PREPARATION_FAILED',
        'Optional semantic preparation could not be produced from the retained inputs',
        semanticInput
      );
    }
  }
  for (const member of requiredMembers)
    prepareReviewText({ bytes: member.bytes, secretAllow: input.secretAllow });
  if (semanticPreparation.payload !== null)
    prepareReviewText({
      bytes: Buffer.from(semanticPreparation.payload),
      secretAllow: input.secretAllow,
    });
  prepareReviewText({
    bytes: Buffer.from(JSON.stringify(semanticPreparation.receipt)),
    secretAllow: input.secretAllow,
  });
  cancelled(options.signal);
  const terminalInputs = {
    run,
    finalizedAt: input.finalizedAt,
    rangeValidation,
    ownershipSummary,
    outputs,
  };
  const preview = buildTerminalRecord({
    ...terminalInputs,
    semanticInput: { ...semanticPreparation.receipt, receipt_file: null },
  });
  const [finalRun] = prepareReviewRecords({
    records: [
      {
        kind: 'run',
        bytes: Buffer.from(
          JSON.stringify({ ...run, finalized: { at: input.finalizedAt, outcome } }, null, 2) + '\n'
        ),
      },
    ],
    secretAllow: input.secretAllow,
  });
  return {
    runBytes: finalRun!.bytes,
    terminalInputs,
    terminalPreview: preview,
    requiredMembers,
    semanticPreparation,
    generation,
    outcome,
    floorPublicationId: retained.floorPublicationId,
    membershipRevisionId: retained.membershipRevisionId,
    counters: proof.counters,
  };
}
