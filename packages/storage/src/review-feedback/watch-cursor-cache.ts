import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { atomicWriteFile } from '../artifacts/atomic-write.js';
import { sha256Hex } from '../crypto.js';
import { assertResolvedWithin } from '../paths/containment.js';
import { canonicalizeBaseUrl } from '../source-plan/canonical-base-url.js';

const WatchCursorRecordSchema = z.object({
  schema_version: z.literal(1),
  pull_request_id: z.string().min(1),
  /** Newest last_human_activity_at this machine has ACTED on. */
  last_seen_human_activity_at: z.string().min(1),
  base_url: z.string().min(1),
  org_id: z.string().min(1),
  updated_at: z.string().min(1),
});

function cursorPath(cacheDir: string, baseUrl: string, orgId: string, prId: string): string {
  const ns = sha256Hex(`${canonicalizeBaseUrl(baseUrl)}|${orgId}`);
  return path.join(cacheDir, 'review-feedback', ns, 'watch-cursor', `${sha256Hex(prId)}.json`);
}

export async function readReviewFeedbackWatchCursor(
  cacheDir: string,
  baseUrl: string,
  orgId: string,
  pullRequestId: string,
  containmentRoot?: string
): Promise<string | null> {
  const file = cursorPath(cacheDir, baseUrl, orgId, pullRequestId);
  const resolved =
    containmentRoot === undefined
      ? file
      : assertResolvedWithin(file, containmentRoot, 'review-feedback cursor record', {
          rejectSymlinks: true,
        });
  let raw: string;
  try {
    raw = await readFile(resolved, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = WatchCursorRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.pull_request_id === pullRequestId
      ? parsed.data.last_seen_human_activity_at
      : null;
  } catch {
    return null;
  }
}

export async function writeReviewFeedbackWatchCursor(
  cacheDir: string,
  args: { baseUrl: string; orgId: string; pullRequestId: string; lastSeenHumanActivityAt: string },
  containmentRoot?: string
): Promise<void> {
  const record = WatchCursorRecordSchema.parse({
    schema_version: 1,
    pull_request_id: args.pullRequestId,
    last_seen_human_activity_at: args.lastSeenHumanActivityAt,
    base_url: args.baseUrl,
    org_id: args.orgId,
    updated_at: new Date().toISOString(),
  });
  await atomicWriteFile(
    cursorPath(cacheDir, args.baseUrl, args.orgId, args.pullRequestId),
    `${JSON.stringify(record, null, 2)}\n`,
    containmentRoot
  );
}
