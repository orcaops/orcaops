import { expect, it } from 'vitest';

import {
  gitRetentionPreparation,
  prepareProjectGitRetention,
  type PrepareProjectGitRetention,
  restoreGitRetentionPreparation,
} from './retention-input.js';
import { uuidv7 } from '../../ids/uuidv7.js';

function input(): PrepareProjectGitRetention {
  return {
    operationId: uuidv7(),
    admissionOperationId: uuidv7(),
    preparedTransitionId: uuidv7(),
    repositoryInstanceId: uuidv7(),
    objectFormat: 'sha1',
    createdAt: '2026-09-01T00:00:00.000Z',
    target: {
      kind: 'capture',
      artifactId: uuidv7(),
      expectedRevision: null,
      expectedExecutionVersion: null,
      expectedBindingGeneration: null,
      expectedBaselinePublicationId: null,
    },
    publications: [
      {
        publicationId: uuidv7(),
        role: 'checkpoint',
        targetId: uuidv7(),
        checkpointNumber: 1,
        checkpointPhase: 'open',
        objectOid: 'a'.repeat(40),
        treeOid: 'b'.repeat(40),
      },
    ],
    secretAllow: [],
  };
}
it('preserves original identities and names an immutable checkpoint publication', () => {
  const value = input();
  const prepared = gitRetentionPreparation(prepareProjectGitRetention(value));
  expect(prepared.operationId).toBe(value.operationId);
  expect(prepared.publications[0]).toEqual({
    ...value.publications[0],
    fullRef: `refs/orcaops/snap/${value.target.kind === 'capture' && value.target.artifactId}/1/open-${value.publications[0]!.publicationId}`,
  });
  expect(prepared.fingerprint).toMatch(/^[a-f0-9]{64}$/);
});
it('detaches nested caller input and refuses forged prepared handles', () => {
  const value = input();
  const prepared = gitRetentionPreparation(prepareProjectGitRetention(value));
  const original = structuredClone(prepared);
  value.publications[0]!.objectOid = 'c'.repeat(40);
  value.target = {
    kind: 'capture',
    artifactId: uuidv7(),
    expectedRevision: null,
    expectedExecutionVersion: null,
    expectedBindingGeneration: null,
    expectedBaselinePublicationId: null,
  };
  expect(prepared).toEqual(original);
  expect(() => {
    prepared.publications[0]!.objectOid = 'd'.repeat(40);
  }).toThrow();
  expect(() => gitRetentionPreparation({ kind: 'prepared-project-git-retention' })).toThrow(
    'genuine'
  );
});
it('uses flat immutable suffixes for baseline and review publications', () => {
  const value = input();
  value.publications[0] = {
    ...value.publications[0]!,
    role: 'baseline',
    checkpointNumber: null,
    checkpointPhase: null,
  };
  const baseline = gitRetentionPreparation(prepareProjectGitRetention(value));
  expect(baseline.publications[0]!.fullRef).toBe(
    `refs/orcaops/baseline/${value.target.kind === 'capture' && value.target.artifactId}-${value.publications[0]!.publicationId}`
  );
  value.target = {
    kind: 'review',
    reviewId: uuidv7(),
    membershipRevisionId: uuidv7(),
    baseRevisionId: null,
    floorPublicationId: null,
    runId: null,
    runRevisionId: null,
    membershipVersion: 1,
    baseVersion: 0,
    floorVersion: 0,
    runSelectionVersion: 0,
  };
  value.publications[0]!.role = 'review-base';
  const review = gitRetentionPreparation(prepareProjectGitRetention(value));
  expect(review.publications[0]!.fullRef).toBe(
    `refs/orcaops/review/${value.target.reviewId}-${value.publications[0]!.publicationId}-base`
  );
});
it.each([
  'same-operation',
  'partial-expectation',
  'wrong-role',
  'unsafe-number',
  'wrong-format',
  'zero-oid',
  'duplicate-boundary',
  'duplicate-target',
  'unknown-field',
] as const)('rejects %s retention input before producing a handle', (kind) => {
  const value = input();
  switch (kind) {
    case 'same-operation':
      value.admissionOperationId = value.operationId;
      break;
    case 'partial-expectation':
      if (value.target.kind === 'capture') value.target.expectedExecutionVersion = 1;
      break;
    case 'wrong-role':
      value.publications[0]!.role = 'review-floor';
      break;
    case 'unsafe-number':
      value.publications[0]!.checkpointNumber = Number.MAX_SAFE_INTEGER + 1;
      break;
    case 'wrong-format':
      value.objectFormat = 'sha256';
      break;
    case 'zero-oid':
      value.publications[0]!.objectOid = '0'.repeat(40);
      break;
    case 'duplicate-boundary':
      value.publications.push({
        ...value.publications[0]!,
        publicationId: uuidv7(),
        targetId: uuidv7(),
      });
      break;
    case 'duplicate-target':
      value.publications.push({
        ...value.publications[0]!,
        publicationId: uuidv7(),
        checkpointPhase: 'close',
      });
      break;
    case 'unknown-field':
      Object.assign(value, { fullRef: 'refs/heads/main' });
      break;
  }
  expect(() => prepareProjectGitRetention(value)).toThrow();
});
it('preserves SHA-256 repository OIDs without rehashing them', () => {
  const value = input();
  value.objectFormat = 'sha256';
  value.publications[0]!.objectOid = 'e'.repeat(64);
  value.publications[0]!.treeOid = 'f'.repeat(64);
  expect(
    gitRetentionPreparation(prepareProjectGitRetention(value)).publications[0]!.objectOid
  ).toBe('e'.repeat(64));
});
function reviewInput(): PrepareProjectGitRetention {
  const value = input();
  value.target = {
    kind: 'review',
    reviewId: uuidv7(),
    membershipRevisionId: uuidv7(),
    baseRevisionId: null,
    floorPublicationId: null,
    runId: 'original-run:topic',
    runRevisionId: uuidv7(),
    membershipVersion: 1,
    baseVersion: 0,
    floorVersion: 0,
    runSelectionVersion: 1,
  };
  value.publications[0] = {
    ...value.publications[0]!,
    role: 'review-floor',
    checkpointNumber: null,
    checkpointPhase: null,
  };
  return value;
}
it.each(['original-run:topic', ' retained run ', 'legacy/run/name'])(
  'preserves the exact original review run identity %s',
  (runId) => {
    const value = reviewInput();
    if (value.target.kind !== 'review') throw new Error('Expected review fixture');
    value.target.runId = runId;
    expect(gitRetentionPreparation(prepareProjectGitRetention(value)).target).toEqual(value.target);
  }
);
it.each([
  'empty-run',
  'non-string-run',
  'missing-revision',
  'invalid-revision',
  'missing-run',
] as const)('rejects %s while preserving exact review revision requirements', (kind) => {
  const value = reviewInput();
  if (value.target.kind !== 'review') throw new Error('Expected review fixture');
  switch (kind) {
    case 'empty-run':
      value.target.runId = '';
      break;
    case 'non-string-run':
      Object.assign(value.target, { runId: 42 });
      break;
    case 'missing-revision':
      value.target.runRevisionId = null;
      break;
    case 'invalid-revision':
      value.target.runRevisionId = 'original-run:topic';
      break;
    case 'missing-run':
      value.target.runId = null;
      break;
  }
  expect(() => prepareProjectGitRetention(value)).toThrow();
});

