import { type Floor } from '@orcaops/review-core';

import { type ReviewArtifact } from '../model.js';
import { readDatabaseReviewArtifacts } from './floor-preparation.js';
import { readDatabaseReviewContext } from './read-context.js';
import { invalid, withReviewDatabase } from './request.js';

export interface CanonicalReviewSource {
  authority: Awaited<ReturnType<typeof readDatabaseReviewContext>>['authority'];
  reviewId: string;
  floor: Floor;
  diffText: string;
  floorInputHash: string;
  artifacts: ReviewArtifact[];
}

/**
 * The review's selected floor, its diff and the artifacts it was derived from,
 * read together.
 *
 * The claim ledger and the dossier both restate what the floor covers, so they
 * read the same retained membership the floor was built from rather than a
 * second artifact source that could disagree with it.
 */
export async function readCanonicalReviewSource(
  branch: string,
  options: { cwd: string; projectId?: string; dataRoot?: string }
): Promise<CanonicalReviewSource> {
  const context = await readDatabaseReviewContext({
    branch,
    cwd: options.cwd,
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
  });
  if (context.floor === null) invalid(`no selected floor for '${branch}'; run review data first`);
  const artifacts = await withReviewDatabase(context.authority, 'reader', (database) =>
    readDatabaseReviewArtifacts(database, context.membership.members)
  );
  return {
    authority: context.authority,
    reviewId: context.reviewId,
    floor: context.floor.floor as Floor,
    diffText: Buffer.from(context.floor.diffBytes).toString('utf8'),
    floorInputHash: context.floor.floor.input_hash,
    artifacts,
  };
}
