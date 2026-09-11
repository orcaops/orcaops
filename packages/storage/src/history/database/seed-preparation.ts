import { z } from 'zod';

import { canonicalJson } from '../../events/canonical-json.js';
import { isUuidV7 } from '../../ids/uuidv7.js';
import { assertNoSecretsInPayload, SecretInPayloadError } from '../../text/secret-guard.js';
import { digest } from '../event-integrity.js';
import { refuseJsonBytes } from './authored-bytes.js';
import { ProjectDatabaseError } from './errors.js';

export interface SeedRevision {
  revisionId: string;
  generation: number;
  contentHash: string;
}
export interface SeedSource {
  readonly sourceId: string;
  readonly sourceIdentity: string;
  readonly sourceLocation: string;
  readonly sourceRevisionId?: string;
  readonly sourceOperationId?: string;
  readonly sourceSha256?: string;
  readonly bytes: Uint8Array;
}
export interface SeedPreparationInput {
  readonly operationId: string;
  readonly revisionId: string;
  readonly expectedRevision: SeedRevision | null;
}
export interface SeedAuthoredInput {
  readonly secretAllow: readonly string[];
}
export interface SeedHistoricalInput {
  readonly sourceManifestIdentity: string;
}
export interface SeedSourceRecord {
  sourceId: string;
  sourceIdentity: string;
  sourceLocation: string;
  sourceRevisionId: string | null;
  sourceOperationId: string | null;
  sourceSha256: string | null;
  bytes: string;
  recordHash: string;
}
export type SeedPreparationMode = 'authored' | 'historical';
export interface SeedPreparationContext {
  mode: SeedPreparationMode;
  operationId: string;
  revisionId: string;
  expectedRevision: SeedRevision | null;
  sourceManifestIdentity: string | null;
  secretAllow: string[];
}
export function invalidSeed(message: string): never {
  throw new ProjectDatabaseError('INVALID_INPUT', message);
}
export function copySeedRevision(value: SeedRevision): SeedRevision {
  if (!value || typeof value !== 'object') invalidSeed('Select an exact seed revision');
  const copy = {
    revisionId: value.revisionId,
    generation: value.generation,
    contentHash: value.contentHash,
  };
  if (
    !isUuidV7(copy.revisionId) ||
    !Number.isSafeInteger(copy.generation) ||
    copy.generation < 1 ||
    !/^[0-9a-f]{64}$/.test(copy.contentHash)
  )
    invalidSeed('Select an exact seed revision with a safe generation and content hash');
  return copy;
}
export function seedPreparationContext(
  input: SeedPreparationInput & Partial<SeedAuthoredInput & SeedHistoricalInput>,
  mode: SeedPreparationMode
): SeedPreparationContext {
  if (!input || typeof input !== 'object') invalidSeed('Provide a typed seed preparation');
  const operationId = input.operationId;
  const revisionId = input.revisionId;
  const originalRevision = input.expectedRevision;
  const expectedRevision = originalRevision === null ? null : copySeedRevision(originalRevision);
  if (!isUuidV7(operationId) || !isUuidV7(revisionId))
    invalidSeed('Provide original operation and new seed revision UUIDv7 identities');
  const secretAllow = mode === 'authored' ? input.secretAllow : [];
  if (!Array.isArray(secretAllow) || secretAllow.some((value) => typeof value !== 'string'))
    invalidSeed('Provide the explicit established secret allowlist for authored seed content');
  const sourceManifestIdentity = mode === 'historical' ? input.sourceManifestIdentity : null;
  if (mode === 'historical' && !validText(sourceManifestIdentity))
    invalidSeed('Retain the original verified source manifest identity');
  return {
    mode,
    operationId,
    revisionId,
    expectedRevision,
    sourceManifestIdentity: sourceManifestIdentity ?? null,
    secretAllow: [...secretAllow],
  };
}
function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}
export function seedSourceRecord(input: SeedSource): SeedSourceRecord {
  if (!input || typeof input !== 'object') invalidSeed('Provide complete original seed sources');
  const copy = {
    sourceId: input.sourceId,
    sourceIdentity: input.sourceIdentity,
    sourceLocation: input.sourceLocation,
    sourceRevisionId: input.sourceRevisionId ?? null,
    sourceOperationId: input.sourceOperationId ?? null,
    sourceSha256: input.sourceSha256 ?? null,
  };
  const originalBytes = input.bytes;
  if (
    !isUuidV7(copy.sourceId) ||
    !validText(copy.sourceIdentity) ||
    !validText(copy.sourceLocation) ||
    (copy.sourceRevisionId !== null && !validText(copy.sourceRevisionId)) ||
    (copy.sourceOperationId !== null && !validText(copy.sourceOperationId)) ||
    (copy.sourceSha256 !== null && !/^[0-9a-f]{64}$/.test(copy.sourceSha256)) ||
    !(originalBytes instanceof Uint8Array)
  )
    invalidSeed(
      'Preserve exact seed source identity, location, bytes and optional original hashes'
    );
  const bytes = Buffer.from(originalBytes);
  const recordHash = digest(bytes);
  if (copy.sourceSha256 !== null && copy.sourceSha256 !== recordHash)
    invalidSeed('Original seed source bytes must agree with the supplied source hash');
  return { ...copy, bytes: bytes.toString('base64'), recordHash };
}
export function seedSourceText(record: SeedSourceRecord): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(record.bytes, 'base64'));
  } catch (cause) {
    throw new ProjectDatabaseError('INVALID_INPUT', 'Provide complete UTF-8 seed source bytes', {
      cause,
    });
  }
}
export function decodeSeedSource<T>(
  record: SeedSourceRecord,
  schema: z.ZodType<T>,
  context: SeedPreparationContext
): T {
  const bytes = Buffer.from(record.bytes, 'base64');
  if (context.mode === 'authored') refuseJsonBytes(bytes, context.secretAllow);
  try {
    const raw: unknown = JSON.parse(seedSourceText(record));
    const parsed = schema.parse(raw);
    if (context.mode === 'authored' && canonicalJson(parsed) !== canonicalJson(raw))
      invalidSeed('Authored seed fields must match their typed schema without normalization');
    return parsed;
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError) throw cause;
    throw new ProjectDatabaseError('INVALID_INPUT', 'Provide a supported typed seed payload', {
      cause,
    });
  }
}
export function refuseSeedMetadata(value: unknown, context: SeedPreparationContext): void {
  if (context.mode !== 'authored') return;
  try {
    assertNoSecretsInPayload(value, context.secretAllow);
  } catch (cause) {
    if (!(cause instanceof SecretInPayloadError)) throw cause;
    throw new ProjectDatabaseError(
      'SECRET_IN_PAYLOAD',
      'Remove or redescribe refused seed content before a new attempt',
      { cause }
    );
  }
}
export function assertUniqueSeedSources(sources: readonly SeedSourceRecord[]): void {
  const ids = new Set<string>();
  const locations = new Set<string>();
  for (const source of sources) {
    const location = JSON.stringify([source.sourceIdentity, source.sourceLocation]);
    if (ids.has(source.sourceId) || locations.has(location))
      invalidSeed('Each original seed occurrence must have one distinct identity and location');
    ids.add(source.sourceId);
    locations.add(location);
  }
}
export function freezeSeed<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freezeSeed);
    Object.freeze(value);
  }
  return value;
}