it('retains an exact nullable baseline expectation independently of artifact revision', () => {
  const value = input();
  if (value.target.kind !== 'capture') throw new Error('capture fixture');
  const baseline = uuidv7();
  value.target.expectedBaselinePublicationId = baseline;
  const prepared = gitRetentionPreparation(prepareProjectGitRetention(value));
  value.target.expectedBaselinePublicationId = null;
  expect(prepared.target).toMatchObject({
    expectedBaselinePublicationId: baseline,
    expectedRevision: null,
  });
  expect(gitRetentionPreparation(prepareProjectGitRetention(value)).target).toMatchObject({
    expectedBaselinePublicationId: null,
  });
});
it.each([undefined, '', 'not-a-publication-id', 12])(
  'rejects an invalid original baseline expectation %s',
  (invalid) => {
    const value = input();
    Object.assign(value.target, { expectedBaselinePublicationId: invalid });
    expect(() => prepareProjectGitRetention(value)).toThrow();
  }
);

it('preserves separate target and resolved-base publications for a floor without a base policy', () => {
  const value = reviewInput();
  if (value.target.kind !== 'review') throw new Error('Expected review fixture');
  const target = value.publications[0]!.targetId;
  const base = {
    ...value.publications[0]!,
    publicationId: uuidv7(),
    role: 'review-floor-base' as const,
    objectOid: 'c'.repeat(40),
    treeOid: 'd'.repeat(40),
  };
  value.publications.push(base);
  const prepared = gitRetentionPreparation(prepareProjectGitRetention(value));
  expect(prepared.target).toEqual(value.target);
  expect(prepared.target).toMatchObject({ baseRevisionId: null });
  expect(prepared.publications.map((p) => p.targetId)).toEqual([target, target]);
  expect(prepared.publications.find((p) => p.role === 'review-floor-base')).toEqual({
    ...base,
    fullRef: `refs/orcaops/review/${value.target.reviewId}-${base.publicationId}-base`,
  });
  const reordered = { ...value, publications: [...value.publications].reverse() };
  expect(gitRetentionPreparation(prepareProjectGitRetention(reordered))).toEqual(prepared);
  const { secretAllow: _allow, ...original } = value;
  expect(restoreGitRetentionPreparation(original)).toEqual(prepared);
  value.publications[1]!.targetId = uuidv7();
  expect(prepared.publications.map((p) => p.targetId)).toEqual([target, target]);
});
it('keeps explicit policy retention distinct from both floor roles', () => {
  const value = reviewInput();
  const floor = value.publications[0]!;
  const policyId = uuidv7();
  value.publications.push(
    { ...floor, publicationId: uuidv7(), role: 'review-floor-base' },
    { ...floor, publicationId: uuidv7(), role: 'review-base', targetId: policyId }
  );
  const prepared = gitRetentionPreparation(prepareProjectGitRetention(value));
  expect(prepared.publications).toHaveLength(3);
  expect(new Set(prepared.publications.map((p) => p.fullRef)).size).toBe(3);
  expect(prepared.publications.find((p) => p.role === 'review-base')!.targetId).toBe(policyId);
  expect(
    prepared.publications.filter((p) => p.role !== 'review-base').map((p) => p.targetId)
  ).toEqual([floor.targetId, floor.targetId]);
});
it('refuses a resolved floor-base role on a capture or a duplicate floor-base choice', () => {
  const capture = input();
  capture.publications[0] = {
    ...capture.publications[0]!,
    role: 'review-floor-base',
    checkpointNumber: null,
    checkpointPhase: null,
  };
  expect(() => prepareProjectGitRetention(capture)).toThrow(/owner/);
  const review = reviewInput();
  const base = { ...review.publications[0]!, role: 'review-floor-base' as const };
  review.publications = [base, { ...base, publicationId: uuidv7(), targetId: uuidv7() }];
  expect(() => prepareProjectGitRetention(review)).toThrow(/distinct publication/);
});
