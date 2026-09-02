import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { atomicWriteFile } from '../artifacts/atomic-write.js';
import { sha256Hex } from '../crypto.js';
import { assertResolvedWithin } from '../paths/containment.js';
import { canonicalizeBaseUrl } from '../source-plan/canonical-base-url.js';

export const REVIEW_FEEDBACK_PULL_CACHE_SCHEMA_VERSION = 1;

/** One cached `orcaops review pull` per (base_url, org, pull_request_id) —
 *  latest-wins. `activity_cursor` is the pass token replies echo. */
export const ReviewFeedbackPullRecordSchema = z.object({
  schema_version: z.literal(REVIEW_FEEDBACK_PULL_CACHE_SCHEMA_VERSION),
  pull_request_id: z.string().min(1),
  task_number: z.number().int().positive().nullable(),
  /** subject.activity.last_human_activity_at at pull time; null = no human activity yet. */
  activity_cursor: z.string().min(1).nullable(),
  /** The raw wire transcript, serialized — re-renderable offline. */
  transcript_json: z.string().min(1),
  /** sha256 hex of transcript_json (re-verified on write). */
  content_hash: z.string().min(1),
  base_url: z.string().min(1),
  org_id: z.string().min(1),
  pulled_at: z.string().min(1),
});
export type ReviewFeedbackPullRecord = z.infer<typeof ReviewFeedbackPullRecordSchema>;

const SUBTREE = 'review-feedback';

function namespaceDir(cacheDir: string, baseUrl: string, orgId: string): string {
  return path.join(cacheDir, SUBTREE, sha256Hex(`${canonicalizeBaseUrl(baseUrl)}|${orgId}`));
}

function subjectPath(cacheDir: string, baseUrl: string, orgId: string, prId: string): string {
  return path.join(namespaceDir(cacheDir, baseUrl, orgId), 'by-subject', `${sha256Hex(prId)}.json`);
}

export async function writeReviewFeedbackPullRecord(
  cacheDir: string,
  record: ReviewFeedbackPullRecord,
  containmentRoot?: string
): Promise<{ recordPath: string }> {
  const parsed = ReviewFeedbackPullRecordSchema.parse(record);
  const actual = sha256Hex(parsed.transcript_json);
  if (actual !== parsed.content_hash) {
    throw new Error(
      `review-feedback pull-cache integrity: sha256(transcript_json)=${actual} != content_hash=${parsed.content_hash} for ${parsed.pull_request_id}`
    );
  }
  const file = subjectPath(cacheDir, parsed.base_url, parsed.org_id, parsed.pull_request_id);
  await atomicWriteFile(file, `${JSON.stringify(parsed, null, 2)}\n`, containmentRoot);
  return { recordPath: file };
}

export async function readReviewFeedbackPullRecord(
  cacheDir: string,
  baseUrl: string,
  orgId: string,
  pullRequestId: string,
  containmentRoot?: string
): Promise<ReviewFeedbackPullRecord | null> {
  const file = subjectPath(cacheDir, baseUrl, orgId, pullRequestId);
  const resolved =
    containmentRoot === undefined
      ? file
      : assertResolvedWithin(file, containmentRoot, 'review-feedback cache record', {
          rejectSymlinks: true,
        });
  let raw: string;
  try {
    raw = await readFile(resolved, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = ReviewFeedbackPullRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.pull_request_id === pullRequestId ? parsed.data : null;
  } catch {
    return null;
  }
}
