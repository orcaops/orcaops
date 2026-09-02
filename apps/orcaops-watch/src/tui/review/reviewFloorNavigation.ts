import type { Floor } from '@orcaops/review-core';

import { filterFlatFiles } from './ReviewExperience';
import type { ReviewControllerState } from './readerReviewController';

/**
 * Resolve the selected Flat Files row to one retained parent hunk.
 *
 * `BriefTree.destinations` names the ReaderPage directly, so only Flat Files
 * resolves through a hunk key here. A cursor that named a floor THREAD instead
 * would have to guess a checkpoint from the thread's first hunk — and a hunk is
 * rendering context that checkpoints in different artifacts can share.
 */
export function floorHunkForActivation(input: {
  floor: Floor;
  state: ReviewControllerState;
}): string | null {
  const { floor, state } = input;
  if (state.screen !== 'flat-files') return null;
  // THE FILTERED list — the one the reviewer is looking at. Indexing the
  // unfiltered one means Enter opens a hunk that is not the highlighted row, and
  // the further down the list they are, the further off it lands.
  return filterFlatFiles(floor, state.fileFilter)[state.flatFileCursor]?.hunkKey ?? null;
}
