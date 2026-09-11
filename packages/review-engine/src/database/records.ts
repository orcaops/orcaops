import { createHash } from 'node:crypto';
import { z } from 'zod';

import { commentEventSchema, floorSchema, journalEventSchema } from '@orcaops/review-core';
import { assertNoSecretsInPayload, SecretInPayloadError } from '@orcaops/storage';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { accountProjectionSchema, dossierV1Schema, forensicInputSchema } from '../dossier.js';
import { ProjectReviewIdentitySchema } from '../projectReviewIdentity.js';
import {
  semanticAnchorAttemptSchema,
  semanticAnchorManifestSchema,
  semanticAnchorModelSchema,
  semanticAnchorResolvedTargetSchema,
  semanticAnchorSubmissionSchema,
} from '../semanticAnchorGenerations.js';
import { semanticAnchorInputReceiptSchema } from '../semanticAnchors.js';
import { storyReviewModelSchema } from '../storyReviewModel.js';
import { twolaneRunFileSchema } from '../twolaneRunFile.js';

export const reviewRecordSchemas = {
  identity: ProjectReviewIdentitySchema,
  floor: floorSchema,
  run: twolaneRunFileSchema,
  'story-model': storyReviewModelSchema,
  dossier: dossierV1Schema,
  'account-projection': accountProjectionSchema,
  'forensic-input': forensicInputSchema,
  comment: commentEventSchema,
  workflow: journalEventSchema,
  'semantic-input': semanticAnchorInputReceiptSchema,
  'semantic-submission': semanticAnchorSubmissionSchema,
  'semantic-attempt': semanticAnchorAttemptSchema,
  'semantic-model': semanticAnchorModelSchema,
  'semantic-target': semanticAnchorResolvedTargetSchema,
  'semantic-manifest': semanticAnchorManifestSchema,
} as const;
export type ReviewRecordKind = keyof typeof reviewRecordSchemas;
export type ReviewRecordValue<K extends ReviewRecordKind> = z.infer<
  (typeof reviewRecordSchemas)[K]
>;
export interface ReviewRecordInput<K extends ReviewRecordKind = ReviewRecordKind> {
  readonly kind: K;
  readonly bytes: Uint8Array;
}
export interface PreparedReviewRecord<K extends ReviewRecordKind = ReviewRecordKind> {
  readonly kind: K;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly value: ReviewRecordValue<K>;
}

function invalid(message: string): never {
  throw new ProjectDatabaseError('INVALID_INPUT', message);
}
function copyUtf8(input: Uint8Array): { bytes: Buffer; text: string } {
  if (!(input instanceof Uint8Array)) invalid('Provide exact UTF-8 review record bytes');
  const bytes = Buffer.from(input);
  try {
    // Preserve a BOM so JSON parsing cannot silently accept different source bytes.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { bytes, text };
  } catch (cause) {
    throw new ProjectDatabaseError('INVALID_INPUT', 'Review records must be valid UTF-8', {
      cause,
    });
  }
}
function copy(input: ReviewRecordInput): { kind: ReviewRecordKind; bytes: Buffer; text: string } {
  if (!input || typeof input.kind !== 'string' || !Object.hasOwn(reviewRecordSchemas, input.kind))
    invalid('Provide a supported review record kind and exact UTF-8 bytes');
  return { kind: input.kind, ...copyUtf8(input.bytes) };
}
function refuse(text: string, allow: readonly string[]): void {
  try {
    assertNoSecretsInPayload(text, allow);
    for (const match of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)) {
      let value: unknown;
      try {
        value = JSON.parse(match[0]);
      } catch {
        continue;
      }
      assertNoSecretsInPayload(value, allow);
    }
  } catch (cause) {
    if (!(cause instanceof SecretInPayloadError)) throw cause;
    throw new ProjectDatabaseError(
      'SECRET_IN_PAYLOAD',
      'Remove or redescribe refused review content before a new attempt',
      { cause }
    );
  }
}
function parse<K extends ReviewRecordKind>(input: {
  kind: K;
  bytes: Buffer;
  text: string;
}): PreparedReviewRecord<K> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(input.text);
  } catch {
    invalid('Review record bytes must contain exactly one valid JSON value');
  }
  const result = reviewRecordSchemas[input.kind].safeParse(decoded);
  if (!result.success)
    invalid(`Review ${input.kind} record violates its complete persisted content schema`);
  return {
    kind: input.kind,
    bytes: input.bytes,
    sha256: createHash('sha256').update(input.bytes).digest('hex'),
    value: result.data as ReviewRecordValue<K>,
  };
}

