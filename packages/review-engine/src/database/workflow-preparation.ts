import { z } from 'zod';

import { CITATION_KIND, type JournalEvent, matchReviewedRows } from '@orcaops/review-core';
import { type ProjectDatabase, type ProjectReadView } from '@orcaops/storage/history/database';

import { buildCurrentGapRows } from '../reviewTargets.js';
import { STORY_REVIEW_MODEL_FILE } from '../storyReviewModel.js';
import { readDatabaseReviewFloor } from './floors.js';
import { decodeRetainedReviewRecord, decodeRetainedReviewText } from './records.js';
import { cancelled, integrity, invalid, revisionId, stale, version } from './request.js';
import { selection } from './reviews.js';
import { readDatabaseReviewFinalization } from './run-finalization-read.js';
import { workflowBasisSchema } from './workflow-read.js';

export const workflowSelectionSchema = z.strictObject({
  floor: z.strictObject({ publicationId: revisionId, version }),
  story: z.strictObject({ publicationId: revisionId.nullable(), version }).optional(),
});
export function requireWorkflowSelection(
  view: ProjectReadView,
  reviewId: string,
  expected: z.infer<typeof workflowSelectionSchema>
) {
  const current = selection(view, reviewId);
  if (
    current.floor_publication_id !== expected.floor.publicationId ||
    current.floor_version !== expected.floor.version ||
    (expected.story !== undefined &&
      (current.story_publication_id !== expected.story.publicationId ||
        current.story_version !== expected.story.version))
  )
    stale(
      'The authored workflow floor or Story selection changed; preserve its target and prepare a new operation'
    );
}

export async function prepareWorkflowTargets(
  database: ProjectDatabase,
  input: {
    authority: Parameters<typeof readDatabaseReviewFloor>[0]['authority'];
    reviewId: string;
    expected: z.infer<typeof workflowSelectionSchema>;
    events: readonly JournalEvent[];
  },
  signal?: AbortSignal
) {
  cancelled(signal);
  const snapshot = database.read((view) => {
    requireWorkflowSelection(view, input.reviewId, input.expected);
    if (!input.expected.story?.publicationId) return null;
    const row = view.get<{
      run_id: string;
      run_revision_id: string;
      floor_publication_id: string;
      generation: string;
    }>(
      "SELECT run_id, run_revision_id, floor_publication_id, generation FROM review_evidence_publications WHERE review_id = ? AND publication_id = ? AND kind = 'story'",
      input.reviewId,
      input.expected.story.publicationId
    );
    if (!row)
      integrity(
        'The selected Story publication is missing; preserve its history for explicit repair'
      );
    return row;
  });
  const retained = await readDatabaseReviewFloor({
    authority: input.authority,
    reviewId: input.reviewId,
    publicationId: input.expected.floor.publicationId,
  });
  if (!retained.value)
    integrity('The selected workflow floor is missing; restore its retained evidence');
  const floor = retained.value.floor;
  const basis: z.infer<typeof workflowBasisSchema> = {
    floor: { ...input.expected.floor, inputHash: floor.input_hash },
  };
  let story: ReturnType<typeof decodeRetainedReviewRecord<'story-model'>>['value'] | null = null;
  if (input.expected.story) basis.story = { ...input.expected.story, generation: null };
  if (snapshot.value) {
    const selected = snapshot.value;
    const terminal = await readDatabaseReviewFinalization({
      authority: input.authority,
      reviewId: input.reviewId,
      runId: selected.run_id,
    });
    const publication = terminal.value?.publications.find(
      (publication) => publication.publicationId === input.expected.story!.publicationId
    );
    if (
      !publication ||
      terminal.value?.revisionId !== selected.run_revision_id ||
      publication.generation !== selected.generation
    )
      integrity('The selected Story differs from its original sealed run publication');
    const member = publication.members.find((member) => member.name === STORY_REVIEW_MODEL_FILE);
    if (!member) integrity('The selected Story model is missing; restore its retained evidence');
    const model = decodeRetainedReviewRecord({ kind: 'story-model', bytes: member.bytes }).value;
    // Re-publishing identical floor inputs does not stale an existing Story.
    if (model.floor_input_hash === floor.input_hash) {
      story = model;
      basis.story!.generation = selected.generation;
    }
  }
  cancelled(signal);
  let gapRows: Awaited<ReturnType<typeof buildCurrentGapRows>> | undefined;
  for (const event of input.events) {
    if (
      event.type === 'section' &&
      !floor.outline.threads.some((thread) => thread.threadKey === event.threadKey)
    )
      invalid('The workflow section is absent from its exact selected floor');
    if (
      event.type === 'uncertainty' &&
      !floor.citations.some(
        (citation) =>
          citation.id === event.citationId && citation.kind === CITATION_KIND.CHECKPOINT_UNCERTAINTY
      )
    )
      invalid('The workflow uncertainty is absent from its exact selected floor');
    if (
      event.type === 'finding' &&
      !story?.findings.some((finding) => finding.id === event.findingKey)
    )
      invalid(
        'The finding is absent from the exact current Story; select its original review target'
      );
    if (
      event.type === 'prompt' &&
      !story?.questions.some((question) => question.id === event.promptKey)
    )
      invalid(
        'The question is absent from the exact current Story; select its original review target'
      );
    if (event.type === 'unassigned') {
      const target = event.target;
      if (target.kind === 'AMBIGUOUS_HUNK') {
        if (!floor.outline.unassigned.ambiguous.hunkKeys.includes(target.hunkKey))
          invalid('The inspected ambiguity is absent from its exact selected floor');
      } else {
        if (!gapRows)
          gapRows = await buildCurrentGapRows(
            floor,
            decodeRetainedReviewText(retained.value.diffBytes).text
          );
        if (matchReviewedRows(target.coveredRows, gapRows).removedRows !== 0)
          invalid('The inspected gap rows are absent from their exact selected floor');
      }
    }
    cancelled(signal);
  }
  return { basis, floor, diffBytes: retained.value.diffBytes, story };
}
