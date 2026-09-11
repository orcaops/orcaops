import { HistoryScopeError } from '@orcaops/project-scope/history/database';
import { type ProjectReadView } from '@orcaops/storage/history/database';

import { assertReviewIdentityInventory } from './reviews.js';

export function selectDatabaseReview(
  view: ProjectReadView,
  input: { reviewId?: string; branch?: string },
  projectId: string
) {
  if (input.reviewId !== undefined) return input.reviewId;
  assertReviewIdentityInventory(view);
  const candidates = view.all<{ review_id: string }>(
    'SELECT review_id FROM reviews WHERE branch = ? ORDER BY review_id LIMIT 3',
    input.branch!
  );
  if (candidates.length > 1)
    throw new HistoryScopeError(
      'REVIEW_SELECTION_REQUIRED',
      'Several reviews match this branch; select the exact review and project',
      {
        candidates: candidates.slice(0, 2).map((row) => ({
          project_id: projectId,
          review_id: row.review_id,
          command: `orcaops review state health --project ${projectId} --review ${row.review_id} --json`,
        })),
        truncated: candidates.length > 2,
      }
    );
  if (!candidates[0])
    throw new HistoryScopeError(
      'REVIEW_NOT_FOUND',
      'No retained review matches this branch; select an existing exact review'
    );
  return candidates[0].review_id;
}
