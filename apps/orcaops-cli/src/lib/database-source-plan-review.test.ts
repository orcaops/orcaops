import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { canonicalJson, type ReviewPullRecord, sha256Hex, uuidv7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
  readProjectSourcePlanNamespace,
  readProjectSourcePlanReview,
} from '@orcaops/storage/history/database';
import type { RemoteTarget } from '@orcaops/storage/history/remote-target';

import { createDatabasePlanReviewPersistence } from './database-source-plan-review.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];

afterEach(async () => {
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'database-plan-review-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
  const initialized = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: '2026-09-09T00:00:00Z',
    authorize() {},
  });
  initialized.close();
  const reader = await openProjectDatabase({ authority, mode: 'reader' });
  handles.push(reader);
  const openWriter = vi.fn(async () => openProjectDatabase({ authority, mode: 'writer' }));
  return { reader, openWriter };
}

const target: RemoteTarget = {
  server_url: 'https://cloud.example.test',
  org_id: 'organization',
  account_id: 'account-a',
};

function candidate(overrides: Partial<ReviewPullRecord> = {}): ReviewPullRecord {
  const body = overrides.body ?? '# Candidate\n';
  return {
    schema_version: 1,
    target: 'candidate',
    external_id: 'source-plan-id',
    version_id: 'candidate-version',
    version_number: 3,
    proposal_id: null,
    base_version_number: null,
    content_hash: sha256Hex(body),
    body,
    base_url: target.server_url,
    org_id: target.org_id,
    pulled_at: '2026-09-09T00:00:00Z',
    ...overrides,
  };
}

it('publishes and replays exact review records without opening a writer for reads', async () => {
  const f = await fixture();
  const persistence = createDatabasePlanReviewPersistence({
    reader: f.reader,
    target,
    secretAllow: [],
    openWriter: f.openWriter,
  });
  await persistence.preflight();
  expect(await persistence.readCandidate('source-plan-id')).toBeNull();
  expect(f.openWriter).not.toHaveBeenCalled();

  const value = candidate();
  await persistence.writeRecord(value);
  const afterFirst = f.reader.read(() => null).counters;
  await persistence.writeRecord(value);
  expect(f.reader.read(() => null).counters).toEqual(afterFirst);
  expect(await persistence.readCandidate(value.external_id)).toEqual(value);

  const namespace = readProjectSourcePlanNamespace(f.reader, {
    serverUrl: target.server_url,
    orgId: target.org_id,
    accountId: target.account_id,
  })!;
  const stored = readProjectSourcePlanReview(f.reader, {
    namespaceId: namespace.namespaceId,
    kind: 'candidate',
    subjectId: value.external_id,
  })!;
  expect(Buffer.from(stored.record.recordBase64, 'base64').toString('utf8')).toBe(
    canonicalJson(value) + '\n'
  );
});

it('requires retained mutation admission while explicit pulls may refresh observation time', async () => {
  const f = await fixture();
  const persistence = createDatabasePlanReviewPersistence({
    reader: f.reader,
    target,
    secretAllow: [],
    openWriter: f.openWriter,
  });
  const first = candidate();
  await persistence.writeRecord(first);
  const counters = f.reader.read(() => null).counters;
  const opens = f.openWriter.mock.calls.length;

  await expect(
    persistence.writeRecord(
      { ...first, pulled_at: '2026-09-09T01:00:00Z' },
      { preserveEquivalent: true }
    )
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  expect(f.openWriter).toHaveBeenCalledTimes(opens);
  expect(f.reader.read(() => null).counters).toEqual(counters);
  expect(await persistence.readCandidate(first.external_id)).toEqual(first);

  const refreshed = { ...first, pulled_at: '2026-09-09T02:00:00Z' };
  await persistence.writeRecord(refreshed);
  expect(await persistence.readCandidate(first.external_id)).toEqual(refreshed);
});

it('refuses record and namespace secrets before opening a writer', async () => {
  const f = await fixture();
  const secret = 'ghp_' + 'A'.repeat(36);
  const counters = f.reader.read(() => null).counters;
  const recordPersistence = createDatabasePlanReviewPersistence({
    reader: f.reader,
    target,
    secretAllow: [],
    openWriter: f.openWriter,
  });
  await expect(
    recordPersistence.writeRecord(candidate({ body: secret, content_hash: sha256Hex(secret) }))
  ).rejects.toMatchObject({ name: 'SecretInPayloadError' });
  expect(f.openWriter).not.toHaveBeenCalled();

  const namespacePersistence = createDatabasePlanReviewPersistence({
    reader: f.reader,
    target: { ...target, account_id: secret },
    secretAllow: [],
    openWriter: f.openWriter,
  });
  await expect(namespacePersistence.writeRecord(candidate())).rejects.toMatchObject({
    name: 'SecretInPayloadError',
  });
  expect(f.openWriter).not.toHaveBeenCalled();
  expect(f.reader.read(() => null).counters).toEqual(counters);
});

it('keeps review records within the authenticated account namespace', async () => {
  const f = await fixture();
  const accountA = createDatabasePlanReviewPersistence({
    reader: f.reader,
    target,
    secretAllow: [],
    openWriter: f.openWriter,
  });
  const accountB = createDatabasePlanReviewPersistence({
    reader: f.reader,
    target: { ...target, account_id: 'account-b' },
    secretAllow: [],
    openWriter: f.openWriter,
  });
  await accountA.writeRecord(candidate());
  expect(await accountB.readCandidate('source-plan-id')).toBeNull();
  expect(await accountA.readCandidate('source-plan-id')).toEqual(candidate());
});
