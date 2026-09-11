import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { type AccountProjection, type ForensicInput } from '../dossier.js';
import { validateSemanticAnchorSubmission } from '../semanticAnchorGenerations.js';
import {
  prepareSemanticAnchorInput,
  SEMANTIC_ANCHOR_INPUT_FILE,
  SEMANTIC_ANCHOR_PROFILE_V1,
  SEMANTIC_ANCHOR_RECEIPT_FILE,
  semanticAnchorStoryCatalogIssue,
} from '../semanticAnchors.js';
import { semanticSubmissionCatalog } from '../semanticSubmissionCatalog.js';
import { type CoverageInput } from '../storyOwnership.js';
import { parseStoryReviewModel, STORY_REVIEW_MODEL_FILE } from '../storyReviewModel.js';
import { canonicalJsonSha256 } from '../submissionNormalization.js';
import { decodeRetainedReviewRecord, prepareReviewText } from './records.js';
import {
  authoritySchema,
  cancelled,
  integrity,
  invalid,
  revisionId,
  scanMetadata,
  stale,
  text,
  validate,
} from './request.js';
import { readDatabaseReviewAttempts } from './run-attempt-read.js';
import { readDatabaseReviewFinalization } from './run-finalization-read.js';
import { runTargetSchema } from './run-progress.js';
import { prepareDatabaseSemanticSubmission } from './semantic-submission.js';

const requestSchema = z.strictObject({
  authority: authoritySchema,
  reviewId: revisionId,
  runId: text,
  generationId: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  expected: runTargetSchema,
  submissionBytes: z.instanceof(Uint8Array),
  secretAllow: z.array(z.string()),
});
export type PrepareDatabaseSemanticGeneration = z.infer<typeof requestSchema>;

