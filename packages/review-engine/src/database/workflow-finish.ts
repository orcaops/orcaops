import {
  CITATION_KIND,
  type CommentRecord,
  type CurrentThreadManifest,
  evaluateFloorOnlyFinishGate,
  evaluateStoryFinishGate,
  FINDING_STATE,
  findingState,
  type Floor,
  type FloorOnlyFinishGateInput,
  type JournalEvent,
  openReviewerCommentCount,
  PROMPT_STATE,
  replayReviewLedgerV2,
  type ReviewedRow,
  UNCERTAINTY_STATE,
  uncertaintyState,
} from '@orcaops/review-core';

import {
  buildCurrentGapRows,
  buildCurrentThreadManifests,
  buildEligibleNarrativeTargets,
} from '../reviewTargets.js';
import { type ReviewRecordValue } from './records.js';

export async function evaluateWorkflowFinish(input: {
  floor: Floor;
  diffText: string;
  events: readonly JournalEvent[];
  story: ReviewRecordValue<'story-model'> | null;
  comments: readonly CommentRecord[];
}) {
  let targets: FloorOnlyFinishGateInput['targets'] = { ok: true };
  let currentThreads: CurrentThreadManifest[] = input.floor.outline.threads.map((thread) => ({
    threadKey: thread.threadKey,
    rows: null,
    digest: null,
  }));
  let currentGapRows: ReviewedRow[] = [];
  try {
    const eligible = await buildEligibleNarrativeTargets(input.floor, input.diffText);
    currentThreads = await buildCurrentThreadManifests(input.floor, eligible);
    currentGapRows = await buildCurrentGapRows(input.floor, input.diffText);
  } catch {
    targets = { ok: false, reason: 'Retained review obligations could not be reconstructed' };
  }
  const ledger = await replayReviewLedgerV2({ events: input.events, currentThreads });
  const floorGate = evaluateFloorOnlyFinishGate({
    targets,
    currentThreads,
    coverage: ledger.coverage,
    currentGapRows,
    inspectedGapRows: ledger.unassigned.gapRows,
    currentAmbiguousHunkKeys: input.floor.outline.unassigned.ambiguous.hunkKeys,
    inspectedAmbiguousHunkKeys: ledger.unassigned.ambiguousHunkKeys,
    openReviewerComments: openReviewerCommentCount(input.comments),
    openUncertaintyCitationIds: input.floor.citations
      .filter((citation) => citation.kind === CITATION_KIND.CHECKPOINT_UNCERTAINTY)
      .map((citation) => citation.id)
      .filter((id) => uncertaintyState(ledger, id) === UNCERTAINTY_STATE.OPEN),
  });
  if (!input.story) return floorGate;
  const openRequiredStoryItems =
    input.story.findings.filter(
      (finding) => finding.required && findingState(ledger, finding.id) === FINDING_STATE.OPEN
    ).length +
    input.story.questions.filter(
      (question) =>
        question.required &&
        (ledger.prompts.find((entry) => entry.promptKey === question.id)?.state ??
          PROMPT_STATE.OPEN) === PROMPT_STATE.OPEN
    ).length;
  return evaluateStoryFinishGate({ floor: floorGate, openRequiredStoryItems });
}
