import { createHash } from 'node:crypto';

/** Single source of truth — the persisted run schema's z.enum derives from it. */
export const SUBMISSION_NORMALIZATION_CODES = [
  'CLEAN_JSON',
  'JSON_STRING_UNWRAPPED',
  'INVALID_JSON',
] as const;
export type SubmissionNormalizationCode = (typeof SUBMISSION_NORMALIZATION_CODES)[number];

export interface NormalizedSubmission {
  value: unknown;
  code: SubmissionNormalizationCode;
  raw_sha256: string;
  normalized_sha256: string;
}

export const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, canonicalize(record[key])])
    );
  }
  return value;
};

/** Stable JSON bytes for persisted lineage hashes; object key order is irrelevant. */
export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));

export const canonicalJsonSha256 = (value: unknown): string => sha256(canonicalJson(value));

/**
 * Parse wire JSON and unwrap at most one JSON-string layer. Model tools
 * occasionally encode an otherwise-valid document as one JSON string; that is
 * mechanically recoverable without guessing at markdown, prose, or nested
 * wrappers. Invalid JSON remains the exact raw string so the normal strict
 * schema produces a shape diagnostic.
 */
export function normalizeSubmission(rawText: string): NormalizedSubmission {
  const raw_sha256 = sha256(rawText);
  let value: unknown;
  let code: SubmissionNormalizationCode = 'CLEAN_JSON';
  try {
    value = JSON.parse(rawText);
  } catch {
    value = rawText;
    code = 'INVALID_JSON';
    return { value, code, raw_sha256, normalized_sha256: canonicalJsonSha256(value) };
  }

  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
      code = 'JSON_STRING_UNWRAPPED';
    } catch {
      // A plain JSON string is valid wire JSON but not a lane document. Keep it
      // intact and let the strict lane schema diagnose the shape.
    }
  }
  return { value, code, raw_sha256, normalized_sha256: canonicalJsonSha256(value) };
}
