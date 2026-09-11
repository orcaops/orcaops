import { expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import * as database from '@orcaops/storage/history/database';

import { prepareReviewCommentLink } from './comment-link-records.js';

vi.mock('@orcaops/storage/history/database', async (importOriginal) => {
  const actual = await importOriginal<typeof database>();
  return { ...actual, openProjectDatabase: vi.fn(actual.openProjectDatabase) };
});

function request() {
  return {
    authority: {
      resolvedRoot: '/unused',
      rootKey: 'unused',
      projectId: uuidv7(),
      storeInstanceId: uuidv7(),
      repositoryInstanceId: uuidv7(),
    },
    operationId: uuidv7(),
    linkId: uuidv7(),
    reviewId: uuidv7(),
    commentId: 'original-comment',
    commentRevisionId: uuidv7(),
    endpoint: {
      kind: 'run-ledger-entry' as const,
      runId: 'original-run',
      runRevisionId: uuidv7(),
      inputPublicationId: uuidv7(),
      ledgerEntryId: 'ldg:COVERAGE_GAP:original',
    },
    actor: 'reviewer' as const,
    at: '2026-06-01T00:00:00.000Z',
    secretAllow: [] as string[],
  };
}
it('copies original non-UUID identities and keeps the link event distinct from the operation', () => {
  const raw = request();
  const prepared = prepareReviewCommentLink(raw);
  const original = structuredClone(prepared);
  raw.endpoint.runId = 'changed';
  raw.authority.projectId = uuidv7();
  raw.secretAllow.push('later');
  expect(prepared).toEqual(original);
  expect(prepared.source).toEqual({
    kind: 'authored',
    eventId: raw.linkId,
    fieldPath: 'link',
    position: 0,
    actor: raw.actor,
    at: raw.at,
  });
  expect(prepared.source.eventId).not.toBe(raw.operationId);
  expect(prepared.source).not.toHaveProperty('commentAuthor');
  expect(database.openProjectDatabase).not.toHaveBeenCalled();
});
it('copies exact captured occurrence and historical membership identities', () => {
  const raw = {
    ...request(),
    endpoint: {
      kind: 'captured-occurrence' as const,
      membershipRevisionId: uuidv7(),
      artifactId: uuidv7(),
      artifactRevision: {
        generation: 2,
        orderedHash: 'a'.repeat(64),
        eventCount: 4,
        byteLength: 1234,
        tailEventId: uuidv7(),
      },
      sourceEventId: uuidv7(),
      fieldPath: '/done_criteria' as const,
      position: 0,
    },
  };
  const prepared = prepareReviewCommentLink(raw);
  raw.endpoint.artifactRevision.generation = 99;
  expect(prepared.input.endpoint).toMatchObject({
    artifactRevision: { generation: 2 },
    fieldPath: '/done_criteria',
    position: 0,
  });
  expect(database.openProjectDatabase).not.toHaveBeenCalled();
});
it.each(['runId', 'runRevisionId', 'inputPublicationId', 'ledgerEntryId'])(
  'requires the exact ledger endpoint %s',
  (field) => {
    const raw = request();
    Reflect.deleteProperty(raw.endpoint, field);
    expect(() => prepareReviewCommentLink(raw)).toThrow(/complete, valid review request/);
  }
);
it.each(['/verification', '/done_criteria/0', '../done_criteria', 'done_criteria'])(
  'refuses the unsupported occurrence path %s',
  (fieldPath) => {
    const raw = {
      ...request(),
      endpoint: {
        kind: 'captured-occurrence',
        membershipRevisionId: uuidv7(),
        artifactId: uuidv7(),
        artifactRevision: {
          generation: 1,
          orderedHash: 'a'.repeat(64),
          eventCount: 1,
          byteLength: 1,
          tailEventId: uuidv7(),
        },
        sourceEventId: uuidv7(),
        fieldPath,
        position: 0,
      },
    };
    expect(() => prepareReviewCommentLink(raw as never)).toThrow(/complete, valid review request/);
  }
);
it('refuses unsupported continuing claim identities and copied comment attribution', () => {
  expect(() =>
    prepareReviewCommentLink({
      ...request(),
      endpoint: { kind: 'claim-revision', claimId: uuidv7(), revisionId: uuidv7() },
    } as never)
  ).toThrow(/complete, valid review request/);
  expect(() => prepareReviewCommentLink({ ...request(), commentAuthor: 'agent' } as never)).toThrow(
    /complete, valid review request/
  );
});
it('refuses all authored metadata before any connection and honors explicit synthetic allowances', () => {
  const raw = { ...request(), commentId: 'ghp_' + 'A'.repeat(36) };
  expect(() => prepareReviewCommentLink(raw)).toThrow(/refused review content/);
  expect(database.openProjectDatabase).not.toHaveBeenCalled();
  expect(prepareReviewCommentLink({ ...raw, secretAllow: [raw.commentId] }).input.commentId).toBe(
    raw.commentId
  );
});
it('retains original cancellation without opening storage', () => {
  const controller = new AbortController();
  controller.abort();
  expect(() => prepareReviewCommentLink(request(), { signal: controller.signal })).toThrow(
    /cancelled/
  );
  expect(database.openProjectDatabase).not.toHaveBeenCalled();
});
