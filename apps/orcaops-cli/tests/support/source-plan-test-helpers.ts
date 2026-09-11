import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { PullCacheRecord } from '@orcaops/storage';
import { uuidv7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  projectDatabasePath,
} from '@orcaops/storage/history/database';
import type { RemoteTarget } from '@orcaops/storage/history/remote-target';

/** `content_hash` tracks `body` unless explicitly overridden. */
export function cloudRecord(over: Partial<PullCacheRecord> = {}): PullCacheRecord {
  const body = over.body ?? '# Cloud Plan\n\nbody';
  return {
    schema_version: 1,
    external_id: 'ext-1',
    slug: 'cloud-plan',
    version_number: 3,
    title: 'Cloud Plan',
    body,
    content_hash: createHash('sha256').update(body, 'utf8').digest('hex'),
    source_ref: null,
    base_url: 'https://cloud.example',
    org_id: 'org_1',
    pulled_at: '2026-06-08T00:00:00.000Z',
    ...over,
  };
}

export async function sourcePlanDatabaseFixture(
  target: RemoteTarget = {
    server_url: 'https://cloud.example',
    org_id: 'org_1',
    account_id: 'account_1',
  }
) {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'orcaops-source-plan-data-')),
  });
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
    initializedAt: '2026-09-09T00:00:00.000Z',
    authorize() {},
  });
  initialized.close();
  const reader = await openProjectDatabase({ authority, mode: 'reader' });
  return {
    authority,
    reader,
    target,
    openWriter: () => openProjectDatabase({ authority, mode: 'writer' }),
    async cleanup() {
      reader.close();
      await rm(root.resolvedRoot, { recursive: true, force: true });
    },
  };
}
