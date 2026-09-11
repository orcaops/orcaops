import { z } from 'zod';

import { refuseJsonBytes } from './authored-bytes.js';
import { ProjectDatabaseError } from './errors.js';
import {
  type GitRetentionPreparation,
  gitRetentionPreparation,
  type PreparedProjectGitRetention,
} from './retention-input.js';
import { canonicalJson } from '../../events/canonical-json.js';
import { isUuidV7 } from '../../ids/uuidv7.js';
import { assertNoSecretsInPayload, SecretInPayloadError } from '../../text/secret-guard.js';
import { digest } from '../event-integrity.js';

const id = z.string().refine(isUuidV7);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = count.refine((value) => value > 0);
const oid = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
  .refine((value) => !/^0+$/.test(value));
const base = z.strictObject({ revisionId: id, bytes: z.instanceof(Uint8Array) });
const member = z.strictObject({
  name: z.enum(['floor.json', 'diff.patch']),
  kind: z.enum(['floor', 'diff']),
  schemaVersion: positive.nullable(),
  relativePath: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteLength: count,
});
const floor = z.strictObject({
  publicationId: id,
  basis: z.strictObject({
    baseSha: oid,
    pinnedTreeSha: oid,
    worktreeHead: oid.nullable(),
    defaultBranch: z.string().min(1).nullable(),
    fingerprintMaxDiffBytes: positive,
    reviewMaxDiffBytes: positive,
    reviewIncludedUntracked: z.array(z.string().min(1)),
  }),
  observedWriteSequence: count,
  members: z.array(member).length(2),
});
const request = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('base'), selectedTransitionId: id, base }),
  z.strictObject({
    kind: z.literal('floor'),
    selectedTransitionId: id,
    base: base.nullable(),
    floor,
  }),
]);
const input = z.strictObject({
  retention: z.custom<PreparedProjectGitRetention>(),
  request,
  secretAllow: z.array(z.string()),
});
export type PrepareReviewRetention = z.input<typeof input>;
declare const preparedReview: unique symbol;
export interface PreparedReviewRetention {
  readonly [preparedReview]: 'original-review-retention';
}
export interface ReviewRetentionPreparation {
  retention: GitRetentionPreparation;
  kind: 'base' | 'floor';
  selectedTransitionId: string;
  base: { revisionId: string; bytesHex: string; sha256: string; kind: 'auto' | 'explicit' } | null;
  floor: z.infer<typeof floor> | null;
  fingerprint: string;
}
const preparations = new WeakMap<object, ReviewRetentionPreparation>();
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
function prepare(
  retention: GitRetentionPreparation,
  raw: z.input<typeof request>,
  secretAllow: readonly string[],
  authored: boolean
): PreparedReviewRetention {
  const parsed = request.safeParse(raw);
  if (!parsed.success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide one complete original pending review request',
      { cause: parsed.error }
    );
  const value = parsed.data;
  if (retention.target.kind !== 'review')
    invalid('Pending review input requires its original review retention owner');
  if (value.selectedTransitionId === retention.preparedTransitionId)
    invalid('Retain distinct original prepared and selected transition identities');
  let preparedBase: ReviewRetentionPreparation['base'] = null;
  if (value.base !== null) {
    const bytes = Buffer.from(value.base.bytes);
    if (authored) refuseJsonBytes(bytes, secretAllow);
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (cause) {
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Retain valid original UTF-8 base policy JSON',
        { cause }
      );
    }
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      Array.isArray(decoded) ||
      !('kind' in decoded) ||
      (decoded.kind !== 'auto' && decoded.kind !== 'explicit')
    )
      invalid('Retain an original auto or explicit base policy record');
    preparedBase = {
      revisionId: value.base.revisionId,
      bytesHex: bytes.toString('hex'),
      sha256: digest(bytes),
      kind: decoded.kind,
    };
  }
  const preparedFloor = value.kind === 'floor' ? value.floor : null;
  if (preparedFloor) {
    const width = retention.objectFormat === 'sha1' ? 40 : 64;
    if (
      [
        preparedFloor.basis.baseSha,
        preparedFloor.basis.pinnedTreeSha,
        preparedFloor.basis.worktreeHead,
      ].some((value) => value !== null && value.length !== width)
    )
      invalid('Original floor basis OIDs must match its repository object format');
    if (new Set(preparedFloor.members.map((value) => value.name)).size !== 2)
      invalid('Retain exactly the original floor and diff members');
    for (const value of preparedFloor.members) {
      const isFloor = value.name === 'floor.json';
      if (
        isFloor !== (value.kind === 'floor') ||
        isFloor !== (value.schemaVersion !== null) ||
        value.relativePath !== `evidence/${preparedFloor.publicationId}/${value.name}`
      )
        invalid('Retain each exact floor member kind, schema and original publication path');
    }
    preparedFloor.members.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  if (value.kind === 'base' && preparedBase?.kind !== 'explicit')
    invalid(
      'An auto policy change has no external retention target; use the database-only base operation'
    );
  const expected = [
    ...(preparedFloor
      ? [
          { role: 'review-floor', targetId: preparedFloor.publicationId },
          { role: 'review-floor-base', targetId: preparedFloor.publicationId },
        ]
      : []),
    ...(preparedBase?.kind === 'explicit'
      ? [{ role: 'review-base', targetId: preparedBase.revisionId }]
      : []),
  ];
  if (
    retention.publications.length !== expected.length ||
    expected.some(
      (target) =>
        !retention.publications.some(
          (publication) =>
            publication.role === target.role && publication.targetId === target.targetId
        )
    )
  )
    invalid(
      'Retention must name exactly both original floor pins and any authored explicit policy pin'
    );
  const original = {
    retention,
    kind: value.kind,
    selectedTransitionId: value.selectedTransitionId,
    base: preparedBase,
    floor: preparedFloor,
  };
  if (authored) {
    try {
      assertNoSecretsInPayload(original, secretAllow);
    } catch (cause) {
      if (!(cause instanceof SecretInPayloadError)) throw cause;
      throw new ProjectDatabaseError(
        'SECRET_IN_PAYLOAD',
        'Remove or redescribe refused pending review input before any write-capable step',
        { cause }
      );
    }
  }
  const handle = Object.freeze({}) as PreparedReviewRetention;
  preparations.set(
    handle,
    freeze({ ...original, fingerprint: digest(Buffer.from(canonicalJson(original))) })
  );
  return handle;
}
export function prepareReviewRetention(raw: PrepareReviewRetention): PreparedReviewRetention {
  const parsed = input.safeParse(raw);
  if (!parsed.success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide complete typed pending review input and refusal policy',
      { cause: parsed.error }
    );
  return prepare(
    gitRetentionPreparation(parsed.data.retention),
    parsed.data.request,
    parsed.data.secretAllow,
    true
  );
}
export function reviewRetentionPreparation(
  value: PreparedReviewRetention
): ReviewRetentionPreparation {
  const prepared = preparations.get(value);
  if (!prepared) invalid('Provide a genuine original pending review preparation');
  return prepared;
}
export function restoreReviewRetentionPreparation(
  retention: GitRetentionPreparation,
  original: z.input<typeof request>
): PreparedReviewRetention {
  try {
    return prepare(retention, original, [], false);
  } catch (cause) {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Original pending review input is inconsistent; preserve history for explicit repair',
      { cause }
    );
  }
}
