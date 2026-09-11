import { commentEventSchema, openCommentCount, replayComments } from '@orcaops/review-core';
import type { ProjectReadView } from '@orcaops/storage/history/database';
import { digest } from '@orcaops/storage/history/primitives';

export interface ReviewCommentRows {
  reviews: Array<{ review_id: string; branch: string }>;
  heads: Array<{
    review_id: string;
    comment_id: string;
    current_revision_id: string;
    version: number;
  }>;
  revisions: Array<{
    review_id: string;
    comment_id: string;
    revision_id: string;
    version: number;
    record_hex: string;
    record_hash: string;
  }>;
}

/** Copy every registered review's comment chain inside the caller's read transaction. */
export function selectReviewComments(view: ProjectReadView): ReviewCommentRows {
  return {
    reviews: view.all('SELECT review_id, branch FROM reviews ORDER BY review_id'),
    heads: view.all(
      'SELECT review_id, comment_id, current_revision_id, version FROM review_comments ORDER BY review_id, comment_id'
    ),
    revisions: view.all(
      'SELECT review_id, comment_id, revision_id, version, hex(record_bytes) AS record_hex, record_hash FROM review_comment_revisions ORDER BY review_id, comment_id, version'
    ),
  };
}

/**
 * Open comments per branch across explicitly registered reviews. Every retained
 * revision must match its hash, its selection head and its persisted schema;
 * any deviation throws so the badge reports unknown rather than a partial count.
 */
export function countOpenReviewComments(rows: ReviewCommentRows): Map<string, number> {
  const byReview = new Map<string, ReviewCommentRows['revisions']>();
  for (const revision of rows.revisions) {
    const group = byReview.get(revision.review_id) ?? [];
    group.push(revision);
    byReview.set(revision.review_id, group);
  }
  const heads = new Map(
    rows.heads.map((head) => [`${head.review_id}\u0000${head.comment_id}`, head])
  );
  const byBranch = new Map<string, number>();
  for (const review of rows.reviews) {
    const events = [];
    const revisions = byReview.get(review.review_id) ?? [];
    const seen = new Map<string, number>();
    for (const revision of revisions) {
      const head = heads.get(`${review.review_id}\u0000${revision.comment_id}`);
      if (!head) throw integrity('Retained comment revisions have no current selection');
      const bytes = Buffer.from(revision.record_hex, 'hex');
      if (digest(bytes) !== revision.record_hash)
        throw integrity('Retained comment bytes differ from their recorded hash');
      const expected = (seen.get(revision.comment_id) ?? 0) + 1;
      if (revision.version !== expected)
        throw integrity('Retained comment revision chain is not contiguous');
      seen.set(revision.comment_id, expected);
      if (revision.version === head.version && revision.revision_id !== head.current_revision_id)
        throw integrity('Retained comment head differs from its selected revision');
      const event = commentEventSchema.parse(JSON.parse(bytes.toString('utf8')));
      if (event.comment_id !== revision.comment_id)
        throw integrity('Retained comment event names another comment');
      events.push(event);
    }
    for (const head of rows.heads)
      if (head.review_id === review.review_id && seen.get(head.comment_id) !== head.version)
        throw integrity('A selected comment revision is missing from its retained chain');
    byBranch.set(
      review.branch,
      (byBranch.get(review.branch) ?? 0) + openCommentCount(replayComments(events))
    );
  }
  return byBranch;
}

function integrity(message: string): Error & { code: string } {
  return Object.assign(new Error(`${message}; preserve history for explicit repair`), {
    code: 'HISTORY_INTEGRITY_REQUIRED',
  });
}
