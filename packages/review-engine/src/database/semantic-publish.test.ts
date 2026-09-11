import { expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import * as store from '@orcaops/storage/history/database';

import {
  publishDatabaseSemanticGeneration,
  type PublishDatabaseSemanticGeneration,
} from './semantic-publish.js';

vi.mock('@orcaops/storage/history/database', async (importOriginal) => {
  const actual = await importOriginal<typeof store>();
  return { ...actual, openProjectDatabase: vi.fn(actual.openProjectDatabase) };
});
function request(): PublishDatabaseSemanticGeneration {
  return {
    authority: {
      resolvedRoot: '/tmp/semantic-refusal-no-store',
      rootKey: 'unopened-root',
      projectId: uuidv7(),
      storeInstanceId: uuidv7(),
      repositoryInstanceId: uuidv7(),
    },
    reviewId: uuidv7(),
    runId: 'existing-non-uuid-run',
    generationId: uuidv7(),
    operationId: uuidv7(),
    attemptRevisionId: uuidv7(),
    modelPublicationId: uuidv7(),
    expected: {
      revisionId: uuidv7(),
      version: 4,
      runSelectionVersion: 1,
      semanticGenerationId: null,
      semanticVersion: 0,
    },
    authored: {
      startedAt: '2026-06-01T00:06:00.000Z',
      submittedAt: '2026-06-01T00:06:01.000Z',
      runtimeIdentity: null,
      profile: 'semantic-anchor-profile-v1',
    },
    attempt: { kind: 'initial' },
    submissionBytes: Buffer.from('{"schema_version":3,"dispositions":[]}'),
    secretAllow: [],
  };
}
it.each(['literal', 'escaped'])(
  'refuses %s discarded secret content before opening storage',
  async (kind) => {
    vi.mocked(store.openProjectDatabase).mockClear();
    const secret = 'ghp_' + 'a'.repeat(36);
    const encoded =
      kind === 'literal'
        ? secret
        : [...secret]
            .map((value) => '\\u' + value.charCodeAt(0).toString(16).padStart(4, '0'))
            .join('');
    await expect(
      publishDatabaseSemanticGeneration({
        ...request(),
        submissionBytes: Buffer.from('{"hidden":"' + encoded + '","hidden":null}'),
      })
    ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
    expect(store.openProjectDatabase).not.toHaveBeenCalled();
  }
);
it('refuses caller-certified models and catalogs before opening storage', async () => {
  vi.mocked(store.openProjectDatabase).mockClear();
  const supplied = { ...request(), model: { accepted: true }, catalog: { items: [] } };
  await expect(publishDatabaseSemanticGeneration(supplied)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
});
it('honors an already canceled operation before opening storage', async () => {
  vi.mocked(store.openProjectDatabase).mockClear();
  const controller = new AbortController();
  controller.abort();
  await expect(
    publishDatabaseSemanticGeneration(request(), { signal: controller.signal })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(store.openProjectDatabase).not.toHaveBeenCalled();
});
