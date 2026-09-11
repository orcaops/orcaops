import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import type { OssSourcePlanUploadPayload } from '@orcaops/sdk';
import { uuidv7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
  readProjectSourcePlanLocator,
  readProjectSourcePlanNamespace,
} from '@orcaops/storage/history/database';
import type { RemoteTarget } from '@orcaops/storage/history/remote-target';

import {
  type DatabaseSourcePlanUploadOptions,
  runDatabaseSourcePlanUpload,
} from './database-source-plan-upload.js';

const transportSeams = vi.hoisted(() => ({
  afterAttempt: null as null | ((sendAllowed: boolean) => Promise<void>),
  beforeAttempt: null as null | (() => Promise<void>),
}));

vi.mock('@orcaops/storage/history/database/source-plan-upload', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@orcaops/storage/history/database/source-plan-upload')>();
  return {
    ...actual,
    admitProjectRemoteAttempt: async (
      ...args: Parameters<typeof actual.admitProjectRemoteAttempt>
    ) => {
      await transportSeams.beforeAttempt?.();
      const result = await actual.admitProjectRemoteAttempt(...args);
      await transportSeams.afterAttempt?.(result.sendAllowed);
      return result;
    },
  };
});

const roots: string[] = [];
const handles: ProjectDatabase[] = [];

afterEach(async () => {
  transportSeams.afterAttempt = null;
  transportSeams.beforeAttempt = null;
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'database-plan-upload-')),
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
  return { authority, reader, openWriter, root: root.resolvedRoot };
}

const target: RemoteTarget = {
  server_url: 'https://cloud.example.test',
  org_id: 'organization',
  account_id: 'account-a',
};

function args(f: Awaited<ReturnType<typeof fixture>>) {
  let tick = 0;
  const create = vi.fn(async (payload: OssSourcePlanUploadPayload) => ({
    id: 'draft-row',
    externalId: payload.external_id,
    slug: 'database-plan',
    status: 'DRAFT',
    unresolved: ['@alice'],
  }));
  const listReviewers = vi.fn(async () => ({
    members: [{ handle: 'alice@example.test', name: 'Alice Example' }],
    scope: 'organization',
  }));
  const resolveBaseline = vi.fn(async () => ({
    repo_url: 'https://example.test/repository',
    branch: 'main',
    head_sha: 'a'.repeat(40),
  }));
  const upload: DatabaseSourcePlanUploadOptions = {
    reader: f.reader,
    openWriter: f.openWriter,
    client: { sourcePlan: { create, listReviewers } },
    repoRoot: f.root,
    target,
    absPath: path.join(f.root, 'plans', 'source.md'),
    fileRealpath: path.join(f.root, 'plans', 'source.md'),
    body: '# Source plan\n',
    title: 'Source plan',
    reviewers: ['@alice'],
    reviewNote: null,
    secretAllow: [],
    resolveBaseline,
    now: () => `2026-09-09T00:00:0${tick++}Z`,
  };
  return { upload, create, listReviewers, resolveBaseline };
}

it('retains the exact upload and replays its terminal result without another open or cloud call', async () => {
  const f = await fixture();
  const prepared = args(f);
  const first = await runDatabaseSourcePlanUpload(prepared.upload);
  expect(first).toMatchObject({
    slug: 'database-plan',
    unresolved: ['@alice'],
    reviewer_suggestions: [
      { tag: '@alice', matches: [{ handle: 'alice@example.test', name: 'Alice Example' }] },
    ],
  });
  expect(prepared.create).toHaveBeenCalledTimes(1);
  expect(prepared.resolveBaseline).toHaveBeenCalledTimes(1);
  const counters = f.reader.read(() => null).counters;
  const opens = f.openWriter.mock.calls.length;

  const replay = await runDatabaseSourcePlanUpload({
    ...prepared.upload,
    resolveBaseline: vi.fn(async () => {
      throw new Error('terminal replay must retain the original baseline');
    }),
  });
  expect(replay).toEqual(first);
  expect(prepared.create).toHaveBeenCalledTimes(1);
  expect(prepared.listReviewers).toHaveBeenCalledTimes(1);
  expect(f.openWriter).toHaveBeenCalledTimes(opens);
  expect(f.reader.read(() => null).counters).toEqual(counters);

  const namespace = readProjectSourcePlanNamespace(f.reader, {
    serverUrl: target.server_url,
    orgId: target.org_id,
    accountId: target.account_id,
  })!;
  const locator = readProjectSourcePlanLocator(f.reader, {
    namespaceId: namespace.namespaceId,
    kind: 'upload',
    realPath: prepared.upload.fileRealpath,
  });
  expect(locator?.record.externalId).toBe(first.external_id);
});

