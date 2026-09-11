import { expect, it } from 'vitest';

import { ProjectDatabaseError } from './errors.js';
import {
  gitRetentionPreparation,
  prepareProjectGitRetention,
  type PrepareProjectGitRetention,
} from './retention-input.js';
import {
  type PrepareReviewRetention,
  prepareReviewRetention,
  restoreReviewRetentionPreparation,
  reviewRetentionPreparation,
} from './review-retention-input.js';
import { uuidv7 } from '../../ids/uuidv7.js';

function fixture(baseKind: 'auto' | 'explicit' | null = null, floor = true) {
  const floorId = uuidv7(),
    baseId = uuidv7();
  const retentionInput: PrepareProjectGitRetention = {
    operationId: uuidv7(),
    admissionOperationId: uuidv7(),
    preparedTransitionId: uuidv7(),
    repositoryInstanceId: uuidv7(),
    objectFormat: 'sha1',
    createdAt: '2026-09-01T00:00:00.000Z',
    target: {
      kind: 'review',
      reviewId: uuidv7(),
      membershipRevisionId: uuidv7(),
      baseRevisionId: null,
      floorPublicationId: null,
      runId: 'original-run',
      runRevisionId: uuidv7(),
      membershipVersion: 1,
      baseVersion: 0,
      floorVersion: 0,
      runSelectionVersion: 1,
    },
    publications: [],
    secretAllow: [],
  };
  const publication = (
    role: 'review-floor' | 'review-floor-base' | 'review-base',
    targetId: string
  ) => ({
    publicationId: uuidv7(),
    role,
    targetId,
    checkpointNumber: null,
    checkpointPhase: null,
    objectOid: 'a'.repeat(40),
    treeOid: 'b'.repeat(40),
  });
  if (floor)
    retentionInput.publications.push(
      publication('review-floor', floorId),
      publication('review-floor-base', floorId)
    );
  if (baseKind === 'explicit') retentionInput.publications.push(publication('review-base', baseId));
  const bytes = Buffer.from(
    baseKind === 'explicit'
      ? `{ "kind":"explicit", "ref":"main", "oid":"${'a'.repeat(40)}", "recordedAt":"2026-09-01T00:00:00.000Z", "source":null }\n`
      : '{ "kind":"auto", "recordedAt":"2026-09-01T00:00:00.000Z", "source":null }\n'
  );
  const base = baseKind ? { revisionId: baseId, bytes } : null;
  const input: PrepareReviewRetention = {
    retention: prepareProjectGitRetention(retentionInput),
    secretAllow: [],
    request: floor
      ? {
          kind: 'floor',
          selectedTransitionId: uuidv7(),
          base,
          floor: {
            publicationId: floorId,
            observedWriteSequence: 12,
            basis: {
              baseSha: 'a'.repeat(40),
              pinnedTreeSha: 'b'.repeat(40),
              worktreeHead: null,
              defaultBranch: 'main',
              fingerprintMaxDiffBytes: 1024,
              reviewMaxDiffBytes: 2048,
              reviewIncludedUntracked: ['z.ts', 'a.ts'],
            },
            members: [
              {
                name: 'floor.json',
                kind: 'floor',
                schemaVersion: 4,
                relativePath: `evidence/${floorId}/floor.json`,
                sha256: 'a'.repeat(64),
                byteLength: 200,
              },
              {
                name: 'diff.patch',
                kind: 'diff',
                schemaVersion: null,
                relativePath: `evidence/${floorId}/diff.patch`,
                sha256: 'b'.repeat(64),
                byteLength: 0,
              },
            ],
          },
        }
      : { kind: 'base', selectedTransitionId: uuidv7(), base: base! },
  };
  return { input, retentionInput, bytes };
}
it.each([null, 'auto', 'explicit'] as const)(
  'retains an immutable floor request with original policy %s',
  (kind) => {
    const f = fixture(kind),
      handle = prepareReviewRetention(f.input),
      value = reviewRetentionPreparation(handle);
    expect(value.kind).toBe('floor');
    expect(value.selectedTransitionId).toBe(f.input.request.selectedTransitionId);
    expect(value.retention.target).toMatchObject({ baseRevisionId: null, runId: 'original-run' });
    expect(value.floor!.observedWriteSequence).toBe(12);
    expect(value.floor!.basis.reviewIncludedUntracked).toEqual(['z.ts', 'a.ts']);
    expect(value.base === null ? null : Buffer.from(value.base.bytesHex, 'hex')).toEqual(
      kind ? f.bytes : null
    );
    const original = structuredClone(value);
    f.bytes.fill(32);
    f.input.request.selectedTransitionId = uuidv7();
    if (f.input.request.kind === 'floor')
      f.input.request.floor.basis.reviewIncludedUntracked.reverse();
    expect(reviewRetentionPreparation(handle)).toEqual(original);
    expect(() => value.floor!.members.reverse()).toThrow();
  }
);
it('retains a standalone explicit base and refuses a forged preparation', () => {
  const f = fixture('explicit', false),
    handle = prepareReviewRetention(f.input);
  expect(reviewRetentionPreparation(handle)).toMatchObject({
    kind: 'base',
    floor: null,
    base: { kind: 'explicit' },
  });
  expect(() => reviewRetentionPreparation({} as never)).toThrow(/genuine/);
  expect(() => prepareReviewRetention({ ...f.input, retention: {} as never })).toThrow(/genuine/);
});
it('restores original accepted bytes without applying later authored refusal', () => {
  const f = fixture('auto');
  const secret = 'ghp_' + 'A'.repeat(36);
  f.input.request.base!.bytes = Buffer.from(
    `{"kind":"auto","note":"${secret}","note":"original","recordedAt":"2026-09-01T00:00:00.000Z","source":null}`
  );
  expect(() => prepareReviewRetention(f.input)).toThrowError(
    expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' })
  );
  const restored = restoreReviewRetentionPreparation(
    gitRetentionPreparation(f.input.retention),
    f.input.request
  );
  expect(Buffer.from(reviewRetentionPreparation(restored).base!.bytesHex, 'hex')).toEqual(
    f.input.request.base!.bytes
  );
  f.input.request.selectedTransitionId = 'broken';
  expect(() =>
    restoreReviewRetentionPreparation(gitRetentionPreparation(f.input.retention), f.input.request)
  ).toThrowError(expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' }));
});
it('normalizes only evidence-member set order and preserves exact bytes and path order', () => {
  const f = fixture('auto');
  const a = reviewRetentionPreparation(prepareReviewRetention(f.input));
  if (f.input.request.kind !== 'floor') throw new Error('Expected floor');
  f.input.request.floor.members.reverse();
  expect(reviewRetentionPreparation(prepareReviewRetention(f.input))).toEqual(a);
  f.input.request.floor.basis.reviewIncludedUntracked.reverse();
  expect(reviewRetentionPreparation(prepareReviewRetention(f.input)).fingerprint).not.toBe(
    a.fingerprint
  );
});
it.each([
  'missing-pin',
  'wrong-target',
  'same-transition',
  'duplicate-member',
  'wrong-path',
  'wrong-kind',
  'wrong-schema',
  'wrong-format',
  'unsafe-sequence',
  'unknown-field',
  'sparse-member',
  'sparse-allow',
  'invalid-json',
  'invalid-utf8',
] as const)('refuses %s before returning any prepared handle', (kind) => {
  const f = fixture('auto');
  if (f.input.request.kind !== 'floor') throw new Error('Expected floor');
  switch (kind) {
    case 'missing-pin':
      f.retentionInput.publications.pop();
      f.input.retention = prepareProjectGitRetention(f.retentionInput);
      break;
    case 'wrong-target':
      f.retentionInput.publications[1]!.targetId = uuidv7();
      f.input.retention = prepareProjectGitRetention(f.retentionInput);
      break;
    case 'same-transition':
      f.input.request.selectedTransitionId = f.retentionInput.preparedTransitionId;
      break;
    case 'duplicate-member':
      f.input.request.floor.members[1] = { ...f.input.request.floor.members[0]! };
      break;
    case 'wrong-path':
      f.input.request.floor.members[0]!.relativePath = `evidence/${uuidv7()}/floor.json`;
      break;
    case 'wrong-kind':
      f.input.request.floor.members[0]!.kind = 'diff';
      break;
    case 'wrong-schema':
      f.input.request.floor.members[0]!.schemaVersion = null;
      break;
    case 'wrong-format':
      f.input.request.floor.basis.baseSha = 'a'.repeat(64);
      break;
    case 'unsafe-sequence':
      f.input.request.floor.observedWriteSequence = Number.MAX_SAFE_INTEGER + 1;
      break;
    case 'unknown-field':
      Object.assign(f.input.request, { verified: true });
      break;
    case 'sparse-member':
      delete f.input.request.floor.members[0];
      break;
    case 'sparse-allow':
      f.input.secretAllow = Array(1);
      break;
    case 'invalid-json':
      f.input.request.base!.bytes = Buffer.from('{broken');
      break;
    case 'invalid-utf8':
      f.input.request.base!.bytes = Buffer.from([0xff]);
      break;
  }
  expect(() => prepareReviewRetention(f.input)).toThrowError(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
});
it('refuses escaped discarded secrets and metadata before a preparation exists', () => {
  const f = fixture('auto');
  const secret = 'ghp_' + 'A'.repeat(36);
  const escaped = [...secret]
    .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('');
  f.input.request.base!.bytes = Buffer.from(
    `{"kind":"auto","note":"${escaped}","note":"original"}`
  );
  expect(() => prepareReviewRetention(f.input)).toThrowError(
    expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' })
  );
  f.input.request.base!.bytes = f.bytes;
  if (f.input.request.kind !== 'floor') throw new Error('Expected floor');
  f.input.request.floor.basis.defaultBranch = secret;
  expect(() => prepareReviewRetention(f.input)).toThrowError(
    expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' })
  );
});
it('requires a review owner and leaves standalone auto policy changes database-only', () => {
  const f = fixture('auto');
  f.input.request = { kind: 'base', selectedTransitionId: uuidv7(), base: f.input.request.base! };
  expect(() => prepareReviewRetention(f.input)).toThrowError(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
  f.retentionInput.target = {
    kind: 'capture',
    artifactId: uuidv7(),
    expectedRevision: null,
    expectedExecutionVersion: null,
    expectedBindingGeneration: null,
    expectedBaselinePublicationId: null,
  };
  f.retentionInput.publications = [{ ...f.retentionInput.publications[0]!, role: 'baseline' }];
  f.input.retention = prepareProjectGitRetention(f.retentionInput);
  expect(() => prepareReviewRetention(f.input)).toThrow(ProjectDatabaseError);
});
