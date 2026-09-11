import path from 'node:path';
import type { z } from 'zod';

import {
  sourcePlanUploadExternalId,
  sourcePlanUploadFingerprint,
  type SourcePlanUploadPayload,
} from '@orcaops/storage/history/database/source-plan-upload';

export interface ReviewerSuggestion {
  tag: string;
  matches: Array<{ handle: string; name: string }>;
}

export interface UploadFingerprintInput {
  body: string;
  title: string;
  reviewers: string[];
  review_note: string | null;
  source_ref: string | null;
  derived_from: SourcePlanUploadPayload['derived_from'];
}

export function computeUploadFingerprint(input: UploadFingerprintInput): string {
  return sourcePlanUploadFingerprint(input);
}

export function computeUploadExternalId(fileRealpath: string, fingerprint: string): string {
  return sourcePlanUploadExternalId(fileRealpath, fingerprint);
}

export function formatUploadInputIssues(error: z.ZodError): string {
  const { formErrors, fieldErrors } = error.flatten();
  const byField = fieldErrors as Record<string, string[] | undefined>;
  const fieldParts = Object.entries(byField).map(
    ([field, messages]) => `${field}: ${(messages ?? []).join(', ')}`
  );
  return `invalid plan upload input — ${[...formErrors, ...fieldParts].join('; ')}`;
}

export function displaySafeSourceRef(absPath: string, repoRoot: string): string | null {
  const relative = path.relative(repoRoot, absPath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  return null;
}

export function suggestReviewers(
  unresolved: string[],
  members: Array<{ handle: string; name: string }>
): ReviewerSuggestion[] {
  const suggestions: ReviewerSuggestion[] = [];
  for (const tag of unresolved) {
    const needle = tag.replace(/^@/, '').trim().toLowerCase();
    if (needle.length === 0) continue;
    const matches = members
      .filter((member) => {
        const handle = member.handle.toLowerCase();
        const name = member.name.toLowerCase();
        return handle.includes(needle) || name.includes(needle) || needle.includes(handle);
      })
      .slice(0, 5)
      .map((member) => ({ handle: member.handle, name: member.name }));
    if (matches.length > 0) suggestions.push({ tag, matches });
  }
  return suggestions;
}