it('records an unknown acknowledgement and refuses every automatic resend', async () => {
  const f = await fixture();
  const prepared = args(f);
  prepared.create.mockRejectedValueOnce(new Error('response lost'));
  await expect(runDatabaseSourcePlanUpload(prepared.upload)).rejects.toThrow(/not acknowledged/);
  const afterFirst = f.reader.read(() => null).counters;
  await expect(runDatabaseSourcePlanUpload(prepared.upload)).rejects.toThrow(
    /will not be resent.*orcaops plan review status.*cannot prove remote absence/i
  );
  expect(prepared.create).toHaveBeenCalledTimes(1);
  expect(prepared.resolveBaseline).toHaveBeenCalledTimes(1);
  expect(f.reader.read(() => null).counters).toEqual(afterFirst);
});

it('allows changed content to use a new operation while an older acknowledgement is unknown', async () => {
  const f = await fixture();
  const original = args(f);
  original.create.mockRejectedValueOnce(new Error('response lost'));
  await expect(runDatabaseSourcePlanUpload(original.upload)).rejects.toThrow(/not acknowledged/);

  const changed = args(f);
  changed.upload.body = '# Changed source plan\n';
  const result = await runDatabaseSourcePlanUpload(changed.upload);
  expect(result.external_id).not.toBe(original.create.mock.calls[0]![0].external_id);
  expect(original.create).toHaveBeenCalledTimes(1);
  expect(changed.create).toHaveBeenCalledTimes(1);
});

it('refuses authored secrets and cancellation before opening a writer', async () => {
  const f = await fixture();
  const secret = args(f);
  secret.upload.reviewNote = 'ghp_' + 'A'.repeat(36);
  await expect(runDatabaseSourcePlanUpload(secret.upload)).rejects.toMatchObject({
    code: 'SECRET_IN_PAYLOAD',
  });
  expect(f.openWriter).not.toHaveBeenCalled();
  expect(secret.create).not.toHaveBeenCalled();

  const cancelled = args(f);
  const controller = new AbortController();
  controller.abort();
  await expect(
    runDatabaseSourcePlanUpload({ ...cancelled.upload, signal: controller.signal })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(f.openWriter).not.toHaveBeenCalled();
  expect(cancelled.create).not.toHaveBeenCalled();
});

it('allows only the winning concurrent admission to send', async () => {
  const f = await fixture();
  const first = args(f);
  const second = args(f);
  let arrivals = 0;
  let release!: () => void;
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  transportSeams.beforeAttempt = async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await bothArrived;
  };

  const settled = await Promise.allSettled([
    runDatabaseSourcePlanUpload(first.upload),
    runDatabaseSourcePlanUpload(second.upload),
  ]);
  expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect(first.create.mock.calls.length + second.create.mock.calls.length).toBe(1);
  expect(settled.find((result) => result.status === 'rejected')).toMatchObject({
    reason: { message: expect.stringContaining('will not be resent') },
  });
});

it('cancels after send admission without dispatching or allowing a later resend', async () => {
  const f = await fixture();
  const prepared = args(f);
  const controller = new AbortController();
  prepared.upload.signal = controller.signal;
  transportSeams.afterAttempt = async (sendAllowed) => {
    if (sendAllowed) controller.abort();
  };

  await expect(runDatabaseSourcePlanUpload(prepared.upload)).rejects.toMatchObject({
    code: 'CANCELLED',
  });
  expect(prepared.create).not.toHaveBeenCalled();
  transportSeams.afterAttempt = null;
  await expect(
    runDatabaseSourcePlanUpload({ ...prepared.upload, signal: undefined })
  ).rejects.toThrow(/will not be resent/);
  expect(prepared.create).not.toHaveBeenCalled();
});

it('validates complete new input before opening a writer', async () => {
  const f = await fixture();

  const invalidPayload = args(f);
  Reflect.set(invalidPayload.upload, 'reviewNote', 42);
  await expect(runDatabaseSourcePlanUpload(invalidPayload.upload)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });

  const invalidTarget = args(f);
  invalidTarget.upload.target = { ...target, server_url: '' };
  await expect(runDatabaseSourcePlanUpload(invalidTarget.upload)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });

  const secretPath = args(f);
  secretPath.upload.fileRealpath = path.join(f.root, 'ghp_' + 'A'.repeat(36));
  await expect(runDatabaseSourcePlanUpload(secretPath.upload)).rejects.toMatchObject({
    code: 'SECRET_IN_PAYLOAD',
  });

  const secretBaseline = args(f);
  secretBaseline.upload.resolveBaseline = async () => ({
    repo_url: 'ghp_' + 'B'.repeat(36),
    branch: 'main',
    head_sha: 'a'.repeat(40),
  });
  await expect(runDatabaseSourcePlanUpload(secretBaseline.upload)).rejects.toMatchObject({
    code: 'SECRET_IN_PAYLOAD',
  });

  expect(f.openWriter).not.toHaveBeenCalled();
  expect(invalidPayload.create).not.toHaveBeenCalled();
  expect(invalidTarget.create).not.toHaveBeenCalled();
  expect(secretPath.create).not.toHaveBeenCalled();
  expect(secretBaseline.create).not.toHaveBeenCalled();
});
