import { z } from 'zod';

import { canonicalJson } from '../../events/canonical-json.js';
import { isUuidV7 } from '../../ids/uuidv7.js';
import { assertNoSecretsInPayload, SecretInPayloadError } from '../../text/secret-guard.js';
import { digest } from '../event-integrity.js';
import { ProjectDatabaseError } from './errors.js';

const id = z.string().refine(isUuidV7);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = counter.refine((value) => value > 0);
const oid = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
  .refine((value) => !/^0+$/.test(value));
const revision = z.strictObject({
  generation: positive,
  orderedHash: z.string().regex(/^[a-f0-9]{64}$/),
  eventCount: positive,
  byteLength: positive,
  tailEventId: id,
});
const captureTarget = z.strictObject({
  kind: z.literal('capture'),
  artifactId: id,
  expectedRevision: revision.nullable(),
  expectedExecutionVersion: positive.nullable(),
  expectedBindingGeneration: counter.nullable(),
  expectedBaselinePublicationId: id.nullable(),
});
const reviewTarget = z.strictObject({
  kind: z.literal('review'),
  reviewId: id,
  membershipRevisionId: id,
  baseRevisionId: id.nullable(),
  floorPublicationId: id.nullable(),
  runId: z.string().min(1).nullable(),
  runRevisionId: id.nullable(),
  membershipVersion: positive,
  baseVersion: counter,
  floorVersion: counter,
  runSelectionVersion: counter,
});
const resource = z.strictObject({
  publicationId: id,
  role: z.enum(['checkpoint', 'baseline', 'review-floor', 'review-floor-base', 'review-base']),
  targetId: id,
  checkpointNumber: positive.nullable(),
  checkpointPhase: z.enum(['open', 'close', 'abandon']).nullable(),
  objectOid: oid,
  treeOid: oid,
});
const inputSchema = z.strictObject({
  operationId: id,
  admissionOperationId: id,
  preparedTransitionId: id,
  repositoryInstanceId: id,
  objectFormat: z.enum(['sha1', 'sha256']),
  createdAt: z.string().datetime(),
  target: z.discriminatedUnion('kind', [captureTarget, reviewTarget]),
  publications: z.array(resource).min(1),
  secretAllow: z.array(z.string()),
});
export type GitRetentionTarget = z.infer<typeof captureTarget> | z.infer<typeof reviewTarget>;
export type GitRetentionPublicationInput = z.infer<typeof resource>;
export type PrepareProjectGitRetention = z.input<typeof inputSchema>;
export interface PreparedProjectGitRetention {
  readonly kind: 'prepared-project-git-retention';
}
export interface GitRetentionPreparation {
  readonly operationId: string;
  readonly admissionOperationId: string;
  readonly preparedTransitionId: string;
  readonly repositoryInstanceId: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly createdAt: string;
  readonly target: GitRetentionTarget;
  readonly publications: readonly (GitRetentionPublicationInput & { fullRef: string })[];
  readonly fingerprint: string;
}
const preparations = new WeakMap<PreparedProjectGitRetention, GitRetentionPreparation>();
function invalid(message: string): never {
  throw new ProjectDatabaseError('INVALID_INPUT', message);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function prepareRetentionValue(
  input: PrepareProjectGitRetention,
  authored: boolean
): GitRetentionPreparation {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide exact typed retention identities and targets',
      {
        cause: parsed.error,
      }
    );
  const { secretAllow, ...value } = parsed.data;
  if (value.operationId === value.admissionOperationId)
    invalid('Admission and original terminal operation IDs must be distinct');
  const target = value.target;
  if (target.kind === 'capture') {
    const creating = target.expectedRevision === null;
    if (
      creating !== (target.expectedExecutionVersion === null) ||
      creating !== (target.expectedBindingGeneration === null)
    )
      invalid(
        'Capture retention must retain the complete existing revision and execution expectation or explicit creation'
      );
  } else if ((target.runId === null) !== (target.runRevisionId === null)) {
    invalid('A review run requires its exact original revision');
  }
  const width = value.objectFormat === 'sha1' ? 40 : 64;
  const publications = value.publications.map((publication) => {
    const checkpoint = publication.role === 'checkpoint';
    if (
      checkpoint !== (publication.checkpointNumber !== null) ||
      checkpoint !== (publication.checkpointPhase !== null)
    )
      invalid('Only checkpoint retention has an exact checkpoint number and phase');
    if (publication.objectOid.length !== width || publication.treeOid.length !== width)
      invalid('Retained OIDs must match the actual repository object format');
    if ((target.kind === 'capture') !== ['checkpoint', 'baseline'].includes(publication.role))
      invalid('A retention publication cannot change its capture or review owner');
    const fullRef =
      target.kind === 'capture'
        ? checkpoint
          ? `refs/orcaops/snap/${target.artifactId}/${publication.checkpointNumber}/${publication.checkpointPhase}-${publication.publicationId}`
          : `refs/orcaops/baseline/${target.artifactId}-${publication.publicationId}`
        : `refs/orcaops/review/${target.reviewId}-${publication.publicationId}${publication.role === 'review-base' || publication.role === 'review-floor-base' ? '-base' : ''}`;
    return { ...publication, fullRef };
  });
  const checkpoints = publications.filter((entry) => entry.role === 'checkpoint');
  const selections = publications.filter((entry) => entry.role !== 'checkpoint');
  if (
    new Set(selections.map((entry) => entry.role)).size !== selections.length ||
    new Set(
      checkpoints.map((entry) => canonicalJson([entry.checkpointNumber, entry.checkpointPhase]))
    ).size !== checkpoints.length ||
    new Set(publications.map((entry) => entry.publicationId)).size !== publications.length ||
    new Set(publications.map((entry) => entry.fullRef)).size !== publications.length ||
    new Set(publications.map((entry) => canonicalJson([entry.role, entry.targetId]))).size !==
      publications.length
  )
    invalid('Retain one distinct publication per exact target role and ref');
  publications.sort((left, right) =>
    left.publicationId < right.publicationId ? -1 : left.publicationId > right.publicationId ? 1 : 0
  );
  const retained = { ...value, publications };
  try {
    if (authored) assertNoSecretsInPayload(retained, secretAllow);
  } catch (cause) {
    if (!(cause instanceof SecretInPayloadError)) throw cause;
    throw new ProjectDatabaseError(
      'SECRET_IN_PAYLOAD',
      'Remove or redescribe refused retention input before a new operation',
      { cause }
    );
  }
  return freeze({ ...retained, fingerprint: digest(Buffer.from(canonicalJson(retained))) });
}
export function prepareProjectGitRetention(
  input: PrepareProjectGitRetention
): PreparedProjectGitRetention {
  const value = prepareRetentionValue(input, true);
  const handle: PreparedProjectGitRetention = Object.freeze({
    kind: 'prepared-project-git-retention',
  });
  preparations.set(handle, value);
  return handle;
}
export function restoreGitRetentionPreparation(
  input: Omit<PrepareProjectGitRetention, 'secretAllow'>
): GitRetentionPreparation {
  try {
    return prepareRetentionValue({ ...input, secretAllow: [] }, false);
  } catch (cause) {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Retained Git publication input is inconsistent; preserve history for explicit repair',
      { cause }
    );
  }
}
export function gitRetentionPreparation(
  value: PreparedProjectGitRetention
): GitRetentionPreparation {
  const retained = preparations.get(value);
  if (!retained) invalid('Provide a genuine prepared Git retention input');
  return retained;
}
