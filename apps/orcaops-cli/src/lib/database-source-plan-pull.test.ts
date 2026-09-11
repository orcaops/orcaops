import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { canonicalJson, type PullCacheRecord, sha256Hex, uuidv7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
  readProjectApprovedSourcePlan,
  readProjectSourcePlanLocator,
  readProjectSourcePlanNamespace,
} from '@orcaops/storage/history/database';
import type { RemoteTarget } from '@orcaops/storage/history/remote-target';

import { createDatabasePlanPullPersistence } from './database-source-plan-pull.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'database-plan-pull-')),
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
    initializedAt: '2026-09-08T00:00:00Z',
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

function record(overrides: Partial<PullCacheRecord> = {}): PullCacheRecord {
  const body = overrides.body ?? 'Use the approved database plan.\n';
  return {
    schema_version: 1,
    external_id: 'source-plan-id',
    slug: 'source-plan',
    version_number: 3,
    title: 'Source Plan',
    body,
    content_hash: sha256Hex(body),
    source_ref: null,
    base_url: target.server_url,
    org_id: target.org_id,
    pulled_at: '2026-09-08T01:00:00Z',
    ...overrides,
  };
}

it('publishes an approved record with stable replay and keeps the first equal selection', async () => {
  const f = await fixture();
  const persistence = createDatabasePlanPullPersistence({
    reader: f.reader,
    target,
    secretAllow: [],
    openWriter: f.openWriter,
  });
  await persistence.preflight();
  expect(f.openWriter).not.toHaveBeenCalled();

  const first = record();
  await persistence.writeRecord(first);
  const firstState = persistence.state().record!;
  const afterFirst = f.reader.read(() => null).counters;
  await persistence.writeRecord(first);
  expect(persistence.state().record).toMatchObject({
    replayed: true,
    value: firstState.value,
    counters: firstState.counters,
  });
  expect(f.reader.read(() => null).counters).toEqual(afterFirst);

  const repull = createDatabasePlanPullPersistence({
    reader: f.reader,
    target,
    secretAllow: [],
    openWriter: f.openWriter,
  });
  await repull.writeRecord(record({ pulled_at: '2026-09-08T02:00:00Z' }));
  expect(repull.state().record!.value.selection).toEqual(firstState.value.selection);
  const namespace = readProjectSourcePlanNamespace(f.reader, {
    serverUrl: target.server_url,
    orgId: target.org_id,
    accountId: target.account_id,
  })!;
  const selected = readProjectApprovedSourcePlan(f.reader, {
    namespaceId: namespace.namespaceId,
    externalId: first.external_id,
    approvedVersion: first.version_number,
  })!;
  expect(Buffer.from(selected.record.recordBase64, 'base64').toString('utf8')).toBe(
    canonicalJson(first) + '\n'
  );
  expect(selected.selection).toEqual(firstState.value.selection);
});

it('isolates account namespaces and publishes path lineage for the selected record', async () => {
  const f = await fixture();
  const output = path.join(f.root, 'outside-repository-plan.md');
  const accountA = createDatabasePlanPullPersistence({
    reader: f.reader,
    target,
    secretAllow: [],
    openWriter: f.openWriter,
  });
  await accountA.writeRecord(record());
  await writeFile(output, 'Use the approved database plan.\n');
  await accountA.writePathPointer({
    realPath: output,
    externalId: 'source-plan-id',
    versionNumber: 3,
  });
  const locator = accountA.state().locator!;
  const afterLocator = f.reader.read(() => null).counters;
  await accountA.writePathPointer({
    realPath: output,
    externalId: 'source-plan-id',
    versionNumber: 3,
  });
  expect(accountA.state().locator).toMatchObject({
    replayed: true,
    value: locator.value,
    counters: locator.counters,
  });
  expect(f.reader.read(() => null).counters).toEqual(afterLocator);

  const otherTarget = { ...target, account_id: 'account-b' };
  const accountB = createDatabasePlanPullPersistence({
    reader: f.reader,
    target: otherTarget,
    secretAllow: [],
    openWriter: f.openWriter,
  });
  await accountB.writeRecord(record());
  const namespaceA = readProjectSourcePlanNamespace(f.reader, {
    serverUrl: target.server_url,
    orgId: target.org_id,
    accountId: target.account_id,
  })!;
  const namespaceB = readProjectSourcePlanNamespace(f.reader, {
    serverUrl: otherTarget.server_url,
    orgId: otherTarget.org_id,
    accountId: otherTarget.account_id,
  })!;
  expect(namespaceA.namespaceId).not.toBe(namespaceB.namespaceId);
  expect(
    readProjectSourcePlanLocator(f.reader, {
      namespaceId: namespaceA.namespaceId,
      kind: 'path',
      realPath: output,
    })?.record.approvedRecordId
  ).toBe(accountA.state().record!.value.selection.recordId);
  expect(
    readProjectSourcePlanLocator(f.reader, {
      namespaceId: namespaceB.namespaceId,
      kind: 'path',
      realPath: output,
    })
  ).toBeNull();
});

it('refuses inbound secrets before opening a writer', async () => {
  const f = await fixture();
  const persistence = createDatabasePlanPullPersistence({
    reader: f.reader,
    target,
    secretAllow: [],
    openWriter: f.openWriter,
  });
  const secret = 'ghp_' + 'A'.repeat(36);
  await expect(persistence.writeRecord(record({ body: secret }))).rejects.toMatchObject({
    name: 'OrcaopsError',
    code: 'SECRET_IN_PAYLOAD',
    details: {
      secret_findings: [expect.objectContaining({ path: 'record.body' })],
    },
  });
  expect(f.openWriter).not.toHaveBeenCalled();
  expect(
    readProjectSourcePlanNamespace(f.reader, {
      serverUrl: target.server_url,
      orgId: target.org_id,
      accountId: target.account_id,
    })
  ).toBeNull();
});
