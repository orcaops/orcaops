import { uuidv7 } from '@orcaops/storage';

import { type fixture } from './database-history.js';
import { createDatabaseReview } from '../../../../packages/review-engine/dist/database/reviews.js';

export async function createReview(
  project: Awaited<ReturnType<typeof fixture>>,
  branch: string | null
): Promise<string> {
  const reviewId = uuidv7(),
    operationId = uuidv7();
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
  await createDatabaseReview({
    authority: project.authority,
    operationId,
    secretAllow: [],
    identityBytes: bytes({
      schema_version: 1,
      review_id: reviewId,
      project_id: project.authority.projectId,
      store_instance_id: project.authority.storeInstanceId,
      repository_instance_id: project.authority.repositoryInstanceId,
      created_by_operation: operationId,
      initial_context: { worktree_id: null, branch, base_sha: null, head_sha: null },
      artifact_ids: [],
      legacy_source_ids: [],
    }),
    membershipBytes: bytes({ revisionId: uuidv7(), members: [], source: null }),
  });
  return reviewId;
}