export function prepareReviewRecords(input: {
  readonly records: readonly ReviewRecordInput[];
  readonly secretAllow: readonly string[];
}): PreparedReviewRecord[] {
  if (
    !input ||
    !Array.isArray(input.records) ||
    input.records.length === 0 ||
    !Array.isArray(input.secretAllow)
  )
    invalid('Provide a nonempty review record batch and explicit secret allowlist');
  const allow = Array.from(input.secretAllow);
  if (!allow.every((value) => typeof value === 'string'))
    invalid('Review secret allowlist entries must be strings');
  const copies = Array.from(input.records, copy);
  for (const item of copies) refuse(item.text, allow);
  return copies.map(parse);
}

export function decodeRetainedReviewRecord<K extends ReviewRecordKind>(
  input: ReviewRecordInput<K>
): PreparedReviewRecord<K> {
  try {
    return parse({ ...copy(input), kind: input.kind });
  } catch (cause) {
    if (!(cause instanceof ProjectDatabaseError)) throw cause;
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Retained review content is invalid; preserve the original bytes for explicit repair',
      { cause }
    );
  }
}

export interface PreparedReviewJson<T> {
  bytes: Buffer;
  sha256: string;
  value: T;
}
function parseJson<T>(
  schema: z.ZodType<T>,
  input: { bytes: Buffer; text: string }
): PreparedReviewJson<T> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(input.text);
  } catch {
    invalid('Review record bytes must contain exactly one valid JSON value');
  }
  const result = schema.safeParse(decoded);
  if (!result.success) invalid('Review record violates its complete persisted content schema');
  return {
    bytes: input.bytes,
    sha256: createHash('sha256').update(input.bytes).digest('hex'),
    value: result.data,
  };
}
export function prepareReviewText(input: { bytes: Uint8Array; secretAllow: readonly string[] }): {
  bytes: Buffer;
  text: string;
} {
  if (!Array.isArray(input.secretAllow)) invalid('Provide an explicit review secret allowlist');
  const allow = Array.from(input.secretAllow);
  if (!allow.every((value) => typeof value === 'string'))
    invalid('Review secret allowlist entries must be strings');
  const copy = copyUtf8(input.bytes);
  refuse(copy.text, allow);
  return copy;
}
export function prepareReviewJson<T>(
  schema: z.ZodType<T>,
  input: { bytes: Uint8Array; secretAllow: readonly string[] }
): PreparedReviewJson<T> {
  return parseJson(schema, prepareReviewText(input));
}
export function decodeRetainedReviewJson<T>(
  schema: z.ZodType<T>,
  bytes: Uint8Array
): PreparedReviewJson<T> {
  try {
    return parseJson(schema, copyUtf8(bytes));
  } catch (cause) {
    if (!(cause instanceof ProjectDatabaseError)) throw cause;
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Retained review record is invalid; preserve original bytes for explicit repair',
      { cause }
    );
  }
}

export function decodeRetainedReviewText(bytes: Uint8Array): { bytes: Buffer; text: string } {
  try {
    return copyUtf8(bytes);
  } catch (cause) {
    if (!(cause instanceof ProjectDatabaseError)) throw cause;
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Retained review text is invalid; preserve original bytes for explicit repair',
      { cause }
    );
  }
}