export async function prepareDatabaseSemanticGeneration(
  raw: PrepareDatabaseSemanticGeneration,
  options: { signal?: AbortSignal } = {}
) {
  const signal = options.signal;
  const input = validate(requestSchema, raw);
  const submission = prepareDatabaseSemanticSubmission({
    bytes: input.submissionBytes,
    maximumBytes: SEMANTIC_ANCHOR_PROFILE_V1.maximum_submission_bytes,
    secretAllow: input.secretAllow,
  });
  scanMetadata({ ...input, submissionBytes: undefined }, input.secretAllow);
  cancelled(signal);
  const finalized = await readDatabaseReviewFinalization({
    authority: input.authority,
    reviewId: input.reviewId,
    runId: input.runId,
  });
  cancelled(signal);
  const terminal = finalized.value;
  if (!terminal) invalid('Semantic preparation requires a retained terminal run');
  if (
    terminal.revisionId !== input.expected.revisionId ||
    terminal.version !== input.expected.version ||
    terminal.selection.current_run_id !== input.runId ||
    terminal.selection.run_selection_version !== input.expected.runSelectionVersion
  )
    stale('The selected run changed; preserve the original semantic target');
  const semantic = terminal.publications.find((publication) => publication.kind === 'semantic');
  const story = terminal.publications.find((publication) => publication.kind === 'story');
  const receiptMember = semantic?.members.find(
    (member) => member.name === SEMANTIC_ANCHOR_RECEIPT_FILE
  );
  if (!receiptMember || !semantic || !story)
    invalid('This finalized run has no retained READY semantic input; it cannot be backfilled');
  const receipt = decodeRetainedReviewRecord({
    kind: 'semantic-input',
    bytes: receiptMember.bytes,
  }).value;
  if (receipt.status !== 'READY')
    invalid('Semantic preparation requires the original READY receipt');
  if (receipt.run_id !== input.runId || receipt.payload_file !== SEMANTIC_ANCHOR_INPUT_FILE)
    integrity('Retained semantic input has a different run or payload identity');
  if (submission.bytes.length > receipt.budget.maximum_submission_bytes)
    invalid('The semantic submission exceeds its retained profile byte ceiling');
  const proof = await readDatabaseReviewAttempts({
    authority: input.authority,
    reviewId: input.reviewId,
    runId: input.runId,
    revisionId: input.expected.revisionId,
  });
  cancelled(signal);
  const retained = proof.value;
  if (!retained) integrity('The finalized run input and attempt history is missing');
  if (
    retained.currentRevisionId !== input.expected.revisionId ||
    retained.currentVersion !== input.expected.version ||
    retained.selection.current_run_id !== input.runId ||
    retained.selection.run_selection_version !== input.expected.runSelectionVersion
  )
    stale('The selected run changed while reading original semantic inputs');
  if (!retained.runBytes.equals(terminal.runBytes))
    integrity('The semantic source readers disagree about the exact retained run revision');
  const modelMember = story.members.find((member) => member.name === STORY_REVIEW_MODEL_FILE);
  if (!modelMember) integrity('The exact retained semantic Story model is missing');
  const model = parseStoryReviewModel(
    decodeRetainedReviewRecord({ kind: 'story-model', bytes: modelMember.bytes }).value
  );
  const lineage = retained.run.account_lineage;
  const accepted = [...retained.attempts]
    .reverse()
    .find((attempt) => attempt.lane === 'account' && attempt.accepted);
  const envelopeMember = accepted?.members.find(
    (member) => member.name === 'accepted-account.json'
  );
  if (!lineage || !envelopeMember || !retained.accepted.account)
    integrity('The retained READY source has no exact accepted-account lineage');
  const envelope = JSON.parse(envelopeMember.bytes.toString()) as { compiled_payload: unknown };
  if (
    canonicalJsonSha256(envelope) !== lineage.accepted_envelope_sha256 ||
    canonicalJsonSha256(envelope.compiled_payload) !== lineage.compiled_payload_sha256 ||
    !isDeepStrictEqual(terminal.terminal.account_lineage, lineage)
  )
    integrity('The accepted semantic account bytes differ from the original terminal lineage');
  const memberText = (name: string) => {
    const member = retained.inputs.find((candidate) => candidate.name === name);
    if (!member) integrity('A required original semantic input member is missing');
    return member.bytes.toString('utf8');
  };
  const projection = retained.inputValues['account-projection-v1.json'] as AccountProjection;
  const prepared = prepareSemanticAnchorInput({
    runId: input.runId,
    storyModel: model,
    storyModelBytes: modelMember.text,
    accountProjection: projection,
    accountProjectionBytes: memberText('account-projection-v1.json'),
    coverage: retained.inputValues['coverage-v1.json'] as CoverageInput,
    coverageBytes: memberText('coverage-v1.json'),
    pinnedDiffText: memberText('diff.patch'),
    forensicInput: retained.inputValues['forensic-input-v1.json'] as ForensicInput,
    forensicInputBytes: memberText('forensic-input-v1.json'),
    accountLineage: {
      acceptedEnvelopeSha256: lineage.accepted_envelope_sha256,
      compiledPayloadSha256: lineage.compiled_payload_sha256,
    },
  });
  const payload = semantic.members.find((member) => member.name === SEMANTIC_ANCHOR_INPUT_FILE);
  if (
    !isDeepStrictEqual(prepared.receipt, receipt) ||
    !payload ||
    prepared.payload !== payload.text ||
    semanticAnchorStoryCatalogIssue(model, prepared.items) !== null
  )
    integrity(
      'The original semantic payload, catalog or receipt differs from its exact source records'
    );
  const catalog = semanticSubmissionCatalog(prepared);
  const validation = validateSemanticAnchorSubmission({
    raw: submission.normalized,
    generationId: input.generationId,
    runId: input.runId,
    floorInputHash: receipt.floor_input_hash!,
    preparedPayloadSha256: receipt.payload_sha256!,
    projection,
    catalog,
  });
  prepareReviewText({
    bytes: Buffer.from(JSON.stringify(validation)),
    secretAllow: input.secretAllow,
  });
  cancelled(signal);
  return {
    reviewId: input.reviewId,
    runId: input.runId,
    generationId: input.generationId,
    expected: input.expected,
    terminalOperationId: terminal.operationId,
    inputPublicationId: semantic.publicationId,
    storyPublicationId: story.publicationId,
    receipt,
    receiptSha256: receiptMember.sha256,
    catalog,
    submission,
    validation,
    counters: proof.counters,
  };
}
