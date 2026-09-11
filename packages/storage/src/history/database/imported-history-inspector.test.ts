import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

import {
  openProjectDatabase,
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
  projectDatabasePath,
} from './connection.js';
import {
  inspectImportedCloudFacts,
  inspectImportedSessionBranches,
  inspectImportedSourcePlanRecords,
} from './imported-history-inspector.js';
import { importProjectHistory } from './legacy-import.js';
import { legacySource } from '../../../tests/legacy-import-source.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { normalizeHistoryRoot } from '../paths.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function convertedStore(): Promise<{
  authority: ProjectDatabaseAuthority;
  file: string;
  source: ReturnType<typeof legacySource>['source'];
}> {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'imported-inspector-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
  const { source } = legacySource();
  await importProjectHistory({
    authority,
    operationId: uuidv7(),
    importedAt: '2026-09-07T12:00:00.000Z',
    repositoryCreation: {
      commonDirectory: '/legacy/repository/.git',
      device: '77',
      inode: '4242',
      birthtimeNs: '1730000000000000001',
    },
    source,
    authorize() {},
  });
  return { authority, file: projectDatabasePath(authority), source };
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

it('decodes retained imported content read-only, marked unknown-account, replaying nothing', async () => {
  const { authority, file, source } = await convertedStore();
  const before = sha256(await readFile(file));

  const handle = await openProjectDatabase({ authority, mode: 'reader' });
  handles.push(handle);
  const operationsBefore = handle.read((view) =>
    view.get<{ n: number }>('SELECT count(*) AS n FROM operations')
  ).value!.n;

  const sourcePlans = inspectImportedSourcePlanRecords(handle);
  const sessions = inspectImportedSessionBranches(handle);
  const cloud = inspectImportedCloudFacts(handle);

  // Every decoded record is marked unknown account and reconstructs no owner.
  for (const list of [sourcePlans, sessions, cloud])
    for (const row of list) expect(row.accountProvenance).toBe('unknown');

  // Source-plan content decodes to the retained bytes and the frozen record's fields.
  expect(sourcePlans).toHaveLength(source.sourcePlanRecords.length);
  const retainedPlan = source.sourcePlanRecords[0]!;
  const decodedPlan = sourcePlans[0]!;
  expect(decodedPlan).toMatchObject({
    sourceLocation: retainedPlan.sourceLocation,
    kind: retainedPlan.kind,
    namespaceBaseUrl: retainedPlan.namespaceBaseUrl,
    namespaceOrgId: retainedPlan.namespaceOrgId,
    externalId: retainedPlan.externalId,
    slug: retainedPlan.slug,
    versionNumber: retainedPlan.versionNumber,
    title: retainedPlan.title,
    contentHash: retainedPlan.contentHash,
  });
  expect(Buffer.from(decodedPlan.recordHex, 'hex')).toEqual(Buffer.from(retainedPlan.recordBytes));
  expect(decodedPlan.recordSha256).toBe(sha256(Buffer.from(retainedPlan.recordBytes)));
  expect(Buffer.from(decodedPlan.bodyHex!, 'hex')).toEqual(Buffer.from(retainedPlan.bodyBytes!));

  // Session-branch content decodes, including the retained branch history and null ack.
  expect(sessions).toHaveLength(source.sessionBranches.length);
  const retainedSession = source.sessionBranches[0]!;
  expect(sessions[0]).toMatchObject({
    repoUrl: retainedSession.repoUrl,
    workingDir: retainedSession.workingDir,
    currentBranch: retainedSession.currentBranch,
    branchHistory: retainedSession.branchHistory,
    baseCommitSha: retainedSession.baseCommitSha,
    ackedAt: null,
    // The frozen profile recorded no session update time; the absence is retained.
    updatedAt: null,
    sourceLocation: retainedSession.sourceLocation,
  });

  // Cloud facts decode the successful sync and the later failed push side by side.
  expect(cloud).toHaveLength(source.cloudFacts.length);
  const bySource = new Map(source.cloudFacts.map((fact) => [fact.artifactId, fact]));
  for (const decoded of cloud) {
    const retained = bySource.get(decoded.artifactId)!;
    expect(decoded).toMatchObject({
      syncedAt: retained.syncedAt,
      syncHash: retained.syncHash,
      externalId: retained.externalId,
      orgId: retained.orgId,
      lastPushAttemptAt: retained.lastPushAttemptAt,
      lastPushErrorKind: retained.lastPushErrorKind,
      lastPushErrorMessage: retained.lastPushErrorMessage,
      consecutiveFailures: retained.consecutiveFailures,
      sourceLocation: retained.sourceLocation,
    });
  }

  // The inspection wrote nothing: no operation row appeared and the retained bytes are unchanged.
  expect(
    handle.read((view) => view.get<{ n: number }>('SELECT count(*) AS n FROM operations')).value!.n
  ).toBe(operationsBefore);
  handle.close();
  handles.splice(handles.indexOf(handle), 1);
  expect(sha256(await readFile(file))).toBe(before);
});

it('refuses to open a writer for inspection', async () => {
  const { authority } = await convertedStore();
  // The inspectors take a read handle; a reader cannot be coaxed into a domain write, which is
  // how they grant no authority and replay nothing.
  const reader = await openProjectDatabase({ authority, mode: 'reader' });
  handles.push(reader);
  expect(() => reader.read((view) => view.get('DELETE FROM legacy_source_plan_records'))).toThrow();
  expect(inspectImportedSourcePlanRecords(reader).length).toBeGreaterThan(0);
});
