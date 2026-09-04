// The cockpit's `✎ n` badge input: count a branch's open review comments by
// replaying `.orcaops/reviews/<slug>/comments.ndjson` in the CHECKOUT the
// sidecar runs in. Review state is checkout-local (like the review surface
// itself), so archive-only projects read 0. Tolerant read: a missing file is
// zero, a malformed line is skipped — a badge must never break a tick.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type CommentEvent,
  commentEventSchema,
  openCommentCount,
  replayComments,
  slugifyBranch,
} from '@orcaops/review-core';

export async function countOpenReviewComments(repoRoot: string, branch: string): Promise<number> {
  const file = path.join(repoRoot, '.orcaops', 'reviews', slugifyBranch(branch), 'comments.ndjson');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return 0;
  }
  const events: CommentEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const result = commentEventSchema.safeParse(JSON.parse(trimmed));
      if (result.success) events.push(result.data);
    } catch {
      // skip — resilience over completeness for a badge count
    }
  }
  return openCommentCount(replayComments(events));
}
